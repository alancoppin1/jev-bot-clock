// The US stock news experiment: one round, the paper accounts, and the dashboard snapshot.
//
// Every round (about every 10-15 minutes, day and night):
//   1. prices for the 40 shares, SPY and the pound/dollar rate
//   2. new SEC filings (8-Ks) for all 40 companies, and new headlines for a quarter of them (taking turns)
//      -> each becomes a news "event" that waits for the stock market to be open
//   3. once trading has been open for 30 minutes after the news, the event is decided:
//      Jev reads it (account A), the no-AI rule looks at results releases (account B),
//      and every A purchase is copied onto a random share (account C)
//   4. stop-losses, trailing stops and time limits are checked for every holding
// Accounts hold pounds; buying a US share converts pounds to dollars (and selling converts back), with a fee each way.
import { TICKERS, NAME, ALIASES, OPINION, STOCK_CONFIG, NEWS_QUESTIONS, A_RULES } from './settings.js';
import { session, sessionFor } from './clock.js';
import { fetchPrices, priceAt, recentFilings, filingText, fetchHeadlines, pool } from './sources.js';
import { askJev, JevError } from '../jev.js';

export const iso = (d = new Date()) => new Date(d).toISOString().slice(0, 19) + 'Z';
const r2 = (v) => Math.round(v * 100) / 100;
const pct = (a, b) => (b ? (a / b - 1) * 100 : 0);
const signed = (v, d = 2) => (v >= 0 ? '+' : '') + v.toFixed(d) + '%';
const KEEP = { log: 300, done: 400, equity: 6000, trades: 1000 };
export const ACCOUNTS = {
  A: { name: 'A · Jev reads the news', desc: "Jev reads each results release, company announcement and batch of headlines. Buys when it judges the news material, good for the company and not yet reflected in the price; sells a holding on material bad news." },
  B: { name: 'B · no AI', desc: 'A simple rule with no AI: buy a share that has risen at least 2% (and beaten the S&P 500 by 1.5%) since its results release; sell a holding that falls 2% after its results.' },
  C: { name: 'C · random', desc: 'Every time A buys, C buys a randomly chosen share from the same 40 instead, and sells it when A sells on news. Shows what A would get by luck alone.' },
};
export const BENCH = {
  H: { name: 'Buy & hold the 40', desc: 'All 40 shares, equal amounts, bought at the start and never sold.' },
  S: { name: 'S&P 500 (SPY)', desc: 'An S&P 500 index fund, bought at the start and never sold.' },
};
export const MIN_TRADES = 30, MIN_DAYS = 60;

function newAccount(cash) {
  return { cash, positions: {}, trades: [], fees: 0, buys_day: '', buys_n: 0 };
}

export function newState(cfg) {
  return {
    schema: 'stocks', session_id: cfg.session_id, created: iso(), start_gbp: cfg.starting_cash_gbp,
    started: null, fx_start: null, fx: null,
    accounts: Object.fromEntries(Object.keys(ACCOUNTS).map(id => [id, newAccount(cfg.starting_cash_gbp)])),
    bench: null, seen_filings: {}, seen_headlines: {}, seeded: false, hl_turn: 0,
    queue: [], done: [], equity: [], log: [], last_prices: {},
    stats: { jev_calls: 0, jev_errors: 0, jev_busy: 0, tokens: 0, cost: 0, costed: 0, secs: 0, filings: 0, headline_events: 0, rounds: 0 },
    last_cycle_at: null, running_until: null,
  };
}

// ------------------------------------------------------------------ money
const value = (a, prices, fx) => Object.entries(a.positions).reduce((v, [t, p]) => v + p.qty * (prices[t] ?? p.entry) / fx, a.cash);

function buy(a, t, price, gbp, cfg, fx, now, extra = {}) {
  const fxFee = gbp * cfg.fx_fee_pct / 100;
  const usd = (gbp - fxFee) * fx, fill = price * (1 + cfg.slippage_pct / 100), qty = usd / fill;
  a.cash -= gbp; a.fees += fxFee + qty * (fill - price) / fx;
  a.positions[t] = { qty, entry: fill, cost: gbp, entry_time: now, high: fill, ...extra };
  a.trades.push({ time: now, ticker: t, side: 'BUY', price: r2(fill), gbp: r2(gbp), why: extra.why || '' });
  if (a.trades.length > KEEP.trades) a.trades.splice(0, a.trades.length - KEEP.trades);
}

function sell(a, t, price, cfg, fx, now, why) {
  const p = a.positions[t]; delete a.positions[t];
  const fill = price * (1 - cfg.slippage_pct / 100), gross = p.qty * fill / fx, fxFee = gross * cfg.fx_fee_pct / 100, gbp = gross - fxFee;
  a.cash += gbp; a.fees += fxFee + p.qty * (price - fill) / fx;
  const pnl = gbp - p.cost;
  a.trades.push({ time: now, ticker: t, side: 'SELL', price: r2(fill), gbp: r2(gbp), pnl: r2(pnl), pnl_pct: r2(pnl / p.cost * 100), held_days: r2((Date.parse(now) - Date.parse(p.entry_time)) / 86400000), why });
  if (a.trades.length > KEEP.trades) a.trades.splice(0, a.trades.length - KEEP.trades);
  return pnl;
}

// can this account buy one more share today?
function roomToBuy(a, cfg, sessionDate) {
  if (a.buys_day !== sessionDate) { a.buys_day = sessionDate; a.buys_n = 0; }
  if (Object.keys(a.positions).length >= cfg.max_positions) return 'already holding the maximum number of shares';
  if (a.buys_n >= cfg.max_buys_per_day) return 'daily buying limit reached';
  return null;
}

function stake(a, prices, fx, cfg) {
  return Math.min(a.cash, value(a, prices, fx) * cfg.position_size_pct / 100);
}

// deterministic "random" pick for account C, from the event id (so a re-run gives the same answer)
function randomPick(seed, exclude) {
  let h = 2166136261;
  for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const choices = TICKERS.filter(t => !exclude.has(t));
  return choices.length ? choices[h % choices.length] : null;
}

// ------------------------------------------------------------------ Jev's view of one event
function describeTime(ms) {
  const s = session(ms);
  const when = s.isOpen ? 'during trading hours' : (s.trading && ms < s.open ? 'before the market opened' : 'after the market had closed');
  return `${iso(ms).slice(0, 16).replace('T', ' ')} UTC (${when})`;
}

export function buildEventState(ev, ctx) {
  const lines = [
    `Company: ${NAME[ev.ticker]} (ticker ${ev.ticker}), a large US-listed company.`,
    ev.kind === 'filing'
      ? `News type: official company filing with the US Securities and Exchange Commission (form 8-K): ${ev.item_names.join('; ')}.`
      : `News type: news headlines about the company from financial news sites.`,
    `Published: ${describeTime(ev.time)}.`,
    `Share price just before publication: $${ctx.before.toFixed(2)}. Share price now (${iso(ctx.now).slice(0, 16).replace('T', ' ')} UTC): $${ctx.price.toFixed(2)}, a change of ${signed(ctx.reaction)} since publication.`,
    `Over the same time the S&P 500 index fund (SPY) changed ${signed(ctx.market)}, so the share has moved ${signed(ctx.reaction - ctx.market)} relative to the market.`,
  ];
  if (ev.kind === 'filing') {
    lines.push('', `Text of the announcement${ctx.truncated ? ' (cut short)' : ''}:`, ctx.text);
  } else {
    lines.push('', 'Headlines, newest first:');
    for (const h of ev.headlines) lines.push(`- [${iso(h.time).slice(5, 16).replace('T', ' ')} UTC, ${h.source}] ${h.title}`);
  }
  return lines.join('\n');
}

export function aDecision(ans) {
  const m = ans?.material?.noul, imp = ans?.impact?.choice, conf = ans?.impact?.confidence ?? 0, pin = ans?.priced_in?.noul;
  if (m == null || imp == null || pin == null) return { act: null, why: 'Jev gave no usable answer' };
  const b = A_RULES.buy, s = A_RULES.sell;
  const desc = `material ${m.toFixed(2)}, ${imp} @ ${conf.toFixed(2)}, priced in ${pin.toFixed(2)}`;
  if (m >= s.material_at_least && imp === s.impact && conf >= s.impact_confidence) return { act: 'SELL', why: `bad news: ${desc}` };
  if (m >= b.material_at_least && imp === b.impact && conf >= b.impact_confidence && pin < b.priced_in_below) return { act: 'BUY', why: `good news not yet priced in: ${desc}` };
  const miss = m < b.material_at_least ? 'not material' : imp !== 'positive' ? `judged ${imp}` : conf < b.impact_confidence ? 'not confident enough' : 'already priced in';
  return { act: 'NONE', why: `${miss}: ${desc}` };
}

// The session in which news published at `ms` gets decided. News that arrives too late in a session
// to allow the 30-minute reaction window is decided in the next session instead.
function decisionSession(ms, cfg) {
  let s = sessionFor(ms);
  if (Math.max(s.open, ms) + cfg.react_minutes * 60000 > s.close - 20 * 60000) s = sessionFor(s.close + 60000);
  return s;
}

// ------------------------------------------------------------------ one round
export async function runRound(st, cfg, { token, deps = {}, startedAt = Date.now() } = {}) {
  const nowMs = deps.now ? deps.now() : Date.now();
  const now = iso(nowMs);
  const ask = deps.askJev || askJev;
  const src = { fetchPrices, recentFilings, filingText, fetchHeadlines, ...(deps.sources || {}) };
  const log = (level, message) => { st.log.push({ time: now, level, message }); if (st.log.length > KEEP.log) st.log.splice(0, st.log.length - KEEP.log); };
  const outOfTime = () => !deps.askJev && Date.now() - startedAt > cfg.round_budget_seconds * 1000;
  st.stats.rounds++;

  // 1. prices
  let P;
  try { P = await src.fetchPrices([...TICKERS, 'SPY', 'GBPUSD=X']); }
  catch (e) { log('WARN', `prices unavailable (${e.message}) - nothing done this round`); return { ok: false }; }
  const prices = {};
  for (const t of [...TICKERS, 'SPY']) if (P[t]?.price) prices[t] = P[t].price;
  const fx = P['GBPUSD=X']?.price || st.fx;
  if (!fx || !prices.SPY) { log('WARN', 'no pound/dollar rate or S&P 500 price - nothing done this round'); return { ok: false }; }
  st.fx = fx; st.last_prices = prices;
  const sess = session(nowMs);
  const fresh = (t) => P[t] && nowMs - P[t].time < 20 * 60000;
  const marketOpen = sess.isOpen && fresh('SPY');      // the calendar says open AND prices are moving
  st.market = { open: marketOpen, session: sess.date, next_open: iso(sessionFor(nowMs).open), next_close: iso(sessionFor(nowMs).close) };

  // start the clock on the first open market: benchmarks buy in, every line starts at £10,000
  if (marketOpen && !st.bench) {
    st.started = now; st.fx_start = fx;
    const share = cfg.starting_cash_gbp / TICKERS.length;
    const H = newAccount(cfg.starting_cash_gbp), S = newAccount(cfg.starting_cash_gbp);
    for (const t of TICKERS) if (prices[t]) buy(H, t, prices[t], share, cfg, fx, now);
    buy(S, 'SPY', prices.SPY, cfg.starting_cash_gbp, cfg, fx, now);
    st.bench = { H, S };
    log('INFO', `experiment started: benchmarks bought in at £1 = $${fx.toFixed(4)}`);
  }

  // 2a. SEC filings for all 40 (the SEC allows up to 10 requests a second, we stay well under)
  const since = nowMs - 3 * 86400000;
  const newFilings = [];
  const secErrors = [];
  await pool(TICKERS, 3, async (t) => {
    try {
      for (const f of await src.recentFilings(t, since, cfg.sec_user_agent)) {
        if (st.seen_filings[f.id]) continue;
        st.seen_filings[f.id] = f.time;
        if (!st.seeded && f.time < nowMs - 86400000) continue;   // first run: ignore anything over a day old
        newFilings.push(f);
      }
    } catch (e) { secErrors.push(`${t}: ${e.message}`); }
    if (!deps.sources) await new Promise(r => setTimeout(r, 150));
  });
  if (secErrors.length) log('WARN', `SEC filings not checked for ${secErrors.length} compan${secErrors.length === 1 ? 'y' : 'ies'} (${secErrors[0]}${secErrors.length > 1 ? '; …' : ''})`);
  for (const f of newFilings.sort((a, b) => a.time - b.time)) {
    const s = decisionSession(f.time, cfg);
    st.queue.push({ id: f.id, ticker: f.ticker, kind: 'filing', time: f.time, items: f.items, item_names: f.item_names, url: f.url, index_url: f.index_url,
      title: `${NAME[f.ticker]}: ${f.item_names.join(', ')}`, session: s.date, decide_after: Math.max(s.open, f.time) + cfg.react_minutes * 60000, status: 'waiting', found: now });
    st.stats.filings++;
    log('NEWS', `${f.ticker} filed an 8-K (${f.item_names.join(', ')})`);
  }

  // 2b. headlines for a quarter of the shares, taking turns
  const groups = Math.max(1, cfg.headline_groups);
  const turn = st.hl_turn % groups; st.hl_turn++;
  const hlTickers = TICKERS.filter((_, i) => i % groups === turn);
  const hlErrors = [];
  await pool(hlTickers, 4, async (t) => {
    let res;
    try { res = await src.fetchHeadlines(t); } catch (e) { hlErrors.push(`${t}: ${e.message}`); return; }
    if (res.errors.length && !res.headlines.length) { hlErrors.push(`${t}: ${res.errors[0]}`); return; }
    const al = ALIASES[t].map(a => a.toLowerCase()), tick = new RegExp(`(^|[^A-Za-z])${t}([^A-Za-z]|$)`);
    const newOnes = [];
    for (const h of res.headlines) {
      const key = t + ':' + h.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
      if (st.seen_headlines[key]) continue;
      st.seen_headlines[key] = h.time;
      if (h.time < nowMs - cfg.headline_hours * 3600000 || h.time > nowMs + 600000) continue;
      if (OPINION.test(h.title)) continue;
      if (!al.some(a => h.title.toLowerCase().includes(a)) && !tick.test(h.title)) continue;
      newOnes.push({ time: h.time, title: h.title, source: h.source });
    }
    if (!newOnes.length) return;
    // add to a headline event for this share that is still waiting for the same session, or start one
    const s = decisionSession(Math.max(...newOnes.map(h => h.time)), cfg);
    let ev = st.queue.find(e => e.kind === 'headlines' && e.ticker === t && e.status === 'waiting' && e.session === s.date);
    if (!ev) {
      ev = { id: `H-${t}-${now}`, ticker: t, kind: 'headlines', time: Math.min(...newOnes.map(h => h.time)), headlines: [], session: s.date, status: 'waiting', found: now };
      st.queue.push(ev); st.stats.headline_events++;
    }
    ev.headlines = [...newOnes, ...ev.headlines].sort((a, b) => b.time - a.time).slice(0, 15);
    ev.time = Math.min(ev.time, ...newOnes.map(h => h.time));
    ev.title = `${NAME[t]}: ${ev.headlines.length} new headline${ev.headlines.length > 1 ? 's' : ''}`;
    ev.decide_after = Math.max(s.open, Math.max(...ev.headlines.map(h => h.time))) + cfg.react_minutes * 60000;
  });
  if (hlErrors.length) log('WARN', `headlines unavailable for ${hlErrors.length} share(s) (${hlErrors[0]})`);
  st.seeded = true;

  // tidy the memory of what's been seen
  for (const k of Object.keys(st.seen_filings)) if (st.seen_filings[k] < nowMs - 10 * 86400000) delete st.seen_filings[k];
  for (const k of Object.keys(st.seen_headlines)) if (st.seen_headlines[k] < nowMs - 4 * 86400000) delete st.seen_headlines[k];

  const accts = st.accounts;
  if (marketOpen) {
    // 3. risk exits first: stop-loss, trailing stop, time limit
    for (const [id, a] of Object.entries(accts)) {
      for (const [t, p] of Object.entries({ ...a.positions })) {
        if (!fresh(t)) continue;
        const price = prices[t];
        p.high = Math.max(p.high, price);
        const trailing = p.high >= p.entry * (1 + cfg.trail_after_gain_pct / 100);
        const stop = trailing ? Math.max(p.entry * (1 - cfg.stop_loss_pct / 100), p.high * (1 - cfg.stop_loss_pct / 100)) : p.entry * (1 - cfg.stop_loss_pct / 100);
        p.stop = stop;
        let why = null;
        if (price <= stop) why = trailing ? 'trailing stop' : 'stop-loss';
        else if ((nowMs - Date.parse(p.entry_time)) / 86400000 >= cfg.max_hold_days) why = 'time limit';
        if (why) { const pnl = sell(a, t, price, cfg, fx, now, why); log('TRADE', `[${id}] SELL ${t} (${why}) P&L £${r2(pnl)}`); }
      }
    }

    // 4. decide the news events that are ready
    const ready = st.queue.filter(e => e.status === 'waiting' && e.session === sess.date && nowMs >= e.decide_after).sort((a, b) => a.decide_after - b.decide_after);
    for (const ev of ready) {
      if (outOfTime()) { log('WARN', 'ran out of time - remaining news will be decided next round'); break; }
      const t = ev.ticker;
      if (!fresh(t)) continue;
      const before = priceAt(P[t], ev.time), spyBefore = priceAt(P.SPY, ev.time);
      if (!before || !spyBefore) { ev.status = 'error'; ev.note = 'no price from before the news'; continue; }
      const ctx = { now: nowMs, price: prices[t], before, reaction: pct(prices[t], before), market: pct(prices.SPY, spyBefore) };

      // account A - Jev
      if (ev.kind === 'filing' && ev.text_chars == null) {
        try {
          const tx = await src.filingText(ev, cfg.sec_user_agent, cfg.filing_text_chars);
          ctx.text = tx.text; ctx.truncated = tx.truncated; ev.text_chars = tx.text.length; ev.exhibit = tx.exhibit;
        } catch (e) { ev.tries = (ev.tries || 0) + 1; if (ev.tries >= 3) { ev.status = 'error'; ev.note = `could not read the filing (${e.message})`; } continue; }
      }
      let rep;
      try {
        if (!deps.askJev && cfg.jev_gap_ms) await new Promise(r => setTimeout(r, cfg.jev_gap_ms));
        if (ev.kind === 'filing' && ctx.text == null) {   // text was read on an earlier try; read again (it isn't stored)
          const tx = await src.filingText(ev, cfg.sec_user_agent, cfg.filing_text_chars); ctx.text = tx.text; ctx.truncated = tx.truncated;
        }
        rep = await ask({ url: cfg.jev_url, model: cfg.jev_model, token, state: buildEventState(ev, ctx), questions: NEWS_QUESTIONS, retries: 3 });
      } catch (e) {
        if (e.busy) { st.stats.jev_busy++; log('SKIP', `${t}: Jev busy - will try again next round`); continue; }
        st.stats.jev_errors++;
        ev.jev_error = e instanceof JevError ? e.message : `unexpected: ${e.message}`;
        log('ERROR', `${t}: ${ev.jev_error}`);
      }
      if (rep) {
        const u = rep.usage || {};
        st.stats.jev_calls++; st.stats.secs += rep.secs; st.stats.tokens += (u.input_tokens || 0) + (u.output_tokens || 0);
        if (u.cost_usd != null) { st.stats.cost += u.cost_usd; st.stats.costed++; }
        const a = rep.answers;
        ev.jev = { material: a.material?.noul, impact: a.impact?.choice, impact_conf: a.impact?.confidence, priced_in: a.priced_in?.noul };
      }
      ev.status = 'decided'; ev.decided_at = now; ev.price_before = r2(before); ev.price_at_decision = r2(prices[t]);
      ev.reaction = r2(ctx.reaction); ev.market = r2(ctx.market);
      ev.actions = {};

      const A = accts.A, C = accts.C;
      const dec = rep ? aDecision(rep.answers) : { act: null, why: 'Jev error - no decision' };
      ev.a_why = dec.why;
      if (dec.act === 'SELL' && A.positions[t]) {
        const pnl = sell(A, t, prices[t], cfg, fx, now, `news: ${dec.why}`); ev.actions.A = 'SELL';
        log('TRADE', `[A] SELL ${t} on bad news, P&L £${r2(pnl)}`);
        const mirror = Object.entries(C.positions).find(([, p]) => p.mirror_of === t);
        if (mirror && fresh(mirror[0])) { sell(C, mirror[0], prices[mirror[0]], cfg, fx, now, `copying A's news sale of ${t}`); ev.actions.C = `SELL ${mirror[0]}`; }
      } else if (dec.act === 'BUY' && !A.positions[t]) {
        const block = roomToBuy(A, cfg, sess.date), gbp = stake(A, prices, fx, cfg);
        if (block) ev.a_why += ` - not bought: ${block}`;
        else if (gbp < 50) ev.a_why += ' - not bought: not enough cash';
        else {
          buy(A, t, prices[t], gbp, cfg, fx, now, { why: dec.why, event: ev.id }); A.buys_n++; ev.actions.A = 'BUY';
          log('TRADE', `[A] BUY ${t} £${r2(gbp)} - ${dec.why}`);
          // account C copies the purchase onto a random share
          const pick = randomPick(ev.id, new Set(Object.keys(C.positions)));
          const cBlock = roomToBuy(C, cfg, sess.date), cGbp = stake(C, prices, fx, cfg);
          if (pick && !cBlock && cGbp >= 50 && fresh(pick)) {
            buy(C, pick, prices[pick], cGbp, cfg, fx, now, { why: `random copy of A's purchase of ${t}`, mirror_of: t }); C.buys_n++; ev.actions.C = `BUY ${pick}`;
          }
        }
      } else if (dec.act === 'BUY') ev.a_why += ' - already held';

      // account B - no AI: results releases only
      if (ev.kind === 'filing' && ev.items.includes('2.02')) {
        const B = accts.B, vs = ctx.reaction - ctx.market;
        if (B.positions[t] && ctx.reaction <= -cfg.b_min_reaction_pct) {
          sell(B, t, prices[t], cfg, fx, now, `fell ${signed(ctx.reaction)} after results`); ev.actions.B = 'SELL';
        } else if (!B.positions[t] && ctx.reaction >= cfg.b_min_reaction_pct && vs >= cfg.b_min_vs_market_pct) {
          const block = roomToBuy(B, cfg, sess.date), gbp = stake(B, prices, fx, cfg);
          if (!block && gbp >= 50) { buy(B, t, prices[t], gbp, cfg, fx, now, { why: `rose ${signed(ctx.reaction)} after results (${signed(vs)} vs market)` }); B.buys_n++; ev.actions.B = 'BUY'; }
        }
      }
    }
  }

  // news that missed its session (bot was down) is dropped, not traded late
  for (const ev of st.queue) if (ev.status === 'waiting' && ev.session < sess.date) { ev.status = 'expired'; ev.note = 'not decided during its trading session'; }
  const finished = st.queue.filter(e => e.status !== 'waiting');
  st.queue = st.queue.filter(e => e.status === 'waiting');
  st.done.push(...finished.map(({ text, ...e }) => e));
  if (st.done.length > KEEP.done) st.done.splice(0, st.done.length - KEEP.done);

  // 5. account values (in pounds)
  if (st.bench) {
    const row = [now, ...Object.keys(ACCOUNTS).map(id => r2(value(accts[id], prices, fx))), r2(value(st.bench.H, prices, fx)), r2(value(st.bench.S, prices, fx))];
    st.live = row;
    const last = st.equity.at(-1);
    if (!last || Date.parse(now) - Date.parse(last[0]) >= cfg.equity_every_minutes * 60000 - 90000) {
      st.equity.push(row); if (st.equity.length > KEEP.equity) st.equity.splice(0, st.equity.length - KEEP.equity);
    }
  }
  return { ok: true, market_open: marketOpen, new_filings: newFilings.length, waiting: st.queue.length, decided: finished.filter(e => e.status === 'decided').length };
}

// ------------------------------------------------------------------ dashboard snapshot
function downsample(rows, limit) {
  if (rows.length <= limit) return rows;
  const step = rows.length / limit, out = [];
  for (let i = 0; i < limit - 1; i++) out.push(rows[Math.floor(i * step)]);
  out.push(rows.at(-1));
  return out;
}

export function snapshot(st, cfg, credits = null) {
  const prices = st.last_prices || {}, fx = st.fx || 1;
  const rows = [...st.equity];
  if (st.live && (!rows.length || st.live[0] > rows.at(-1)[0])) rows.push(st.live);
  const days = st.started ? Math.max(0, (Date.now() - Date.parse(st.started)) / 86400000) : 0;
  const acct = (id, a, meta) => {
    const eq = value(a, prices, fx), sells = a.trades.filter(t => t.side === 'SELL');
    return {
      id, name: meta.name, desc: meta.desc, equity: r2(eq), ret: r2(pct(eq, cfg.starting_cash_gbp)), cash: r2(a.cash), fees: r2(a.fees),
      closed: sells.length, wins: sells.filter(t => t.pnl > 0).length, realised: r2(sells.reduce((s, t) => s + t.pnl, 0)),
      holdings: Object.entries(a.positions).map(([t, p]) => {
        const px = prices[t] ?? p.entry, v = p.qty * px / fx;
        return { ticker: t, name: NAME[t] || t, entry: r2(p.entry), price: r2(px), value: r2(v), pnl: r2(v - p.cost), pnl_pct: r2(pct(v, p.cost)), since: p.entry_time, stop: p.stop ? r2(p.stop) : r2(p.entry * (1 - cfg.stop_loss_pct / 100)), why: p.why || '' };
      }),
      trades: a.trades.slice(-40).reverse(),
    };
  };
  const A = st.accounts.A, aSells = A.trades.filter(t => t.side === 'SELL').length;
  const lines = [...Object.entries(ACCOUNTS).map(([id, m]) => acct(id, st.accounts[id], m))];
  const bench = st.bench ? Object.entries(BENCH).map(([id, m]) => { const eq = value(st.bench[id], prices, fx); return { id, name: m.name, desc: m.desc, equity: r2(eq), ret: r2(pct(eq, cfg.starting_cash_gbp)) }; }) : [];
  let verdict;
  if (!st.started) verdict = 'Waiting for the US market to open (Monday 14:30 UK time). The experiment starts on the first open round.';
  else if (aSells < MIN_TRADES || days < MIN_DAYS) verdict = `TOO EARLY TO JUDGE. A needs at least ${MIN_TRADES} closed trades and ${MIN_DAYS} days (it has ${aSells} over ${Math.floor(days)} days). Until then, results are mostly luck.`;
  else {
    const aRet = lines[0].ret, cRet = lines[2].ret, hRet = bench[0]?.ret ?? 0, sRet = bench[1]?.ret ?? 0;
    verdict = aRet > Math.max(cRet, hRet, sRet) ? 'A IS AHEAD of random picks and both benchmarks on paper. Encouraging, not proof: check it held up over different weeks.'
      : aRet > cRet ? 'A beats random picks but not simply holding shares. Jev may add a little, but not enough to beat buying and holding.'
      : 'NOT WORKING. Jev\'s news picks are doing no better than random picks.';
  }
  const evt = (e) => ({ id: e.id, ticker: e.ticker, kind: e.kind, title: e.title, time: iso(e.time), session: e.session, status: e.status,
    decide_after: e.decide_after ? iso(e.decide_after) : null, decided_at: e.decided_at || null, url: e.url || null, items: e.items || null,
    headlines: e.headlines ? e.headlines.slice(0, 6).map(h => ({ time: iso(h.time), source: h.source, title: h.title })) : null,
    jev: e.jev || null, a_why: e.a_why || null, actions: e.actions || null, reaction: e.reaction ?? null, market: e.market ?? null, note: e.note || e.jev_error || null });
  return {
    schema: 2, kind: 'stocks', generated_at: iso(), session_id: st.session_id, created: st.created, started: st.started,
    market: st.market || null, fx: st.fx, fx_start: st.fx_start, start_gbp: cfg.starting_cash_gbp, verdict, days: r2(days),
    accounts: lines, bench,
    series: { ids: [...Object.keys(ACCOUNTS), ...Object.keys(BENCH)], rows: downsample(rows, 1500) },
    waiting: st.queue.map(evt).sort((a, b) => (a.decide_after || '').localeCompare(b.decide_after || '')),
    decided: st.done.slice(-80).reverse().map(evt),
    stats: { ...st.stats, avg_secs: st.stats.jev_calls ? r2(st.stats.secs / st.stats.jev_calls) : 0 },
    rules: {
      universe: TICKERS.map(t => ({ ticker: t, name: NAME[t] })),
      questions: Object.fromEntries(Object.entries(NEWS_QUESTIONS).map(([k, q]) => [k, { type: q.type, instructions: q.instructions, criteria: q.criteria ?? null }])),
      a: A_RULES, risk: { position_size_pct: cfg.position_size_pct, max_positions: cfg.max_positions, max_buys_per_day: cfg.max_buys_per_day,
        stop_loss_pct: cfg.stop_loss_pct, trail_after_gain_pct: cfg.trail_after_gain_pct, max_hold_days: cfg.max_hold_days, react_minutes: cfg.react_minutes,
        fx_fee_pct: cfg.fx_fee_pct, slippage_pct: cfg.slippage_pct },
      b: { min_reaction_pct: cfg.b_min_reaction_pct, min_vs_market_pct: cfg.b_min_vs_market_pct },
    },
    log: st.log.filter(e => Date.now() - Date.parse(e.time) < 3 * 86400000).slice(-60).reverse(),
    credits,
  };
}
