import { chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';

const MAX_LOCAL_BYTES = 16 * 1024 * 1024;

export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function readJson(path) {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_LOCAL_BYTES) throw new Error('Local archive file is not a bounded regular file.');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > stat.size) throw new Error('Local file changed while being read. Retry after other writers stop.');
    const raw = buffer.subarray(0, length).toString('utf8');
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid record');
      return value;
    } catch { throw new Error('A local archive or credential file is invalid. Restore it before continuing.'); }
  } finally { await handle.close(); }
}

export async function atomicJson(directory, name, value) {
  await privateDirectory(directory);
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_LOCAL_BYTES) throw new Error('Local archive would exceed the 16 MiB file limit.');
  const temporary = join(directory, `.write-${randomUUID()}`);
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600, flush: true });
    await rename(temporary, join(directory, name));
  } finally { await rm(temporary, { force: true }); }
}

export async function acquireLock(directory) {
  await privateDirectory(directory);
  const path = join(directory, '.lock');
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Archive lock exists. Inspect .lock/owner.json and confirm the previous process stopped before removing only that lock.');
    throw error;
  }
  const owner = { pid: process.pid, nonce: randomUUID(), started_at: new Date().toISOString() };
  try { await atomicJson(path, 'owner.json', owner); }
  catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
  return async () => {
    const current = await readJson(join(path, 'owner.json'));
    if (current?.nonce === owner.nonce) await rm(path, { recursive: true, force: true });
  };
}
