# Changelog

All notable user-facing changes to the Linkerlee Bookmarker extension.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version
here must match `version` in both `package.json` and `manifest.json` — bump all three
together, or the built extension ships mislabelled.

Issue keys refer to the `COW` project in Linear.

## [0.9.4] — 2026-08-28

### Changed

- The popup and the options page have a look of their own. Both were drawn in
  the browser's own system colours, which made the extension read as an
  unbranded dialog and shared nothing with the amber Linkerlee mark. They now
  use a warm palette built from that mark: a header carrying the logo and the
  page title, uppercase field labels, the current URL in a quiet read-only
  field, amber tag chips, a full-width Save button, and a footer with the
  account link and the version. The toolbar badge moved to the same amber. A
  hand-written dark palette replaces what the system colours used to give for
  free, so dark mode is still followed.
- The popup header now carries a status badge answering the two questions that
  change what Save will do: whether Linkerlee is reachable (Connected, Offline,
  Server error, Auth failed, Not connected) and whether this page is already
  bookmarked (Already saved). It replaces the "Already bookmarked — saving will
  update it." banner, which is still read out in full by screen readers and on
  hover. Connection failures used to surface only as an error line under the
  form, after the fact. The badge stays neutral until a request has actually
  come back — being configured is not the same as being reachable.

### Fixed

- The popup no longer implies a page is unsaved when it could not find out. If
  the lookup that decides "new bookmark or update?" failed, nothing said so, and
  Save quietly created a second copy of a page that was already bookmarked. That
  failure is now reported.
- "Offline" is no longer shown for problems that have nothing to do with the
  network. A missing token, an unusable base URL and a withdrawn host grant are
  all refused before a request is sent; they now read "Not connected" and point
  at the options page, where the fix actually is.

## [0.9.3] — 2026-08-20

### Fixed

- The popup no longer offers a save form when nothing can be saved. It treated
  "configured" as "has a token", but a request is refused locally in three
  cases: no token, a saved address that is not a usable https host, and a host
  grant that was declined or later withdrawn. The last two became reachable
  when self-hosted instances landed in 0.9.1 — the form appeared, tags were
  picked and a title typed, and only Save revealed that nothing could reach the
  server. The popup now asks all three questions up front and names the actual
  problem, pointing at the options page when a grant is missing.

## [0.9.2] — 2026-08-20

### Fixed

- The popup no longer sends the URL of a page on an internal scheme. Opening it
  on an `about:` page in Firefox, or on a `file://` page in either browser, sent
  that URL to the tag-suggestion and bookmark-lookup endpoints — including the
  path of a local file. The saved-link badge had always refused those; the popup
  skipped only `chrome://` and `chrome-extension://`, and the two had drifted.
  Both now share one rule, which admits http(s) pages and nothing else. The
  privacy policy already promised this behaviour. (COW-57)

  Note this means a `file://` page can no longer be saved from the popup. It
  could before, by sending the local path to the server.

## [0.9.1] — 2026-08-20

### Added

- The extension can reach a self-hosted Linkerlee. The Base URL field always
  accepted any address, but only `linkerlee.com` was ever permitted, so anything
  else failed as "Failed to fetch" — indistinguishable from a typo or a server
  being down. Entering another https address now asks the browser for access to
  that one host, and releases the previous one when it changes. Nothing is
  granted at install: the default configuration still talks only to
  linkerlee.com and prompts for nothing. (COW-56)
- The instance you are saving to is named in the popup and in the options page
  whenever it is not the default, so a redirected instance is visible rather
  than something you have to go looking for. (COW-56)

### Fixed

- A failure to reach the configured instance now says what is wrong — that the
  extension has not been allowed to reach that host, naming it — instead of
  "Failed to fetch". The saved-link badge, which runs on every tab switch with
  no interface of its own, logs the same rather than silently going blank.
  (COW-56)

### Security

- `http://` base URLs are refused: the API token would otherwise cross the
  network in plain text. So are addresses carrying credentials — a URL such as
  `https://linkerlee.com@example.invalid` reads as the trusted host and resolves
  to another — and hostnames that are not plain DNS labels, which is what keeps
  a request for one concrete host from ever widening into a wildcard. (COW-56)

## [0.9.0] — 2026-08-20

### Added

- Unsaved tag and title work is no longer lost when the popup closes. Clicking
  outside an extension popup destroys it instantly, and MV3 offers no cancellable
  close event, so a warning *at* close time is not possible. Instead the popup
  warns while it is open — a banner and a ring on Save as soon as the form differs
  from what was loaded — and keeps the draft, per URL, restoring it the next time
  you open the popup on that page. The draft is folded back in as a delta rather
  than replayed, because saving replaces the whole tag set and a stale replay would
  delete tags added on the platform in the meantime. (COW-50)
- A **Remove** button for a page that is already bookmarked, with an inline
  "Remove this bookmark?" confirmation rather than a native dialog, which an
  extension popup cannot show reliably. Removal is a soft delete and the status
  says so — the link is recoverable from your Linkerlee trash. Needs the platform
  running the matching `DELETE /api/links/{id}` endpoint. (COW-54)
- The extension version in the popup footer, on both the form and the
  not-yet-configured screen, read from the manifest so it cannot drift from what
  the browser installed. (COW-55)

### Fixed

- The popup no longer paints its form before the script runs, and the
  not-yet-configured screen no longer shows the whole form underneath its "this
  extension isn't configured yet" message. `form { display: grid }` outranked the
  browser's own `[hidden]` rule, so hiding the form did nothing. The same cascade
  bug had silently removed the entire confirmation step from the new Remove
  button. Hidden now means hidden. (COW-54)
- `npm run typecheck` passes again. A merge resolved an import conflict by keeping
  both sides, leaving `getConfig` imported twice; the build tolerated it, so
  nothing went red on the way in.

### Internal

- Vitest, with the draft merge, the draft prune and the stored-record validation
  under test — the logic where a mistake silently loses or deletes a user's tags.
  There is still no CI, so `npm test`, `npm run typecheck`, `npm run build` and
  `web-ext lint` remain a local discipline. (COW-53)

## [0.2.0] — 2026-08-18

### Added

- A link back to the Linkerlee platform in the popup, in a footer row below the save
  button. The popup was a dead end: after saving there was no route to your account.
  The same link appears on the not-yet-configured screen, which asked for an API
  token without saying the token is generated on the platform. Both follow the base
  URL configured in Options rather than a hardcoded host. (COW-48)

### Fixed

- The tag suggestion list no longer covers the save button. It was absolutely
  positioned, so it overlaid the save row as soon as it had more than a couple of
  entries; and because an absolutely positioned element adds no height, the popup
  never grew for it and a long list was clipped at the popup's bottom edge. It is now
  laid out in flow, reserving its own space while open and collapsing when closed, so
  the closed layout is unchanged. Note the save button now shifts down while the list
  is open. (COW-47)

## [0.1.0] — 2026-08-11

### Added

- Initial release. Save the current tab to Linkerlee from the toolbar popup, with the
  URL and page title pre-filled.
- Tag suggestions for the current page, plus search over your existing tags and
  creating new ones inline.
- Re-opening the popup on an already-bookmarked page loads its existing tags and
  switches the action to an update.
- Options page for the base URL and API token, with a **Test connection** check.
- A badge on the toolbar icon marking tabs whose link is already saved.
- Chrome (MV3) and Firefox builds from one source, with the Firefox background
  fallback applied at build time.
