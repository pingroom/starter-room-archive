# PingRoom room archive

Export the history currently visible to a PingRoom connection for one closed UTC day, then search the saved text offline. Use it to keep local release notes, decisions, and room updates alongside your project.

**Free accounts expose only the latest 100 visible pings across the connection’s granted feed, before room and date filters.** An older day can return no rows even when pings existed. Pro provides deeper historical access, but permissions, deletions, and changing pagination still prevent a completeness guarantee. This is an archive of observations, not a certified backup or audit log.

## Try it offline

Use this repository as a GitHub template or clone it. Requires Node.js 22 or later.

```sh
npm ci
npm run demo
npm test
```

The demo uses the real pinned `@pingroom/sdk` 0.7.1 with a local mock transport. It scans twice, merges the same notification ID, searches the result, and removes its temporary files. It needs no credentials and makes no network requests.

## Connect and export

1. Install [PingRoom](https://pingroom.io/i), sign in, and create or join the room you want to archive.
2. Run `npm run connect`. Open the displayed pairing link and grant the connection access to that room. The link is reused while that invocation waits for approval.
3. Export a past UTC day, then search locally:

```sh
npm start -- 2026-10-14
npm run search -- "release notes"
```

The date must be earlier than today in UTC. Export calls `rooms.get(roomCode)` to resolve the room UUID, then `notifications.list({ room_id, date, limit: 25, page })`. Export makes only GET requests; it sends no pings and changes no room configuration. Search makes no API requests and needs no credentials.

Pairing saves the returned home room and credential in ignored `.pingroom/credentials.json`. On POSIX systems, the file uses mode `0600` inside a `0700` directory. Keep the checkout in your private user directory on Windows.

For a different granted room or CI, copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM`. The defined environment pair overrides saved credentials; a blank or partial pair is rejected. Room codes are normalized to uppercase. `.env` loads automatically; existing environment values take precedence. On POSIX systems, protect `.env` with `chmod 600 .env`.

## What is saved

`archive/YYYY-MM-DD.json` contains notification IDs, timestamps, message, title (`notification_title` from history), room code, visible sender ID/name, action number/source, and question prompt/state when present. Each row records when it was first and last observed. Redacted sender details remain absent; the exporter does not infer them from other fields.

Structured `data`, full-message extensions, attachment metadata and bytes, room details, and API credentials are excluded. Titles, messages, sender names, and question prompts can still contain sensitive text. Local copies survive later server deletion, redaction, or loss of access; manage their retention and permissions yourself. Files are private and ignored by Git, but are not encrypted. Use a private local directory; symlinked input files are rejected.

Search matches a literal, case-insensitive phrase in message, title, sender name, or question prompt. It reads the newest 365 day files and returns at most 50 matches as JSON, escaping terminal control characters. `truncated` tells you when the search bounds omit days or matches.

## Rescans and limits

Every invocation starts at page 1. It merges by notification ID, updates rows observed again, and preserves previously observed rows that are absent from a later response. Absence is not treated as deletion. It saves after each successful page using an atomic file replacement; it does not keep a revision history of changed text.

The final overlapping page-1 read can detect a changed head or total. Offset pages can still shift without detection. `scan_finished` means the visible page walk and head check finished; it never means all historical pings were recovered. `partial` records a request failure, cancellation, detected drift, or a bound being reached. A zero-row result carries the same limitations.

Defaults and fixed bounds:

- Up to 40 pages of 25 rows, plus one overlapping head read and one room lookup: at most 42 API requests per scan. Set `ARCHIVE_MAX_PAGES` from 1 to 40 to lower this bound.
- At most 10,000 retained records per day and 16 MiB per local JSON file. Each save rewrites the whole day file; this starter is intended for modest local archives.
- Five-second SDK request timeouts. This SDK’s history list has no abort-signal parameter; Ctrl-C stops after the current request settles. A ten-second shutdown watchdog may leave a lock after forced termination.

Exit status is `0` for `scan_finished`, `2` for `partial`, and `1` for setup/storage failure. SIGINT/SIGTERM use `130`/`143`. Inspect `scan.reason`, `drift_detected`, and the page/request counts in the JSON output. Rerun the same day to collect newly visible rows; repeated reads cannot recover data the API no longer exposes.

## Adapt it

Point `ARCHIVE_DIR` at your project’s private archive directory. Import `archiveDay` from `src/archive.js` into a scheduled local script and pass an explicit closed UTC day. Keep the bounded SDK timeout when supplying your own client. Schedule repeated recent-day exports only if that retention policy suits your team; no scheduler is installed by this template.

`archive/scope.json` binds the directory to a hash of the credential and room code, plus the resolved room UUID. A different credential, rotated token, or different room requires a new `ARCHIVE_DIR`. Do not delete the binding to combine unrelated archives. Keep an old directory for offline search by setting `ARCHIVE_DIR` before `npm run search`.

If a prior process crashed, inspect `.lock/owner.json` and confirm that process has stopped before manually removing only the `.lock` directory. Then rerun the same day; a saved `running` status is safe to rescan from page 1. Invalid JSON, mismatched scope, or invalid saved rows are rejected without overwriting the archive. Restore the affected files from your own backup or use a new directory. Atomic replacement protects against interrupted writes; it is not a database or power-loss recovery guarantee.

If pairing or reading fails, confirm that the connection still has the room grant and that the paired account can see the history in PingRoom. Empty results on Free may reflect the feed-wide 100-ping cap. Pairing and actual plan visibility are not exercised by offline tests.

## Development

`npm test` checks the real SDK’s HTTP paths and query parameters, duplicate IDs, restarts, partial scans, drift, corrupted files, scope changes, cancellation, private credentials, and escaped offline search. CI runs tests and the offline demo on Node 22 and 24. See the [official SDK](https://github.com/pingroom/sdk) for additional API capabilities.

Related templates: [daily digest](https://github.com/pingroom/starter-daily-digest), [room action runner](https://github.com/pingroom/starter-room-action-runner), and [artifact delivery](https://github.com/pingroom/starter-artifact-delivery).

MIT licensed.
