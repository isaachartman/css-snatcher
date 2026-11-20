// Injects the content script on demand. Re-injecting an already-loaded script
// just toggles it (see the guard at the top of content.js).
async function toggle(tab) {
  if (!tab || !tab.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (err) {
    // chrome://, the Web Store, PDF viewer etc. can't be scripted.
    console.warn('CSS Snatcher cannot run on this page:', err.message);
  }
}

chrome.action.onClicked.addListener(toggle);

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-snatcher') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  toggle(tab);
});
