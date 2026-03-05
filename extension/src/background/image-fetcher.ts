function optimizeGeminiUrl(url: string): string {
  if (url.includes('lh3.googleusercontent.com')) {
    return url.replace(/=s\d+(-[a-z]+)?$/, '=s2048');
  }
  return url;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

export async function fetchImageAsBase64(imageUrl: string): Promise<string> {
  const optimizedUrl = optimizeGeminiUrl(imageUrl);

  let response = await fetch(optimizedUrl);

  if (!response.ok && optimizedUrl !== imageUrl) {
    response = await fetch(imageUrl);
  }

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status}`);
  }

  return blobToBase64(await response.blob());
}
