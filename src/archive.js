import { join } from 'node:path';
import { UUID, roomCode, sha256 } from './config.js';
import { acquireLock, atomicJson, readJson } from './storage.js';

const MAX_RECORDS = 10_000;
const statuses = new Set(['running', 'scan_finished', 'partial']);

export function validateDay(day, now = new Date()) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Supply a closed UTC day as YYYY-MM-DD.');
  const parsed = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day || day >= now.toISOString().slice(0, 10)) throw new Error('The date must be valid and earlier than today in UTC.');
  return day;
}

function nullableString(value, maxLength) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > maxLength) throw new Error('Unexpected notification text.');
  return value;
}

function onlyKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
}

function timestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

function project(event, code, roomId, day) {
  if (!event || !UUID.test(event.id ?? '') || typeof event.message !== 'string' || event.message.length > 1024
    || event.room?.id !== roomId || typeof event.room?.code !== 'string' || roomCode(event.room.code) !== code
    || typeof event.created_at !== 'string' || !Number.isFinite(Date.parse(event.created_at))
    || new Date(event.created_at).toISOString().slice(0, 10) !== day) throw new Error('Notification does not match this room and UTC day.');
  const senderId = event.sender?.id ?? null;
  if (senderId !== null && !UUID.test(senderId)) throw new Error('Invalid sender identity.');
  const action = event.action_number ?? null;
  if (action !== null && (!Number.isInteger(action) || action < 1 || action > 16)) throw new Error('Invalid action slot.');
  return {
    id: event.id, created_at: event.created_at, room_code: code, message: event.message,
    title: nullableString(event.notification_title, 200),
    sender: { id: senderId, name: nullableString(event.sender?.name, 160) },
    action_number: action, trigger_source: nullableString(event.trigger_source, 40),
    question: event.question == null ? null : { prompt: nullableString(event.question.prompt, 500), state: nullableString(event.question.state, 40) },
  };
}

export function validateArchive(state, day, scope) {
  if (!state || state.version !== 1 || state.day !== day || state.scope !== scope || !UUID.test(state.room_id ?? '')
    || !Array.isArray(state.records) || state.records.length > MAX_RECORDS || !statuses.has(state.scan?.status)
    || typeof state.room_code !== 'string' || roomCode(state.room_code) !== state.room_code
    || !Number.isInteger(state.scan.history_requests) || state.scan.history_requests < 0
    || !Number.isInteger(state.scan.pages_scanned) || state.scan.pages_scanned < 0) throw new Error('Saved archive is invalid or belongs to another connection. Restore it before continuing.');
  const seen = new Set();
  for (const record of state.records) {
    if (!onlyKeys(record, ['id', 'created_at', 'room_code', 'message', 'title', 'sender', 'action_number', 'trigger_source', 'question', 'first_observed_at', 'last_observed_at']) || !UUID.test(record.id ?? '') || seen.has(record.id) || typeof record.message !== 'string'
      || typeof record.created_at !== 'string' || !Number.isFinite(Date.parse(record.created_at))
      || new Date(record.created_at).toISOString().slice(0, 10) !== day
      || record.room_code !== state.room_code || !onlyKeys(record.sender, ['id', 'name'])
      || (record.question !== null && !onlyKeys(record.question, ['prompt', 'state']))
      || !timestamp(record.first_observed_at) || !timestamp(record.last_observed_at)) throw new Error('Saved archive records are invalid. Restore the file before continuing.');
    project({ ...record, notification_title: record.title, room: { id: state.room_id, code: state.room_code } }, state.room_code, state.room_id, day);
    seen.add(record.id);
  }
}

function pageRecords(page, expectedPage, code, roomId, day) {
  if (!page || page.current_page !== expectedPage || page.per_page !== 25 || !Number.isInteger(page.total) || page.total < 0
    || !Number.isInteger(page.last_page) || page.last_page < 1 || !Array.isArray(page.data) || page.data.length > 25) throw new Error('Invalid history pagination response.');
  return page.data.map((event) => project(event, code, roomId, day));
}

/** Read-only scan of the current visible history; never a snapshot guarantee. */
export async function archiveDay({ client, room, tokenFingerprint, day, root, maxPages = 40, signal, now = new Date() }) {
  validateDay(day, now);
  const code = roomCode(room);
  if (!client?.rooms?.get || !client?.notifications?.list || !tokenFingerprint || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 40) throw new Error('Supply a client, connection fingerprint, and a page budget from 1 to 40.');
  signal?.throwIfAborted();
  const scope = sha256(JSON.stringify({ tokenFingerprint, room: code }));
  const release = await acquireLock(root);
  try {
    const binding = await readJson(join(root, 'scope.json'));
    if (binding && (binding.version !== 1 || binding.scope !== scope || binding.room_code !== code || !UUID.test(binding.room_id ?? ''))) throw new Error('Archive directory belongs to another connection or room. Choose a new ARCHIVE_DIR; do not overwrite its binding.');
    let state = await readJson(join(root, `${day}.json`));
    if (state) validateArchive(state, day, scope);
    if (state && !binding) throw new Error('Archive binding is missing. Restore scope.json before continuing.');
    if (state && (state.room_id !== binding.room_id || state.room_code !== binding.room_code)) throw new Error('Saved archive does not match its room binding. Restore it before continuing.');
    signal?.throwIfAborted();
    const resolved = await client.rooms.get(code);
    if (!UUID.test(resolved?.id ?? '') || typeof resolved.invite_code !== 'string' || roomCode(resolved.invite_code) !== code
      || (binding && binding.room_id !== resolved.id)) throw new Error('Resolved room does not match the archive binding.');
    signal?.throwIfAborted();
    if (!binding) await atomicJson(root, 'scope.json', { version: 1, scope, room_code: code, room_id: resolved.id });
    const records = new Map((state?.records ?? []).map((record) => [record.id, record]));
    const scan = {
      status: 'running', started_at: new Date().toISOString(), finished_at: null,
      pages_scanned: 0, history_requests: 0, rows_observed: 0, duplicate_rows: 0,
      first_total: null, last_total: null, head_before: null, head_after: null,
      drift_detected: false, reason: null,
    };
    state = { version: 1, scope, room_code: code, room_id: resolved.id, day, records: [], scan };
    const seenThisScan = new Set();
    const save = async () => {
      state.records = [...records.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      await atomicJson(root, `${day}.json`, state);
    };
    const merge = (items) => {
      if (records.size + items.filter((item) => !records.has(item.id)).length > MAX_RECORDS) throw new Error('Daily archive record limit reached.');
      const observed = new Date().toISOString();
      for (const item of items) {
        if (seenThisScan.has(item.id)) scan.duplicate_rows += 1;
        seenThisScan.add(item.id);
        scan.rows_observed += 1;
        const previous = records.get(item.id);
        records.set(item.id, { ...item, first_observed_at: previous?.first_observed_at ?? observed, last_observed_at: observed });
      }
    };
    const request = async (pageNumber) => {
      signal?.throwIfAborted();
      scan.history_requests += 1;
      const page = await client.notifications.list({ room_id: resolved.id, date: day, limit: 25, page: pageNumber });
      signal?.throwIfAborted();
      const items = pageRecords(page, pageNumber, code, resolved.id, day);
      return { page, items };
    };
    await save();
    let reachedEnd = false;
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      let current;
      try { current = await request(pageNumber); }
      catch { scan.reason = signal?.aborted ? 'cancelled' : 'request_or_response_failed'; break; }
      const { page, items } = current;
      if (scan.first_total === null) {
        scan.first_total = page.total;
        scan.head_before = items[0]?.id ?? null;
      } else if (page.total !== scan.first_total) scan.drift_detected = true;
      scan.last_total = page.total;
      try { merge(items); }
      catch { scan.reason = 'record_limit'; break; }
      scan.pages_scanned += 1;
      await save();
      if (items.length === 0 && pageNumber < page.last_page) { scan.reason = 'pagination_changed'; scan.drift_detected = true; break; }
      if (pageNumber >= page.last_page) { reachedEnd = true; break; }
    }
    if (!reachedEnd && !scan.reason) scan.reason = 'page_limit';
    // One overlapping head read catches common insert/delete shifts. A stable
    // head still cannot prove a consistent snapshot across offset pages.
    if (reachedEnd) {
      try {
        const { page, items } = await request(1);
        merge(items);
        scan.head_after = items[0]?.id ?? null;
        scan.last_total = page.total;
        if (scan.head_before !== scan.head_after || scan.first_total !== page.total) scan.drift_detected = true;
      } catch { scan.reason = signal?.aborted ? 'cancelled' : 'head_recheck_failed'; }
    }
    if (scan.drift_detected && !scan.reason) scan.reason = 'pagination_changed';
    scan.status = scan.reason ? 'partial' : 'scan_finished';
    scan.finished_at = new Date().toISOString();
    await save();
    return { path: join(root, `${day}.json`), day, stored_records: records.size, scan: { ...scan } };
  } finally { await release(); }
}
