import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { validateArchive } from './archive.js';
import { UUID, roomCode } from './config.js';

export async function searchArchive(root, term) {
  if (typeof term !== 'string' || !term.trim() || term.length > 200) throw new Error('Supply a search phrase of 1–200 characters.');
  const binding = await readJson(join(root, 'scope.json'));
  if (!binding || binding.version !== 1 || typeof binding.scope !== 'string' || !UUID.test(binding.room_id ?? '') || roomCode(binding.room_code) !== binding.room_code) throw new Error('No valid archive binding found. Run an export first.');
  const days = (await readdir(root)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse();
  const matches = [];
  const phrase = term.toLowerCase();
  let matched = 0;
  for (const name of days.slice(0, 365)) {
    const day = name.slice(0, 10);
    const state = await readJson(join(root, name));
    validateArchive(state, day, binding.scope);
    if (state.room_id !== binding.room_id || state.room_code !== binding.room_code) throw new Error('Archive file does not match its room binding.');
    for (const record of state.records) {
      const text = [record.message, record.title, record.sender.name, record.question?.prompt].filter(Boolean).join('\n').toLowerCase();
      if (!text.includes(phrase)) continue;
      matched += 1;
      if (matches.length < 50) matches.push({ day, id: record.id, created_at: record.created_at, message: record.message, title: record.title, sender: { id: record.sender.id, name: record.sender.name }, question: record.question === null ? null : { prompt: record.question.prompt, state: record.question.state }, scan_status: state.scan.status });
    }
  }
  return { matches, matched_in_scanned_days: matched, days_scanned: Math.min(days.length, 365), truncated: matched > 50 || days.length > 365 };
}

export const safeJson = (value) => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028\u2029]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
