import { useState, useCallback } from 'react';
import type { AIResponsePart } from '../../core/types';

interface ResultPanelProps {
  loading: boolean;
  responseParts: AIResponsePart[];
  error: string | null;
  onLoadImage: (base64: string, mimeType: string) => void;
}

const CopyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export function ResultPanel({ loading, responseParts, error, onLoadImage }: ResultPanelProps) {
  const [copied, setCopied] = useState(false);

  const textContent = responseParts
    .filter((p) => p.type === 'text')
    .map((p) => p.content)
    .join('\n');

  const handleCopy = useCallback(async () => {
    if (!textContent) return;
    await navigator.clipboard.writeText(textContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [textContent]);

  return (
    <div className="result-panel">
      <div className="result-header">
        <h3>AI Response</h3>
        {textContent && (
          <button className={`copy-btn ${copied ? 'copied' : ''}`} onClick={handleCopy}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      {loading && (
        <p className="loading">
          <span className="loading-dots">
            <span />
            <span />
            <span />
          </span>
          Analyzing...
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
      {responseParts.map((part, i) => {
        if (part.type === 'text') {
          return <p key={i} className="response-text">{part.content}</p>;
        }
        if (part.type === 'image') {
          const src = `data:${part.mimeType || 'image/png'};base64,${part.content}`;
          return (
            <div key={i} className="response-image-container">
              <img className="response-image" src={src} alt="AI generated" />
              <button
                className="load-to-canvas-btn"
                onClick={() => onLoadImage(part.content, part.mimeType || 'image/png')}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Load to canvas
              </button>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
