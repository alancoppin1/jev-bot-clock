// One trading round, the paper portfolio, and the report/dashboard summary.
// Same maths as the PC bot (trader.py / broker.py / report.py).
import { fetchCandles, fetchPrice, indicators, buildState, NotListedError } from './market.js';
import { askJev, JevError } from './jev.js';
import { entrySignal, exitSignal, summarise, describe } from './rules.js';

export const iso = (d = new Date()) => d.toISOString().slice(0, 19) + 'Z';
const r2 = (v) => Math.round(v * 100) / 100;
const MIN_TRADES = 30, MIN_DAYS = 60;
const KEEP = { decisions: 600, events: 300, trades: 5000, equity: 20000 };

export function newState(cfg) {
  return {
    version: 1, runner: 'cloud', created: iso(), starting_cash: cfg.starting_cash_gbp, cash: cfg.starting_cash_gbp,
    positions: {}, benchmark_start: {}, last_exit: {}, day: '', day_start_equity: 0, fees_paid: 0,
    unavailable: [], last_cycle_at: null, running_until: null,
    stats: { checks: 0, errors: 0, tokens: 0, secs: 0, cost: 0, costed: 0, retries: 0 },
    decisions: [], trades: [], equity: [], events: [],
  };
}

// ------------------------------------------------------------------ portfolio
const equityOf = (st, prices) => Object.entries(st.positions)
  .reduce((v, [m, p]) => v + p.qty * (prices[m] ?? p.entry_price), st.cash);

function benchmarkEquity(st, prices, feePct) {
  const markets = Object.keys(st.benchmark_start);
  if (!markets.length) return st.starting_cash;
  const share = st.starting_cash / markets.length * (1 - feePct / 100);
  return markets.reduce((t, m) => { const s = st.benchmark_start[m], n = prices[m] ?? s; return t + (s ? share * n / s : share); }, 0);
}

function buy(st, m, price, spend, cfg, slip, now) {
  const fill = price * (1 + slip / 100), fee = spend * cfg.fee_pct / 100, qty = (spend - fee) / fill;
  st.cash -= spend; st.fees_paid += fee;
  st.positions[m] = { qty, entry_price: fill, cost_gbp: spend, entry_time: now,
    stop_price: fill * (1 - cfg.stop_loss_pct / 100), target_price: fill * (1 + cfg.take_profit_pct / 100) };
  return { side: 'BUY', qty, fill_price: fill, fee, gbp: spend, pnl: '', pnl_pct: '', entry_time: '' };
}

function sell(st, m, price, cfg, slip, now) {
  const p = st.positions[m]; delete st.positions[m];
  const fill = price * (1 - slip / 100), gross = p.qty * fill, fee = gross * cfg.fee_pct / 100, proceeds = gross - fee;
  st.cash += proceeds; st.fees_paid += fee; st.last_exit[m] = now;
  const pnl = proceeds - p.cost_gbp;
  return { side: 'SELL', qty: p.qty, fill_price: fill, fee, gbp: proceeds, pnl: r2(pnl), pnl_pct: Math.round(pnl / p.cost_gbp * 1e5) / 1e3, entry_time: p.entry_time };
}

const slipFor = (cfg, m) => cfg.major_markets.includes(m) ? cfg.slippage_pct : cfg.slippage_pct_other;

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ------------------------------------------------------------------ one round
export async function runCycle(st, cfg, rules, { token, deps = {}, startedAt = Date.now() } = {}) {
  const fc = deps.fetchCandles || fetchCandles, fp = deps.fetchPrice || fetchPrice, ask = deps.askJev || askJev;
  const now = () => iso(deps.now ? deps.now() : new Date());
  const push = (k, row) => { st[k].push({ time: now(), ...row }); if (st[k].length > KEEP[k]) st[k].splice(0, st[k].length - KEEP[k]); };
  const event = (level, message) => push('events', { level, message });
  const markets = cfg.markets.filter(m => !st.unavailable.includes(m));
  // one-off: every error logged before skips existed was Jev being busy (HTTP 429/503)
  if (st.stats.skips == null) { st.stats.skips = st.stats.errors; st.stats.errors = 0; }

  // 1. prices (parallel)
  const data = {};
  await pool(markets, cfg.market_concurrency, async (m) => {
    try {
      const [candles, price] = await Promise.all([fc(m, cfg.candle_seconds), fp(m)]);
      data[m] = { candles, price };
    } catch (e) {
      if (e instanceof NotListedError) { st.unavailable.push(m); event('WARN', `${m}: not available on Coinbase - skipping it`); }
      else event('WARN', `${m}: could not get market data (${e.message})`);
    }
  });
  const prices = {};
  for (const m of markets) if (data[m]) { prices[m] = data[m].price; if (st.benchmark_start[m] == null) st.benchmark_start[m] = data[m].price; }
  if (!Object.keys(prices).length) { event('WARN', 'no market data this round'); return { markets: 0 }; }

  // 2. daily loss limit (UTC day)
  const today = now().slice(0, 10), eqNow = equityOf(st, prices);
  if (st.day !== today) { st.day = today; st.day_start_equity = eqNow; }
  const dayLoss = st.day_start_equity ? (1 - eqNow / st.day_start_equity) * 100 : 0;
  const blocked = dayLoss >= cfg.daily_loss_limit_pct;

  // 3. hard stops first, then ask Jev (in parallel) for everything still in play
  const order = markets.filter(m => prices[m] != null);
  const hitsStop = (m) => { const p = st.positions[m]; return !!p && (prices[m] <= p.stop_price || prices[m] >= p.target_price); };
  const stopped = new Set(order.filter(hitsStop));
  // Jev is asked about one group of coins per round, taking turns (stop-loss/take-profit still checks every coin every round)
  const split = Math.max(1, cfg.jev_split || 1);
  st.round = (st.round || 0) + 1;
  const turn = st.round % split;
  const ask_list = order.filter(m => !stopped.has(m) && cfg.markets.indexOf(m) % split === turn);
  const replies = {};
  const budgetMs = (cfg.round_budget_seconds || 200) * 1000;
  let outOfTime = 0;
  await pool(ask_list, cfg.jev_concurrency, async (m) => {
    if (!deps.askJev && Date.now() - startedAt > budgetMs) { outOfTime++; return; }
    if (!deps.askJev && cfg.jev_gap_ms) await new Promise(r => setTimeout(r, cfg.jev_gap_ms));
    let ind;
    try { ind = indicators(data[m].candles, prices[m]); } catch (e) { event('WARN', `${m}: ${e.message}`); return; }
    const state = buildState(m, ind, cfg.candle_seconds, deps.now ? deps.now() : new Date());
    try { replies[m] = await ask({ url: cfg.jev_url, model: cfg.jev_model, token, state, questions: rules.questions }); }
    catch (e) { replies[m] = { error: e instanceof JevError ? e.message : `unexpected: ${e.message}`, busy: !!e.busy, state }; }
  });

  // 3b. second try for coins Jev was too busy to answer, after a short pause
  const busyList = ask_list.filter(m => replies[m]?.busy);
  if (busyList.length && (deps.askJev || Date.now() - startedAt < budgetMs - 30000)) {
    if (!deps.askJev) await new Promise(r => setTimeout(r, cfg.jev_retry_pause_ms || 5000));
    await pool(busyList, 1, async (m) => {
      if (!deps.askJev && Date.now() - startedAt > budgetMs) return;
      if (!deps.askJev && cfg.jev_gap_ms) await new Promise(r => setTimeout(r, cfg.jev_gap_ms));
      try {
        const rep = await ask({ url: cfg.jev_url, model: cfg.jev_model, token, state: replies[m].state, questions: rules.questions, retries: 2 });
        st.stats.second_tries = (st.stats.second_tries || 0) + 1;
        replies[m] = rep;
      } catch (e) { replies[m] = { error: e instanceof JevError ? e.message : `unexpected: ${e.message}`, busy: !!e.busy }; }
    });
  }

  if (outOfTime) event('WARN', `ran out of time - ${outOfTime} coin(s) not checked this round`);

  // 4. apply stops and rules coin by coin in a fixed order (cash is shared, so sequence matters)
  for (const m of order) {
    const price = prices[m], pos = st.positions[m];
    if (stopped.has(m)) {
      const reason = price <= pos.stop_price ? 'stop-loss' : 'take-profit';
      const t = sell(st, m, price, cfg, slipFor(cfg, m), now());
      push('trades', { engine: 'jev', market: m, reason, ...t });
      push('decisions', { engine: 'jev', market: m, price, position_open: true, answers: '', action: 'SELL', reason, jev_seconds: '', input_tokens: '', output_tokens: '', cost_usd: '' });
      event('TRADE', `SELL ${m} @ ${t.fill_price} (${reason}) P&L £${t.pnl}`);
      continue;
    }
    const rep = replies[m]; if (!rep) continue;
    const base = { engine: 'jev', market: m, price, position_open: !!pos };
    if (rep.error) {
      if (rep.busy) {
        st.stats.skips = (st.stats.skips || 0) + 1;
        event('SKIP', `${m}: Jev was busy even after a second try - skipped this round, will check again next round`);
        push('decisions', { ...base, answers: '', action: 'NONE', reason: `Skipped: ${rep.error}`, jev_seconds: '', input_tokens: '', output_tokens: '', cost_usd: '' });
      } else {
        st.stats.errors++;
        event('ERROR', `${m}: ${rep.error} - no action taken`);
        push('decisions', { ...base, answers: '', action: 'NONE', reason: `Jev error: ${rep.error}`, jev_seconds: '', input_tokens: '', output_tokens: '', cost_usd: '' });
      }
      continue;
    }
    const u = rep.usage || {};
    st.stats.checks++; st.stats.secs += rep.secs; st.stats.retries += rep.attempts - 1;
    st.stats.tokens += (u.input_tokens || 0) + (u.output_tokens || 0);
    if (u.cost_usd != null) { st.stats.cost += u.cost_usd; st.stats.costed++; }
    const row = { ...base, answers: summarise(rep.answers), jev_seconds: Math.round(rep.secs * 1000) / 1000,
      input_tokens: u.input_tokens ?? '', output_tokens: u.output_tokens ?? '', cost_usd: u.cost_usd ?? '' };

    if (pos) {
      const [hit, why] = exitSignal(rules, rep.answers);
      if (hit) {
        const t = sell(st, m, price, cfg, slipFor(cfg, m), now());
        push('trades', { engine: 'jev', market: m, reason: `exit rule: ${why}`, ...t });
        push('decisions', { ...row, action: 'SELL', reason: why });
        event('TRADE', `SELL ${m} @ ${t.fill_price} (${why}) P&L £${t.pnl}`);
      } else push('decisions', { ...row, action: 'HOLD', reason: why });
      continue;
    }
    const [ok, why] = entrySignal(rules, rep.answers);
    const cooling = st.last_exit[m] && (Date.parse(now()) - Date.parse(st.last_exit[m])) / 60000 < cfg.cooldown_minutes;
    if (ok && blocked) push('decisions', { ...row, action: 'NONE', reason: `daily loss limit (${dayLoss.toFixed(1)}%)` });
    else if (ok && cooling) push('decisions', { ...row, action: 'NONE', reason: 'cooldown after last exit' });
    else if (ok) {
      const spend = Math.min(st.cash, equityOf(st, prices) * cfg.position_size_pct / 100);
      if (spend < 10) { push('decisions', { ...row, action: 'NONE', reason: 'not enough cash' }); continue; }
      const t = buy(st, m, price, spend, cfg, slipFor(cfg, m), now());
      push('trades', { engine: 'jev', market: m, reason: `entry rule: ${why}`, ...t });
      push('decisions', { ...row, action: 'BUY', reason: why });
      event('TRADE', `BUY ${m} £${r2(spend)} @ ${t.fill_price}`);
    } else push('decisions', { ...row, action: 'NONE', reason: why });
  }

  // 5. equity snapshot
  const eq = equityOf(st, prices);
  push('equity', { engine: 'jev', cash: r2(st.cash), positions_value: r2(eq - st.cash), equity: r2(eq),
    benchmark_equity: r2(benchmarkEquity(st, prices, cfg.fee_pct)), open_positions: Object.keys(st.positions).join(' ') || '-' });
  return { markets: Object.keys(prices).length, asked: ask_list.length, equity: r2(eq), open: Object.keys(st.positions) };
}

// ------------------------------------------------------------------ report & dashboard
function maxDrawdown(values) {
  let peak = values[0], worst = 0;
  for (const v of values) { peak = Math.max(peak, v); worst = Math.max(worst, peak ? (peak - v) / peak * 100 : 0); }
  return worst;
}

export function verdict(s) {
  if (s.closed < MIN_TRADES || s.days < MIN_DAYS) {
    return `TOO EARLY TO JUDGE. You need at least ${MIN_TRADES} closed trades and ${MIN_DAYS} days (you have ${s.closed} trades over ${Math.round(s.days)} days). Results this small are mostly luck.`;
  }
  if (s.ret <= s.bench_ret) return 'NOT WORKING. The bot is doing no better than simply buying and holding. Do not put real money behind these rules - change them, reset, and test again.';
  return 'BEATING BUY-AND-HOLD ON PAPER. That is encouraging but not proof: check it held up across both rising and falling weeks, and remember real fills and fees can be worse than simulated.';
}

export function summary(st) {
  if (!st.equity.length) return {};
  const eq = st.equity.map(r => r.equity), bench = st.equity.map(r => r.benchmark_equity);
  const sells = st.trades.filter(t => t.side === 'SELL'), pnls = sells.map(t => +t.pnl);
  const wins = pnls.filter(p => p > 0), losses = pnls.filter(p => p <= 0);
  const days = (Date.parse(st.equity.at(-1).time) - Date.parse(st.equity[0].time)) / 86400000;
  const by_reason = {};
  for (const t of sells) { const k = String(t.reason).split(':')[0]; const [n, p] = by_reason[k] || [0, 0]; by_reason[k] = [n + 1, p + +t.pnl]; }
  const s = {
    from: st.equity[0].time, to: st.equity.at(-1).time, days, start: st.starting_cash,
    equity: eq.at(-1), ret: (eq.at(-1) / st.starting_cash - 1) * 100,
    bench: bench.at(-1), bench_ret: (bench.at(-1) / st.starting_cash - 1) * 100,
    dd: maxDrawdown(eq), bench_dd: maxDrawdown(bench),
    closed: sells.length, wins: wins.length, losses: losses.length,
    avg_win: wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0,
    avg_loss: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0,
    fees: st.fees_paid, open: Object.keys(st.positions),
    checks: st.stats.checks, errors: st.stats.errors, tokens: st.stats.tokens,
    avg_secs: st.stats.checks ? st.stats.secs / st.stats.checks : 0,
    cost: st.stats.cost, costed: st.stats.costed, retries: st.stats.retries, skips: st.stats.skips || 0, second_tries: st.stats.second_tries || 0, by_reason,
    min_trades: MIN_TRADES, min_days: MIN_DAYS,
  };
  s.verdict = verdict(s);
  return s;
}

function downsample(rows, limit) {
  if (rows.length <= limit) return rows;
  const step = rows.length / limit, out = [];
  for (let i = 0; i < limit - 1; i++) out.push(rows[Math.floor(i * step)]);
  out.push(rows.at(-1));
  return out;
}

export function snapshot(st, cfg, rules, credits = null) {
  const latest = {};
  for (const d of st.decisions) latest[d.market] = d;
  const prices = {};
  for (const [m, d] of Object.entries(latest)) if (d.price !== '' && d.price != null) prices[m] = +d.price;
  const positions = Object.entries(st.positions).map(([m, p]) => {
    const price = prices[m] ?? p.entry_price, value = p.qty * price;
    return { ...p, market: m, price, value, pnl: value - p.cost_gbp, pnl_pct: (value / p.cost_gbp - 1) * 100 };
  });
  return {
    schema: 1, generated_at: iso(), engine: 'jev', provider: 'vercel', runner: 'cloud',
    markets: cfg.markets.filter(m => !st.unavailable.includes(m)),
    check_every_minutes: cfg.check_every_minutes, jev_split: cfg.jev_split || 1, starting_cash: st.starting_cash, cash: st.cash, fees_paid: st.fees_paid,
    risk: { position_size_pct: cfg.position_size_pct, stop_loss_pct: cfg.stop_loss_pct, take_profit_pct: cfg.take_profit_pct,
      daily_loss_limit_pct: cfg.daily_loss_limit_pct, cooldown_minutes: cfg.cooldown_minutes, fee_pct: cfg.fee_pct,
      slippage_pct: cfg.slippage_pct, slippage_pct_other: cfg.slippage_pct_other, major_markets: cfg.major_markets },
    unavailable: [...st.unavailable].sort(),
    rules: { entry: describe(rules.entry), exit: describe(rules.exit),
      questions: Object.fromEntries(Object.entries(rules.questions).map(([k, q]) => [k, { type: q.type, instructions: q.instructions, criteria: q.criteria ?? null }])) },
    summary: summary(st),
    positions, prices, latest,
    equity: downsample(st.equity.map(r => [r.time, r.equity, r.benchmark_equity]), 1500),
    trades: st.trades.slice(-200),
    decisions: st.decisions.slice(-60),
    events: st.events.filter(e => (e.level === 'WARN' || e.level === 'ERROR' || e.level === 'SKIP') && !(e.level === 'ERROR' && /Jev unavailable after/.test(e.message)) && Date.now() - Date.parse(e.time) < 86400000).slice(-30),   // last 24 hours only
    credits,
  };
}
