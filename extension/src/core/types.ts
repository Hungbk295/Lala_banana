export interface ImageMeta {
  sourceUrl: string;
  objectUrl: string;
  base64?: string;
}

export interface CanvasRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ParsedAnnotation {
  type: 'highlight' | 'arrow' | 'instruction' | 'freehand-circle';
  region?: NormalizedRect;
  pointer?: {
    from: { x: number; y: number };
    to: { x: number; y: number };
  };
  text?: string;
  _shapeId: string;
  _merged?: boolean;
}

export interface ContextMenuPayload {
  base64: string;
  sourceUrl: string;
  pageUrl?: string;
  pageTitle?: string;
}

export interface PendingImage {
  base64: string;
  sourceUrl: string;
  timestamp: number;
}

export interface APIRequest {
  originalImage: string;
  annotatedImage: string;
  prompt: string;
}

export type MessageType =
  | { type: 'IMAGE_FROM_CONTEXT_MENU'; payload: ContextMenuPayload }
  | { type: 'IMAGE_CAPTURED'; dataUrl: string }
  | { type: 'CAPTURE_TAB' }
  | { type: 'SEND_TO_AI'; payload: APIRequest }
  | { type: 'AI_RESPONSE'; payload: { text: string } }
  | { type: 'AI_ERROR'; payload: { error: string } };
