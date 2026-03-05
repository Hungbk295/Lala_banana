export async function getApiKey(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get('apiKey', (result) => {
      resolve((result.apiKey as string) || null);
    });
  });
}

export async function setApiKey(key: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ apiKey: key }, resolve);
  });
}

export async function removeApiKey(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove('apiKey', resolve);
  });
}
