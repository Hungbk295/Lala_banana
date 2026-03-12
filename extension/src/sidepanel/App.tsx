import { useState, useEffect, useRef, useCallback } from 'react';
import type { Editor, TLShapeId, TLPageId } from 'tldraw';
import { CanvasEditor } from './components/CanvasEditor';
import { Toolbar } from './components/Toolbar';
import { PageTabs } from './components/PageTabs';
import { ResultPanel } from './components/ResultPanel';
import { SkillsPanel, buildSkillContext } from './components/SkillsPanel';
import type { SkillsConfig } from './components/SkillsPanel';
import { insertImageToCanvas, exportCanvasAsBase64, compressImage, compressBase64ForAPI, copyCanvasToClipboard } from '../core/image-utils';
import { parseAnnotations } from '../core/annotation-parser';
import { buildPrompt } from '../core/prompt-builder';
import type { ImageMeta, AIResponsePart } from '../core/types';

interface PageInfo {
  id: TLPageId;
  name: string;
}

interface PageState {
  imageMeta: ImageMeta | null;
  imageShapeId: TLShapeId | null;
  responseParts: AIResponsePart[];
  aiError: string | null;
  loading: boolean;
  instruction: string;
  skills: SkillsConfig;
}

const defaultSkills = (): SkillsConfig => ({
  promptTemplate: 'none',
  colorTemplate: 'none',
});

const defaultPageState = (): PageState => ({
  imageMeta: null,
  imageShapeId: null,
  responseParts: [],
  aiError: null,
  loading: false,
  instruction: '',
  skills: defaultSkills(),
});

export function App() {
  const editorRef = useRef<Editor | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [hasSelection, setHasSelection] = useState(false);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [currentPageId, setCurrentPageId] = useState<TLPageId>('' as TLPageId);
  const [skillsOpen, setSkillsOpen] = useState(false);

  // Per-page state
  const [pageStates, setPageStates] = useState<Record<string, PageState>>({});

  const getPageState = useCallback((pageId: TLPageId): PageState => {
    return pageStates[pageId] || defaultPageState();
  }, [pageStates]);

  const updatePageState = useCallback((pageId: TLPageId, update: Partial<PageState>) => {
    setPageStates((prev) => ({
      ...prev,
      [pageId]: { ...(prev[pageId] || defaultPageState()), ...update },
    }));
  }, []);

  const currentState = getPageState(currentPageId);

  // Load image from URL (fetches via service worker to bypass CORS)
  const loadImageFromUrl = useCallback(
    async (srcUrl: string) => {
      if (!editorRef.current) return;
      const editor = editorRef.current;
      const pageId = editor.getCurrentPageId();

      try {
        const response = await new Promise<{ base64: string; mimeType: string }>((resolve, reject) => {
          chrome.runtime.sendMessage(
            { type: 'FETCH_IMAGE', payload: { url: srcUrl } },
            (resp) => {
              if (resp?.error) reject(new Error(resp.error));
              else resolve(resp);
            }
          );
        });

        const { base64, mimeType } = response;
        const dataUrl = `data:${mimeType};base64,${base64}`;

        const byteChars = atob(base64);
        const byteArray = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) {
          byteArray[i] = byteChars.charCodeAt(i);
        }
        const blob = new Blob([byteArray], { type: mimeType });

        const imageMeta = { sourceUrl: srcUrl, objectUrl: dataUrl, base64 };
        const shapeId = await insertImageToCanvas(editor, dataUrl, blob);
        updatePageState(pageId, { imageMeta, imageShapeId: shapeId });
      } catch (err) {
        console.error('Failed to load image:', err);
      }
    },
    [updatePageState]
  );

  // Listen for messages from service worker
  useEffect(() => {
    const handleMessage = (message: any) => {
      if (message.type === 'IMAGE_FROM_CONTEXT_MENU') {
        loadImageFromUrl(message.payload.srcUrl);
      }
      if (message.type === 'IMAGE_CAPTURED') {
        if (!editorRef.current) return;
        const pageId = editorRef.current.getCurrentPageId();
        const base64 = message.dataUrl.split(',')[1];
        const blob = new Blob(
          [Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))],
          { type: 'image/jpeg' }
        );
        const imageMeta = { sourceUrl: 'tab-capture', objectUrl: message.dataUrl, base64 };
        updatePageState(pageId, { imageMeta });
        insertImageToCanvas(editorRef.current, message.dataUrl, blob).then((shapeId) => {
          updatePageState(pageId, { imageShapeId: shapeId });
        });
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, [loadImageFromUrl, updatePageState]);

  // Check pending image from storage on mount (handshake pattern)
  useEffect(() => {
    async function checkPendingImage() {
      const result = await chrome.storage.session.get('pendingImage');
      if (result.pendingImage) {
        const pending = result.pendingImage as { srcUrl: string; timestamp: number };
        if (Date.now() - pending.timestamp < 10000) {
          loadImageFromUrl(pending.srcUrl);
        }
        await chrome.storage.session.remove('pendingImage');
      }
    }
    checkPendingImage();
  }, [loadImageFromUrl]);

  const syncPages = useCallback((editor: Editor) => {
    const editorPages = editor.getPages();
    setPages(editorPages.map((p) => ({ id: p.id, name: p.name })));
    setCurrentPageId(editor.getCurrentPageId());
  }, []);

  const handleEditorReady = useCallback((editor: Editor) => {
    editorRef.current = editor;

    syncPages(editor);

    const unsub = editor.store.listen(
      () => {
        const selectedIds = editor.getSelectedShapeIds();
        setHasSelection(selectedIds.length > 0);
        syncPages(editor);
      },
      { source: 'user', scope: 'session' }
    );

    return () => unsub();
  }, [syncPages]);

  const handlePaste = useCallback(
    async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) continue;

          const compressed = await compressImage(blob, {
            maxWidth: 1920,
            maxHeight: 1080,
            quality: 0.85,
          });

          const dataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(compressed);
          });

          if (editorRef.current) {
            const pageId = editorRef.current.getCurrentPageId();
            const imageMeta = { sourceUrl: 'clipboard', objectUrl: dataUrl };
            const shapeId = await insertImageToCanvas(editorRef.current, dataUrl, compressed);
            updatePageState(pageId, { imageMeta, imageShapeId: shapeId });
          }
          break;
        }
      }
    },
    [updatePageState]
  );

  useEffect(() => {
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  // Send to Gemini via proxy — uses current page's state
  const handleSend = useCallback(async () => {
    if (!editorRef.current) return;
    const editor = editorRef.current;
    const pageId = editor.getCurrentPageId();
    const ps = pageStates[pageId] || defaultPageState();

    // Allow send if page has any shapes (image shapes auto-detected)
    const hasShapes = editor.getCurrentPageShapeIds().size > 0;
    if (!hasShapes) return;

    // Auto-detect image shape if not tracked
    let imageShapeId = ps.imageShapeId;
    let imageMeta = ps.imageMeta;
    if (!imageShapeId || !imageMeta) {
      const imageShape = editor.getCurrentPageShapes().find((s) => s.type === 'image');
      if (!imageShape) return;
      imageShapeId = imageShape.id;
      // Extract base64 from the asset
      const assetId = (imageShape.props as any).assetId;
      const asset = assetId ? editor.getAsset(assetId) : null;
      const src = (asset?.props as any)?.src || '';
      const base64 = src.startsWith('data:') ? src.split(',')[1] : '';
      imageMeta = { sourceUrl: 'duplicated', objectUrl: src, base64 };
      updatePageState(pageId, { imageShapeId, imageMeta });
    }

    updatePageState(pageId, { loading: true, responseParts: [], aiError: null });

    try {
      const annotations = parseAnnotations(editor, imageShapeId);

      // Build skill context
      const skillContext = buildSkillContext(ps.skills);
      const userInstruction = [ps.instruction, skillContext].filter(Boolean).join('\n') || undefined;

      const prompt = buildPrompt(annotations, userInstruction);
      const annotatedImage = await exportCanvasAsBase64(editor);

      let originalImage = imageMeta.base64 || '';
      if (!originalImage && imageMeta.objectUrl) {
        originalImage = imageMeta.objectUrl.split(',')[1] || '';
      }

      // Compress images to avoid "content too large" API error
      const [compressedOriginal, compressedAnnotated] = await Promise.all([
        compressBase64ForAPI(originalImage, 'image/jpeg'),
        compressBase64ForAPI(annotatedImage, 'image/png'),
      ]);

      const response = await new Promise<any>((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'SEND_TO_GEMINI', payload: { originalImage: compressedOriginal, annotatedImage: compressedAnnotated, prompt } },
          resolve
        );
      });

      if (response.type === 'GEMINI_RESPONSE') {
        updatePageState(pageId, { responseParts: response.payload.parts, loading: false });
      } else if (response.type === 'AI_ERROR') {
        updatePageState(pageId, { aiError: response.payload.error, loading: false });
      }
    } catch (err: any) {
      updatePageState(pageId, { aiError: err.message || 'Unknown error', loading: false });
    }
  }, [pageStates, updatePageState]);

  // Load response image to canvas
  const handleLoadResponseImage = useCallback(async (base64: string, mimeType: string) => {
    if (!editorRef.current) return;
    const editor = editorRef.current;
    const pageId = editor.getCurrentPageId();

    const byteChars = atob(base64);
    const byteArray = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
      byteArray[i] = byteChars.charCodeAt(i);
    }
    const blob = new Blob([byteArray], { type: mimeType });
    const dataUrl = `data:${mimeType};base64,${base64}`;

    const imageMeta = { sourceUrl: 'gemini-response', objectUrl: dataUrl, base64 };
    const shapeId = await insertImageToCanvas(editor, dataUrl, blob);
    updatePageState(pageId, { imageMeta, imageShapeId: shapeId });
  }, [updatePageState]);

  const handleCopyImage = useCallback(async () => {
    if (!editorRef.current) return;
    try {
      await copyCanvasToClipboard(editorRef.current);
      setCopyStatus('copied');
      setTimeout(() => setCopyStatus('idle'), 2000);
    } catch {
      setCopyStatus('error');
      setTimeout(() => setCopyStatus('idle'), 2000);
    }
  }, []);

  const handleCapture = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' });
  }, []);

  const handleDeleteSelected = useCallback(() => {
    if (!editorRef.current) return;
    const editor = editorRef.current;
    const pageId = editor.getCurrentPageId();
    const selectedIds = editor.getSelectedShapeIds();
    if (selectedIds.length === 0) return;

    const ps = pageStates[pageId] || defaultPageState();
    if (ps.imageShapeId && selectedIds.includes(ps.imageShapeId)) {
      updatePageState(pageId, { imageShapeId: null, imageMeta: null });
    }

    editor.deleteShapes(selectedIds);
  }, [pageStates, updatePageState]);

  const handleDuplicateToNewPage = useCallback(() => {
    if (!editorRef.current) return;
    const editor = editorRef.current;
    const selectedIds = editor.getSelectedShapeIds();
    if (selectedIds.length === 0) return;

    const sourcePageId = editor.getCurrentPageId();
    const sourceState = pageStates[sourcePageId] || defaultPageState();
    const pageCount = editor.getPages().length;
    const newPageName = `Page ${pageCount + 1}`;

    // Check if we're duplicating the image shape
    const duplicatingImage = sourceState.imageShapeId && selectedIds.includes(sourceState.imageShapeId);

    editor.run(() => {
      editor.markHistoryStoppingPoint('duplicate_to_new_page');
      editor.duplicateShapes(selectedIds);
      const duplicatedIds = editor.getSelectedShapeIds();
      editor.createPage({ name: newPageName });
      const newPageId = editor.getPages()[pageCount].id;
      editor.moveShapesToPage(duplicatedIds, newPageId);

      // Carry over imageMeta to new page if image was duplicated
      if (duplicatingImage && sourceState.imageMeta) {
        // Find the image shape on the new page
        const newPageShapes = editor.getCurrentPageShapes();
        const newImageShape = newPageShapes.find((s) => s.type === 'image');
        if (newImageShape) {
          updatePageState(newPageId, {
            imageMeta: { ...sourceState.imageMeta },
            imageShapeId: newImageShape.id,
          });
        }
      }
    });

    syncPages(editor);
  }, [syncPages, pageStates, updatePageState]);

  const handlePageSelect = useCallback((pageId: TLPageId) => {
    if (!editorRef.current) return;
    editorRef.current.setCurrentPage(pageId);
    setCurrentPageId(pageId);
  }, []);

  const handleClearImage = useCallback(() => {
    if (!editorRef.current) return;
    const editor = editorRef.current;
    const pageId = editor.getCurrentPageId();
    const allIds = [...editor.getCurrentPageShapeIds()];
    editor.deleteShapes(allIds);
    updatePageState(pageId, {
      imageShapeId: null,
      imageMeta: null,
      responseParts: [],
      aiError: null,
    });
  }, [updatePageState]);

  const handleInstructionChange = useCallback((value: string) => {
    updatePageState(currentPageId, { instruction: value });
  }, [currentPageId, updatePageState]);

  const handleSkillsChange = useCallback((skills: SkillsConfig) => {
    updatePageState(currentPageId, { skills });
  }, [currentPageId, updatePageState]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSend();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSend]);

  // Determine if send should be enabled: has shapes on current page
  const hasContent = !!currentState.imageMeta || (editorRef.current?.getCurrentPageShapeIds().size ?? 0) > 0;
  const hasActiveSkills = currentState.skills.promptTemplate !== 'none' || currentState.skills.colorTemplate !== 'none';

  return (
    <div className="app-container">
      <Toolbar
        hasImage={!!currentState.imageMeta || hasContent}
        hasSelection={hasSelection}
        onCapture={handleCapture}
        onClearImage={handleClearImage}
        onDeleteSelected={handleDeleteSelected}
        onCopyImage={handleCopyImage}
        onDuplicateToNewPage={handleDuplicateToNewPage}
        copyStatus={copyStatus}
      />

      <PageTabs
        pages={pages}
        currentPageId={currentPageId}
        onPageSelect={handlePageSelect}
      />

      <div className="canvas-container">
        <CanvasEditor onEditorReady={handleEditorReady} />
      </div>

      <SkillsPanel
        open={skillsOpen}
        config={currentState.skills}
        onChange={handleSkillsChange}
        onClose={() => setSkillsOpen(false)}
      />

      <div className="bottom-bar">
        <div className="input-wrapper">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <input
            type="text"
            placeholder="Describe what to change..."
            value={currentState.instruction}
            onChange={(e) => handleInstructionChange(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                handleSend();
              }
            }}
          />
        </div>
        <button
          className={`send-btn ${currentState.loading ? 'loading' : ''}`}
          onClick={handleSend}
          disabled={currentState.loading}
          title="Send to AI (⌘↵)"
        >
          {currentState.loading ? '' : (
            <>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
              Send
            </>
          )}
        </button>
        <button
          className={`skills-trigger ${skillsOpen ? 'active' : ''} ${hasActiveSkills ? 'has-skills' : ''}`}
          onClick={() => setSkillsOpen(!skillsOpen)}
          title="Skills"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 4V2" />
            <path d="M15 16v-2" />
            <path d="M8 9h2" />
            <path d="M20 9h2" />
            <path d="M17.8 11.8L19 13" />
            <path d="M15 9h.01" />
            <path d="M17.8 6.2L19 5" />
            <path d="M12.2 6.2L11 5" />
            <path d="M12.2 11.8L11 13" />
            <path d="M2 21l7-7" />
            <path d="M9 14l-2.586 2.586a2 2 0 1 1-2.828-2.828L6.172 11.172" />
          </svg>
        </button>
      </div>

      {(currentState.loading || currentState.responseParts.length > 0 || currentState.aiError) && (
        <ResultPanel
          loading={currentState.loading}
          responseParts={currentState.responseParts}
          error={currentState.aiError}
          onLoadImage={handleLoadResponseImage}
        />
      )}
    </div>
  );
}
