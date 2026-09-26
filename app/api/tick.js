// One trading round in the cloud. Called every 15 minutes by the GitHub scheduler
// (plus a daily Vercel cron as a backstop). Safe to call any time: it runs at most
// one round per 10 minutes, and two overlapping calls can't both trade.
import { readJsonTagged, writeJson, StoreNotConnected } from './_store.js';
import { CONFIG, RULES } from './_lib/settings.js';
import { runCycle, snapshot, newState, iso } from './_lib/engine.js';
import { gatewayToken } from './_lib/jev.js';
import SEED from './_lib/seed.js';

export const config = { maxDuration: 300 };

async function credits(token) {
  try {
    const r = await fetch('https://ai-gateway.vercel.sh/v1/credits', {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return { balance: parseFloat(d.balance), total_used: parseFloat(d.total_used) };
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const started = Date.now();
  try {
    let { data: st, etag } = await readJsonTagged('state.json');
    if (!st) st = SEED ? structuredClone(SEED) : newState(CONFIG);

    const now = Date.now();
    const sinceMin = st.last_cycle_at ? (now - Date.parse(st.last_cycle_at)) / 60000 : Infinity;
    if (sinceMin < CONFIG.min_gap_minutes) {
      return res.status(200).json({ ok: true, skipped: 'ran recently', minutes_since_last: Math.round(sinceMin * 10) / 10 });
    }
    if (st.running_until && Date.parse(st.running_until) > now) {
      return res.status(200).json({ ok: true, skipped: 'another round is in progress' });
    }

    // claim the round (fails if another call claimed it first)
    st.running_until = iso(new Date(now + 280 * 1000));
    let claim;
    try {
      claim = await writeJson('state.json', st, etag ? { ifMatch: etag } : { overwrite: false });
    } catch (e) {
      console.error('claim failed', e);
      return res.status(200).json({ ok: true, skipped: 'another round claimed this slot', detail: String(e.message || e).slice(0, 200) });
    }

    const token = await gatewayToken();
    const result = await runCycle(st, CONFIG, RULES, { token, startedAt: started });
    st.last_cycle_at = iso();
    st.running_until = null;

    await writeJson('state.json', st, claim?.etag ? { ifMatch: claim.etag } : {});
    await writeJson('snapshot.json', snapshot(st, CONFIG, RULES, await credits(token)));
    return res.status(200).json({ ok: true, seconds: (Date.now() - started) / 1000, ...result });
  } catch (e) {
    if (e instanceof StoreNotConnected) return res.status(503).json({ error: e.message });
    console.error('tick failed', e);
    return res.status(500).json({ error: 'round failed', detail: String(e.message || e).slice(0, 300) });
  }
}
