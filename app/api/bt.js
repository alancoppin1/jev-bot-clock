// Backtest data collector. Replays past prices through Jev and stores its answers, so rule sets
// can be tested offline on months of history. Assets and dates are hidden from Jev: it sees only
// rescaled numbers. ops: probe | step | status | dump
import { redisCmd } from './_store.js';
import { indicators } from './_lib/market.js';
import { askJev, gatewayToken } from './_lib/jev.js';
import { CONFIG } from './_lib/settings.js';

export const config = { maxDuration: 300 };

const STOCKS = 'AAPL MSFT NVDA AMZN GOOGL META TSLA JPM V UNH XOM JNJ WMT PG MA HD CVX KO PEP COST MRK ABBV BAC CRM ORCL NFLX AMD DIS MCD CSCO'.split(' ');
const CRYPTO = 'BTC ETH SOL ADA DOGE LTC LINK DOT'.split(' ');
export const ASSETS = [
  { id: 'SPY', kind: 'bench' },
  ...STOCKS.map(id => ({ id, kind: 'stock' })),
  ...CRYPTO.map(id => ({ id: id + '-USD', kind: 'crypto' })),
];

const QUESTIONS = {
  trend: { type: 'choice', instructions: 'Direction of the price trend over the last 72 periods',
    criteria: { up: 'Price is making higher highs and higher lows and sits above its moving averages', sideways: 'Price is ranging without a clear direction', down: 'Price is making lower highs and lower lows and sits below its moving averages' } },
  momentum: { type: 'score', instructions: 'Strength of short-term price momentum over the last 6 periods', criteria: ['Strongly falling', 'Falling', 'Flat', 'Rising', 'Strongly rising'] },
  overextended: { type: 'noul', instructions: 'Price has risen sharply and looks stretched or overbought relative to its recent range' },
  breakdown: { type: 'noul', instructions: 'Price is breaking down below recent support levels' },
  rise: { type: 'noul', instructions: 'The price will be higher 10 periods from now than it is now' },
};

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; jev-backtest/1.0)' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sig = (v) => Number(Number(v).toPrecision(7));

async function yahoo(sym, range = '5y') {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=1d`, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
  const res = (await r.json()).chart?.result?.[0];
  const q = res?.indicators?.quote?.[0], adj = res?.indicators?.adjclose?.[0]?.adjclose;
  if (!res?.timestamp || !q) throw new Error('Yahoo: no data');
  const out = [];
  res.timestamp.forEach((t, i) => {
    if (q.close[i] == null || q.open[i] == null) return;
    const f = adj && adj[i] != null ? adj[i] / q.close[i] : 1;   // adjust for splits and dividends
    out.push([t, sig(q.open[i] * f), sig(q.high[i] * f), sig(q.low[i] * f), sig(q.close[i] * f), q.volume[i] || 0]);
  });
  return out;
}

async function stooq(sym) {
  const r = await fetch(`https://stooq.com/q/d/l/?s=${sym.toLowerCase()}.us&i=d`, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Stooq HTTP ${r.status}`);
  const rows = (await r.text()).trim().split('\n').slice(1).map(l => l.split(','));
  const out = rows.filter(x => x.length >= 6 && isFinite(+x[4])).map(x => [Date.parse(x[0] + 'T21:00:00Z') / 1000, +x[1], +x[2], +x[3], +x[4], +x[5] || 0]);
  if (out.length < 200) throw new Error('Stooq: no data');
  return out;
}

async function coinbaseHourly(product, hours = 4500) {
  const all = new Map(); let end = Math.floor(Date.now() / 3600000) * 3600;
  for (let got = 0; got < hours; got += 300) {
    const start = end - 300 * 3600;
    const u = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
    let rows = null;
    for (let k = 0; k < 4 && !rows; k++) {
      const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(15000) });
      if (r.ok) rows = await r.json(); else if (r.status === 429) await sleep(1500 * (k + 1)); else throw new Error(`Coinbase HTTP ${r.status}`);
    }
    if (!rows) throw new Error('Coinbase busy');
    for (const [t, low, high, open, close, vol] of rows) all.set(t, [t, +open, +high, +low, +close, sig(vol)]);
    end = start; await sleep(250);
  }
  return [...all.values()].sort((a, b) => a[0] - b[0]);
}

async function loadBars(a) {
  const raw = await redisCmd(['GET', 'bt:c:' + a.id]);
  if (raw) return JSON.parse(raw);
  let bars;
  if (a.kind === 'crypto') bars = await coinbaseHourly(a.id);
  else { try { bars = await yahoo(a.id); } catch (e) { bars = await stooq(a.id); } bars = bars.slice(-640); }
  await redisCmd(['SET', 'bt:c:' + a.id, JSON.stringify(bars)]);
  return bars;
}

// decision points: every day for shares (last ~2 years); every 4th hour for crypto (last ~6 months)
function samples(a, bars) {
  const out = [];
  if (a.kind === 'stock') for (let i = Math.max(110, bars.length - 504); i < bars.length; i++) out.push(i);
  if (a.kind === 'crypto') for (let i = 110; i < bars.length; i++) if (Math.floor(bars[i][0] / 3600) % 4 === 0) out.push(i);
  return out;
}

const signed = (v) => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
export function snapshotText(a, bars, i) {
  const k = 100 / bars[i][4];                               // rescale so the current price is 100
  const win = bars.slice(i - 109, i + 1).map(([t, o, h, l, c, v]) => ({ time: t, open: o * k, high: h * k, low: l * k, close: c * k, volume: v }));
  const ind = indicators(win, 100), f = (v) => v.toFixed(2), pc = (n, o) => (n / o - 1) * 100;
  return [
    `Price snapshot for one asset. Candle size: 1 ${a.kind === 'crypto' ? 'hour' : 'trading day'}. Prices are rescaled so the current price is 100.`,
    `Current price: 100.00`,
    `Change over last 1 period: ${signed(ind.chg_1)}`, `Change over last 6 periods: ${signed(ind.chg_6)}`,
    `Change over last 24 periods: ${signed(ind.chg_24)}`, `Change over last 72 periods: ${signed(ind.chg_72)}`,
    `20-period moving average: ${f(ind.sma20)} (price is ${signed(pc(100, ind.sma20))} vs this)`,
    `50-period moving average: ${f(ind.sma50)} (price is ${signed(pc(100, ind.sma50))} vs this)`,
    `RSI(14): ${ind.rsi14.toFixed(1)} (above 70 is commonly read as overbought, below 30 as oversold)`,
    `72-period high: ${f(ind.high72)}; 72-period low: ${f(ind.low72)}; price sits at ${ind.range_pos.toFixed(0)}% of that range (0% = at the low, 100% = at the high)`,
    `Volume over last 6 periods vs 72-period average: ${ind.vol_ratio.toFixed(2)}x`,
    `Last 12 closes, oldest to newest: ${ind.recent_closes.map(f).join(', ')}`,
  ].join('\n');
}

const enc = (x) => [x.trend?.choice?.[0] ?? '?', x.trend?.confidence ?? '', x.momentum?.score ?? '', x.momentum?.confidence ?? '', x.overextended?.noul ?? '', x.breakdown?.noul ?? '', x.rise?.noul ?? '']
  .map(v => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v).join('|');

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k]); } }));
}

async function step(q) {
  const t0 = Date.now(), budget = (+q.secs || 235) * 1000;
  let conc = Math.max(1, +q.c || 4);
  const token = await gatewayToken();
  const done = new Set(await redisCmd(['SMEMBERS', 'bt:done']));
  const st = { ok: 0, busy: 0, err: 0, last_err: '', asset: '', conc };
  for (const a of ASSETS) {
    if (done.has(a.id)) continue;
    if (Date.now() - t0 > budget) break;
    st.asset = a.id;
    const bars = await loadBars(a);
    const all = samples(a, bars);
    const have = new Set(all.length ? await redisCmd(['HKEYS', 'bt:a:' + a.id]) : []);
    const todo = all.filter(i => !have.has(String(i)));
    let holes = 0;
    while (todo.length && Date.now() - t0 < budget) {
      const batch = todo.splice(0, conc * 5), got = []; let busy = 0;
      await pool(batch, conc, async (i) => {
        try {
          const rep = await askJev({ url: CONFIG.jev_url, model: CONFIG.jev_model, token, state: snapshotText(a, bars, i), questions: QUESTIONS, retries: 1, timeoutMs: 15000 });
          got.push(String(i), enc(rep.answers)); st.ok++;
        } catch (e) {
          if (e.refused) throw e;
          holes++; if (e.busy) { busy++; st.busy++; } else { st.err++; st.last_err = String(e.message).slice(0, 120); }
        }
      });
      if (got.length) await redisCmd(['HSET', 'bt:a:' + a.id, ...got]);
      if (busy > batch.length * 0.3) { conc = Math.max(1, Math.floor(conc / 2)); await sleep(4000); }
    }
    if (!todo.length && !holes) await redisCmd(['SADD', 'bt:done', a.id]), done.add(a.id);
  }
  const secs = (Date.now() - t0) / 1000;
  return { done: ASSETS.every(a => done.has(a.id)), assets_done: done.size, of: ASSETS.length, ...st, end_conc: conc, secs, per_min: Math.round(st.ok / secs * 60) };
}

async function probe() {
  const out = {};
  for (const [name, fn] of [['yahoo', () => yahoo('AAPL')], ['stooq', () => stooq('AAPL')], ['coinbase', () => coinbaseHourly('BTC-USD', 600)]]) {
    try { const b = await fn(); out[name] = { bars: b.length, first: new Date(b[0][0] * 1000).toISOString().slice(0, 10), last: new Date(b.at(-1)[0] * 1000).toISOString().slice(0, 10), last_close: b.at(-1)[4] }; }
    catch (e) { out[name] = { error: String(e.message).slice(0, 150) }; }
  }
  try {
    const bars = await yahoo('AAPL').catch(() => coinbaseHourly('BTC-USD', 600));
    const token = await gatewayToken(), t0 = Date.now(); let ok = 0, busy = 0, err = '', sample = null;
    await pool(Array.from({ length: 30 }, (_, k) => bars.length - 1 - k), 6, async (i) => {
      try { const r = await askJev({ url: CONFIG.jev_url, model: CONFIG.jev_model, token, state: snapshotText({ kind: 'stock' }, bars, i), questions: QUESTIONS, retries: 0, timeoutMs: 15000 }); ok++; sample = sample || enc(r.answers); }
      catch (e) { if (e.busy) busy++; else err = String(e.message).slice(0, 150); }
    });
    out.jev = { calls: 30, concurrency: 6, ok, busy, err, secs: (Date.now() - t0) / 1000, sample };
  } catch (e) { out.jev = { error: String(e.message).slice(0, 200) }; }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  try {
    if (q.op === 'probe') return res.status(200).json(await probe());
    if (q.op === 'step') return res.status(200).json(await step(q));
    if (q.op === 'status') {
      const done = await redisCmd(['SMEMBERS', 'bt:done']); const counts = {};
      for (const a of ASSETS) if (a.kind !== 'bench') counts[a.id] = await redisCmd(['HLEN', 'bt:a:' + a.id]);
      return res.status(200).json({ done, counts, total: Object.values(counts).reduce((s, v) => s + v, 0) });
    }
    if (q.op === 'dump') {
      const a = ASSETS.find(x => x.id === q.asset); if (!a) return res.status(404).json({ error: 'unknown asset' });
      const bars = JSON.parse(await redisCmd(['GET', 'bt:c:' + a.id]) || '[]'), flat = await redisCmd(['HGETALL', 'bt:a:' + a.id]) || [], ans = {};
      for (let i = 0; i < flat.length; i += 2) ans[flat[i]] = flat[i + 1];
      return res.status(200).json({ id: a.id, kind: a.kind, bars, ans });
    }
    if (q.op === 'assets') return res.status(200).json(ASSETS);
    return res.status(400).json({ error: 'op must be probe, step, status, dump or assets' });
  } catch (e) {
    console.error('bt failed', e);
    return res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
}
