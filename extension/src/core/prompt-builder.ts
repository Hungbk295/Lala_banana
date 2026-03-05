import type { ParsedAnnotation } from './types';

function describePosition(x: number, y: number): string {
  const horiz = x < 0.33 ? 'trái' : x < 0.66 ? 'giữa' : 'phải';
  const vert = y < 0.33 ? 'trên' : y < 0.66 ? 'giữa' : 'dưới';
  if (horiz === 'giữa' && vert === 'giữa') return 'chính giữa ảnh';
  return `vùng ${vert}-${horiz}`;
}

export function buildPrompt(
  annotations: ParsedAnnotation[],
  userInstruction?: string
): string {
  const parts: string[] = [];

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
