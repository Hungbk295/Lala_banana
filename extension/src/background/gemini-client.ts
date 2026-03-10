const API_ENDPOINT = 'https://api.antamediadhcp.com/v1/chat/completions';
const API_KEY = 'sk-jc-key-1';
const MODEL = 'gemini-3.1-flash-image';

export interface GeminiImageResult {
  imageBase64: string;
  mimeType: string;
  text?: string;
}

export async function removeBackground(
  imageBase64: string,
  mimeType: string = 'image/jpeg',
  prompt?: string
): Promise<GeminiImageResult> {
  const defaultPrompt =
    'Remove the background from this image. Replace the background with a solid bright green color (exactly #00FF00). Keep only the main subject/object unchanged. Fill ALL background areas with solid #00FF00 green, no gradients, no patterns, no checkerboard. Output as PNG.';

  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${imageBase64}`,
              },
            },
            {
              type: 'text',
              text: prompt || defaultPrompt,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      `API error: ${(error as any).error?.message || response.statusText}`
    );
  }

  const data = await response.json();
  const message = data.choices?.[0]?.message;

  if (!message) {
    throw new Error('No response from API');
  }

  const text = typeof message.content === 'string' ? message.content : undefined;

  // Images are in message.images array
  if (message.images && message.images.length > 0) {
    const imgObj = message.images[0];
    const url: string = imgObj.image_url?.url || '';
    const match = url.match(/^data:([^;]+);base64,(.+)$/s);
    if (match) {
      return {
        imageBase64: match[2],
        mimeType: match[1],
        text,
      };
    }
  }

  throw new Error(text ? `No image in response: ${text.substring(0, 200)}` : 'No image in response');
}
