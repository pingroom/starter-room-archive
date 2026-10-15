import { PingRoom } from '@pingroom/sdk';
import { archiveConfig, loadConnection, loadEnvironment, sha256 } from './config.js';
import { archiveDay } from './archive.js';
import { errorSummary } from './errors.js';
import { shutdownSignal } from './signals.js';
import { safeJson } from './search-archive.js';

const shutdown = shutdownSignal();
try {
  loadEnvironment();
  const [day, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Use: npm start -- YYYY-MM-DD.');
  const { token, room } = await loadConnection();
  const result = await archiveDay({ client: new PingRoom({ token, baseUrl: 'https://api.pingroom.io', timeoutMs: 5_000 }), tokenFingerprint: sha256(token), room, day, ...archiveConfig(), signal: shutdown.signal });
  console.log(safeJson(result));
  if (result.scan.status === 'partial') process.exitCode ||= 2;
} catch (error) { console.error(errorSummary(error)); process.exitCode ||= 1; }
finally { shutdown.dispose(); }
