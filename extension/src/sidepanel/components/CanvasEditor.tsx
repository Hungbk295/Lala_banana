import React, { useCallback } from 'react';
import { Tldraw } from 'tldraw';
import type { Editor } from 'tldraw';
import 'tldraw/tldraw.css';

interface CanvasEditorProps {
  onEditorReady: (editor: Editor) => void;
}

export function CanvasEditor({ onEditorReady }: CanvasEditorProps) {
  const handleMount = useCallback(
    (editor: Editor) => {
      onEditorReady(editor);
    },
    [onEditorReady]
  );

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <Tldraw onMount={handleMount} />
    </div>
  );
}
