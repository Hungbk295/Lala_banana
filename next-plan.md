# Next Plan

## Trạng thái hiện tại

### Đã làm
- ImageContext: lưu conversation history (text-only) per page
- History carry qua khi duplicate to new page
- History inject vào prompt để AI có context các lần edit trước
- trimHistory giới hạn 10 entries (5 turns), giữ turn đầu + gần nhất

### Chưa làm (backlog)
- Gửi ảnh gốc (generation 0) kèm mỗi request để AI so sánh visual diff
- Multi-turn conversation thực sự với ảnh (nặng, cân nhắc sau)

---

## Feature tiếp theo: Session Persistence

### Bài toán
Khi user đóng side panel hoặc đóng browser → mở lại, toàn bộ state mất:
- Canvas shapes (ảnh, annotation)
- Page states (imageMeta, imageContext, instruction, skills)
- Response history

Cần lưu session để user quay lại làm việc tiếp.

### Storage choice: `chrome.storage.local`

| Option | Quota | Persist | Ghi chú |
|--------|-------|---------|---------|
| `chrome.storage.session` | 10MB | Mất khi đóng browser | Không đủ |
| `chrome.storage.local` | 10MB (hoặc unlimited) | Persist vĩnh viễn | Phù hợp |
| `localStorage` | 5-10MB | Persist nhưng scoped per origin | Không dùng được cross-context |
| `IndexedDB` | Unlimited | Persist | Tốt cho dữ liệu lớn (ảnh) |

**Khuyến nghị:** `chrome.storage.local` cho metadata + `IndexedDB` cho image blobs nếu cần.

Thêm `"unlimitedStorage"` vào `manifest.json` permissions để bỏ giới hạn 10MB.

### Dữ liệu cần lưu

```
Session {
  // tldraw canvas state — serialized store snapshot
  tldrawSnapshot: TLStoreSnapshot;

  // App-level state per page
  pageStates: Record<pageId, {
    imageMeta: ImageMeta | null;
    imageShapeId: string | null;
    imageContext: ImageContext;
    instruction: string;
    skills: SkillsConfig;
    responseParts: AIResponsePart[];  // để hiện lại response panel
  }>;

  // Metadata
  currentPageId: string;
  savedAt: number;
}
```

### Vấn đề kích thước

- tldraw snapshot chứa asset data (base64 images) → có thể rất lớn
- 1 ảnh compressed ~200-500KB base64
- 5 pages x 2 ảnh = ~2-5MB
- `chrome.storage.local` với `unlimitedStorage` → OK
- Nếu không muốn `unlimitedStorage`: tách image data ra IndexedDB

### Chiến lược lưu/restore

#### Khi nào lưu (auto-save)
- Debounced save sau mỗi thay đổi quan trọng:
  - Sau khi nhận AI response
  - Sau khi load image to canvas
  - Sau khi duplicate page
  - Khi side panel `beforeunload` / `visibilitychange`
- Debounce 2-3 giây để tránh write quá nhiều
- KHÔNG save trên mỗi mouse move / shape drag (quá thường xuyên)

#### Khi nào restore
- Side panel mount (`App.tsx useEffect[]`)
- Check `chrome.storage.local` cho session data
- Nếu có → restore tldraw snapshot + pageStates
- Nếu không → start fresh

### Implementation plan

#### Step 1: Serialize/Deserialize tldraw store

```typescript
// core/session.ts

import type { Editor } from 'tldraw';

interface SessionData {
  tldrawSnapshot: any;  // editor.store.getStoreSnapshot()
  pageStates: Record<string, PageState>;
  currentPageId: string;
  savedAt: number;
}

export function serializeSession(editor: Editor, pageStates, currentPageId): SessionData {
  return {
    tldrawSnapshot: editor.store.getStoreSnapshot(),
    pageStates: sanitizePageStates(pageStates),  // remove non-serializable fields
    currentPageId,
    savedAt: Date.now(),
  };
}

export function sanitizePageStates(states): Record<string, any> {
  // Remove objectUrl (blob URLs invalid after reload)
  // Keep base64, sourceUrl, imageContext, instruction, skills, responseParts
  const clean = {};
  for (const [pageId, state] of Object.entries(states)) {
    clean[pageId] = {
      ...state,
      loading: false,
      aiError: null,
      imageMeta: state.imageMeta ? {
        sourceUrl: state.imageMeta.sourceUrl,
        objectUrl: '',  // will be reconstructed from base64
        base64: state.imageMeta.base64,
      } : null,
    };
  }
  return clean;
}
```

#### Step 2: Save logic (debounced)

```typescript
// Trong App.tsx

const saveSession = useCallback(
  debounce(() => {
    if (!editorRef.current) return;
    const data = serializeSession(editorRef.current, pageStates, currentPageId);
    chrome.storage.local.set({ session: data });
  }, 3000),
  [pageStates, currentPageId]
);

// Trigger save sau các action quan trọng
// Option A: gọi saveSession() manual sau handleSend, handleLoadResponseImage, etc.
// Option B: useEffect watch pageStates changes → auto save (simpler)

useEffect(() => {
  saveSession();
}, [pageStates, currentPageId]);

// Save on unload
useEffect(() => {
  const handleUnload = () => {
    if (!editorRef.current) return;
    const data = serializeSession(editorRef.current, pageStates, currentPageId);
    // Sync write — beforeunload cannot be async
    chrome.storage.local.set({ session: data });
  };
  window.addEventListener('beforeunload', handleUnload);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') handleUnload();
  });
  return () => window.removeEventListener('beforeunload', handleUnload);
}, [pageStates, currentPageId]);
```

#### Step 3: Restore logic

```typescript
// Trong App.tsx — handleEditorReady hoặc useEffect riêng

async function restoreSession(editor: Editor) {
  const result = await chrome.storage.local.get('session');
  if (!result.session) return false;

  const session: SessionData = result.session;

  // Kiểm tra session không quá cũ (ví dụ < 7 ngày)
  if (Date.now() - session.savedAt > 7 * 24 * 60 * 60 * 1000) {
    await chrome.storage.local.remove('session');
    return false;
  }

  // Restore tldraw store
  editor.store.loadStoreSnapshot(session.tldrawSnapshot);

  // Restore page states
  // Reconstruct objectUrl from base64 for imageMeta
  const restoredStates = {};
  for (const [pageId, state] of Object.entries(session.pageStates)) {
    restoredStates[pageId] = {
      ...state,
      imageMeta: state.imageMeta?.base64 ? {
        ...state.imageMeta,
        objectUrl: `data:image/jpeg;base64,${state.imageMeta.base64}`,
      } : state.imageMeta,
    };
  }
  setPageStates(restoredStates);

  // Navigate to saved page
  if (session.currentPageId) {
    editor.setCurrentPage(session.currentPageId);
    setCurrentPageId(session.currentPageId);
  }

  return true;
}
```

#### Step 4: Clear session

```typescript
// Thêm button "New Session" hoặc tự clear khi user bấm Clear All
async function clearSession() {
  await chrome.storage.local.remove('session');
}
```

#### Step 5: manifest.json

```json
{
  "permissions": [
    "activeTab",
    "storage",
    "unlimitedStorage",  // ← thêm
    "sidePanel",
    "contextMenus"
  ]
}
```

### Edge cases cần xử lý

| Case | Xử lý |
|------|--------|
| Session quá cũ (> 7 ngày) | Auto clear, start fresh |
| Storage quota exceeded | Catch error, xóa responseParts (lớn nhất) rồi retry |
| tldraw version upgrade làm snapshot incompatible | Wrap restore trong try/catch, start fresh nếu fail |
| User mở extension trên 2 tab cùng lúc | Mỗi tab save/restore độc lập? Hoặc last-write-wins |
| Restore xong user right-click ảnh mới | Ảnh mới load bình thường, overwrite page state |
| base64 quá lớn cho storage | Nén ảnh trước khi lưu (reuse compressBase64ForAPI) |
| Side panel re-render nhưng không phải fresh open | Check flag `sessionRestored` để tránh restore lặp |

### Thứ tự implement

1. Tạo `core/session.ts` — serialize/deserialize/sanitize functions
2. Thêm `unlimitedStorage` vào manifest
3. Thêm restore logic vào `handleEditorReady`
4. Thêm debounced auto-save vào `App.tsx`
5. Thêm `beforeunload` / `visibilitychange` save
6. Thêm clear session khi "Clear All" hoặc "New Session"
7. Test: mở → load ảnh → annotate → send → đóng → mở lại → verify state
