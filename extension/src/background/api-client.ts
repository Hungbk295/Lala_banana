import type { APIRequest } from '../core/types';

const SYSTEM_PROMPT = `Bạn là trợ lý phân tích hình ảnh. User gửi ảnh gốc và ảnh có annotation (khoanh tròn, mũi tên, ghi chú). Hãy đọc annotation và phản hồi.

QUY TẮC BẮT BUỘC:
- Luôn trả lời bằng tiếng Việt
- KHÔNG mở đầu kiểu "Dựa trên hình ảnh...", "Tôi thấy rằng...", "Theo annotation...". Vào thẳng nội dung
- KHÔNG dùng format đánh số với tiêu đề rồi xuống dòng giải thích. KHÔNG viết kiểu:
  1. Tiêu đề:
     - Giải thích
- Thay vào đó viết liền mạch, tự nhiên, gộp ý liên quan thành câu đọc được. Ví dụ: "Thu hẹp mắt lại cho sắc hơn. Thêm lông mày nhíu xuống giữa để tạo vẻ đe dọa. Đổi miệng thành nhăn hoặc gầm gừ."
- Mỗi ý là một câu ngắn gọn, nối tiếp nhau. Có thể xuống dòng giữa các nhóm ý khác nhau
- Nếu user muốn sửa ảnh AI, viết prompt tiếng Việt mà user có thể copy-paste luôn
- Cụ thể: nói "nút xanh góc phải" thay vì "phần tử đó"
- Ngắn gọn, thực tế, không rào trước đón sau`;

async function getStoredApiKey(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get('apiKey', (result) => {
      resolve((result.apiKey as string) || null);
    });
  });
}

export async function sendToAI(request: APIRequest): Promise<string> {
  const apiKey = await getStoredApiKey();
  if (!apiKey) throw new Error('API key not configured. Please set it in the extension settings.');

  const messages: any[] = [
    {
      role: 'system',
      content: SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${request.originalImage}`,
            detail: 'high',
          },
        },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${request.annotatedImage}`,
            detail: 'high',
          },
        },
        {
          type: 'text',
          text: request.prompt,
        },
      ],
    },
  ];

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 4096,
      messages,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `API error: ${error.error?.message || response.statusText}`
    );
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || 'No response';
}
