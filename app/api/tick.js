// One round of the US stock news experiment. Called every 10-15 minutes by cron-job.org
// (plus a daily Vercel cron as a backstop). Safe to call any time: it runs at most one round
// per 7 minutes, and two overlapping calls can't both trade.
// The crypto bot that used to run here was retired on 2026-10-17; its final results are kept in archive/.
import { readJson, readJsonTagged, writeJson, StoreNotConnected, acquireLock, releaseLock } from './_store.js';
import { STOCK_CONFIG as CFG } from './_lib/stocks/settings.js';
import { runRound, snapshot, newState, iso } from './_lib/stocks/engine.js';
import { gatewayToken } from './_lib/jev.js';
import { waitUntil } from '@vercel/functions';

export const config = { maxDuration: 300 };
const STATE = 'stocks/state.json';

async function credits(token) {
  try {
    const r = await fetch('https://ai-gateway.vercel.sh/v1/credits', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    return { balance: parseFloat(d.balance), total_used: parseFloat(d.total_used) };
  } catch { return null; }
}

// keep the crypto bot's final state and dashboard data before the stock bot takes over the dashboard
async function archiveCrypto() {
  if (await readJson('archive/crypto-final-snapshot.json')) return;
  const [cs, cp] = await Promise.all([readJson('state.json'), readJson('snapshot.json')]);
  if (cs) await writeJson('archive/crypto-final-state.json', cs);
  if (cp && cp.schema !== 2) await writeJson('archive/crypto-final-snapshot.json', { ...cp, retired_at: iso() });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const started = Date.now();
  try {
    let { data: st, etag } = await readJsonTagged(STATE);
    if (!st || st.session_id !== CFG.session_id) {
      if (st) await writeJson(`archive/${st.session_id}.json`, st);
      else await archiveCrypto();
      st = newState(CFG); etag = null;
    }

    const now = Date.now();
    const sinceMin = st.last_cycle_at ? (now - Date.parse(st.last_cycle_at)) / 60000 : Infinity;
    if (sinceMin < CFG.min_gap_minutes) return res.status(200).json({ ok: true, skipped: 'ran recently', minutes_since_last: Math.round(sinceMin * 10) / 10 });

    const lock = await acquireLock('stock-round', 290);
    if (lock === false) return res.status(200).json({ ok: true, skipped: 'another round is in progress' });

    const token = await gatewayToken();    // fetch while the request is still open
    const round = async () => {
      try {
        const result = await runRound(st, CFG, { token, startedAt: started });
        st.last_cycle_at = iso();
        await writeJson(STATE, st, etag ? { ifMatch: etag } : {});
        await writeJson('snapshot.json', snapshot(st, CFG, await credits(token)));
        return result;
      } finally { await releaseLock('stock-round', lock); }
    };

    // Default: answer at once and finish in the background (wake-up services give up after 30 seconds).
    // Add ?wait=1 to wait for the full result.
    if (req.query?.wait !== '1') {
      waitUntil(round().catch(e => console.error('background round failed', e)));
      return res.status(202).json({ ok: true, started: true });
    }
    const result = await round();
    return res.status(200).json({ ok: true, seconds: (Date.now() - started) / 1000, ...result });
  } catch (e) {
    if (e instanceof StoreNotConnected) return res.status(503).json({ error: e.message });
    console.error('tick failed', e);
    return res.status(500).json({ error: 'round failed', detail: String(e.message || e).slice(0, 300) });
  }
}
