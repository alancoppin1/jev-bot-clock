// Receives the bot's snapshot. The first upload token ever seen is remembered
// (only its SHA-256 hash is stored); every later upload must use the same token.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readJson, writeJson, StoreNotConnected } from './_store.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');

function sameHash(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (token.length < 20) return res.status(401).json({ error: 'missing upload token' });

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  if (!body || body.schema !== 1 || !body.generated_at) {
    return res.status(400).json({ error: 'not a Jev paper trader snapshot' });
  }

  try {
    // Once the bot runs in the cloud, uploads from the old PC copy are refused so they can't overwrite it.
    if (await readJson('state.json')) {
      return res.status(409).json({ error: 'the bot now runs in the cloud - PC uploads are switched off' });
    }
    const owner = await readJson('auth.json');
    if (!owner) {
      await writeJson('auth.json', { hash: sha(token), claimed_at: new Date().toISOString() }, { overwrite: false });
    } else if (!sameHash(owner.hash, sha(token))) {
      return res.status(403).json({ error: 'upload token does not match this dashboard' });
    }
    await writeJson('snapshot.json', body);
    return res.status(200).json({ ok: true });
  } catch (e) {
    if (e instanceof StoreNotConnected) return res.status(503).json({ error: e.message });
    console.error('ingest failed', e);
    return res.status(500).json({ error: 'could not save snapshot' });
  }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
