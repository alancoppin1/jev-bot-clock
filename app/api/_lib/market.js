// Coinbase public market data, indicators and the factual snapshot Jev judges.
// Only PAST data is used - Jev never sees anything the bot could not have known.
const COINBASE = 'https://api.exchange.coinbase.com';
const HEADERS = { 'User-Agent': 'jev-paper-trader/2.0 (cloud)' };

export class NotListedError extends Error {}

async function getJson(url) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (r.status === 400 || r.status === 404) throw new NotListedError(`HTTP ${r.status}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function fetchCandles(product, granularity = 3600) {
  const rows = await getJson(`${COINBASE}/products/${product}/candles?granularity=${granularity}`);
  return rows
    .map(([time, low, high, open, close, volume]) => ({ time, low: +low, high: +high, open: +open, close: +close, volume: +volume }))
    .sort((a, b) => a.time - b.time);
}

export async function fetchPrice(product) {
  const d = await getJson(`${COINBASE}/products/${product}/ticker`);
  return +d.price;
}

const pctChange = (n, o) => (o ? (n / o - 1) * 100 : 0);
const sma = (v, n) => { const w = v.slice(-n); return w.reduce((a, b) => a + b, 0) / w.length; };

function rsi(closes, n = 14) {
  if (closes.length <= n) return 50;
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0)); losses.push(Math.max(-d, 0));
  }
  let g = gains.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let l = losses.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < gains.length; i++) { g = (g * (n - 1) + gains[i]) / n; l = (l * (n - 1) + losses[i]) / n; }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

export function indicators(candles, price) {
  if (candles.length < 60) throw new Error(`need at least 60 candles, got ${candles.length}`);
  const closes = candles.slice(0, -1).map(c => c.close).concat([price]);   // live price replaces the forming candle
  const last72 = candles.slice(-72);
  const hi72 = Math.max(...last72.map(c => c.high));
  const lo72 = Math.min(...last72.map(c => c.low));
  const vol6 = candles.slice(-7, -1).reduce((a, c) => a + c.volume, 0) / 6;
  const vol72 = candles.slice(-73, -1).reduce((a, c) => a + c.volume, 0) / 72;
  const at = (k) => closes[closes.length - 1 - k];
  return {
    price,
    chg_1: pctChange(price, at(1)),
    chg_6: pctChange(price, at(6)),
    chg_24: pctChange(price, at(24)),
    chg_72: closes.length >= 73 ? pctChange(price, at(72)) : pctChange(price, closes[0]),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    rsi14: rsi(closes, 14),
    high72: hi72,
    low72: lo72,
    range_pos: hi72 > lo72 ? (price - lo72) / (hi72 - lo72) * 100 : 50,
    vol_ratio: vol72 ? vol6 / vol72 : 1,
    recent_closes: closes.slice(-13, -1),
  };
}

// Prices keep enough precision to be meaningful for sub-penny coins.
export function fmtPrice(p) {
  if (p >= 100) return p.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return p.toLocaleString('en-GB', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  return Number(p.toPrecision(6)).toString();
}
const signed = (v, d = 2) => (v >= 0 ? '+' : '') + v.toFixed(d) + '%';

export function buildState(market, ind, candleSeconds, now = new Date()) {
  const unit = candleSeconds === 3600 ? 'hour' : `${candleSeconds / 60}-minute candle`;
  const p = ind.price;
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  return [
    `Market snapshot for ${market} at ${stamp}. Prices in GBP. Candle size: 1 ${unit}.`,
    `Current price: ${fmtPrice(p)}`,
    `Change over last 1 ${unit}: ${signed(ind.chg_1)}`,
    `Change over last 6 ${unit}s: ${signed(ind.chg_6)}`,
    `Change over last 24 ${unit}s: ${signed(ind.chg_24)}`,
    `Change over last 72 ${unit}s: ${signed(ind.chg_72)}`,
    `20-period moving average: ${fmtPrice(ind.sma20)} (price is ${signed(pctChange(p, ind.sma20))} vs this)`,
    `50-period moving average: ${fmtPrice(ind.sma50)} (price is ${signed(pctChange(p, ind.sma50))} vs this)`,
    `RSI(14): ${ind.rsi14.toFixed(1)} (above 70 is commonly read as overbought, below 30 as oversold)`,
    `72-period high: ${fmtPrice(ind.high72)}; 72-period low: ${fmtPrice(ind.low72)}; price sits at ${ind.range_pos.toFixed(0)}% of that range (0% = at the low, 100% = at the high)`,
    `Volume over last 6 periods vs 72-period average: ${ind.vol_ratio.toFixed(2)}x`,
    `Last 12 closes, oldest to newest: ${ind.recent_closes.map(fmtPrice).join(', ')}`,
  ].join('\n');
}
