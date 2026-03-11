import { useState, useEffect, useRef, useCallback } from 'react';
import type { Editor, TLShapeId } from 'tldraw';
import { CanvasEditor } from './components/CanvasEditor';
import { Toolbar } from './components/Toolbar';
import { ResultPanel } from './components/ResultPanel';
import { insertImageToCanvas, exportCanvasAsBase64, compressImage, copyCanvasToClipboard } from '../core/image-utils';
import { parseAnnotations } from '../core/annotation-parser';
import { buildPrompt } from '../core/prompt-builder';
import type { ImageMeta, AIResponsePart } from '../core/types';

export function App() {
  const editorRef = useRef<Editor | null>(null);
  const [imageMeta, setImageMeta] = useState<ImageMeta | null>(null);
  const [imageShapeId, setImageShapeId] = useState<TLShapeId | null>(null);
  const [responseParts, setResponseParts] = useState<AIResponsePart[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [hasSelection, setHasSelection] = useState(false);

  // Load image from URL (fetches via service worker to bypass CORS)
  const loadImageFromUrl = useCallback(
    async (srcUrl: string) => {
      if (!editorRef.current) return;

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

        setImageMeta({ sourceUrl: srcUrl, objectUrl: dataUrl, base64 });

        const shapeId = await insertImageToCanvas(editorRef.current, dataUrl, blob);
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

          const dataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(compressed);
          });

          setImageMeta({ sourceUrl: 'clipboard', objectUrl: dataUrl });

          if (editorRef.current) {
            const shapeId = await insertImageToCanvas(editorRef.current, dataUrl, compressed);
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

  // Send to Gemini via proxy
  const handleSend = useCallback(async () => {
    if (!editorRef.current || !imageShapeId || !imageMeta) return;

    setLoading(true);
    setResponseParts([]);
    setAiError(null);

    try {
      const annotations = parseAnnotations(editorRef.current, imageShapeId);
      const prompt = buildPrompt(annotations, instruction || undefined);
      const annotatedImage = await exportCanvasAsBase64(editorRef.current);

      let originalImage = imageMeta.base64 || '';
      if (!originalImage && imageMeta.objectUrl) {
        originalImage = imageMeta.objectUrl.split(',')[1] || '';
      }

      const response = await new Promise<any>((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'SEND_TO_GEMINI', payload: { originalImage, annotatedImage, prompt } },
          resolve
        );
      });

      if (response.type === 'GEMINI_RESPONSE') {
        setResponseParts(response.payload.parts);
      } else if (response.type === 'AI_ERROR') {
        setAiError(response.payload.error);
      }
    } catch (err: any) {
      setAiError(err.message || 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [imageShapeId, imageMeta, instruction]);

  // Load response image to canvas
  const handleLoadResponseImage = useCallback(async (base64: string, mimeType: string) => {
    if (!editorRef.current) return;

    const byteChars = atob(base64);
    const byteArray = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
      byteArray[i] = byteChars.charCodeAt(i);
    }
    const blob = new Blob([byteArray], { type: mimeType });
    const dataUrl = `data:${mimeType};base64,${base64}`;

    setImageMeta({ sourceUrl: 'gemini-response', objectUrl: dataUrl, base64 });

    const shapeId = await insertImageToCanvas(editorRef.current, dataUrl, blob);
    setImageShapeId(shapeId);
  }, []);

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

    if (imageShapeId && selectedIds.includes(imageShapeId)) {
      setImageShapeId(null);
      setImageMeta(null);
    }

    editor.deleteShapes(selectedIds);
  }, [imageShapeId]);

  const handleClearImage = useCallback(() => {
    if (!editorRef.current) return;
    const editor = editorRef.current;
    const allIds = [...editor.getCurrentPageShapeIds()];
    editor.deleteShapes(allIds);
    setImageShapeId(null);
    setImageMeta(null);
    setResponseParts([]);
    setAiError(null);
  }, []);

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
        hasImage={!!imageMeta}
        hasSelection={hasSelection}
        onCapture={handleCapture}
        onClearImage={handleClearImage}
        onDeleteSelected={handleDeleteSelected}
        onCopyImage={handleCopyImage}
        copyStatus={copyStatus}
      />

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
          className={`send-btn ${loading ? 'loading' : ''}`}
          onClick={handleSend}
          disabled={!imageMeta || loading}
          title={
            !imageMeta
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

      {(loading || responseParts.length > 0 || aiError) && (
        <ResultPanel
          loading={loading}
          responseParts={responseParts}
          error={aiError}
          onLoadImage={handleLoadResponseImage}
        />
      )}
    </div>
  );
}
