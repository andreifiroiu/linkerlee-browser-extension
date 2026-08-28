import { fetchUser } from '../lib/api';
import {
  HostAccessError,
  hostLabel,
  isDefaultHost,
  releaseUnusedHosts,
  requestHostAccess,
} from '../lib/permissions';
import { getConfig, setConfig } from '../lib/storage';
import { ApiError } from '../lib/types';

const form = document.getElementById('form') as HTMLFormElement;
const baseUrlInput = document.getElementById('baseUrl') as HTMLInputElement;
const tokenInput = document.getElementById('token') as HTMLInputElement;
const testButton = document.getElementById('test') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement;
const hostNote = document.getElementById('host-note') as HTMLParagraphElement;

function showStatus(message: string, kind: 'ok' | 'error' = 'ok'): void {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', kind === 'error');
  statusEl.hidden = false;
}

/** Keeps the configured destination visible: it is where the token and every
 *  page URL the extension looks up are sent. */
function showHostNote(baseUrl: string): void {
  if (isDefaultHost(baseUrl)) {
    hostNote.textContent = '';
    return;
  }
  // Two messages of very different severity share this element: naming a
  // working self-hosted host is information, an unparseable address is a
  // failure. They must not look alike, or a typo reads as a working config.
  const host = hostLabel(baseUrl);
  const usable = host !== null;
  hostNote.className = usable ? 'banner banner-warn' : 'banner banner-error';
  hostNote.textContent = usable
    ? `Self-hosted: your token and the pages you save are sent to ${host}.`
    : 'Not a usable address — the base URL must start with https:// and name a single host.';
}

async function load(): Promise<void> {
  const cfg = await getConfig();
  baseUrlInput.value = cfg.baseUrl;
  tokenInput.value = cfg.token ?? '';
  showHostNote(cfg.baseUrl);
}

baseUrlInput.addEventListener('input', () => {
  showHostNote(baseUrlInput.value);
});

/**
 * Secure the host before storing anything.
 *
 * `permissions.request()` has to run inside the user gesture — an `await` ahead
 * of it and Firefox refuses — so it goes first, and the config is written only
 * once access is actually granted. A denied prompt must leave the previous,
 * working configuration untouched rather than half-applied.
 */
async function persist(action: 'save' | 'test'): Promise<boolean> {
  const baseUrl = baseUrlInput.value;

  let granted: boolean;
  try {
    granted = await requestHostAccess(baseUrl);
  } catch (err) {
    showStatus(
      err instanceof HostAccessError ? err.message : (err as Error).message,
      'error',
    );
    return false;
  }

  if (!granted) {
    showStatus(
      `Access to ${hostLabel(baseUrl) ?? 'that host'} was declined, so nothing was changed. The extension can only reach hosts you allow.`,
      'error',
    );
    return false;
  }

  await setConfig({ baseUrl, token: tokenInput.value.trim() || null });
  showHostNote(baseUrl);
  if (action === 'save') showStatus('Saved.');

  // Best-effort, and last: the save has already committed, so a failure to let
  // go of the old origin must not swallow the confirmation or cancel the
  // connection test that follows.
  try {
    await releaseUnusedHosts(baseUrl);
  } catch (err) {
    console.warn('[linkerlee] could not release access to the previous host', err);
  }

  return true;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await persist('save');
});

testButton.addEventListener('click', async () => {
  if (!(await persist('test'))) return;

  showStatus('Testing…');
  try {
    const user = await fetchUser();
    showStatus(`Connected as ${user.name} <${user.email}>.`);
  } catch (err) {
    const msg =
      err instanceof ApiError ? `${err.message} (HTTP ${err.status || 'network'})` : (err as Error).message;
    showStatus(`Connection failed: ${msg}`, 'error');
  }
});

void load();
