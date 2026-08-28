import {
  createLink,
  deleteLink,
  findLink,
  getAllTags,
  suggestTags,
  updateLink,
} from '../lib/api';
import { clearDraft, getDraft, mergeDraft, saveDraft, type FormState } from '../lib/drafts';
import { hostLabel, isDefaultHost } from '../lib/permissions';
import { checkSetup, setupMessage, type SetupProblem } from '../lib/setup';
import { DEFAULT_BASE_URL, getConfig } from '../lib/storage';
import { ApiError, type ExistingLink, type Tag } from '../lib/types';
import { isSaveableUrl } from '../lib/urls';

const DASHBOARD_PATH = '/dashboard';

const needsSetup = document.getElementById('needs-setup') as HTMLElement;
const setupReason = document.getElementById('setup-reason') as HTMLParagraphElement;
const openOptionsBtn = document.getElementById('open-options') as HTMLButtonElement;
const form = document.getElementById('form') as HTMLFormElement;
const statusPill = document.getElementById('status-pill') as HTMLElement;
const statusPillLabel = document.getElementById('status-pill-label') as HTMLElement;
const statusPillDetail = document.getElementById('status-pill-detail') as HTMLElement;
const urlInput = document.getElementById('url') as HTMLInputElement;
const titleInput = document.getElementById('title') as HTMLInputElement;
const selectedTagsEl = document.getElementById('selected-tags') as HTMLElement;
const tagSearchInput = document.getElementById('tag-search') as HTMLInputElement;
const tagSuggestionsList = document.getElementById('tag-suggestions') as HTMLUListElement;
const tagsStatusEl = document.getElementById('tags-status') as HTMLElement;
const noTagsHint = document.getElementById('no-tags-hint') as HTMLElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const formStatusEl = document.getElementById('form-status') as HTMLElement;
const draftWarning = document.getElementById('draft-warning') as HTMLParagraphElement;
const hostBanner = document.getElementById('host-banner') as HTMLParagraphElement;
const removeBtn = document.getElementById('remove') as HTMLButtonElement;
const removeConfirm = document.getElementById('remove-confirm') as HTMLElement;
const removeYesBtn = document.getElementById('remove-yes') as HTMLButtonElement;
const removeNoBtn = document.getElementById('remove-no') as HTMLButtonElement;
const platformLink = document.getElementById('platform-link') as HTMLAnchorElement;
const versionEl = document.getElementById('version') as HTMLElement;

const allTags = new Map<number, Tag>();
const selectedIds = new Set<number>();
const newTagNames = new Set<string>();

let existing: ExistingLink | null = null;
let activeTabId: number | null = null;

/**
 * What the popup was *given* — the tab's title, then whatever the server adds as
 * it loads. Anything that differs from this is the user's unsaved work.
 *
 * It is assigned before the API calls and updated as they land, rather than
 * snapshotted from the form afterwards: the form is live throughout, and a
 * snapshot taken at the end would quietly absorb anything typed during the load
 * — the very work this feature exists to protect.
 */
let baseline: FormState | null = null;
let draftUrl: string | null = null;

/** Draft I/O stays off until init() has had its chance to restore one. */
let draftReady = false;
let restored = false;
let restoreNote = '';
/** A message that outlives the dirty/clean cycle (e.g. the feature is degraded). */
let notice: string | null = null;
/** Set once the user edits the title, so nothing loading late overwrites it. */
let titleTouched = false;
/** Bumped on every pass, so a late storage failure knows it is stale. */
let syncGeneration = 0;
/** A write is in flight. Saving and removing must not race for the same link. */
let busy = false;

openOptionsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// getConfig() only strips a trailing slash on write, so baseUrl may still carry one;
// new URL() keeps that from turning into a double slash. It also throws on an
// unparseable baseUrl — reachable, because the options page's "Test connection"
// stores the field without the form's type="url" validation. Falling back keeps a
// bad value from throwing here and leaving init() with neither section shown.
function platformUrl(baseUrl: string): string {
  try {
    return new URL(DASHBOARD_PATH, baseUrl).toString();
  } catch {
    return new URL(DASHBOARD_PATH, DEFAULT_BASE_URL).toString();
  }
}

// Read from the manifest rather than written here, so it cannot drift from what
// the browser actually installed. Set before init() runs: it needs no config, and
// the setup screen is exactly where someone is most likely to be asked for it.
// One footer serves both screens, so this is written once.
versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

platformLink.addEventListener('click', (event) => {
  event.preventDefault();
  // Close only once the tab is actually open: window.close() destroys this
  // document, so a rejected create would otherwise disappear without a trace.
  chrome.tabs.create({ url: platformLink.href }).then(
    () => window.close(),
    (err: unknown) => {
      console.warn('[linkerlee] could not open platform link', err);
    },
  );
});

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * What the popup knows about reaching Linkerlee. Deliberately starts at
 * 'unknown': being configured is not the same as being reachable, and nothing
 * has been on the wire when the form is first shown.
 */
type Connection = 'unknown' | 'ok' | 'setup' | 'auth' | 'offline' | 'blocked' | 'server';

let connection: Connection = 'unknown';
let connectionDetail = '';

/**
 * The one badge in the header, derived rather than assigned. It answers two
 * independent questions — can this popup reach Linkerlee, and is this page
 * already in it — and an earlier version let whichever one wrote last win. A
 * failed save then erased "Already saved" from a page that was still
 * bookmarked, and nothing put it back. Both facts live in state now
 * (`connection` and `existing`) and this renders whatever they currently say.
 */
function renderStatusPill(): void {
  const write = (
    text: string,
    kind: 'neutral' | 'ok' | 'accent' | 'danger',
    detail = '',
  ): void => {
    // The label, not the pill itself: writing textContent on the pill would
    // delete the detail span that lives inside it.
    statusPillLabel.textContent = text;
    statusPill.className = `pill pill-${kind}`;
    // The title is a sighted-mouse convenience. The detail span is the channel
    // of record — it is in the accessibility tree, and role="status" on the
    // pill announces it when either half changes.
    if (detail) statusPill.title = detail;
    else statusPill.removeAttribute('title');
    statusPillDetail.textContent = detail;
  };

  switch (connection) {
    case 'unknown':
      return write('Syncing…', 'neutral');
    case 'setup':
      return write('Not connected', 'danger');
    case 'auth':
      // Not the server's own words: reportWriteFailure deliberately replaces a
      // 401 body with advice the user can act on, and the badge should not
      // undo that ten lines above it.
      return write('Auth failed', 'danger', 'Your API token was rejected. Update it in the extension options.');
    case 'blocked':
      return write('Not connected', 'danger', connectionDetail);
    case 'offline':
      return write('Offline', 'danger', connectionDetail);
    case 'server':
      return write('Server error', 'danger', connectionDetail);
    case 'ok':
      return existing !== null
        ? write('Already saved', 'accent', 'Already bookmarked — saving will update it.')
        : write('Connected', 'ok');
  }
}

function setConnection(next: Connection, detail = ''): void {
  connection = next;
  connectionDetail = detail;
  renderStatusPill();
}

function showSetup(reason: string): void {
  setupReason.textContent = reason;
  needsSetup.hidden = false;
  form.hidden = true;
  setConnection('setup');
  // The footer is shared, so its link has to say the thing that is useful on
  // the screen being shown — here, where the missing token comes from.
  platformLink.textContent = 'Get your API token on Linkerlee ↗';
}

function showForm(): void {
  needsSetup.hidden = true;
  form.hidden = false;
  // Not 'ok' — checkSetup() only asked local questions, so nothing has proved
  // the server is there yet. The first request that comes back does that.
  renderStatusPill();
  platformLink.textContent = 'Open your Linkerlee account ↗';
}

function renderChips(): void {
  selectedTagsEl.replaceChildren();

  const append = (label: string, onRemove: () => void, isNew: boolean): void => {
    const chip = document.createElement('span');
    chip.className = isNew ? 'chip chip-new' : 'chip';
    chip.textContent = label;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${label}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      onRemove();
      renderChips();
    });
    chip.append(remove);
    selectedTagsEl.append(chip);
  };

  for (const id of selectedIds) {
    const tag = allTags.get(id);
    if (!tag) continue;
    append(tag.name, () => selectedIds.delete(id), false);
  }
  for (const name of newTagNames) {
    append(name, () => newTagNames.delete(name), true);
  }

  syncDraftState();
}

function isAlreadySelected(name: string): boolean {
  const norm = normalize(name);
  if (newTagNames.has(norm)) return true;
  for (const id of selectedIds) {
    if (normalize(allTags.get(id)?.name ?? '') === norm) return true;
  }
  return false;
}

function tagExistsByName(name: string): boolean {
  const norm = normalize(name);
  for (const tag of allTags.values()) {
    if (normalize(tag.name) === norm) return true;
  }
  return false;
}

function renderDropdown(): void {
  const query = tagSearchInput.value;
  const normQuery = normalize(query);

  const matches = [...allTags.values()]
    .filter((tag) => !selectedIds.has(tag.id))
    .filter((tag) => (normQuery ? normalize(tag.name).includes(normQuery) : true))
    .slice(0, 8);

  tagSuggestionsList.replaceChildren();

  for (const tag of matches) {
    const li = document.createElement('li');
    li.textContent = tag.name;
    li.addEventListener('mousedown', (event) => {
      event.preventDefault();
      selectedIds.add(tag.id);
      tagSearchInput.value = '';
      renderChips();
      renderDropdown();
    });
    tagSuggestionsList.append(li);
  }

  const canCreate =
    normQuery.length > 0 && !tagExistsByName(normQuery) && !isAlreadySelected(normQuery);
  if (canCreate) {
    const li = document.createElement('li');
    li.className = 'create-option';
    li.textContent = `+ Create “${normQuery}”`;
    li.addEventListener('mousedown', (event) => {
      event.preventDefault();
      createNewTag(normQuery);
    });
    tagSuggestionsList.append(li);
  }

  tagSuggestionsList.hidden = tagSuggestionsList.childElementCount === 0;
}

function createNewTag(name: string): void {
  const norm = normalize(name);
  if (norm === '' || isAlreadySelected(norm)) return;
  newTagNames.add(norm);
  tagSearchInput.value = '';
  renderChips();
  renderDropdown();
}

titleInput.addEventListener('input', () => {
  titleTouched = true;
  syncDraftState();
});

tagSearchInput.addEventListener('focus', renderDropdown);
tagSearchInput.addEventListener('input', renderDropdown);
tagSearchInput.addEventListener('blur', () => {
  setTimeout(() => {
    tagSuggestionsList.hidden = true;
  }, 100);
});
tagSearchInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const value = tagSearchInput.value.trim();
  if (value === '') return;
  if (tagExistsByName(value)) {
    const match = [...allTags.values()].find(
      (tag) => normalize(tag.name) === normalize(value),
    );
    if (match && !selectedIds.has(match.id)) {
      selectedIds.add(match.id);
      tagSearchInput.value = '';
      renderChips();
      renderDropdown();
    }
    return;
  }
  createNewTag(value);
});

function setTagsStatus(text: string, kind: 'muted' | 'error' = 'muted'): void {
  tagsStatusEl.textContent = text;
  tagsStatusEl.className = kind;
}

function setFormStatus(text: string, kind: 'muted' | 'error' | 'ok' = 'muted'): void {
  formStatusEl.textContent = text;
  formStatusEl.className = kind;
}

function snapshot(): FormState {
  return {
    title: titleInput.value,
    tagIds: [...selectedIds],
    newTags: [...newTagNames],
  };
}

function serialize(state: FormState): string {
  return JSON.stringify({
    title: state.title.trim(),
    tagIds: [...state.tagIds].sort((a, b) => a - b),
    newTags: [...state.newTags].sort(),
  });
}

/**
 * Writes the banner without re-announcing an unchanged sentence to a screen
 * reader — role="status" makes every textContent write a live-region update.
 *
 * The element stays in the tree and empties instead of toggling `hidden` (CSS
 * collapses it when empty): screen readers vary in whether they announce a live
 * region that was hidden at the moment its text changed.
 */
function setDraftWarning(text: string, kind: 'warn' | 'error' = 'warn'): void {
  draftWarning.className = kind === 'warn' ? 'banner banner-warn' : 'banner banner-error';
  if (draftWarning.textContent !== text) draftWarning.textContent = text;
}

function clearDraftWarning(): void {
  setDraftWarning('');
}

function droppedTagsNote(dropped: number): string {
  return dropped === 1
    ? ' 1 tag no longer exists and was dropped.'
    : ` ${dropped} tags no longer exist and were dropped.`;
}

/** A message that survives the dirty/clean cycle — the feature itself is off or
 *  degraded, which the user cannot discover any other way. */
function showNotice(text: string): void {
  notice = text;
  setDraftWarning(text);
}

/**
 * Single funnel for "does the form differ from what was loaded". Compares
 * against the baseline rather than tracking a mutation flag, so undoing a change
 * (adding a tag and removing it again) goes back to clean.
 *
 * Called from renderChips(), which every tag mutation already routes through,
 * and from the title input. Inert until init() has finished restoring, so the
 * loading form neither warns nor overwrites the draft it is about to read.
 */
function syncDraftState(): void {
  if (!draftReady || baseline === null || draftUrl === null) return;

  const current = snapshot();
  const base = baseline;
  const url = draftUrl;
  const dirty = serialize(current) !== serialize(base);
  // Storage settles after the fact, by which time the form may have moved on. A
  // late failure must not paint a banner contradicting what is on screen now.
  const generation = ++syncGeneration;

  saveBtn.classList.toggle('dirty', dirty);

  if (!dirty) {
    restored = false;
    restoreNote = '';
    if (notice !== null) setDraftWarning(notice);
    else clearDraftWarning();

    clearDraft(url).catch((err: unknown) => {
      console.warn('[linkerlee] failed to drop the saved draft', err);
      if (generation !== syncGeneration) return;
      setDraftWarning(
        'Changes you undid may come back the next time you open this popup.',
        'error',
      );
    });
    return;
  }

  // Stays on the restored wording until the form goes clean again: further edits
  // on top of a restored draft are still unsaved changes the popup brought back.
  setDraftWarning(
    restored
      ? `Restored unsaved changes — not saved to Linkerlee yet.${restoreNote}`
      : 'Unsaved changes — click Save to keep them.',
  );

  // Written on every change rather than on close: the popup is torn down without
  // warning, and an unload-time storage write would not reliably land.
  saveDraft(url, { state: current, base, savedAt: Date.now() }).catch((err: unknown) => {
    console.warn('[linkerlee] failed to keep a draft', err);
    if (generation !== syncGeneration) return;
    // The banner promises the work comes back. It will not — say so, because the
    // popup console this was logged to dies with the popup.
    setDraftWarning("Couldn't keep a copy of these changes — save now or lose them.", 'error');
  });
}

/** Re-apply a draft left behind when the popup was dismissed. See mergeDraft()
 *  for why it is folded in as a delta rather than replayed wholesale. */
async function restoreDraft(url: string, loaded: FormState): Promise<void> {
  const draft = await getDraft(url);
  if (!draft) return;

  const merged = mergeDraft(draft, loaded, (id) => allTags.has(id));

  // The dropdown is live by the time the read above resolves, so the user may
  // have picked a tag while it was in flight. Same protection the title and the
  // new-tag names already get.
  const pickedMeanwhile = [...selectedIds].filter((id) => !loaded.tagIds.includes(id));

  // A name that has since become a real tag is selected as that tag rather than
  // created again — every interactive path enforces the same rule, and the
  // server would otherwise be asked to create a duplicate.
  const restoredNames: string[] = [];
  const promoted: number[] = [];
  for (const name of new Set([...merged.state.newTags, ...newTagNames])) {
    const match = [...allTags.values()].find((tag) => normalize(tag.name) === normalize(name));
    if (match) promoted.push(match.id);
    else restoredNames.push(name);
  }

  const candidate: FormState = {
    // Never overwrite something the user is already typing.
    title: titleTouched ? titleInput.value : merged.state.title,
    tagIds: [...new Set([...merged.state.tagIds, ...pickedMeanwhile, ...promoted])],
    newTags: restoredNames,
  };

  // The link may have been saved elsewhere since; if the draft no longer adds
  // anything, drop it rather than warning about nothing.
  if (serialize(candidate) === serialize(loaded)) {
    await clearDraft(url);
    // Unless the only reason it adds nothing is that its tags were deleted —
    // staying quiet there would read as "there was never anything pending".
    if (merged.dropped > 0) {
      showNotice(`Unsaved tags from earlier couldn't be restored:${droppedTagsNote(merged.dropped)}`);
    }
    return;
  }

  titleInput.value = candidate.title;
  selectedIds.clear();
  for (const id of candidate.tagIds) selectedIds.add(id);
  newTagNames.clear();
  for (const name of candidate.newTags) newTagNames.add(name);

  restored = true;
  restoreNote = merged.dropped > 0 ? droppedTagsNote(merged.dropped) : '';
  renderChips();
}

function applyExistingLink(link: ExistingLink): void {
  existing = link;
  if (link.title) {
    // This lands after a network round trip, by which time the user may already
    // be typing — take the server's title as the baseline either way, but only
    // put it in the field if it isn't going to overwrite them.
    if (!titleTouched) titleInput.value = link.title;
    if (baseline !== null) baseline = { ...baseline, title: link.title };
  }
  for (const tag of link.tags) {
    allTags.set(tag.id, tag);
    selectedIds.add(tag.id);
  }
  if (baseline !== null) baseline = { ...baseline, tagIds: link.tags.map((tag) => tag.id) };
  // `existing` is what the pill reads for the bookmark half of its answer.
  renderStatusPill();
  saveBtn.textContent = 'Update';
  // Only reachable once we know there is something to remove.
  removeBtn.hidden = false;
}

async function init(): Promise<void> {
  const cfg = await getConfig();

  // Both of these are set before the setup branch below, which returns early:
  // the setup screen needs a working link to where the token is generated, and
  // it is just as much a place where the destination host should be named.
  // Through hostLabel(), never new URL() directly: a stored base URL is not
  // guaranteed to parse, and a throw here would leave the popup showing neither
  // the form nor the setup screen — including the button that opens Options.
  const host = hostLabel(cfg.baseUrl);
  if (host !== null && !isDefaultHost(cfg.baseUrl)) {
    // A redirected instance receives the token and the URL of everything saved,
    // so it should never be something the user has to go looking for.
    hostBanner.textContent = `Saving to ${host}`;
  }

  platformLink.href = platformUrl(cfg.baseUrl);

  // Every local refusal apiFetch() would make, asked before the form is built:
  // a missing token, an unusable base URL, or a host grant that was declined or
  // later withdrawn all leave a form that cannot save anything. Showing it
  // anyway invites the user to pick tags and type a title, then answers with an
  // error on Save — and, in the withdrawn-grant case, tells them nothing about
  // where the fix is.
  let problem: SetupProblem | null = null;
  try {
    problem = await checkSetup(cfg);
  } catch (err) {
    // Fail open. A permissions query that throws is not evidence the extension
    // is unconfigured, and hiding the form over it would leave the popup with
    // nothing on screen but a setup notice that may be wrong. apiFetch() makes
    // the same three checks before anything reaches the network, so the worst
    // case is the old behaviour: an error on Save rather than one up front.
    console.warn('[linkerlee] could not check whether the extension is set up', err);
  }
  if (problem !== null) {
    showSetup(setupMessage(problem, host));
    return;
  }
  showForm();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // The same rule the badge uses. Skipping only chrome:// and
  // chrome-extension:// left about: and file:// pages to be sent for tag
  // suggestions and bookmark lookup — a local file path is not something to hand
  // a server.
  if (!isSaveableUrl(tab?.url)) {
    setFormStatus('No saveable URL in the active tab.', 'error');
    saveBtn.disabled = true;
    return;
  }

  activeTabId = tab.id ?? null;
  urlInput.value = tab.url;
  if (!titleTouched) titleInput.value = tab.title ?? '';
  draftUrl = tab.url;
  baseline = { title: tab.title ?? '', tagIds: [], newTags: [] };
  renderChips();

  setTagsStatus('Loading…');

  const [tagsResult, existingResult, suggestionsResult] = await Promise.allSettled([
    getAllTags(),
    findLink(tab.url),
    suggestTags(tab.url),
  ]);

  if (tagsResult.status === 'fulfilled') {
    // The first proof that the server is actually there — the badge has said
    // "Syncing…" until now.
    setConnection('ok');
    for (const tag of tagsResult.value) {
      allTags.set(tag.id, tag);
    }
    if (allTags.size === 0) {
      noTagsHint.hidden = false;
    }
  } else {
    handleApiFailure(tagsResult.reason, 'Failed to load tags');
    // Without the catalogue a selected tag can't be rendered or validated, so
    // drafts stay off rather than overwriting a good one with a half-loaded
    // form. Say so — silently dropping the protection is what this feature is
    // meant to stop.
    showNotice("Tags didn't load — changes here won't be kept if you close this.");
    return;
  }

  if (existingResult.status === 'fulfilled') {
    if (existingResult.value) applyExistingLink(existingResult.value);
  } else {
    // findLink already turns the expected 404 into null, so a rejection here is
    // a real fault. Saying nothing lets the badge read "Connected" with no
    // "Already saved" beside it, which the user reads as "this page is not
    // saved yet" — and Save then creates a duplicate.
    handleApiFailure(existingResult.reason, "Couldn't check whether this page is already saved");
    showNotice('Could not tell whether this page is already saved — saving may create a second copy.');
  }

  if (suggestionsResult.status === 'fulfilled') {
    // Into the catalogue either way, so a suggested tag picked in an earlier
    // popup can still be named — and therefore restored — in edit mode.
    for (const tag of suggestionsResult.value) {
      allTags.set(tag.id, tag);
    }
    if (!existing) {
      for (const tag of suggestionsResult.value) {
        selectedIds.add(tag.id);
      }
      if (baseline !== null) baseline = { ...baseline, tagIds: [...selectedIds] };
    }
    setTagsStatus(
      existing
        ? `${selectedIds.size} attached`
        : suggestionsResult.value.length > 0
          ? `${suggestionsResult.value.length} suggested`
          : 'No suggestions',
    );
  } else {
    setTagsStatus('Suggestions unavailable', 'error');
  }

  renderChips();

  try {
    if (baseline !== null) await restoreDraft(tab.url, baseline);
  } catch (err) {
    // Malformed records are already dropped on read, so this is a real fault —
    // don't block the form over it, but don't let the user assume a clean popup
    // means there was nothing pending either.
    console.warn('[linkerlee] failed to restore the saved draft', err);
    showNotice("Couldn't check for unsaved changes from earlier.");
  }

  // Only now: a change made from here on is the user's, and the draft that was
  // on disk has had its chance to come back. Removing is armed at the same
  // moment, so it can never run against a draft that has not been read yet.
  draftReady = true;
  removeBtn.disabled = false;
  syncDraftState();
}

/**
 * Move the header pill to match a failure.
 *
 * Status 0 is not one condition: apiFetch refuses locally for a missing token,
 * an unusable base URL and a missing host grant, and only the fourth case is a
 * dead network. `local` tells them apart, because "Offline" sends someone to
 * check their Wi-Fi over a problem that is fixed on the options page.
 *
 * A 4xx that is not an auth failure stays out of the badge — a 422 on one field
 * says nothing about whether Linkerlee is reachable, and belongs in the form
 * status alone.
 */
function reflectFailureInPill(err: unknown): void {
  if (!(err instanceof ApiError)) return;
  if (err.status === 401 || err.status === 403) {
    setConnection('auth');
  } else if (err.status === 0) {
    setConnection(err.local ? 'blocked' : 'offline', err.message);
  } else if (err.status >= 500) {
    // Reachable, but not answering. Left out of the badge entirely, this was
    // the one failure that could put a green "Connected" beside a red error.
    setConnection('server', err.message);
  }
}

/**
 * Surface a failed write: a field error if the server gave one, else its
 * message. Returns whether it was an auth failure, which the caller uses to
 * leave the button disabled — retrying with the same bad token cannot help.
 */
function reportWriteFailure(err: unknown): boolean {
  reflectFailureInPill(err);
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) {
      // The one failure the user can act on — say how, as init() does, rather
      // than passing through whatever the server said.
      setFormStatus('Auth failed. Update your token in options.', 'error');
      return true;
    }
    const firstFieldError = Object.values(err.fieldErrors)[0]?.[0];
    setFormStatus(firstFieldError ?? err.message, 'error');
    return false;
  }
  setFormStatus((err as Error).message, 'error');
  return false;
}

function handleApiFailure(err: unknown, prefix: string): void {
  reflectFailureInPill(err);
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
    setFormStatus('Auth failed. Update your token in options.', 'error');
    saveBtn.disabled = true;
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  setFormStatus(`${prefix}: ${message}`, 'error');
}

function showRemoveConfirm(show: boolean): void {
  // The whole row swaps to the question: "Save" sitting beside "Remove this
  // bookmark? Remove Cancel" reads as a third answer to it, and does not fit
  // the popup's width either.
  removeConfirm.hidden = !show;
  removeBtn.hidden = show;
  saveBtn.hidden = show;
}

removeBtn.addEventListener('click', () => {
  showRemoveConfirm(true);
  // Land on Cancel, so a stray Enter or Space does not confirm the destructive
  // half of a question the user has only just been asked.
  removeNoBtn.focus();
});

removeNoBtn.addEventListener('click', () => {
  showRemoveConfirm(false);
  removeBtn.focus();
});

removeYesBtn.addEventListener('click', async () => {
  if (busy || existing === null || draftUrl === null) return;

  busy = true;
  removeYesBtn.disabled = true;
  removeNoBtn.disabled = true;
  setFormStatus('Removing…');

  const url = draftUrl;

  try {
    await deleteLink(existing.id);
  } catch (err) {
    // Already gone is the outcome the user asked for, not a failure.
    if (!(err instanceof ApiError && err.status === 404)) {
      const authFailed = reportWriteFailure(err);
      busy = false;
      removeNoBtn.disabled = false;
      removeYesBtn.disabled = authFailed;
      removeBtn.disabled = authFailed;
      // The button that took the click is gone or disabled; leave focus
      // somewhere useful rather than on <body>.
      removeNoBtn.focus();
      return;
    }
  }

  setFormStatus('Removed. Recoverable from your Linkerlee trash.', 'ok');

  // Back to an unsaved page, so nothing here is an unsaved edit any more.
  // Cleared directly rather than through the dirty check: syncDraftState() is
  // inert until init() finishes, and the button is reachable before that — a
  // draft left behind would be restored onto a bookmark that no longer exists.
  existing = null;
  restored = false;
  restoreNote = '';
  notice = null;
  baseline = snapshot();
  clearDraftWarning();
  saveBtn.classList.remove('dirty');
  clearDraft(url).catch((err: unknown) => {
    console.warn('[linkerlee] failed to drop the draft of a removed link', err);
  });

  showRemoveConfirm(false);
  removeBtn.hidden = true;
  // `existing` was just cleared, so the pill drops "Already saved" on its own —
  // and the delete that got us here proves the connection is fine.
  setConnection('ok');
  saveBtn.textContent = 'Save';
  // The form still holds the removed link's tags, and `existing` is now null, so
  // a click here would re-create what was just deleted.
  saveBtn.disabled = true;

  if (activeTabId !== null) {
    chrome.runtime.sendMessage({
      type: 'refresh-badge',
      tabId: activeTabId,
      url: urlInput.value,
    });
  }
  // Longer than the save path's: this is the only place the user is told the
  // removal can be undone.
  setTimeout(() => window.close(), 1600);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  // A hidden submit button is still the form's default button, so Enter in the
  // title would otherwise save the very bookmark the user is being asked about.
  if (busy || !removeConfirm.hidden) return;

  busy = true;
  saveBtn.disabled = true;
  removeBtn.disabled = true;
  setFormStatus(existing ? 'Updating…' : 'Saving…');

  // Read before the request, not after it: the form stays editable while the
  // request is in flight, and this is what actually reaches the server.
  const submitted = snapshot();
  let saved = false;

  try {
    if (existing) {
      await updateLink(existing.id, {
        title: submitted.title.trim() || undefined,
        tags: submitted.tagIds,
        newTags: submitted.newTags,
      });
      setFormStatus('Updated.', 'ok');
    } else {
      await createLink({
        link: urlInput.value,
        title: submitted.title.trim() || undefined,
        tags: submitted.tagIds,
        newTags: submitted.newTags,
      });
      setFormStatus('Saved.', 'ok');
    }
    saved = true;
  } catch (err) {
    saveBtn.disabled = reportWriteFailure(err);
    removeBtn.disabled = saveBtn.disabled;
    busy = false;
  }

  // Outside the try: a fault in this bookkeeping must not be reported as a
  // failed save, which would have the user click Save again and duplicate it.
  if (!saved) return;

  // The write went through, so whatever the badge was complaining about is over
  // — without this a retry that succeeds leaves a red "Offline" in the header
  // beside a green "Saved." below it.
  setConnection('ok');

  // What was submitted is on the server now, so it becomes the baseline. The
  // funnel then clears the stored draft — or keeps one, if the user carried on
  // typing while the request was in flight.
  baseline = submitted;
  restored = false;
  restoreNote = '';
  notice = null;
  // Clear first: in the degraded mode where drafts never came up, syncDraftState
  // is inert and would leave the old notice on screen.
  clearDraftWarning();
  syncDraftState();

  if (activeTabId !== null) {
    chrome.runtime.sendMessage({
      type: 'refresh-badge',
      tabId: activeTabId,
      url: urlInput.value,
    });
  }
  setTimeout(() => window.close(), 800);
});

void init();
