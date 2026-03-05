import React from 'react';

interface ToolbarProps {
  hasApiKey: boolean;
  onCapture: () => void;
  onSettings: () => void;
}

export function Toolbar({
  hasApiKey,
  onCapture,
  onSettings,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      <button onClick={onCapture} title="Capture current tab screenshot">
        Screenshot
      </button>
      <div style={{ flex: 1 }} />
      <button onClick={onSettings} title={hasApiKey ? 'Change API key' : 'Set API key'}>
        {hasApiKey ? 'API Key' : 'Set API Key'}
      </button>
    </div>
  );
}
