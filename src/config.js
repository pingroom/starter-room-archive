import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson, readJson } from './storage.js';

export const credentialDirectory = fileURLToPath(new URL('../.pingroom/', import.meta.url));
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function roomCode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.trim())) throw new Error('A valid room code is required.');
  return value.trim().toUpperCase();
}

export function loadEnvironment() {
  try { process.loadEnvFile('.env'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export function archiveConfig(env = process.env) {
  const maxPages = env.ARCHIVE_MAX_PAGES === undefined ? 40 : Number(env.ARCHIVE_MAX_PAGES);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 40) throw new Error('ARCHIVE_MAX_PAGES must be an integer from 1 to 40.');
  if (env.ARCHIVE_DIR !== undefined && !env.ARCHIVE_DIR.trim()) throw new Error('ARCHIVE_DIR must not be blank.');
  return { root: env.ARCHIVE_DIR ? resolve(env.ARCHIVE_DIR) : fileURLToPath(new URL('../archive/', import.meta.url)), maxPages };
}

export async function saveConnection(directory, connection) {
  await atomicJson(directory, 'credentials.json', { token: connection.token, room: roomCode(connection.room) });
}

export async function loadConnection(directory = credentialDirectory, env = process.env) {
  let connection;
  if (env.PINGROOM_TOKEN !== undefined || env.PINGROOM_ROOM !== undefined) {
    if (!env.PINGROOM_TOKEN?.trim() || !env.PINGROOM_ROOM?.trim()) throw new Error('Set both PINGROOM_TOKEN and PINGROOM_ROOM; blank or partial overrides are refused.');
    connection = { token: env.PINGROOM_TOKEN.trim(), room: env.PINGROOM_ROOM };
  } else connection = await readJson(join(directory, 'credentials.json'));
  if (!connection || typeof connection.token !== 'string' || !connection.token.trim()) throw new Error('Run npm run connect, or set both PINGROOM_TOKEN and PINGROOM_ROOM.');
  return { token: connection.token, room: roomCode(connection.room) };
}
