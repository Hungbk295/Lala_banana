import { useState, useCallback } from 'react';

interface ResultPanelProps {
  loading: boolean;
  response: string | null;
  error: string | null;
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

export function ResultPanel({ loading, response, error }: ResultPanelProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!response) return;
    await navigator.clipboard.writeText(response);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [response]);

  return (
    <div className="result-panel">
      <div className="result-header">
        <h3>AI Response</h3>
        {response && (
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
      {response && <p className="response-text">{response}</p>}
    </div>
  );
}
