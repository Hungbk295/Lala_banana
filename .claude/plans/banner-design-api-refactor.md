# Plan: Banner Design API — Tích hợp vào Gemini Flow

> Last updated: 2026-03-16
> Status: PLANNING — chưa implement

---

## Vấn đề cần giải quyết

Phiên bản hiện tại (`banner-design` skill) phụ thuộc Claude Code Bash tool để chạy Python scripts. Cần tích hợp vào luồng call Gemini API hiện tại của extension, để khi user gửi ảnh + annotation → Gemini có thể truy vấn design knowledge base (palette, typography, platform specs...) qua tool-use loop.

---

## Quyết định kiến trúc

- **B**: Deploy BM25 engine thành **server riêng** (Banner Server) — không sửa proxy.
- **Y**: **Tool-use loop** chạy trong extension service worker — Gemini quyết định gọi tool, service worker thực thi bằng cách gọi Banner Server.

---

## Các thực thể và vai trò

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Side Panel     │     │  Service Worker   │     │  Proxy (anta.)  │
│   (React UI)     │────▶│  (Orchestrator)   │────▶│  (AI Provider)  │
│                  │     │                   │     │  Forward→Gemini │
└─────────────────┘     │                   │     └─────────────────┘
                        │                   │
                        │   tool_use loop   │     ┌─────────────────┐
                        │   ◄────────────►  │────▶│  Banner Server  │
                        │                   │     │  (Knowledge DB) │
                        └──────────────────┘     │  BM25 + CSV     │
                                                  │  REST API only  │
                                                  └─────────────────┘
```

| Thực thể | Vai trò | Biết về AI? |
|-----------|---------|-------------|
| **Side Panel (UI)** | Thu thập input, hiển thị kết quả | Không |
| **Service Worker** | Orchestrator — chạy tool-use loop, route giữa Gemini và Banner Server | Có — hiểu tool_use protocol |
| **Proxy (api.anta...)** | Forward request tới Gemini. Không sửa. | Không — transparent |
| **Banner Server** | Knowledge master base — trả design data qua REST API | Không — pure data server |

---

## Flow chi tiết

```
User click Send (with Design Intelligence ON)
    ↓
Side Panel → chrome.runtime.sendMessage('SEND_TO_GEMINI', payload)
    ↓
Service Worker nhận payload
    ↓ Thêm tool definitions vào request body
    ↓ POST Gemini (via proxy) với tools + images + prompt
    ↓
Gemini trả về: tool_use { name: "banner_search", input: { query: "warm elegant" } }
    ↓
Service Worker bắt tool_use
    ↓ GET banner-server/search?q=warm+elegant&domain=palette
    ↓
Banner Server: BM25 search trên CSV → trả JSON
    ↓
Service Worker gửi tool_result lại cho Gemini (via proxy)
    ↓
Gemini có thể gọi thêm tool (banner_design_system, ...) hoặc end_turn
    ↓
Khi end_turn → Service Worker parse response (text + image)
    ↓
Service Worker → sendResponse → Side Panel hiển thị
```

**Khi Design Intelligence OFF:** Flow giữ nguyên như hiện tại — single-shot, không tools.

---

## Banner Server

### Stack
- **Python + FastAPI** (hoặc Flask)
- **BM25 engine** — copy nguyên từ `banner-design` skill (`core.py`, `brand_system.py`)
- **CSV data** — copy nguyên
- **Stateless** — không lưu state, không gọi AI

### API Endpoints

```
GET  /search?q={query}&domain={palette|typography|context|platform|mood}&n={max_results}
     → { results: [...] }

GET  /design-system?mood={query}&brand={type}&platform={platform}&name={project_name}
     → { palette: {...}, typography: {...}, layout: {...}, checklist: [...] }

GET  /brand/{name}
     → { design_system: {...} } hoặc 404

POST /brand/{name}
     Body: { design_system: {...} }
     → { saved: true, path: "..." }
```

### Hosting
- TBD — VPS riêng / Railway / Vercel / cùng machine port khác

---

## Tool Definitions (gửi kèm Gemini request)

4 tools expose cho Gemini:

```json
[
  {
    "name": "banner_search",
    "description": "Search banner design database. Returns palettes, typography, platform specs, or mood descriptors.",
    "parameters": {
      "query": "string (required) — mood descriptors, brand type, platform name",
      "domain": "enum [palette, typography, context, platform, mood] (optional)",
      "max_results": "integer, default 3"
    }
  },
  {
    "name": "banner_design_system",
    "description": "Generate complete banner design system: palette + typography + layout + platform specs.",
    "parameters": {
      "mood_query": "string (required)",
      "brand_type": "string (optional) — beauty, tech, fashion...",
      "platform": "string (optional) — instagram, facebook, linkedin",
      "project_name": "string (optional)"
    }
  },
  {
    "name": "load_brand_memory",
    "description": "Load existing brand guidelines by name.",
    "parameters": {
      "brand_name": "string (required)"
    }
  },
  {
    "name": "save_brand_memory",
    "description": "Save brand guidelines after generating.",
    "parameters": {
      "brand_name": "string (required)",
      "design_system_json": "string (required)"
    }
  }
]
```

---

## Extension Code Changes

### `gemini-client.ts` — thêm tool-use loop

```typescript
// Hiện tại: sendToGemini() — single-shot
// Mới: sendToGeminiWithTools() — loop

export async function sendToGeminiWithTools(request: GeminiRequest): Promise<AIResponsePart[]> {
  const contents = [buildUserMessage(request)];

  while (true) {
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      tools: [{ functionDeclarations: BANNER_TOOL_DEFINITIONS }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    };

    const data = await callGeminiProxy(body);
    const parts = data.candidates[0].content.parts;
    contents.push({ role: 'model', parts });

    // Check for function calls
    const functionCalls = parts.filter(p => p.functionCall);
    if (functionCalls.length === 0) {
      return parseResponse(data); // done
    }

    // Execute tools via Banner Server
    const toolResults = await Promise.all(
      functionCalls.map(fc => executeBannerTool(fc.functionCall))
    );
    contents.push({ role: 'user', parts: toolResults });
  }
}

async function executeBannerTool(call: { name: string; args: any }) {
  const BANNER_SERVER = 'https://banner-server.example.com'; // TBD

  let result: any;
  switch (call.name) {
    case 'banner_search':
      result = await fetch(`${BANNER_SERVER}/search?q=${call.args.query}&domain=${call.args.domain || ''}&n=${call.args.max_results || 3}`);
      break;
    case 'banner_design_system':
      result = await fetch(`${BANNER_SERVER}/design-system?mood=${call.args.mood_query}&brand=${call.args.brand_type || ''}&platform=${call.args.platform || ''}`);
      break;
    // ... load_brand_memory, save_brand_memory
  }

  return {
    functionResponse: {
      name: call.name,
      response: await result.json(),
    }
  };
}
```

### `service-worker.ts` — route dựa vào flag

```typescript
if (message.type === 'SEND_TO_GEMINI') {
  const sendFn = message.payload.useDesignTools
    ? sendToGeminiWithTools
    : sendToGemini;
  // ...
}
```

### `SkillsPanel.tsx` — thêm toggle

Thêm toggle "Design Intelligence" on/off. Khi on → service worker gửi kèm tool definitions.
Gemini tự quyết định gọi tool nào dựa trên ảnh + instruction — user không cần chọn mood/brand/platform thủ công.

---

## Open Questions

1. **Banner Server hosting** — chọn platform nào?
2. **Gemini function calling + image generation** — cần verify xem `gemini-3.1-flash-image` có support cả hai cùng lúc không. Nếu không → cần 2-phase (loop text-only → generate image riêng).
3. **Tool definitions format** — Gemini dùng `functionDeclarations` format, khác với Anthropic `tool_use`. Cần map đúng schema.
4. **Latency budget** — Tool-use loop thêm 2-3 roundtrips. Cần đo xem user chấp nhận được bao lâu.
5. **SkillsPanel UX cũ** — Giữ hay bỏ hardcoded vibe + palette chips? Có thể giữ song song: chips = quick select, Design Intelligence = full engine.

---

## Build Order

```
Step 1  Banner Server — deploy FastAPI + BM25 engine + CSV data
Step 2  Verify — test API endpoints trả đúng data
Step 3  gemini-client.ts — thêm sendToGeminiWithTools() + tool-use loop
Step 4  service-worker.ts — route dựa flag useDesignTools
Step 5  SkillsPanel.tsx — thêm Design Intelligence toggle
Step 6  E2E test — full flow: annotation → tool loop → design system → image generation
Step 7  Verify Gemini tool_use + image gen compatibility
```

---

## Scope không thay đổi

- **BM25 engine**: giữ nguyên 100% — chạy trên Banner Server
- **CSV data**: giữ nguyên 100%
- **Brand memory format**: giữ nguyên `.md` files
- **Extension UI**: giữ nguyên canvas, annotation, result panel
- **Proxy server (api.anta...)**: không sửa
