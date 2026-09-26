// Outside information for variant D: the Crypto Fear & Greed Index and recent crypto headlines,
// judged by Jev once per round (one extra Jev call), then used as a filter on A's signals.
const UA = { 'User-Agent': 'jev-paper-trader/2.0 (cloud)' };
const FEEDS = [
  { source: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { source: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
];
export const COIN_NAMES = {
  BTC: ['Bitcoin', 'BTC'], ETH: ['Ethereum', 'Ether', 'ETH'], SOL: ['Solana', 'SOL'], ADA: ['Cardano', 'ADA'],
  DOGE: ['Dogecoin', 'DOGE'], LTC: ['Litecoin', 'LTC'], LINK: ['Chainlink', 'LINK'], DOT: ['Polkadot', 'DOT'],
  SHIB: ['Shiba Inu', 'SHIB'], UNI: ['Uniswap', 'UNI'], ATOM: ['Cosmos', 'ATOM'], BCH: ['Bitcoin Cash', 'BCH'],
  AAVE: ['Aave', 'AAVE'], ALGO: ['Algorand', 'ALGO'], ETC: ['Ethereum Classic', 'ETC'], FIL: ['Filecoin', 'FIL'],
  CRV: ['Curve Finance', 'Curve DAO', 'CRV'], XTZ: ['Tezos', 'XTZ'], SNX: ['Synthetix', 'SNX'], CHZ: ['Chiliz', 'CHZ'],
};

const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

async function getText(url, fetcher) {
  const r = await fetcher(url, { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

export function parseRss(xml, source) {
  const out = [];
  for (const item of xml.split(/<item[\s>]/).slice(1)) {
    const title = decode((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    const date = Date.parse((item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '');
    if (title && Number.isFinite(date)) out.push({ time: new Date(date).toISOString().slice(0, 16) + 'Z', title, source });
  }
  return out;
}

// Returns { fng: {value, label} | null, headlines: [...], errors: [...] }
export async function fetchNews({ fetcher = fetch, now = Date.now(), hours = 12, max = 20 } = {}) {
  const errors = [];
  let fng = null;
  try {
    const d = JSON.parse(await getText('https://api.alternative.me/fng/?limit=1', fetcher));
    const x = d.data?.[0];
    if (x) fng = { value: +x.value, label: x.value_classification };
  } catch (e) { errors.push(`Fear & Greed: ${e.message}`); }
  let all = [];
  await Promise.all(FEEDS.map(async (f) => {
    try { all = all.concat(parseRss(await getText(f.url, fetcher), f.source)); }
    catch (e) { errors.push(`${f.source}: ${e.message}`); }
  }));
  const cutoff = now - hours * 3600000;
  const seen = new Set();
  const headlines = all.filter(h => Date.parse(h.time) >= cutoff && Date.parse(h.time) <= now + 600000)
    .sort((a, b) => b.time.localeCompare(a.time))
    .filter(h => { const k = h.title.toLowerCase().slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, max);
  return { fng, headlines, errors };
}

// which of our coins the headlines mention (whole-word match; "Bitcoin Cash"/"Ethereum Classic" don't count for BTC/ETH)
export function coinsMentioned(headlines, markets) {
  // tickers match exactly (case-sensitive, so "link" or "dot" as ordinary words don't count); names ignore case
  const re = (tick, n) => new RegExp(`\\b${n}\\b`, n === tick ? '' : 'i');
  const found = new Set();
  for (const h of headlines) {
    let t = ' ' + h.title + ' ';
    for (const tick of ['BCH', 'ETC']) for (const n of COIN_NAMES[tick]) if (re(tick, n).test(t)) { found.add(tick); t = t.replace(new RegExp(re(tick, n).source, 'g' + re(tick, n).flags), ' '); }
    for (const [tick, names] of Object.entries(COIN_NAMES)) {
      if (tick !== 'BCH' && tick !== 'ETC' && names.some(n => re(tick, n).test(t))) found.add(tick);
    }
  }
  return markets.map(m => m.replace('-GBP', '')).filter(t => found.has(t));
}

export function buildNewsState(news, nowIso) {
  const lines = [`Crypto market news briefing at ${nowIso.slice(0, 16).replace('T', ' ')} UTC.`];
  lines.push(news.fng ? `Crypto Fear & Greed Index (0 = extreme fear, 100 = extreme greed): ${news.fng.value} (${news.fng.label}).` : 'Crypto Fear & Greed Index: unavailable.');
  if (!news.headlines.length) lines.push('No crypto headlines in the last 12 hours.');
  else {
    lines.push(`Latest crypto headlines, newest first (last 12 hours):`);
    for (const h of news.headlines) lines.push(`- [${h.time.slice(11, 16)} UTC, ${h.source}] ${h.title}`);
  }
  return lines.join('\n');
}

export function newsQuestions(mentioned) {
  const q = {
    market_news: {
      type: 'score',
      instructions: 'Overall likely effect of this news and market mood on crypto prices over the next day',
      criteria: ['Very negative', 'Negative', 'Neutral', 'Positive', 'Very positive'],
    },
    risk_event: {
      type: 'noul',
      instructions: 'The headlines report a major negative event for the crypto market, such as an exchange hack, a large regulatory crackdown or a market-wide crash',
    },
  };
  for (const t of mentioned) {
    q[`coin_${t}`] = {
      type: 'choice',
      instructions: `Likely effect of these headlines on the price of ${COIN_NAMES[t][0]} (${t}) over the next day`,
      criteria: { negative: `News is bad for ${t}`, neutral: `No clear effect on ${t}`, positive: `News is good for ${t}` },
    };
  }
  return q;
}

// Turns Jev's news answers into D's gates. Returns null when there's no usable read (D then acts like A).
export function newsView(answers) {
  if (!answers) return null;
  const mood = answers.market_news?.score, risk = answers.risk_event?.noul ?? 0;
  const coins = {};
  for (const [k, a] of Object.entries(answers)) if (k.startsWith('coin_')) coins[k.slice(5) + '-GBP'] = { view: a.choice, conf: a.confidence };
  return { mood, risk, coins };
}
