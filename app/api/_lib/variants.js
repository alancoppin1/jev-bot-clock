// Side-by-side rule variants. Each is its own £10,000 paper account run on the same prices
// (and, for B, the same Jev answers) as the main bot "A", so they cost nothing extra in Jev calls.
//   B - improved rules: Jev's entry signal + only buy while Bitcoin is above its 50-hour average,
//       a stop sized to each coin's normal movement that trails up behind the price, no fixed target.
//   C - no Jev: the same rules as A, but decided straight from the indicators, to test whether Jev adds anything.
import { entrySignal, exitSignal } from './rules.js';

const r2 = (v) => Math.round(v * 100) / 100;
export const VARIANTS = {
  B: { name: 'B · improved rules', short: 'B', desc: "Jev's buy signal, only while Bitcoin is above its 50-hour average; stop sized to each coin's normal movement (3–8%) that trails up behind the price; no fixed profit target." },
  C: { name: 'C · no Jev', short: 'C', desc: "Same rules and stops as A, but decided straight from the price indicators (moving averages, 6-hour change, RSI) with no Jev." },
  D: { name: 'D · A + news', short: 'D', desc: "A's rules, plus Jev reads the latest crypto headlines and the Fear & Greed Index: no buying when the news mood is negative, a major bad event is reported, or a coin's own news is bad; sells a coin on bad news about it or a major bad event." },
};

export function newAccount(cash, now) {
  return { started: now, starting_cash: cash, cash, positions: {}, last_exit: {}, day: '', day_start_equity: 0, fees_paid: 0, trades: [], equity: [] };
}

const equityOf = (a, prices) => Object.entries(a.positions).reduce((v, [m, p]) => v + p.qty * (prices[m] ?? p.entry_price), a.cash);

function buy(a, m, price, spend, cfg, slip, now) {
  const fill = price * (1 + slip / 100), fee = spend * cfg.fee_pct / 100, qty = (spend - fee) / fill;
  a.cash -= spend; a.fees_paid += fee;
  a.positions[m] = { qty, entry_price: fill, cost_gbp: spend, entry_time: now, high: fill,
    stop_price: fill * (1 - cfg.stop_loss_pct / 100), target_price: fill * (1 + cfg.take_profit_pct / 100) };
  a.trades.push({ time: now, market: m, side: 'BUY', fill_price: fill, gbp: r2(spend), pnl: '' });
  return a.positions[m];
}

function sell(a, m, price, cfg, slip, now, reason) {
  const p = a.positions[m]; delete a.positions[m];
  const fill = price * (1 - slip / 100), gross = p.qty * fill, fee = gross * cfg.fee_pct / 100, proceeds = gross - fee;
  a.cash += proceeds; a.fees_paid += fee; a.last_exit[m] = now;
  const pnl = r2(proceeds - p.cost_gbp);
  a.trades.push({ time: now, market: m, side: 'SELL', fill_price: fill, gbp: r2(proceeds), pnl, reason });
  if (a.trades.length > 2000) a.trades.splice(0, a.trades.length - 2000);
  return pnl;
}

// Jev-style answers worked out from the indicators alone (for variant C)
export function indicatorAnswers(ind) {
  const up = ind.price > ind.sma20 && ind.sma20 > ind.sma50 && ind.chg_72 > 0;
  const down = ind.price < ind.sma20 && ind.sma20 < ind.sma50 && ind.chg_72 < 0;
  return {
    trend: { type: 'choice', choice: up ? 'up' : down ? 'down' : 'sideways', confidence: 1 },
    momentum: { type: 'score', score: ind.chg_6 > 0.5 ? 3 : 2, confidence: 1 },
    overextended: { type: 'noul', noul: ind.rsi14 > 70 || ind.range_pos > 95 ? 1 : 0 },
    breakdown: { type: 'noul', noul: ind.price <= ind.low72 * 1.01 ? 1 : 0 },
  };
}

// One round for one variant account.
//   turn: coins judged this round; jev: Jev replies by coin; ind: indicators by coin; btcUp: Bitcoin filter
export function runVariant(id, a, { order, turn, prices, jev, ind, btcUp, news, cfg, rules, slipFor, now, event }) {
  const today = now.slice(0, 10), eqNow = equityOf(a, prices);
  if (a.day !== today) { a.day = today; a.day_start_equity = eqNow; }
  const dayLoss = a.day_start_equity ? (1 - eqNow / a.day_start_equity) * 100 : 0;
  const blocked = dayLoss >= cfg.daily_loss_limit_pct;

  for (const m of order) {
    const price = prices[m], pos = a.positions[m];
    // stops: every coin, every round
    if (pos) {
      if (id === 'B') {
        pos.high = Math.max(pos.high, price);
        pos.stop_price = Math.max(pos.stop_price, pos.high * (1 - pos.stop_pct / 100));   // trails up, never down
        if (price <= pos.stop_price) {
          const pnl = sell(a, m, price, cfg, slipFor(m), now, pos.high > pos.entry_price * 1.001 ? 'trailing stop' : 'stop-loss');
          event('TRADE', `[${id}] SELL ${m} (stop) P&L £${pnl}`); continue;
        }
      } else if (price <= pos.stop_price || price >= pos.target_price) {
        const pnl = sell(a, m, price, cfg, slipFor(m), now, price <= pos.stop_price ? 'stop-loss' : 'take-profit');
        event('TRADE', `[${id}] SELL ${m} (${price <= pos.stop_price ? 'stop-loss' : 'take-profit'}) P&L £${pnl}`); continue;
      }
    }
    if (!turn.has(m)) continue;

    // this round's judgement for the coin
    let answers = null;
    if (id === 'C') answers = ind[m] ? indicatorAnswers(ind[m]) : null;
    else answers = jev[m] && !jev[m].error ? jev[m].answers : null;
    if (!answers) continue;

    // D: news read by Jev (if there's no usable read this round, D simply follows A's rules)
    const coinNews = id === 'D' && news ? news.coins[m] : null;
    const badCoinNews = !!coinNews && coinNews.view === 'negative' && (coinNews.conf ?? 1) >= 0.6;
    if (a.positions[m]) {
      if (id === 'D' && news && (badCoinNews || news.risk >= 0.7)) {
        const why = badCoinNews ? 'bad news for this coin' : 'major bad news event';
        const pnl = sell(a, m, price, cfg, slipFor(m), now, `news: ${why}`); event('TRADE', `[${id}] SELL ${m} (${why}) P&L £${pnl}`); continue;
      }
      const [hit, why] = exitSignal(rules, answers);
      if (hit) { const pnl = sell(a, m, price, cfg, slipFor(m), now, `exit rule: ${why}`); event('TRADE', `[${id}] SELL ${m} (exit rule) P&L £${pnl}`); }
      continue;
    }
    const [ok] = entrySignal(rules, answers);
    if (!ok || blocked) continue;
    if (id === 'B' && !btcUp) continue;
    if (id === 'D' && news && ((news.mood ?? 2) < 1.5 || news.risk >= 0.5 || badCoinNews)) continue;
    if (a.last_exit[m] && (Date.parse(now) - Date.parse(a.last_exit[m])) / 60000 < cfg.cooldown_minutes) continue;
    const spend = Math.min(a.cash, equityOf(a, prices) * cfg.position_size_pct / 100);
    if (spend < 10) continue;
    const p = buy(a, m, price, spend, cfg, slipFor(m), now);
    if (id === 'B') {
      p.stop_pct = Math.min(8, Math.max(3, 3 * (ind[m]?.atr14_pct ?? 1)));
      p.stop_price = p.entry_price * (1 - p.stop_pct / 100);
      p.target_price = null;
    }
    event('TRADE', `[${id}] BUY ${m} £${r2(spend)}`);
  }
  return equityOf(a, prices);
}

export function variantSummary(a, prices) {
  const sells = a.trades.filter(t => t.side === 'SELL'), wins = sells.filter(t => t.pnl > 0);
  const lastEq = a.equity.length ? a.equity.at(-1)[1] : a.starting_cash;
  const eq = prices ? equityOf(a, prices) : lastEq;
  return {
    equity: eq, ret: (eq / a.starting_cash - 1) * 100, closed: sells.length, wins: wins.length,
    win_rate: sells.length ? wins.length / sells.length * 100 : null, fees: a.fees_paid,
    open: Object.keys(a.positions), cash: a.cash, started: a.started,
    realised: sells.reduce((s, t) => s + t.pnl, 0),
  };
}
