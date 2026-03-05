// Tab screenshot capture — triggered from side panel
chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' });
