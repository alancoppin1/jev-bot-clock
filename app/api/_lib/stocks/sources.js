// Where the stock bot gets its information. All free, public sources:
//   prices    - Yahoo Finance (5-minute bars, US shares, SPY, and the pound/dollar rate)
//   filings   - SEC EDGAR (company announcements filed as 8-Ks, e.g. quarterly results releases)
//   headlines - Nasdaq and Seeking Alpha RSS feeds per share
import { CIK, MATERIAL_ITEMS } from './settings.js';

const BROWSER_UA = 'Mozilla/5.0 (compatible; jev-paper-trader/3.0)';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function get(url, { ua = BROWSER_UA, as = 'json', tries = 3, timeout = 15000 } = {}) {
  let last = '';
  for (let i = 0; i < tries; i++) {
    let r;
    try { r = await fetch(url, { headers: { 'User-Agent': ua, Accept: as === 'json' ? 'application/json' : '*/*' }, signal: AbortSignal.timeout(timeout) }); }
    catch (e) { last = e.message; await sleep(800 * 2 ** i); continue; }
    if (r.ok) return as === 'json' ? r.json() : r.text();
    last = `HTTP ${r.status}`;
    if (r.status !== 429 && r.status < 500) break;
    await sleep(1000 * 2 ** i + Math.random() * 400);
  }
  throw new Error(`${new URL(url).hostname}: ${last}`);
}

export async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ------------------------------------------------------------------ prices
// Returns { SYMBOL: { price, time (ms), prevClose, bars: [[ms, close], ...] } } for the last 5 days of 5-minute bars.
export async function fetchPrices(symbols) {
  const out = {};
  const chunks = [];
  for (let i = 0; i < symbols.length; i += 15) chunks.push(symbols.slice(i, i + 15));
  await pool(chunks, 2, async (chunk) => {
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${chunk.map(encodeURIComponent).join(',')}&range=5d&interval=5m`;
    const d = await get(url);
    for (const res of d.spark?.result || []) {
      const r = res.response?.[0]; if (!r?.meta) continue;
      const ts = r.timestamp || [], cl = r.indicators?.quote?.[0]?.close || [];
      const bars = [];
      ts.forEach((t, k) => { if (cl[k] != null) bars.push([t * 1000, cl[k]]); });
      out[res.symbol] = { price: r.meta.regularMarketPrice, time: (r.meta.regularMarketTime || 0) * 1000,
        prevClose: r.meta.chartPreviousClose ?? r.meta.previousClose, bars };
    }
  });
  return out;
}

// Price at a moment: the last 5-minute bar that had closed by then (falls back to the oldest known price).
export function priceAt(p, ms) {
  if (!p) return null;
  let best = null;
  for (const [t, c] of p.bars) { if (t + 5 * 60000 <= ms) best = c; else break; }
  return best ?? p.prevClose ?? p.bars[0]?.[1] ?? null;
}

// ------------------------------------------------------------------ SEC filings
const cik10 = (c) => String(c).padStart(10, '0');

// New 8-K announcements for one company since `sinceMs`. Each: { id, ticker, time, items, item_names, form, url, index_url }
export async function recentFilings(ticker, sinceMs, ua) {
  const d = await get(`https://data.sec.gov/submissions/CIK${cik10(CIK[ticker])}.json`, { ua });
  const r = d.filings?.recent; if (!r) return [];
  const out = [];
  for (let i = 0; i < r.form.length; i++) {
    const t = Date.parse(r.acceptanceDateTime[i]);
    if (!(t >= sinceMs)) break;                          // newest first
    if (r.form[i] !== '8-K') continue;
    const items = String(r.items[i] || '').split(',').map(s => s.trim()).filter(Boolean);
    const mat = items.filter(x => MATERIAL_ITEMS[x]);
    if (!mat.length) continue;
    const acc = r.accessionNumber[i], folder = `https://www.sec.gov/Archives/edgar/data/${CIK[ticker]}/${acc.replace(/-/g, '')}`;
    out.push({ id: acc, ticker, time: t, items: mat, item_names: mat.map(x => MATERIAL_ITEMS[x]),
      url: `${folder}/${r.primaryDocument[i]}`, index_url: `${folder}/${acc}-index.htm` });
  }
  return out;
}

export function htmlToText(html) {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;|&#xa0;/gi, ' ').replace(/&amp;/g, '&').replace(/&quot;|&#8220;|&#8221;/g, '"')
    .replace(/&#8217;|&#8216;|&#39;|&apos;|&rsquo;|&lsquo;/g, "'").replace(/&#8212;|&mdash;|&#8211;|&ndash;/g, '-').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#\d+;|&[a-z]+;/gi, ' ').replace(/[ \t\r\f\v]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

// The text of the announcement: the press release exhibit (EX-99.x) if there is one, else the 8-K itself.
export async function filingText(f, ua, maxChars) {
  const idx = await get(f.index_url, { ua, as: 'text' });
  const docs = [];
  for (const row of idx.split(/<tr[^>]*>/i).slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
    const href = (row.match(/href="([^"]+\.html?)"/i) || [])[1];
    if (cells.length >= 4 && href) docs.push({ type: cells[3], href: href.replace(/^\/ix\?doc=/, '') });
  }
  const ex = docs.filter(d => /^EX-99/i.test(d.type));
  const pick = ex.length ? ex.slice(0, 2) : docs.filter(d => d.type === '8-K').slice(0, 1);
  let text = '';
  for (const d of pick) {
    const html = await get(new URL(d.href, 'https://www.sec.gov').href, { ua, as: 'text' });
    text += (text ? '\n\n' : '') + htmlToText(html);
    if (text.length >= maxChars) break;
  }
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars, exhibit: ex.length > 0 };
}

// ------------------------------------------------------------------ headlines
const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

export function parseRss(xml, source) {
  const out = [];
  for (const item of xml.split(/<item[\s>]/).slice(1)) {
    const title = decode((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    const time = Date.parse((item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '');
    const link = decode((item.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '');
    if (title && Number.isFinite(time)) out.push({ time, title, source, link });
  }
  return out;
}

export async function fetchHeadlines(ticker) {
  const feeds = [
    { source: 'Nasdaq', url: `https://www.nasdaq.com/feed/rssoutbound?symbol=${ticker}` },
    { source: 'Seeking Alpha', url: `https://seekingalpha.com/api/sa/combined/${ticker}.xml` },
  ];
  const errors = [];
  let all = [];
  await Promise.all(feeds.map(async (f) => {
    try { const items = parseRss(await get(f.url, { as: 'text', tries: 2, timeout: 10000 }), f.source); all.push(...items); }
    catch (e) { errors.push(`${f.source}: ${e.message}`); }
  }));
  const seen = new Set();
  all = all.sort((a, b) => b.time - a.time).filter(h => { const k = h.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50); if (seen.has(k)) return false; seen.add(k); return true; });
  return { headlines: all, errors };
}
