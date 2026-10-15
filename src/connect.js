import { PingRoom } from '@pingroom/sdk';
import { credentialDirectory, saveConnection } from './config.js';
import { errorSummary } from './errors.js';
import { shutdownSignal } from './signals.js';

const shutdown = shutdownSignal();
try {
  console.log('Export visible room history for local search. Free accounts expose only the latest 100 visible pings across their feed.');
  console.log('Install or open PingRoom and sign in: https://pingroom.io/i');
  const client = new PingRoom({ baseUrl: 'https://api.pingroom.io', timeoutMs: 5_000 });
  const pairing = await client.auth.startPairing({ agent_label: 'Room history archive' });
  console.log(`Approve this connection and grant access to the room: ${pairing.pair_browser_url ?? pairing.pair_url}`);
  const active = await client.auth.waitForPairing(pairing, { signal: shutdown.signal });
  const room = active.home_room ?? active.room;
  if (!room?.invite_code) throw new Error('No delivery room returned. Create or join a private room, then connect again.');
  await saveConnection(credentialDirectory, { token: active.credential, room: room.invite_code });
  console.log('Saved .pingroom/credentials.json. Run npm start -- YYYY-MM-DD for a closed UTC day.');
} catch (error) { console.error(errorSummary(error)); process.exitCode ||= 1; }
finally { shutdown.dispose(); }
