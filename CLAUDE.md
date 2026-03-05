# AI Annotation Extension — Implementation Plan

## 1. Bài toán & Scope

Extension cho phép user:

1. **Right-click ảnh trên web** (đặc biệt ảnh Gemini generate) → ảnh tự động load vào editor
2. Hoặc paste / capture screenshot thủ công
3. Vẽ annotation lên ảnh (highlight, arrow, text)
4. Gửi ảnh + annotation context tới AI API

**Use case chính:** User generate ảnh bằng Gemini → right-click ảnh → "Edit with AI Annotation" → vẽ annotation chỉ chỗ cần sửa → gửi lại cho AI.

**Không làm trong MVP:** AI auto-annotate, history, multi-image, real-time collaboration.

---

## 2. Quyết định kiến trúc

### 2.1 Extension surface: Side Panel (Chrome 114+)

Lý do chọn Side Panel thay vì popup hay new tab:

- Popup bị đóng khi user click ra ngoài → mất state
- New tab tách rời khỏi trang đang inspect
- Side Panel giữ nguyên context, resize được, persistent

Trade-off: Side Panel width tối đa ~400-500px trên màn hình thường. Canvas sẽ hẹp nhưng đủ cho annotation workflow. Nếu user cần full-screen canvas → thêm button "Open in tab" mở editor.html trong new tab.

### 2.2 Canvas engine: tldraw v3

Chọn tldraw vì:

- API `editor.getCurrentPageShapes()` clean, trả về typed shapes
- Built-in tools: select, draw, arrow, rectangle, text
- Image shape native
- MIT license
- Bundle ~2MB — chấp nhận được cho side panel (load 1 lần)

### 2.3 Coordinate system

Đây là vấn đề plan cũ bỏ qua hoàn toàn:

- tldraw dùng canvas coordinates (có zoom, pan)
- Image shape có position (x, y) và size (w, h) trên canvas
- Annotation shapes có position riêng trên canvas
- AI cần pixel coordinates tương đối với image gốc

Giải pháp: **Normalize tất cả annotation coordinates về image-relative coordinates (0-1 range)**

```
normalizedX = (shape.x - image.x) / image.props.w
normalizedY = (shape.y - image.y) / image.props.h
```

Lợi ích: AI hiểu "highlight tại 25% từ trái, 40% từ trên" bất kể image resolution.

### 2.4 Context Menu → Image Fetch pipeline

**Flow:**

```
User right-click ảnh trên Gemini (hoặc bất kỳ web page)
    ↓
Chrome context menu: "Edit with AI Annotation"
    ↓
background/service-worker.ts nhận info.srcUrl
    ↓
Service worker fetch image (BYPASS CORS)
    ↓
Convert response → base64
    ↓
Send base64 → side panel via chrome.runtime.sendMessage
    ↓
Side panel nhận → insert vào tldraw canvas
```

**Tại sao phải fetch từ service worker?**

URL ảnh Gemini có dạng `https://lh3.googleusercontent.com/gg/...`. Đây là Google CDN, không set `Access-Control-Allow-Origin` cho extension origins. Nếu fetch từ side panel (web context) → CORS block.

Service worker (background script) trong MV3 **không bị CORS restriction** khi extension có `host_permissions` cho domain đó. Đây là cách chính thống Chrome recommend.

**Xử lý URL patterns cần hỗ trợ:**

| Source | URL pattern | Ghi chú |
|--------|-------------|---------|
| Gemini | `lh3.googleusercontent.com/gg/*` | Ảnh generate, có suffix `=s1024-rj` control size |
| Gemini (variant) | `lh3.googleusercontent.com/d/*` | Ảnh từ Drive |
| ChatGPT/DALL-E | `oaidalleapiprodscus.blob.core.windows.net/*` | Azure blob |
| General web | `*` | Bất kỳ `<img>` nào user right-click |

MVP chỉ cần support `*` (mọi ảnh) — không cần filter theo domain.

**Gemini image URL trick:**

URL Gemini có suffix `=s1024-rj` để control kích thước. Có thể thay đổi:
- `=s1024` → ảnh 1024px (default)
- `=s2048` → ảnh 2048px (higher quality)  
- `=s0` → ảnh gốc full resolution
- Bỏ suffix → ảnh gốc

Extension nên thử fetch `=s2048` trước để có quality tốt hơn cho annotation.

### 2.5 API strategy

MVP support Claude API (vision). Payload gồm:

1. Image gốc (base64, compressed JPEG, max 1MB)
2. Annotated image (screenshot canvas export, để AI "nhìn" annotation visually)
3. Structured annotation text (parsed từ shapes)

Gửi cả 3 vì: structured text cho precision, annotated image cho visual context. AI có thể cross-reference.

---

## 3. File structure

```
extension/
├── manifest.json                 # MV3, side_panel, contextMenus permission
├── background/
│   ├── service-worker.ts         # Extension lifecycle, context menu, message routing
│   ├── image-fetcher.ts          # Fetch image from URL (CORS bypass)
│   └── api-client.ts             # AI API calls (runs in SW context)
├── sidepanel/
│   ├── index.html                # Side panel entry
│   ├── App.tsx                   # Main React app
│   ├── components/
│   │   ├── CanvasEditor.tsx      # tldraw wrapper + image insertion
│   │   ├── Toolbar.tsx           # Paste, undo, send, export
│   │   └── ResultPanel.tsx       # AI response display
│   └── styles.css
├── content/
│   └── capture.ts                # Tab screenshot capture
├── core/
│   ├── annotation-parser.ts      # Shapes → structured annotations
│   ├── coordinate-transform.ts   # Canvas coords → image-relative coords
│   ├── prompt-builder.ts         # Annotations → LLM prompt
│   ├── image-utils.ts            # Compression, base64, crop
│   └── types.ts                  # Shared types
├── config/
│   └── api-config.ts             # API key storage (chrome.storage.local)
└── vite.config.ts                # Build config cho extension
```

---

## 4. Module specifications

### Module 1 — Image Input

**4 input methods (ưu tiên theo thứ tự):**

**Context menu — right-click image (primary):**
```typescript
// background/service-worker.ts

// Tạo context menu khi extension install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'annotate-image',
    title: 'Edit with AI Annotation',
    contexts: ['image'], // Chỉ hiện khi right-click lên <img>
  });
});

// Handle click
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'annotate-image') return;
  if (!info.srcUrl) return;

  try {
    // 1. Fetch image từ service worker (bypass CORS)
    const base64 = await fetchImageAsBase64(info.srcUrl);

    // 2. Mở side panel
    await chrome.sidePanel.open({ tabId: tab!.id! });

    // 3. Gửi image data sang side panel
    // Dùng setTimeout nhỏ để side panel có thời gian mount
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'IMAGE_FROM_CONTEXT_MENU',
        payload: {
          base64,
          sourceUrl: info.srcUrl,
          pageUrl: info.pageUrl,
          pageTitle: tab?.title,
        },
      });
    }, 500);
  } catch (err) {
    console.error('Failed to fetch image:', err);
  }
});
```

```typescript
// background/image-fetcher.ts

export async function fetchImageAsBase64(imageUrl: string): Promise<string> {
  // Gemini URL optimization: upgrade resolution
  const optimizedUrl = optimizeGeminiUrl(imageUrl);

  const response = await fetch(optimizedUrl);

  if (!response.ok) {
    // Fallback to original URL if optimized fails
    if (optimizedUrl !== imageUrl) {
      const fallback = await fetch(imageUrl);
      if (!fallback.ok) throw new Error(`Fetch failed: ${fallback.status}`);
      return blobToBase64(await fallback.blob());
    }
    throw new Error(`Fetch failed: ${response.status}`);
  }

  return blobToBase64(await response.blob());
}

function optimizeGeminiUrl(url: string): string {
  // lh3.googleusercontent.com URLs support size suffix
  if (url.includes('lh3.googleusercontent.com')) {
    // Replace =s1024-rj or similar with =s2048 for better quality
    return url.replace(/=s\d+(-[a-z]+)?$/, '=s2048');
  }
  return url;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary);
}
```

```typescript
// sidepanel/App.tsx — nhận image từ context menu

useEffect(() => {
  const handleMessage = (message: any) => {
    if (message.type === 'IMAGE_FROM_CONTEXT_MENU') {
      const { base64, sourceUrl } = message.payload;

      // Convert base64 → blob → object URL → insert vào canvas
      const byteChars = atob(base64);
      const byteNumbers = new Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) {
        byteNumbers[i] = byteChars.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: 'image/jpeg' });
      const objectUrl = URL.createObjectURL(blob);

      // Store source URL for later reference (e.g., send back to Gemini)
      setImageMeta({ sourceUrl, objectUrl });

      // Insert vào tldraw canvas
      if (editorRef.current) {
        insertImageToCanvas(editorRef.current, objectUrl, blob);
      }
    }
  };

  chrome.runtime.onMessage.addListener(handleMessage);
  return () => chrome.runtime.onMessage.removeListener(handleMessage);
}, []);
```

**Paste (secondary):**
```typescript
// Trong CanvasEditor.tsx
useEffect(() => {
  const handlePaste = async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (!blob) continue;

        // Compress trước khi đưa vào canvas
        const compressed = await compressImage(blob, {
          maxWidth: 1920,
          maxHeight: 1080,
          quality: 0.85
        });

        const url = URL.createObjectURL(compressed);
        insertImageToCanvas(editor, url, compressed);
      }
    }
  };

  window.addEventListener('paste', handlePaste);
  return () => window.removeEventListener('paste', handlePaste);
}, [editor]);
```

**Screenshot capture:**
```typescript
// content/capture.ts — gửi message tới service worker
chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' });

// background/service-worker.ts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CAPTURE_TAB') {
    chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 85 }, (dataUrl) => {
      // Forward to side panel
      chrome.runtime.sendMessage({ type: 'IMAGE_CAPTURED', dataUrl });
    });
  }
});
```

**Drag & drop:** Standard HTML5 dragover/drop events trên canvas container.

### Module 2 — Canvas Editor

```tsx
// sidepanel/components/CanvasEditor.tsx
import { Tldraw, Editor, TLShapeId } from 'tldraw';
import { useRef, useCallback } from 'react';

interface CanvasEditorProps {
  onEditorReady: (editor: Editor) => void;
}

export function CanvasEditor({ onEditorReady }: CanvasEditorProps) {
  const editorRef = useRef<Editor | null>(null);

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor;
    onEditorReady(editor);

    // Lock image shape after insert (prevent accidental move)
    // Disable tools we don't need to reduce UI noise
    // Keep: select, draw, arrow, geo (rectangle), text
  }, [onEditorReady]);

  return (
    <div style={{ width: '100%', height: 'calc(100vh - 80px)' }}>
      <Tldraw
        onMount={handleMount}
        // Disable pages, share, etc for extension context
        options={{ maxPages: 1 }}
      />
    </div>
  );
}
```

### Module 3 — Image Insertion

```typescript
// core/image-utils.ts
export async function insertImageToCanvas(
  editor: Editor,
  imageUrl: string,
  blob: Blob
): Promise<TLShapeId> {
  // Get image dimensions
  const img = new Image();
  await new Promise((resolve) => {
    img.onload = resolve;
    img.src = imageUrl;
  });

  // Fit image to canvas viewport
  const viewport = editor.getViewportScreenBounds();
  const scale = Math.min(
    (viewport.width * 0.9) / img.width,
    (viewport.height * 0.9) / img.height,
    1 // Don't upscale
  );

  const w = img.width * scale;
  const h = img.height * scale;

  // Center in viewport
  const x = (viewport.width - w) / 2;
  const y = (viewport.height - h) / 2;

  // Create asset first
  const assetId = AssetRecordType.createId();
  editor.createAssets([{
    id: assetId,
    type: 'image',
    typeName: 'asset',
    props: {
      src: imageUrl,
      w: img.width,
      h: img.height,
      name: 'screenshot',
      isAnimated: false,
      mimeType: blob.type,
    },
    meta: {},
  }]);

  // Then create image shape
  const shapeId = createShapeId();
  editor.createShape({
    id: shapeId,
    type: 'image',
    x, y,
    props: {
      assetId,
      w, h,
    },
  });

  // Lock image position
  editor.updateShape({
    id: shapeId,
    type: 'image',
    isLocked: true,
  });

  return shapeId;
}
```

### Module 4 — Annotation Parser (core logic)

Đây là module quan trọng nhất và phức tạp nhất. Plan cũ chỉ map type → label, thiếu hoàn toàn spatial reasoning.

```typescript
// core/annotation-parser.ts
import { Editor, TLShape, TLGeoShape, TLArrowShape, TLTextShape } from 'tldraw';
import { normalizeToImageCoords } from './coordinate-transform';

export interface ParsedAnnotation {
  type: 'highlight' | 'arrow' | 'instruction' | 'freehand-circle';
  // Image-relative coordinates (0-1 range)
  region?: { x: number; y: number; w: number; h: number };
  // For arrows: what it points from/to
  pointer?: {
    from: { x: number; y: number };
    to: { x: number; y: number };
    targetRegion?: ParsedAnnotation; // Resolved reference
  };
  // Text content
  text?: string;
  // Raw shape for debug
  _shapeId: string;
}

export function parseAnnotations(
  editor: Editor,
  imageShapeId: string
): ParsedAnnotation[] {
  const shapes = editor.getCurrentPageShapes();
  const imageShape = editor.getShape(imageShapeId);
  if (!imageShape) return [];

  // Step 1: Separate image from annotations
  const annotationShapes = shapes.filter(s => s.id !== imageShapeId);

  // Step 2: Parse each shape
  const annotations: ParsedAnnotation[] = [];

  for (const shape of annotationShapes) {
    switch (shape.type) {
      case 'geo': {
        // Rectangle, ellipse, etc = highlight region
        const geo = shape as TLGeoShape;
        const region = normalizeToImageCoords(
          { x: shape.x, y: shape.y, w: geo.props.w, h: geo.props.h },
          imageShape
        );
        annotations.push({
          type: 'highlight',
          region,
          _shapeId: shape.id,
        });
        break;
      }

      case 'arrow': {
        // Arrow = pointer relationship
        const arrow = shape as TLArrowShape;
        const bindings = editor.getBindingsFromShape(shape, 'arrow');

        // Resolve arrow endpoints
        const startPoint = editor.getArrowTerminalsInArrowSpace(shape);
        const from = normalizeToImageCoords(
          { x: startPoint.start.x + shape.x, y: startPoint.start.y + shape.y, w: 0, h: 0 },
          imageShape
        );
        const to = normalizeToImageCoords(
          { x: startPoint.end.x + shape.x, y: startPoint.end.y + shape.y, w: 0, h: 0 },
          imageShape
        );

        // Check if arrow is bound to another shape (hit testing)
        let targetRegion: ParsedAnnotation | undefined;
        if (bindings.length > 0) {
          const boundShape = editor.getShape(bindings[0].toId);
          if (boundShape) {
            targetRegion = annotations.find(a => a._shapeId === boundShape.id);
          }
        }

        annotations.push({
          type: 'arrow',
          pointer: { from, to, targetRegion },
          _shapeId: shape.id,
        });
        break;
      }

      case 'text': {
        const text = shape as TLTextShape;
        const region = normalizeToImageCoords(
          { x: shape.x, y: shape.y, w: 100, h: 30 }, // Approximate
          imageShape
        );
        annotations.push({
          type: 'instruction',
          text: text.props.text,
          region,
          _shapeId: shape.id,
        });
        break;
      }

      case 'draw': {
        // Freehand draw — detect if it's roughly circular (= highlight)
        // Otherwise skip (noise)
        // MVP: skip freehand entirely
        break;
      }
    }
  }

  // Step 3: Resolve cross-references
  // E.g., text near a highlight → attach text as label for that highlight
  return resolveProximityRelations(annotations);
}

function resolveProximityRelations(
  annotations: ParsedAnnotation[]
): ParsedAnnotation[] {
  // For each text annotation, check if it's near a highlight
  // If yes, attach it as a label
  const highlights = annotations.filter(a => a.type === 'highlight');
  const texts = annotations.filter(a => a.type === 'instruction');

  for (const text of texts) {
    if (!text.region) continue;
    for (const highlight of highlights) {
      if (!highlight.region) continue;
      const distance = regionDistance(text.region, highlight.region);
      if (distance < 0.05) { // Within 5% of image size
        highlight.text = text.text;
        text._merged = true; // Mark as merged
      }
    }
  }

  return annotations.filter(a => !a._merged);
}
```

### Module 5 — Coordinate Transform

```typescript
// core/coordinate-transform.ts
export interface CanvasRect {
  x: number; y: number; w: number; h: number;
}

export interface NormalizedRect {
  x: number; y: number; w: number; h: number;
  // All values 0-1, relative to image
}

export function normalizeToImageCoords(
  canvasRect: CanvasRect,
  imageShape: TLShape
): NormalizedRect {
  const imgX = imageShape.x;
  const imgY = imageShape.y;
  const imgW = (imageShape as any).props.w;
  const imgH = (imageShape as any).props.h;

  return {
    x: clamp01((canvasRect.x - imgX) / imgW),
    y: clamp01((canvasRect.y - imgY) / imgH),
    w: clamp01(canvasRect.w / imgW),
    h: clamp01(canvasRect.h / imgH),
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
```

### Module 6 — Prompt Builder

```typescript
// core/prompt-builder.ts
export function buildPrompt(
  annotations: ParsedAnnotation[],
  userInstruction?: string
): string {
  const sections: string[] = [];

  // Group annotations by type
  const highlights = annotations.filter(a => a.type === 'highlight');
  const arrows = annotations.filter(a => a.type === 'arrow');
  const instructions = annotations.filter(a => a.type === 'instruction');

  if (highlights.length > 0) {
    sections.push('## Highlighted Regions');
    highlights.forEach((h, i) => {
      const r = h.region!;
      const pos = `(${pct(r.x)}, ${pct(r.y)}) size ${pct(r.w)}×${pct(r.h)}`;
      const label = h.text ? ` — "${h.text}"` : '';
      sections.push(`${i + 1}. Region at ${pos}${label}`);
    });
  }

  if (arrows.length > 0) {
    sections.push('\n## Arrows');
    arrows.forEach((a, i) => {
      const p = a.pointer!;
      const fromPos = `(${pct(p.from.x)}, ${pct(p.from.y)})`;
      const toPos = `(${pct(p.to.x)}, ${pct(p.to.y)})`;
      sections.push(`${i + 1}. Arrow from ${fromPos} → ${toPos}`);
    });
  }

  if (instructions.length > 0) {
    sections.push('\n## Text Instructions');
    instructions.forEach((t, i) => {
      sections.push(`${i + 1}. "${t.text}"`);
    });
  }

  if (userInstruction) {
    sections.push(`\n## User Request\n${userInstruction}`);
  }

  return [
    'You are analyzing a UI screenshot with user annotations.',
    'Two images are attached: the original screenshot and the annotated version.',
    'The annotations indicate areas the user wants to modify.',
    'Coordinates are given as percentages relative to the image (0% = left/top, 100% = right/bottom).',
    '',
    ...sections,
    '',
    'Based on the annotations and instructions, describe the specific changes needed.',
  ].join('\n');
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
```

### Module 7 — API Client

```typescript
// background/api-client.ts
interface APIRequest {
  originalImage: string;      // base64
  annotatedImage: string;     // base64 (canvas export)
  prompt: string;             // Built prompt
}

export async function sendToAI(request: APIRequest): Promise<string> {
  const apiKey = await getStoredApiKey();
  if (!apiKey) throw new Error('API key not configured');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: request.originalImage,
            },
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: request.annotatedImage,
            },
          },
          {
            type: 'text',
            text: request.prompt,
          },
        ],
      }],
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`API error: ${error.error?.message || response.statusText}`);
  }

  const data = await response.json();
  return data.content[0]?.text || 'No response';
}

async function getStoredApiKey(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get('apiKey', (result) => {
      resolve(result.apiKey || null);
    });
  });
}
```

---

## 5. Manifest.json

```json
{
  "manifest_version": 3,
  "name": "AI Annotation",
  "version": "0.1.0",
  "permissions": [
    "activeTab",
    "storage",
    "sidePanel",
    "contextMenus"
  ],
  "host_permissions": [
    "https://lh3.googleusercontent.com/*",
    "https://*.blob.core.windows.net/*",
    "https://api.anthropic.com/*",
    "<all_urls>"
  ],
  "side_panel": {
    "default_path": "sidepanel/index.html"
  },
  "background": {
    "service_worker": "background/service-worker.ts"
  },
  "action": {
    "default_title": "Open AI Annotation"
  },
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  }
}
```

**Giải thích `host_permissions`:**

- `lh3.googleusercontent.com` — cần để service worker fetch ảnh Gemini (bypass CORS)
- `*.blob.core.windows.net` — DALL-E images (nếu cần sau này)
- `api.anthropic.com` — Claude API calls
- `<all_urls>` — cho phép fetch ảnh từ bất kỳ website nào user right-click. Nếu muốn conservative hơn, bỏ dòng này và chỉ giữ các domain cụ thể. Trade-off: user sẽ không right-click được ảnh từ các site khác.

**Lưu ý:** Chrome Web Store review sẽ hỏi tại sao cần `<all_urls>`. Justification: extension cần fetch image từ bất kỳ page nào user right-click, service worker cần bypass CORS để đọc image data.

---

## 6. Edge case: Side Panel chưa mount khi nhận message

Đây là race condition quan trọng nhất trong flow context menu:

```
User right-click → service worker xử lý → mở side panel → gửi message
                                            ↑                    ↑
                                      side panel bắt đầu      side panel có thể
                                      mount React app          chưa mount xong
```

**Giải pháp: Handshake pattern**

```typescript
// background/service-worker.ts

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'annotate-image' || !info.srcUrl) return;

  const base64 = await fetchImageAsBase64(info.srcUrl);

  // Mở side panel
  await chrome.sidePanel.open({ tabId: tab!.id! });

  // Lưu image vào storage tạm — side panel sẽ check khi mount
  await chrome.storage.session.set({
    pendingImage: {
      base64,
      sourceUrl: info.srcUrl,
      timestamp: Date.now(),
    }
  });

  // Cũng thử gửi message (nếu side panel đã mount sẵn)
  try {
    await chrome.runtime.sendMessage({
      type: 'IMAGE_FROM_CONTEXT_MENU',
      payload: { base64, sourceUrl: info.srcUrl },
    });
  } catch {
    // Side panel chưa mount — không sao, nó sẽ đọc từ storage
  }
});

// sidepanel/App.tsx

useEffect(() => {
  // Check pending image từ storage khi mount
  async function checkPendingImage() {
    const result = await chrome.storage.session.get('pendingImage');
    if (result.pendingImage) {
      const { base64, sourceUrl, timestamp } = result.pendingImage;
      // Chỉ dùng nếu < 10 giây trước (tránh load ảnh cũ)
      if (Date.now() - timestamp < 10000) {
        loadImageToCanvas(base64, sourceUrl);
      }
      // Clear pending
      await chrome.storage.session.remove('pendingImage');
    }
  }
  checkPendingImage();

  // Cũng listen message cho lần sau (side panel đã mở sẵn)
  const handleMessage = (message: any) => {
    if (message.type === 'IMAGE_FROM_CONTEXT_MENU') {
      loadImageToCanvas(message.payload.base64, message.payload.sourceUrl);
    }
  };
  chrome.runtime.onMessage.addListener(handleMessage);
  return () => chrome.runtime.onMessage.removeListener(handleMessage);
}, []);
```

**`chrome.storage.session`** là storage chỉ tồn tại trong browser session (mất khi đóng browser). Dùng thay vì `local` vì pending image không cần persist.

---

## 6. Build & Dev setup

```bash
# Stack
pnpm create vite extension --template react-ts
pnpm add tldraw @anthropic-ai/sdk
pnpm add -D @crxjs/vite-plugin  # Vite plugin cho Chrome Extension

# Dev
pnpm dev   # Hot reload trong extension

# Build
pnpm build # Output to dist/
```

Dùng `@crxjs/vite-plugin` vì nó handle HMR cho extension, auto-generate manifest, và support TypeScript natively.

---

## 7. Phased Roadmap (realistic)

### Phase 1 — Context menu + Canvas skeleton (2-3 ngày)

Deliverables:
- Context menu "Edit with AI Annotation" appears on right-click image
- Service worker fetches image (CORS bypass verified on Gemini URLs)
- Side panel opens and receives image
- tldraw canvas renders with image inserted
- User can draw rectangle, arrow, text on image
- Paste image also works as fallback

Validation: Go to Gemini → generate image → right-click → "Edit with AI Annotation" → image appears in side panel canvas → draw annotations.

### Phase 2 — Annotation pipeline (2-3 ngày)

Deliverables:
- `parseAnnotations()` reads shapes, outputs structured data
- `normalizeToImageCoords()` converts to image-relative coords
- `buildPrompt()` generates readable prompt
- "Send" button logs prompt to console
- Canvas export produces annotated PNG

Validation: Draw annotations → click Send → console shows correct prompt with normalized coordinates.

### Phase 3 — API integration (1-2 ngày)

Deliverables:
- Settings page for API key
- API client sends image + prompt to Claude
- Response displays in result panel
- Basic error handling (no key, network failure, rate limit)

Validation: Full flow — paste → annotate → send → see AI response.

### Phase 4 — Polish (2-3 ngày)

Deliverables:
- Image compression (> 1MB → JPEG 85%)
- Crop highlight region → send as separate image (10x better AI understanding)
- Keyboard shortcuts (Cmd+V paste, Cmd+Enter send)
- Loading states, error toasts
- Export annotated image as PNG

**Total realistic estimate: 7-11 ngày** cho một developer.

---

## 8. Crop highlight trick (critical optimization)

Đây là insight quan trọng nhất từ plan cũ, nhưng cần implement cụ thể:

```typescript
// Khi user highlight 1 vùng, crop vùng đó từ ảnh gốc
async function cropHighlightRegion(
  originalImage: HTMLImageElement,
  normalizedRegion: NormalizedRect
): Promise<string> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  const sx = normalizedRegion.x * originalImage.naturalWidth;
  const sy = normalizedRegion.y * originalImage.naturalHeight;
  const sw = normalizedRegion.w * originalImage.naturalWidth;
  const sh = normalizedRegion.h * originalImage.naturalHeight;

  canvas.width = sw;
  canvas.height = sh;
  ctx.drawImage(originalImage, sx, sy, sw, sh, 0, 0, sw, sh);

  return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
}
```

Gửi cho AI cả full image lẫn cropped region. AI hiểu chính xác user muốn sửa chỗ nào.

---

## 9. Rủi ro & Mitigation

| Rủi ro | Mitigation |
|--------|-----------|
| tldraw bundle size lớn (2MB+) | Lazy load, chỉ load khi side panel mở |
| tldraw API thay đổi giữa versions | Pin exact version, lock package |
| Side panel width hẹp | Responsive canvas, zoom-to-fit image |
| Image quá lớn cho API | Compress + resize trước khi encode base64 |
| API key security | chrome.storage.local (encrypted at rest by Chrome) |
| Canvas coordinate ≠ image pixel | Module coordinate-transform xử lý |
| Gemini image URL thay đổi format | Fetch generic `info.srcUrl`, không hardcode URL pattern |
| Service worker bị terminate (MV3 idle timeout 30s) | Dùng `chrome.runtime.sendMessage` để wake, không giữ persistent state trong SW |
| Side panel chưa mount khi SW gửi message | Retry logic với setTimeout + message acknowledgment |
| `<all_urls>` bị Chrome Web Store reject | Fallback: chỉ whitelist Google domains, yêu cầu user paste cho site khác |

---

## 10. Không làm (conscious decisions)

- **Không dùng freehand draw cho annotation** — noise, khó parse, AI không hiểu. Chỉ dùng rectangle, arrow, text.
- **Không multi-page** — 1 image per session, đơn giản.
- **Không AI auto-annotate trong MVP** — scope creep.
- **Không support Firefox/Safari** — Chrome only cho MVP (Side Panel API là Chrome-specific).
- **Không offline mode** — cần API call.