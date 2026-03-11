import type { AIResponsePart, GeminiPart } from '../core/types';

const PROXY_BASE = 'https://api.antamediadhcp.com';
const PROXY_API_KEY = 'sk-jc-key-1';
const MODEL = 'gemini-3.1-flash-image';
const GEMINI_ENDPOINT = `${PROXY_BASE}/api/provider/google/v1beta/models/${MODEL}:generateContent`;

const SYSTEM_PROMPT = `Bạn là trợ lý chỉnh sửa hình ảnh. User gửi ảnh gốc và ảnh có annotation (khoanh tròn, mũi tên, ghi chú). Hãy đọc annotation và tạo ảnh mới đã chỉnh sửa theo yêu cầu.

QUY TẮC BẮT BUỘC:
- Luôn trả lời bằng tiếng Việt
- KHÔNG mở đầu kiểu "Dựa trên hình ảnh...", "Tôi thấy rằng...". Vào thẳng nội dung
- Tạo ảnh mới đã chỉnh sửa theo annotation của user
- Giải thích ngắn gọn những gì đã thay đổi
- Cụ thể: nói "nút xanh góc phải" thay vì "phần tử đó"
- Ngắn gọn, thực tế, không rào trước đón sau`;

interface GeminiRequest {
  originalImage: string; // base64
  annotatedImage: string; // base64
  prompt: string;
}

export async function sendToGemini(request: GeminiRequest): Promise<AIResponsePart[]> {
  const parts: GeminiPart[] = [
    {
      inlineData: {
        mimeType: 'image/jpeg',
        data: request.originalImage,
      },
    },
    {
      inlineData: {
        mimeType: 'image/png',
        data: request.annotatedImage,
      },
    },
    {
      text: request.prompt,
    },
  ];

  const body = {
    systemInstruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents: [
      {
        role: 'user',
        parts,
      },
    ],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  };

  const response = await fetch(GEMINI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${PROXY_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      `Gemini API error: ${(error as any).error?.message || response.statusText}`
    );
  }

  const data = await response.json();

  // Parse response parts
  const responseParts: AIResponsePart[] = [];
  const candidates = data.candidates;
  if (!candidates || candidates.length === 0) {
    throw new Error('No response from Gemini');
  }

  const content = candidates[0].content;
  if (!content?.parts) {
    throw new Error('Empty response from Gemini');
  }

  for (const part of content.parts) {
    if (part.text) {
      responseParts.push({ type: 'text', content: part.text });
    }
    if (part.inlineData) {
      responseParts.push({
        type: 'image',
        content: part.inlineData.data,
        mimeType: part.inlineData.mimeType,
      });
    }
  }

  return responseParts;
}
