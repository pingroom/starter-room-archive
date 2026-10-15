import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PingRoom } from '@pingroom/sdk';
import { archiveDay, validateDay } from '../src/archive.js';
import { acquireLock, readJson } from '../src/storage.js';
import { searchArchive, safeJson } from '../src/search-archive.js';
import { archiveConfig, loadConnection, saveConnection } from '../src/config.js';
import { errorSummary } from '../src/errors.js';

const day = '2020-01-02';
const roomId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const senderId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const id = (number) => `${String(number).padStart(8, '0')}-1111-1111-1111-111111111111`;
const event = (number, overrides = {}) => ({
  id: id(number), message: `Report ${number}`, notification_title: 'Release notes',
  created_at: `${day}T12:00:00.000Z`, room: { id: roomId, invite_code: 'TEAM' },
  sender: { id: senderId, name: 'Colleague', email: 'excluded@example.invalid' },
  action_number: 1, trigger_source: 'manual', question: null,
  ...overrides,
});
const page = (number, rows, total = rows.length, last = 1) => ({ current_page: number, per_page: 25, data: rows, total, last_page: last, next_page_url: null, prev_page_url: null });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function fixture(t, answer = (n) => page(n, [event(1)])) {
  const root = await mkdtemp(join(tmpdir(), 'pingroom-archive-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  let historyCalls = 0;
  const client = new PingRoom({ token: 'offline-only-secret', baseUrl: 'https://offline.invalid', timeoutMs: 1000, async fetch(input, options) {
    const url = new URL(input);
    assert.equal(options.method, 'GET', 'archive must not write to the API');
    calls.push(url);
    if (url.pathname === '/api/agent/rooms/TEAM') return response({ id: roomId, invite_code: 'TEAM' });
    assert.equal(url.pathname, '/api/agent/notifications');
    assert.deepEqual(Object.fromEntries(url.searchParams), { room_id: roomId, date: day, limit: '25', page: url.searchParams.get('page') });
    const result = await answer(Number(url.searchParams.get('page')), ++historyCalls);
    return result instanceof Response ? result : response(result);
  } });
  const options = { client, root, day, room: 'team', tokenFingerprint: 'credential-fingerprint' };
  return { root, calls, options, run: (overrides = {}) => archiveDay({ ...options, ...overrides }), state: () => readJson(join(root, `${day}.json`)) };
}

test('real SDK resolves uppercase room, reads exact paginated GET query, stores only allowed content', async (t) => {
  const f = await fixture(t, (n) => page(n, [event(1, {
    data: { token: 'do-not-archive' }, attachments: [{ url: 'https://private.invalid/file' }],
    question: { prompt: 'Ready to ship?', state: 'closed', responses: [{ secret: true }] },
  })]));
  const result = await f.run();
  assert.equal(result.scan.status, 'scan_finished');
  assert.equal(result.scan.pages_scanned, 1);
  assert.equal(result.scan.history_requests, 2);
  assert.equal(f.calls[0].pathname, '/api/agent/rooms/TEAM');
  const state = await f.state();
  assert.equal(state.records[0].sender.id, senderId);
  assert.equal(state.records[0].title, 'Release notes');
  assert.deepEqual(state.records[0].question, { prompt: 'Ready to ship?', state: 'closed' });
  const text = await readFile(join(f.root, `${day}.json`), 'utf8');
  for (const secret of ['offline-only-secret', 'do-not-archive', 'private.invalid', 'excluded@example.invalid', 'responses']) assert.ok(!text.includes(secret));
  assert.equal((await stat(f.root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.root, `${day}.json`))).mode & 0o777, 0o600);
});

test('duplicates across pages merge by ID and head read does not duplicate records', async (t) => {
  const f = await fixture(t, (n) => n === 1 ? page(n, [event(3), event(2)], 3, 2) : page(n, [event(2), event(1)], 3, 2));
  const result = await f.run();
  assert.equal(result.stored_records, 3);
  assert.equal(result.scan.duplicate_rows, 3);
  assert.deepEqual(f.calls.slice(1).map((url) => url.searchParams.get('page')), ['1', '2', '1']);
});

test('rescan restarts at page one, updates observed IDs, and retains rows absent from API', async (t) => {
  let rows = [event(1), event(2)];
  const f = await fixture(t, (n) => page(n, rows));
  await f.run();
  const firstObserved = (await f.state()).records.find((row) => row.id === id(2)).first_observed_at;
  rows = [event(2, { message: 'Updated report' }), event(3)];
  const result = await f.run();
  const state = await f.state();
  assert.equal(result.stored_records, 3);
  assert.equal(state.records.find((row) => row.id === id(1)).message, 'Report 1');
  assert.equal(state.records.find((row) => row.id === id(2)).message, 'Updated report');
  assert.equal(state.records.find((row) => row.id === id(2)).first_observed_at, firstObserved);
  assert.deepEqual(f.calls.filter((url) => url.pathname.endsWith('notifications')).map((url) => url.searchParams.get('page')), ['1', '1', '1', '1']);
});

test('changed totals and overlapping head detect drift and retain the newly observed head', async (t) => {
  const f = await fixture(t, (n, count) => count === 1 ? page(n, [event(1)], 1) : page(n, [event(2), event(1)], 2));
  const result = await f.run();
  assert.equal(result.scan.status, 'partial');
  assert.equal(result.scan.reason, 'pagination_changed');
  assert.equal(result.scan.drift_detected, true);
  assert.equal(result.stored_records, 2);
});

test('failed second page preserves first page and next invocation starts again at page one', async (t) => {
  let fail = true;
  const f = await fixture(t, (n) => n === 2 && fail ? response({ message: 'secret transport text', code: 'server_error' }, 503) : page(n, [event(n)], 2, 2));
  const first = await f.run();
  assert.equal(first.scan.status, 'partial');
  assert.equal(first.scan.reason, 'request_or_response_failed');
  assert.equal(first.stored_records, 1);
  fail = false;
  const second = await f.run();
  assert.equal(second.scan.status, 'scan_finished');
  assert.equal(second.stored_records, 2);
  assert.deepEqual(f.calls.filter((url) => url.pathname.endsWith('notifications')).map((url) => url.searchParams.get('page')), ['1', '2', '1', '2', '1']);
  assert.ok(!JSON.stringify(await f.state()).includes('secret transport text'));
});

test('page budget produces an explicit partial scan with no extra head request', async (t) => {
  const f = await fixture(t, (n) => page(n, [event(n)], 100, 4));
  const result = await f.run({ maxPages: 1 });
  assert.equal(result.scan.reason, 'page_limit');
  assert.equal(result.scan.history_requests, 1);
  assert.equal(result.stored_records, 1);
});

test('empty day is a finished visible scan, not a completeness claim', async (t) => {
  const f = await fixture(t, (n) => page(n, []));
  const result = await f.run();
  assert.equal(result.scan.status, 'scan_finished');
  assert.equal(result.stored_records, 0);
  assert.ok(!Object.hasOwn(result, 'complete'));
});

test('foreign room, wrong date, malformed sender, and wrong pagination fail closed', async (t) => {
  for (const body of [
    page(1, [event(1, { room: { id: roomId, invite_code: 'OTHER' } })]),
    page(1, [event(1, { created_at: '2020-01-03T00:00:00Z' })]),
    page(1, [event(1, { sender: { id: 'public-user-id', name: 'Person' } })]),
    page(2, [event(1)]),
  ]) {
    const f = await fixture(t, () => body);
    const result = await f.run();
    assert.equal(result.scan.reason, 'request_or_response_failed');
    assert.equal(result.stored_records, 0);
  }
});

test('redacted sender remains null, without falling back to raw sender_id', async (t) => {
  const f = await fixture(t, (n) => page(n, [event(1, { sender: null, sender_id: senderId })]));
  await f.run();
  assert.deepEqual((await f.state()).records[0].sender, { id: null, name: null });
});

test('connection fingerprint and room binding cannot be changed or silently adopted', async (t) => {
  const f = await fixture(t);
  await f.run();
  const before = f.calls.length;
  await assert.rejects(f.run({ tokenFingerprint: 'other-token' }), /another connection/);
  await assert.rejects(f.run({ room: 'other' }), /another connection/);
  assert.equal(f.calls.length, before);
  const state = await f.state();
  state.room_id = senderId;
  await writeFile(join(f.root, `${day}.json`), JSON.stringify(state));
  await assert.rejects(f.run(), /room binding/);
  assert.equal(f.calls.length, before);
});

test('corrupted JSON and unknown saved fields are rejected before API access', async (t) => {
  const f = await fixture(t);
  await f.run();
  const original = await f.state();
  const before = f.calls.length;
  await writeFile(join(f.root, `${day}.json`), '{bad secret');
  await assert.rejects(f.run(), /invalid/);
  original.records[0].data = { unexpected: 'secret' };
  await writeFile(join(f.root, `${day}.json`), JSON.stringify(original));
  await assert.rejects(f.run(), /records are invalid/);
  await assert.rejects(searchArchive(f.root, 'report'), /records are invalid/);
  assert.equal(f.calls.length, before);
});

test('cancel after an in-flight list read saves partial state and releases lock', async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, (n) => { controller.abort(new Error('cancel')); return page(n, [event(1)]); });
  const result = await f.run({ signal: controller.signal });
  assert.equal(result.scan.reason, 'cancelled');
  assert.equal(result.stored_records, 0);
  await assert.rejects(stat(join(f.root, '.lock')), { code: 'ENOENT' });
});

test('exclusive directory lock refuses a second writer and requires explicit stale recovery', async (t) => {
  const f = await fixture(t);
  const release = await acquireLock(f.root);
  await assert.rejects(f.run(), /Archive lock exists/);
  assert.equal(f.calls.length, 0);
  await release();
  assert.equal((await f.run()).scan.status, 'scan_finished');
});

test('only valid closed UTC days are accepted, including leap-year boundaries', () => {
  const now = new Date('2024-03-01T00:00:00Z');
  assert.equal(validateDay('2024-02-29', now), '2024-02-29');
  for (const invalid of ['2023-02-29', '2024-02-30', '2024-3-01', '2024-03-01', '2024-03-02', '../../x', undefined]) assert.throws(() => validateDay(invalid, now));
});

test('offline search covers title/question/sender, matches literals, and safely escapes terminal text', async (t) => {
  const f = await fixture(t, (n) => page(n, [event(1, { message: 'Literal [release] \u001b[31m\u009bRED\u2028', question: { prompt: 'Ready now?', state: 'open' } })]));
  await f.run();
  const count = f.calls.length;
  for (const term of ['Release notes', 'READY NOW', 'colleague', '[release]']) assert.equal((await searchArchive(f.root, term)).matches.length, 1);
  assert.equal((await searchArchive(f.root, '.*')).matches.length, 0);
  const output = safeJson(await searchArchive(f.root, '[release]'));
  assert.ok(output.includes('\\u001b'));
  assert.ok(output.includes('\\u009b'));
  assert.ok(output.includes('\\u2028'));
  assert.ok(!output.includes('\u001b'));
  assert.equal(f.calls.length, count);
});

test('credentials are private and any defined environment pair overrides or fails', async (t) => {
  const f = await fixture(t);
  await saveConnection(f.root, { token: 'saved-token', room: 'team' });
  assert.deepEqual(await loadConnection(f.root, {}), { token: 'saved-token', room: 'TEAM' });
  assert.equal((await stat(join(f.root, 'credentials.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await loadConnection(f.root, { PINGROOM_TOKEN: ' override ', PINGROOM_ROOM: 'other' }), { token: 'override', room: 'OTHER' });
  for (const env of [{ PINGROOM_TOKEN: '' }, { PINGROOM_ROOM: 'TEAM' }, { PINGROOM_TOKEN: 'ok', PINGROOM_ROOM: ' ' }]) await assert.rejects(loadConnection(f.root, env), /both PINGROOM_TOKEN/);
  assert.throws(() => archiveConfig({ ARCHIVE_MAX_PAGES: '41' }), /1 to 40/);
});

test('transport errors do not expose response or fetch details', async () => {
  for (const fetch of [async () => response({ message: 'credential=secret' }, 403), async () => { throw new Error('credential=secret'); }]) {
    const client = new PingRoom({ token: 'offline', fetch, baseUrl: 'https://offline.invalid' });
    try { await client.rooms.get('TEAM'); assert.fail('Expected an error'); }
    catch (error) { assert.ok(!errorSummary(error).includes('secret')); }
  }
});
