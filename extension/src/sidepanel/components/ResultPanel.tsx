import React, { useState, useCallback } from 'react';

interface ResultPanelProps {
  loading: boolean;
  response: string | null;
  error: string | null;
}

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
          <button className="copy-btn" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        )}
      </div>
      {loading && <p className="loading">Analyzing...</p>}
      {error && <p className="error-text">{error}</p>}
      {response && <p className="response-text">{response}</p>}
    </div>
  );
}
