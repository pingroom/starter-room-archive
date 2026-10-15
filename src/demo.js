import { PingRoom } from '@pingroom/sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveDay } from './archive.js';
import { searchArchive, safeJson } from './search-archive.js';

const roomId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const day = '2020-01-02';
const event = { id: '11111111-1111-1111-1111-111111111111', message: 'Release notes are ready.', created_at: `${day}T12:00:00Z`, room: { id: roomId, invite_code: 'DEMO' }, sender: { id: null, name: null }, action_number: null, trigger_source: 'manual', data: { excluded: 'Private structured data is not archived.' } };
// All requests are answered locally. No environment credentials, pairing,
// global fetch, or live API calls are used by this demo.
const client = new PingRoom({ token: 'offline-demo', baseUrl: 'https://offline.invalid', async fetch(url, options) {
  if (options.method !== 'GET') throw new Error('The archive must never write to the API.');
  const path = new URL(url).pathname;
  const body = path === '/api/agent/rooms/DEMO' ? { id: roomId, invite_code: 'DEMO' }
    : path === '/api/agent/notifications' ? { current_page: 1, per_page: 25, total: 1, last_page: 1, data: [event], next_page_url: null, prev_page_url: null }
      : null;
  if (!body) throw new Error('Unexpected offline request.');
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
} });
const root = await mkdtemp(join(tmpdir(), 'pingroom-archive-demo-'));
try {
  const options = { client, root, room: 'DEMO', tokenFingerprint: 'offline', day };
  const first = await archiveDay(options);
  const repeated = await archiveDay(options);
  console.log(safeJson({ first_scan: first.scan.status, records_after_rescan: repeated.stored_records, search: await searchArchive(root, 'release') }));
} finally { await rm(root, { recursive: true, force: true }); }
