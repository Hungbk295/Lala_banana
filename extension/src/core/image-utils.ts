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
  _imageUrl: string,
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

  // Offset new images so they don't stack on top of each other
  const existingImages = editor
    .getCurrentPageShapes()
    .filter((s) => s.type === 'image');
  const offset = existingImages.length * 30;

  const x = (viewport.width - w) / 2 + offset;
  const y = (viewport.height - h) / 2 + offset;

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

export async function copyCanvasToClipboard(editor: Editor): Promise<void> {
  const shapeIds = editor.getCurrentPageShapeIds();
  if (shapeIds.size === 0) throw new Error('No content to copy');

  const result = await editor.toImage([...shapeIds], {
    format: 'png',
    background: true,
  });

  await navigator.clipboard.write([
    new ClipboardItem({ 'image/png': result.blob }),
  ]);
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

/**
 * Remove solid-color background via chroma keying.
 * Works for green screen (#00FF00), checkerboard grays, or any dominant bg color.
 * Auto-detects the background color by sampling corners.
 */
export async function removeBackground(
  base64: string,
  mimeType: string
): Promise<{ base64: string; mimeType: string }> {
  const img = new Image();
  img.src = `data:${mimeType};base64,${base64}`;
  await new Promise((r) => { img.onload = r; });

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imageData.data;
  const w = canvas.width;
  const h = canvas.height;

  // Sample corners to detect background color
  const corners = [
    0,                          // top-left
    (w - 1) * 4,               // top-right
    (h - 1) * w * 4,           // bottom-left
    ((h - 1) * w + w - 1) * 4, // bottom-right
  ];

  // Find most common corner color (majority vote)
  const samples = corners.map((i) => ({ r: d[i], g: d[i + 1], b: d[i + 2] }));
  let bgColor = samples[0];
  let bestCount = 0;
  for (const s of samples) {
    const count = samples.filter(
      (o) => Math.abs(o.r - s.r) + Math.abs(o.g - s.g) + Math.abs(o.b - s.b) < 40
    ).length;
    if (count > bestCount) {
      bestCount = count;
      bgColor = s;
    }
  }

  // Need at least 2 corners matching to be confident
  if (bestCount < 2) return { base64, mimeType };

  // Check if it's green screen (#00FF00 area)
  const isGreenScreen = bgColor.g > 200 && bgColor.r < 100 && bgColor.b < 100;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];

    if (isGreenScreen) {
      // Green screen keying with edge feathering
      const greenDom = g - Math.max(r, b);
      if (greenDom > 80) {
        d[i + 3] = 0;
      } else if (greenDom > 30) {
        d[i + 3] = Math.round(255 * (1 - (greenDom - 30) / 50));
        // Remove green spill from edge pixels
        d[i + 1] = Math.min(g, Math.max(r, b));
      }
    } else {
      // Generic color keying (for checkerboard grays, white bg, etc.)
      const dist = Math.abs(r - bgColor.r) + Math.abs(g - bgColor.g) + Math.abs(b - bgColor.b);
      if (dist < 30) {
        d[i + 3] = 0;
      } else if (dist < 60) {
        d[i + 3] = Math.round(255 * ((dist - 30) / 30));
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return {
    base64: canvas.toDataURL('image/png').split(',')[1],
    mimeType: 'image/png',
  };
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
