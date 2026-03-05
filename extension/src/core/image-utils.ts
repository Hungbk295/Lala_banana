import type { Editor, TLShapeId } from 'tldraw';
import { createShapeId, AssetRecordType } from 'tldraw';
import type { NormalizedRect } from './types';

interface CompressOptions {
  maxWidth: number;
  maxHeight: number;
  quality: number;
}

export async function compressImage(
  blob: Blob,
  options: CompressOptions
): Promise<Blob> {
  const img = await blobToImage(blob);

  const scale = Math.min(
    options.maxWidth / img.width,
    options.maxHeight / img.height,
    1
  );

  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);

  return new Promise((resolve) => {
    canvas.toBlob(
      (b) => resolve(b || blob),
      'image/jpeg',
      options.quality
    );
  });
}

export function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

export async function insertImageToCanvas(
  editor: Editor,
  imageUrl: string,
  blob: Blob
): Promise<TLShapeId> {
  // Convert blob to data URL — tldraw v4 rejects blob: protocol URLs
  const dataUrl = await blobToDataUrl(blob);

  const img = await new Promise<HTMLImageElement>((resolve) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.src = dataUrl;
  });

  const viewport = editor.getViewportScreenBounds();
  const scale = Math.min(
    (viewport.width * 0.9) / img.width,
    (viewport.height * 0.9) / img.height,
    1
  );

  const w = img.width * scale;
  const h = img.height * scale;
  const x = (viewport.width - w) / 2;
  const y = (viewport.height - h) / 2;

  const assetId = AssetRecordType.createId();
  editor.createAssets([
    {
      id: assetId,
      type: 'image',
      typeName: 'asset',
      props: {
        src: dataUrl,
        w: img.width,
        h: img.height,
        name: 'screenshot',
        isAnimated: false,
        mimeType: blob.type as any,
      },
      meta: {},
    },
  ]);

  const shapeId = createShapeId();
  editor.createShape({
    id: shapeId,
    type: 'image',
    x,
    y,
    props: {
      assetId,
      w,
      h,
    },
  });

  editor.updateShape({
    id: shapeId,
    type: 'image',
    isLocked: true,
  });

  return shapeId;
}

export async function exportCanvasAsBase64(
  editor: Editor
): Promise<string> {
  const shapeIds = editor.getCurrentPageShapeIds();
  if (shapeIds.size === 0) return '';

  const blob = await editor.toImage([...shapeIds], {
    format: 'png',
    background: true,
  });

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.readAsDataURL(blob.blob);
  });
}

export async function cropHighlightRegion(
  originalImage: HTMLImageElement,
  normalizedRegion: NormalizedRect
): Promise<string> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  const sx = normalizedRegion.x * originalImage.naturalWidth;
  const sy = normalizedRegion.y * originalImage.naturalHeight;
  const sw = normalizedRegion.w * originalImage.naturalWidth;
  const sh = normalizedRegion.h * originalImage.naturalHeight;

  canvas.width = sw;
  canvas.height = sh;
  ctx.drawImage(originalImage, sx, sy, sw, sh, 0, 0, sw, sh);

  return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
}

export function base64ToBlob(base64: string, mimeType = 'image/jpeg'): Blob {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
}
