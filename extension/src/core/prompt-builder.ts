import type { ParsedAnnotation, ImageContext } from './types';

const MAX_HISTORY_ENTRIES = 10; // 5 turns (user+model pairs)

function describePosition(x: number, y: number): string {
  const horiz = x < 0.33 ? 'trái' : x < 0.66 ? 'giữa' : 'phải';
  const vert = y < 0.33 ? 'trên' : y < 0.66 ? 'giữa' : 'dưới';
  if (horiz === 'giữa' && vert === 'giữa') return 'chính giữa ảnh';
  return `vùng ${vert}-${horiz}`;
}

export function trimHistory(history: ImageContext['history']): ImageContext['history'] {
  if (history.length <= MAX_HISTORY_ENTRIES) return history;
  // Keep first turn (original context) + most recent turns
  return [
    history[0],
    history[1],
    ...history.slice(-MAX_HISTORY_ENTRIES + 2),
  ];
}

export function buildPrompt(
  annotations: ParsedAnnotation[],
  userInstruction?: string,
  imageContext?: ImageContext
): string {
  const parts: string[] = [];

  // Inject history if available
  if (imageContext && imageContext.history.length > 0) {
    parts.push('## Lịch sử chỉnh sửa trước đó');
    for (let i = 0; i < imageContext.history.length; i += 2) {
      const userEntry = imageContext.history[i];
      const modelEntry = imageContext.history[i + 1];
      const turnNum = Math.floor(i / 2) + 1;
      parts.push(`Lần ${turnNum}:`);
      parts.push(`  Yêu cầu: ${userEntry.text}`);
      if (modelEntry) {
        parts.push(`  Kết quả: ${modelEntry.text}`);
      }
    }
    parts.push(`\nẢnh hiện tại là kết quả sau ${imageContext.generation} lần chỉnh sửa.`);
    parts.push('---');
  }

  parts.push('Đây là ảnh tôi đang làm việc. Ảnh thứ hai có annotation tôi vẽ lên.');

  const highlights = annotations.filter((a) => a.type === 'highlight');
  const arrows = annotations.filter((a) => a.type === 'arrow');
  const instructions = annotations.filter((a) => a.type === 'instruction');

  if (highlights.length > 0) {
    const descs = highlights.map((h) => {
      const pos = h.region ? describePosition(h.region.x, h.region.y) : 'một vùng';
      return h.text ? `"${h.text}" (${pos})` : `vùng khoanh ở ${pos}`;
    });
    parts.push(`Tôi đã khoanh: ${descs.join(', ')}.`);
  }

  if (arrows.length > 0) {
    parts.push(`Có ${arrows.length} mũi tên chỉ vào các phần cần chú ý.`);
  }

  if (instructions.length > 0) {
    const notes = instructions.map((t) => `"${t.text}"`).join(', ');
    parts.push(`Ghi chú trên ảnh: ${notes}.`);
  }

  if (userInstruction) {
    parts.push(`\nYêu cầu: ${userInstruction}`);
  } else if (annotations.length === 0) {
    parts.push('\nHãy xem ảnh và cho nhận xét.');
  } else {
    parts.push('\nDựa vào annotation, cho tôi biết cần sửa gì.');
  }

  return parts.join('\n');
}
