# Next Plan — AI Annotation Extension Enhancement

> Last updated: 2026-03-13

---

## Research Insights (from competitive analysis)

- Google built markup tools directly into Gemini (late 2025) — proves demand
- No Chrome extension bridges annotation → AI vision API — real gap in market
- Pi Annotate (GitHub) is closest competitor but focuses on bug reporting, not AI image editing
- Structured prompts achieve 94.2% success rate on Gemini vs lower for free-text — validates annotation parser
- Crop region + full image is industry standard (Adobe Firefly, Pi Annotate)
- AI image quality degrades after multiple iteration rounds — fewer iterations = better results
- Users complain about subscription fatigue — BYOK (bring your own key) model is a strength

### Key sources
- Adobe Firefly Generative Fill — brush mask + multi-option output
- Google Gemini Markup Tools (late 2025) — native annotation-to-AI
- Pi Annotate (GitHub) — per-element crops, numbered annotations
- Marker.io — auto-metadata, AI Magic Rewrite, 2-way sync
- BugHerd — pin-comment model, zero ambiguity feedback
- Ziflow — version comparison, before/after slider
- CHI 2024 PromptCharm — multi-modal prompting research validation

---

## Enhancement Roadmap

### Phase 1 — Week 1: Core UX Improvements

#### 1. Integrate Crop Highlight into Send Flow
- **Status:** Code exists (`cropHighlightRegion()`) but NOT called in send flow
- **What:** When user draws rectangle highlight → crop that region → send alongside full image + cropped region
- **Why:** Adobe Firefly & Pi Annotate both validate this pattern. Reduces iteration rounds.
- **Impact: HIGH** | **Effort: LOW** (code already exists)

#### 2. Before/After Comparison
- **What:** When AI returns a new image, show slider overlay or side-by-side with original
- **Why:** Ziflow, Adobe Firefly both have this. Users need fast result evaluation.
- **Impact: HIGH** | **Effort: MEDIUM**

### Phase 2 — Week 2: Annotation UX

#### 3. Pin-Comment Mode
- **What:** Click a point on image → popup to type instruction right there
- **Why:** BugHerd "point, click, pin" model. Much simpler than draw rectangle + draw text separately
- **Impact: HIGH** | **Effort: MEDIUM**

#### 4. Auto-number Annotations
- **What:** Each annotation gets a numbered badge (1, 2, 3...) on canvas. Prompt references by number.
- **Why:** Every major feedback tool does this (Marker.io, Pi Annotate, BugHerd)
- **Impact: MEDIUM** | **Effort: LOW**

### Phase 3 — Week 3: AI Intelligence

#### 5. Re-generation Prompt Suggestion
- **What:** AI response includes a ready-to-paste prompt for Gemini to regenerate the image better
- **Why:** Closes the feedback loop. Unique value proposition — no other tool does this.
- **Impact: HIGH** | **Effort: LOW** (prompt engineering)

#### 6. Brush Mask Tool
- **What:** Let user "paint" the region to edit instead of only rectangles
- **Why:** Adobe Firefly generative fill gold standard. Irregular regions can't be covered by rectangles.
- **Impact: HIGH** | **Effort: HIGH** (custom tldraw tool or canvas overlay)

### Phase 4 — Week 4: Platform & Polish

#### 7. Multi-AI Support
- **What:** Add Claude Vision, GPT-4o alongside Gemini. User selects in settings.
- **Why:** Differentiator vs Google's built-in markup (Gemini-only)
- **Impact: MEDIUM** | **Effort: MEDIUM**

#### 8. Export to AI Chat
- **What:** Button "Open in Gemini" → opens tab with pre-built prompt. Or copy to clipboard for any AI.
- **Impact: MEDIUM** | **Effort: LOW**

#### 9. Quick Actions (No-annotation)
- **What:** Buttons: "Remove background", "Upscale", "Change style to..." — 1-click, no annotation needed
- **Impact: MEDIUM** | **Effort: MEDIUM**

#### 10. Auto-metadata Context
- **What:** Auto-capture source URL, page title, image dimensions, original prompt (if from Gemini)
- **Why:** Marker.io validates this — context users forget to provide
- **Impact: LOW-MEDIUM** | **Effort: LOW**

---

## Existing Backlog: Session Persistence

### Bài toán
Khi user đóng side panel hoặc đóng browser → mở lại, toàn bộ state mất:
- Canvas shapes (ảnh, annotation)
- Page states (imageMeta, imageContext, instruction, skills)
- Response history

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
  tldrawSnapshot: TLStoreSnapshot;
  pageStates: Record<pageId, {
    imageMeta: ImageMeta | null;
    imageShapeId: string | null;
    imageContext: ImageContext;
    instruction: string;
    skills: SkillsConfig;
    responseParts: AIResponsePart[];
  }>;
  currentPageId: string;
  savedAt: number;
}
```

### Implementation plan

#### Step 1: Serialize/Deserialize tldraw store

```typescript
// core/session.ts
interface SessionData {
  tldrawSnapshot: any;
  pageStates: Record<string, PageState>;
  currentPageId: string;
  savedAt: number;
}

export function serializeSession(editor, pageStates, currentPageId): SessionData {
  return {
    tldrawSnapshot: editor.store.getStoreSnapshot(),
    pageStates: sanitizePageStates(pageStates),
    currentPageId,
    savedAt: Date.now(),
  };
}
```

#### Step 2: Debounced auto-save in App.tsx

- Save after: AI response, load image, duplicate page, visibilitychange
- Debounce 3s to avoid excessive writes
- Sync save on beforeunload

#### Step 3: Restore on mount

- Check chrome.storage.local for session
- If < 7 days old → restore tldraw snapshot + pageStates
- Reconstruct objectUrl from base64

#### Step 4: Clear session on "New Session" or "Clear All"

### Edge cases

| Case | Xử lý |
|------|--------|
| Session > 7 days old | Auto clear, start fresh |
| Storage quota exceeded | Remove responseParts (largest), retry |
| tldraw version incompatible snapshot | try/catch, start fresh |
| 2 tabs open simultaneously | Last-write-wins |
| base64 too large | Compress before saving |

---

## Known Tech Debt (from SDD review)

- [ ] Hardcoded API key `sk-jc-key-1` in gemini-client.ts — move to chrome.storage.local
- [ ] Crop highlight function exists but not integrated into send flow
- [ ] No reconciliation when imageShapeId is invalidated by page mutations
- [ ] Page switch mid-async can desync state
- [ ] Prompt composition split across 4 files (SkillsPanel, App.tsx, prompt-builder, gemini-client)
- [ ] Test whether Gemini actually uses structured coordinates (A/B test)
