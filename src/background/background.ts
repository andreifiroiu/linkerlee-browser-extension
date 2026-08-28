import { findLink } from '../lib/api';
import { getConfig } from '../lib/storage';
import { ApiError } from '../lib/types';
import { isSaveableUrl } from '../lib/urls';

const BADGE_TEXT = '✓';
// The --accent from src/styles/tokens.css: the toolbar checkmark and the popup
// it opens should be the same amber.
const BADGE_COLOR = '#F5A518';

async function refreshBadge(tabId: number, url: string | undefined): Promise<void> {
  await chrome.action.setBadgeText({ tabId, text: '' });

  if (!isSaveableUrl(url)) return;

  const cfg = await getConfig();
  if (!cfg.token) return;

  try {
    const link = await findLink(url);
    if (link) {
      await chrome.action.setBadgeText({ tabId, text: BADGE_TEXT });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
    }
  } catch (err) {
    // status 0 covers the local refusals — no token, an unusable base URL, or no
    // permission for the configured host. Those are worth a line: this worker
    // runs on every tab switch with no UI, so otherwise the badge simply stops
    // working and says nothing. The messages name only the host, never the token.
    if (!(err instanceof ApiError) || err.status === 0 || err.status >= 500) {
      console.warn('[linkerlee] badge refresh failed', err);
    }
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await refreshBadge(tabId, tab.url);
  } catch {
    // tab might have been closed mid-check
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    await refreshBadge(tabId, tab.url);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'refresh-badge' && typeof message.tabId === 'number') {
    void refreshBadge(message.tabId, message.url).then(() => sendResponse(true));
    return true;
  }
  return false;
});
