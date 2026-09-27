// One trading round in the cloud. Called every 15 minutes by the GitHub scheduler
// (plus a daily Vercel cron as a backstop). Safe to call any time: it runs at most
// one round per 10 minutes, and two overlapping calls can't both trade.
import { readJsonTagged, writeJson, StoreNotConnected, acquireLock, releaseLock } from './_store.js';
import { CONFIG, RULES } from './_lib/settings.js';
import { runCycle, snapshot, newState, iso } from './_lib/engine.js';
import { gatewayToken } from './_lib/jev.js';
import SEED from './_lib/seed.js';
import { waitUntil } from '@vercel/functions';

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
    // fresh session: archive the old paper accounts and start again from the starting cash
    if (CONFIG.session_id && st.session_id !== CONFIG.session_id) {
      await writeJson(`archive/${st.session_id || 'first-session'}.json`, st);
      st = newState(CONFIG);
      st.events.push({ time: iso(), level: 'INFO', message: 'fresh paper-trading session started - previous session archived' });
    }

    const now = Date.now();
    const sinceMin = st.last_cycle_at ? (now - Date.parse(st.last_cycle_at)) / 60000 : Infinity;
    if (sinceMin < CONFIG.min_gap_minutes) {
      return res.status(200).json({ ok: true, skipped: 'ran recently', minutes_since_last: Math.round(sinceMin * 10) / 10 });
    }
    if (st.running_until && Date.parse(st.running_until) > now) {
      return res.status(200).json({ ok: true, skipped: 'another round is in progress' });
    }

    // claim the round (fails if another call claimed it first)
    let claim, lock = await acquireLock('round', 290);
    if (lock === false) return res.status(200).json({ ok: true, skipped: 'another round is in progress' });
    if (lock && etag) {
      claim = { etag };                         // Redis: a small lock key instead of re-saving the whole state
    } else {
      st.running_until = iso(new Date(now + 280 * 1000));
      try {
        claim = await writeJson('state.json', st, etag ? { ifMatch: etag } : { overwrite: false });
      } catch (e) {
        await releaseLock('round', lock);
        console.error('claim failed', e);
        return res.status(200).json({ ok: true, skipped: 'another round claimed this slot', detail: String(e.message || e).slice(0, 200) });
      }
    }

    // Get the AI Gateway pass now, while this request is still open. Once we've replied, Vercel's
    // per-request pass may no longer be reachable and an older one can be picked up instead.
    const token = await gatewayToken();
    const round = async () => {
      const result = await runCycle(st, CONFIG, RULES, { token, startedAt: started });
      st.last_cycle_at = iso();
      st.running_until = null;
      await writeJson('state.json', st, claim?.etag ? { ifMatch: claim.etag } : {});
      await writeJson('snapshot.json', snapshot(st, CONFIG, RULES, await credits(token)));
      await releaseLock('round', lock);
      return result;
    };

    // Default: answer at once and finish the round in the background, because wake-up
    // services (cron-job.org) give up after 30 seconds and a round takes 2-3 minutes.
    // Add ?wait=1 to wait for the full result instead.
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
