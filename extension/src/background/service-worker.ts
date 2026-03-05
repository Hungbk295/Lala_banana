import { fetchImageAsBase64 } from './image-fetcher';
import { sendToAI } from './api-client';

// Create context menu on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'annotate-image',
    title: 'Edit with AI Annotation',
    contexts: ['image'],
  });
});

// Handle context menu click
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'annotate-image' || !info.srcUrl) return;

  // MUST open side panel FIRST (synchronously in user gesture context)
  // before any async work, otherwise Chrome rejects it
  await chrome.sidePanel.open({ tabId: tab!.id! });

  // Store srcUrl immediately so side panel can start loading
  await chrome.storage.session.set({
    pendingImage: {
      srcUrl: info.srcUrl,
      pageUrl: info.pageUrl,
      pageTitle: tab?.title,
      timestamp: Date.now(),
    },
  });

  // Also try sending message directly (if side panel already mounted)
  try {
    await chrome.runtime.sendMessage({
      type: 'IMAGE_FROM_CONTEXT_MENU',
      payload: {
        srcUrl: info.srcUrl,
        pageUrl: info.pageUrl,
        pageTitle: tab?.title,
      },
    });
  } catch {
    // Side panel not mounted yet — it will read from storage
  }
});

// Handle action click (open side panel)
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id! });
});

// Handle messages from side panel
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CAPTURE_TAB') {
    chrome.tabs.captureVisibleTab(
      null as unknown as number,
      { format: 'jpeg', quality: 85 },
      (dataUrl) => {
        chrome.runtime.sendMessage({ type: 'IMAGE_CAPTURED', dataUrl });
      }
    );
    return true;
  }

  if (message.type === 'FETCH_IMAGE') {
    const url = message.payload.url;
    fetch(url)
      .then(async (resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        bytes.forEach((b) => (binary += String.fromCharCode(b)));
        sendResponse({ base64: btoa(binary), mimeType: blob.type || 'image/jpeg' });
      })
      .catch((err) => {
        sendResponse({ error: err.message });
      });
    return true;
  }

  if (message.type === 'SEND_TO_AI') {
    sendToAI(message.payload)
      .then((text) => {
        sendResponse({ type: 'AI_RESPONSE', payload: { text } });
      })
      .catch((err) => {
        sendResponse({
          type: 'AI_ERROR',
          payload: { error: err.message },
        });
      });
    return true; // Keep channel open for async response
  }
});
