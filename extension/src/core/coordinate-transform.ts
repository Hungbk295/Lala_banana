import type { CanvasRect, NormalizedRect } from './types';

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function normalizeToImageCoords(
  canvasRect: CanvasRect,
  imageShape: { x: number; y: number; props: { w: number; h: number } }
): NormalizedRect {
  const imgX = imageShape.x;
  const imgY = imageShape.y;
  const imgW = imageShape.props.w;
  const imgH = imageShape.props.h;

  return {
    x: clamp01((canvasRect.x - imgX) / imgW),
    y: clamp01((canvasRect.y - imgY) / imgH),
    w: clamp01(canvasRect.w / imgW),
    h: clamp01(canvasRect.h / imgH),
  };
}
