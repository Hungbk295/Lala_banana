import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { Editor, TLShapeId } from 'tldraw';
import { CanvasEditor } from './components/CanvasEditor';
import { Toolbar } from './components/Toolbar';
import { ResultPanel } from './components/ResultPanel';
import { insertImageToCanvas, exportCanvasAsBase64, compressImage } from '../core/image-utils';
import { parseAnnotations } from '../core/annotation-parser';
import { buildPrompt } from '../core/prompt-builder';
import { getApiKey, setApiKey } from '../config/api-config';
import type { ImageMeta } from '../core/types';

export function App() {
  const editorRef = useRef<Editor | null>(null);
  const [imageMeta, setImageMeta] = useState<ImageMeta | null>(null);
  const [imageShapeId, setImageShapeId] = useState<TLShapeId | null>(null);
  const [aiResponse, setAiResponse] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [instruction, setInstruction] = useState('');

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

  const handleSend = useCallback(async () => {
    if (!editorRef.current || !imageShapeId || !imageMeta) return;

    setLoading(true);
    setAiResponse(null);
    setAiError(null);

    try {
      const annotations = parseAnnotations(editorRef.current, imageShapeId);
      const prompt = buildPrompt(annotations, instruction || undefined);
      const annotatedImage = await exportCanvasAsBase64(editorRef.current);

      // Get original image base64
      let originalImage = imageMeta.base64 || '';
      if (!originalImage && imageMeta.objectUrl) {
        // objectUrl is already a data URL
        originalImage = imageMeta.objectUrl.split(',')[1] || '';
      }

      const response = await chrome.runtime.sendMessage({
        type: 'SEND_TO_AI',
        payload: { originalImage, annotatedImage, prompt },
      });

      if (response.type === 'AI_RESPONSE') {
        setAiResponse(response.payload.text);
      } else if (response.type === 'AI_ERROR') {
        setAiError(response.payload.error);
      }
    } catch (err: any) {
      setAiError(err.message || 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [imageShapeId, imageMeta, instruction]);

  const handleCapture = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' });
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
        onCapture={handleCapture}
        onSettings={() => setShowSettings(!showSettings)}
      />

      {!hasApiKey && (
        <div className="api-key-bar">
          <input
            type="password"
            placeholder="Paste OpenAI API key (sk-proj-...)"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && apiKeyInput.trim()) {
                handleSaveApiKey();
              }
            }}
          />
          <button onClick={handleSaveApiKey} disabled={!apiKeyInput.trim()}>
            Save Key
          </button>
        </div>
      )}

      {showSettings && hasApiKey && (
        <div className="api-key-bar">
          <input
            type="password"
            placeholder="OpenAI API key"
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
        <input
          type="text"
          placeholder="Describe what you want to change..."
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <button
          className="send-btn"
          onClick={handleSend}
          disabled={!imageMeta || !hasApiKey || loading}
          title={
            !hasApiKey
              ? 'Set API key first'
              : !imageMeta
                ? 'Load an image first (right-click or paste)'
                : 'Send to AI (Cmd+Enter)'
          }
        >
          {loading ? 'Sending...' : 'Send'}
        </button>
      </div>

      {(loading || aiResponse || aiError) && (
        <ResultPanel
          loading={loading}
          response={aiResponse}
          error={aiError}
        />
      )}
    </div>
  );
}
