import { useState, useEffect, useRef, useCallback } from 'react';
import type { Editor, TLShapeId } from 'tldraw';
import { CanvasEditor } from './components/CanvasEditor';
import { Toolbar } from './components/Toolbar';
import { ResultPanel } from './components/ResultPanel';
import { insertImageToCanvas, exportCanvasAsBase64, compressImage, copyCanvasToClipboard } from '../core/image-utils';
import { parseAnnotations } from '../core/annotation-parser';
import { buildPrompt } from '../core/prompt-builder';
import { getApiKey, setApiKey } from '../config/api-config';
import type { ImageMeta } from '../core/types';

export function App() {
  const editorRef = useRef<Editor | null>(null);
  const [imageMeta, setImageMeta] = useState<ImageMeta | null>(null);
  const [imageShapeId, setImageShapeId] = useState<TLShapeId | null>(null);
  const [aiResponse, setAiResponse] = useState<string | null>(null);
  const [aiImages, setAiImages] = useState<string[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [hasSelection, setHasSelection] = useState(false);

  // Check API key on mount
  useEffect(() => {
    getApiKey().then((key) => {
      setHasApiKey(!!key);
      if (key) setApiKeyInput(key);
    });
  }, []);

  // Load image from URL (fetches via service worker to bypass CORS)
  const loadImageFromUrl = useCallback(
    async (srcUrl: string) => {
      if (!editorRef.current) return;

      try {
        // Fetch image via service worker (bypass CORS)
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

        // Create blob for insertImageToCanvas
        const byteChars = atob(base64);
        const byteArray = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) {
          byteArray[i] = byteChars.charCodeAt(i);
        }
        const blob = new Blob([byteArray], { type: mimeType });

        setImageMeta({ sourceUrl: srcUrl, objectUrl: dataUrl, base64 });

        const shapeId = await insertImageToCanvas(
          editorRef.current,
          dataUrl,
          blob
        );
        setImageShapeId(shapeId);
      } catch (err) {
        console.error('Failed to load image:', err);
      }
    },
    []
  );

  // Listen for messages from service worker
  useEffect(() => {
    const handleMessage = (message: any) => {
      if (message.type === 'IMAGE_FROM_CONTEXT_MENU') {
        loadImageFromUrl(message.payload.srcUrl);
      }
      if (message.type === 'IMAGE_CAPTURED') {
        // Data URL from tab capture — extract base64 and load
        const base64 = message.dataUrl.split(',')[1];
        const blob = new Blob(
          [Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))],
          { type: 'image/jpeg' }
        );
        setImageMeta({ sourceUrl: 'tab-capture', objectUrl: message.dataUrl, base64 });
        if (editorRef.current) {
          insertImageToCanvas(editorRef.current, message.dataUrl, blob).then(setImageShapeId);
        }
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, [loadImageFromUrl]);

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

  const handleEditorReady = useCallback((editor: Editor) => {
    editorRef.current = editor;

    // Track selection changes to show/hide delete button
    const unsub = editor.store.listen(
      () => {
        const selectedIds = editor.getSelectedShapeIds();
        setHasSelection(selectedIds.length > 0);
      },
      { source: 'user', scope: 'session' }
    );

    return () => unsub();
  }, []);

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

          // Read as data URL for tldraw compatibility
          const dataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(compressed);
          });

          setImageMeta({ sourceUrl: 'clipboard', objectUrl: dataUrl });

          if (editorRef.current) {
            const shapeId = await insertImageToCanvas(
              editorRef.current,
              dataUrl,
              compressed
            );
            setImageShapeId(shapeId);
          }
          break;
        }
      }
    },
    []
  );

  useEffect(() => {
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  const doSend = useCallback(async (target: 'SEND_TO_AI' | 'SEND_TO_GEMINI') => {
    if (!editorRef.current || !imageShapeId || !imageMeta) return;

    setLoading(true);
    setAiResponse(null);
    setAiImages([]);
    setAiError(null);

    try {
      const annotations = parseAnnotations(editorRef.current, imageShapeId);
      const prompt = buildPrompt(annotations, instruction || undefined);
      const annotatedImage = await exportCanvasAsBase64(editorRef.current);

      let originalImage = imageMeta.base64 || '';
      if (!originalImage && imageMeta.objectUrl) {
        originalImage = imageMeta.objectUrl.split(',')[1] || '';
      }

      const response = await chrome.runtime.sendMessage({
        type: target,
        payload: { originalImage, annotatedImage, prompt },
      });

      if (response.type === 'AI_RESPONSE') {
        if (response.payload.text) setAiResponse(response.payload.text);
        if (response.payload.images?.length) setAiImages(response.payload.images);
      } else if (response.type === 'AI_ERROR') {
        setAiError(response.payload.error);
      }
    } catch (err: any) {
      setAiError(err.message || 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [imageShapeId, imageMeta, instruction]);

  const handleSend = useCallback(() => doSend('SEND_TO_AI'), [doSend]);
  const handleSendGemini = useCallback(() => doSend('SEND_TO_GEMINI'), [doSend]);

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
    const selectedIds = editor.getSelectedShapeIds();
    if (selectedIds.length === 0) return;

    // Check if the tracked image shape is being deleted
    if (imageShapeId && selectedIds.includes(imageShapeId)) {
      setImageShapeId(null);
      setImageMeta(null);
    }

    editor.deleteShapes(selectedIds);
  }, [imageShapeId]);

  const handleClearImage = useCallback(() => {
    if (!editorRef.current) return;
    const editor = editorRef.current;
    // Delete all shapes on canvas
    const allIds = [...editor.getCurrentPageShapeIds()];
    editor.deleteShapes(allIds);
    setImageShapeId(null);
    setImageMeta(null);
    setAiResponse(null);
    setAiImages([]);
    setAiError(null);
  }, []);

  const handleSaveApiKey = useCallback(async () => {
    await setApiKey(apiKeyInput);
    setHasApiKey(true);
    setShowSettings(false);
  }, [apiKeyInput]);

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

  return (
    <div className="app-container">
      <Toolbar
        hasApiKey={hasApiKey}
        hasImage={!!imageMeta}
        hasSelection={hasSelection}
        onCapture={handleCapture}
        onClearImage={handleClearImage}
        onDeleteSelected={handleDeleteSelected}
        onSettings={() => setShowSettings(!showSettings)}
        onCopyImage={handleCopyImage}
        copyStatus={copyStatus}
      />

      {!hasApiKey && (
        <div className="api-key-bar">
          <svg className="key-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
          </svg>
          <input
            type="password"
            placeholder="Paste API key to get started..."
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && apiKeyInput.trim()) {
                handleSaveApiKey();
              }
            }}
          />
          <button onClick={handleSaveApiKey} disabled={!apiKeyInput.trim()}>
            Save
          </button>
        </div>
      )}

      {showSettings && hasApiKey && (
        <div className="api-key-bar">
          <svg className="key-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
          </svg>
          <input
            type="password"
            placeholder="Update API key..."
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && apiKeyInput.trim()) {
                handleSaveApiKey();
              }
            }}
          />
          <button onClick={handleSaveApiKey} disabled={!apiKeyInput.trim()}>
            Update
          </button>
        </div>
      )}

      <div className="canvas-container">
        <CanvasEditor onEditorReady={handleEditorReady} />
      </div>

      <div className="bottom-bar">
        <div className="input-wrapper">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <input
            type="text"
            placeholder="Describe what to change..."
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                handleSend();
              }
            }}
          />
        </div>
        <button
          className={`gemini-btn ${loading ? 'loading' : ''}`}
          onClick={handleSendGemini}
          disabled={!imageMeta || loading}
          title={!imageMeta ? 'Load an image first' : 'Send to Gemini (uses browser cookies)'}
        >
          {loading ? '' : (
            <>
              <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" fill="url(#gemGrad)" opacity="0.15"/>
                <path d="M12 2v20M2 12h20M5.64 5.64l12.73 12.73M18.36 5.64L5.64 18.36" stroke="url(#gemGrad)" strokeWidth="1.5"/>
                <defs><linearGradient id="gemGrad" x1="0" y1="0" x2="24" y2="24"><stop stopColor="#4285F4"/><stop offset="1" stopColor="#A855F7"/></linearGradient></defs>
              </svg>
              Gemini
            </>
          )}
        </button>
        <button
          className={`send-btn ${loading ? 'loading' : ''}`}
          onClick={handleSend}
          disabled={!imageMeta || !hasApiKey || loading}
          title={
            !hasApiKey
              ? 'Set API key first'
              : !imageMeta
                ? 'Load an image first (right-click or paste)'
                : 'Send to AI (⌘↵)'
          }
        >
          {loading ? '' : (
            <>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
              Send
            </>
          )}
        </button>
      </div>

      {(loading || aiResponse || aiImages.length > 0 || aiError) && (
        <ResultPanel
          loading={loading}
          response={aiResponse}
          images={aiImages}
          error={aiError}
        />
      )}
    </div>
  );
}
