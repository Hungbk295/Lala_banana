import type { APIRequest, GeminiResponse } from '../core/types';

async function getCookiesForUrl(url: string): Promise<string> {
  const cookies = await chrome.cookies.getAll({ url });
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

interface GeminiSession {
  atToken: string;
  fsid: string;
  bl: string;
}

async function getGeminiSession(): Promise<GeminiSession> {
  const cookies = await getCookiesForUrl('https://gemini.google.com/');

  const resp = await fetch('https://gemini.google.com/app', {
    headers: {
      'Cookie': cookies,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    },
  });

  if (!resp.ok) {
    throw new Error(`Cannot access Gemini (${resp.status}). Make sure you're logged in.`);
  }

  const html = await resp.text();

  const atMatch = html.match(/"SNlM0e":"([^"]+)"/);
  if (!atMatch) {
    throw new Error('Gemini session not found. Please open gemini.google.com and log in first.');
  }

  const fsidMatch = html.match(/"FdrFJe":"(\d+)"/);
  const blMatch = html.match(/"cfb2h":"([^"]+)"/);

  return {
    atToken: atMatch[1],
    fsid: fsidMatch?.[1] || '',
    bl: blMatch?.[1] || '',
  };
}

async function uploadImage(
  base64Data: string,
  fileName: string,
  mimeType: string
): Promise<string> {
  const cookies = await getCookiesForUrl('https://push.clients6.google.com/');

  // Decode base64 to binary — must send raw bytes, not the base64 string
  const binaryStr = atob(base64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  const rawSize = bytes.byteLength;

  // Step 1: Init resumable upload
  const initResp = await fetch('https://push.clients6.google.com/upload/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Cookie': cookies,
      'Origin': 'https://gemini.google.com',
      'Referer': 'https://gemini.google.com/',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(rawSize),
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Tenant-Id': 'bard-storage',
      'X-Client-Pctx': 'CgcSBWjK7pYx',
      'Push-Id': 'feeds/mcudyrk2a4khkz',
    },
    body: `File name: ${fileName}`,
  });

  if (!initResp.ok) throw new Error(`Upload init failed: ${initResp.status}`);

  const uploadUrl = initResp.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('No upload URL in response');

  // Step 2: Upload raw binary + finalize
  const uploadResp = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cookie': cookies,
      'Origin': 'https://gemini.google.com',
      'Referer': 'https://gemini.google.com/',
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
      'X-Tenant-Id': 'bard-storage',
      'X-Client-Pctx': 'CgcSBWjK7pYx',
      'Push-Id': 'feeds/mcudyrk2a4khkz',
    },
    body: bytes,
  });

  if (!uploadResp.ok) throw new Error(`Upload failed: ${uploadResp.status}`);

  return (await uploadResp.text()).trim();
}

function parseResponse(raw: string): GeminiResponse {
  // Remove XSSI prefix
  const cleaned = raw.replace(/^\)\]}'[\s]*\n/, '');

  // Split into chunks by size lines
  const lines = cleaned.split('\n');
  const chunks: string[] = [];
  let buf = '';

  for (const line of lines) {
    if (/^\d+$/.test(line.trim())) {
      if (buf.trim()) chunks.push(buf.trim());
      buf = '';
    } else {
      buf += line + '\n';
    }
  }
  if (buf.trim()) chunks.push(buf.trim());

  let bestText = '';
  const allImages: string[] = [];

  for (const chunk of chunks) {
    try {
      const parsed = JSON.parse(chunk);

      // Extract generated image URLs from all chunks
      collectImageUrls(parsed, allImages);

      // Extract text (skip tool-status chunks)
      if (!isToolChunk(parsed)) {
        const text = extractText(parsed);
        if (text && text.length > bestText.length) {
          bestText = text;
        }
      }
    } catch { /* skip invalid JSON */ }
  }

  // Deduplicate images
  const uniqueImages = [...new Set(allImages)];

  if (bestText.length > 5 || uniqueImages.length > 0) {
    return {
      text: bestText.length > 5 ? bestText : undefined,
      images: uniqueImages.length > 0 ? uniqueImages : undefined,
    };
  }

  throw new Error('Could not parse Gemini response');
}

/** Walk the response tree and collect generated image URLs (gg-dl = generated/download) */
function collectImageUrls(obj: any, urls: string[]): void {
  if (typeof obj === 'string') {
    // Generated images use /gg-dl/ path; uploaded inputs use /gg/
    if (
      obj.includes('lh3.googleusercontent.com/gg-dl/') ||
      obj.includes('lh3.googleusercontent.com/gg/d/')
    ) {
      urls.push(obj);
    }
    return;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      collectImageUrls(item, urls);
    }
  }
}

function isToolChunk(data: any): boolean {
  try {
    if (!Array.isArray(data)) return false;
    const toolSlot = data[6];
    if (Array.isArray(toolSlot) && toolSlot[1] && Array.isArray(toolSlot[1])) {
      const toolName = toolSlot[1][0];
      if (typeof toolName === 'string' && toolName.includes('tool')) return true;
    }
  } catch { /* not a tool chunk */ }
  return false;
}

function extractText(data: any): string | null {
  try {
    if (Array.isArray(data) && Array.isArray(data[0])) {
      for (const item of data) {
        if (Array.isArray(item) && typeof item[2] === 'string') {
          try {
            const inner = JSON.parse(item[2]);
            if (inner?.[4]?.[0]?.[1]?.[0]) return inner[4][0][1][0];
            if (typeof inner?.[0]?.[0] === 'string' && inner[0][0].length > 5) return inner[0][0];
            if (inner?.[4]?.[0]?.[1] && Array.isArray(inner[4][0][1])) {
              const parts = inner[4][0][1];
              const texts = parts.filter((p: any) => typeof p === 'string' && p.length > 5);
              if (texts.length > 0) return texts.join('\n');
            }
          } catch { /* not inner JSON */ }
        }
      }
    }
  } catch { /* path failed */ }

  return findLongest(data);
}

function findLongest(obj: any, min = 15): string | null {
  let best = '';
  const skipPatterns = ['Đang tải', 'Loading', 'Generating', 'data_analysis_tool'];
  (function walk(v: any) {
    if (
      typeof v === 'string' &&
      v.length >= min &&
      v.includes(' ') &&
      !v.startsWith('http') &&
      !v.startsWith('/') &&
      !skipPatterns.some(p => v.startsWith(p))
    ) {
      if (v.length > best.length) best = v;
    } else if (Array.isArray(v)) v.forEach(walk);
  })(obj);
  return best || null;
}

export async function sendToGemini(request: APIRequest): Promise<GeminiResponse> {
  // 1. Get session tokens
  const session = await getGeminiSession();
  if (!session.bl) throw new Error('Could not get Gemini server version');

  // 2. Upload annotated image
  const filePath = await uploadImage(
    request.annotatedImage,
    'annotated.png',
    'image/png'
  );

  // 3. Build payload (69-element array matching Gemini's expected format)
  const inner: any[] = new Array(69).fill(null);
  inner[0] = [
    request.prompt, 0, null,
    [[[filePath, 1, null, 'image/png'], 'annotated.png']],
    null, null, 0,
  ];
  inner[1] = ['en'];
  inner[2] = ['', '', '', null, null, null, null, null, null, ''];
  inner[3] = ''; // conversation_id (new conversation)
  inner[4] = ''; // response_id
  inner[6] = [0];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[0]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[49] = 14;
  inner[53] = 0;
  inner[59] = crypto.randomUUID().toUpperCase();
  inner[61] = [];
  inner[68] = 1;

  const fReq = JSON.stringify([null, JSON.stringify(inner)]);

  // 4. Send chat request
  const cookies = await getCookiesForUrl('https://gemini.google.com/');
  const reqid = Math.floor(Math.random() * 9000 + 1000) * 100;

  const params = new URLSearchParams({
    bl: session.bl,
    'f.sid': session.fsid,
    hl: 'en',
    _reqid: String(reqid),
    rt: 'c',
  });

  const resp = await fetch(
    `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${params}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Cookie': cookies,
        'Origin': 'https://gemini.google.com',
        'Referer': 'https://gemini.google.com/',
        'X-Same-Domain': '1',
      },
      body: `f.req=${encodeURIComponent(fReq)}&at=${encodeURIComponent(session.atToken)}&`,
    }
  );

  if (!resp.ok) throw new Error(`Gemini error: ${resp.status} ${resp.statusText}`);

  return parseResponse(await resp.text());
}
