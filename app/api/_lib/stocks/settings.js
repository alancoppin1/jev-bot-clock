// Settings for the US stock news experiment.
// Jev reads company news (SEC filings such as results releases, plus headlines) and the bot
// paper-trades on its verdicts. Three paper accounts run side by side on the same news:
//   A - Jev decides from the news
//   B - no AI: a simple rule (buy shares that jump after their results)
//   C - random: every time A buys, C buys a randomly chosen share instead
// plus two benchmarks: H (buy and hold all 40 shares) and S (S&P 500 index fund, SPY).

// [ticker, SEC company number (CIK), name]
export const UNIVERSE = [
  ['AAPL', 320193, 'Apple'], ['MSFT', 789019, 'Microsoft'], ['NVDA', 1045810, 'NVIDIA'], ['AMZN', 1018724, 'Amazon'],
  ['GOOGL', 1652044, 'Alphabet (Google)'], ['META', 1326801, 'Meta Platforms'], ['TSLA', 1318605, 'Tesla'], ['AVGO', 1730168, 'Broadcom'],
  ['JPM', 19617, 'JPMorgan Chase'], ['V', 1403161, 'Visa'], ['MA', 1141391, 'Mastercard'], ['BAC', 70858, 'Bank of America'],
  ['GS', 886982, 'Goldman Sachs'], ['UNH', 731766, 'UnitedHealth'], ['LLY', 59478, 'Eli Lilly'], ['JNJ', 200406, 'Johnson & Johnson'],
  ['MRK', 310158, 'Merck'], ['ABBV', 1551152, 'AbbVie'], ['XOM', 2115436, 'ExxonMobil'], ['CVX', 93410, 'Chevron'],
  ['WMT', 104169, 'Walmart'], ['COST', 909832, 'Costco'], ['PG', 80424, 'Procter & Gamble'], ['KO', 21344, 'Coca-Cola'],
  ['PEP', 77476, 'PepsiCo'], ['HD', 354950, 'Home Depot'], ['MCD', 63908, "McDonald's"], ['NKE', 320187, 'Nike'],
  ['DIS', 1744489, 'Disney'], ['NFLX', 1065280, 'Netflix'], ['CRM', 1108524, 'Salesforce'], ['ORCL', 1341439, 'Oracle'],
  ['ADBE', 796343, 'Adobe'], ['AMD', 2488, 'AMD'], ['QCOM', 804328, 'Qualcomm'], ['INTC', 50863, 'Intel'],
  ['CSCO', 858877, 'Cisco'], ['IBM', 51143, 'IBM'], ['BA', 12927, 'Boeing'], ['CAT', 18230, 'Caterpillar'],
];
// Words that show a headline is actually about the company (case-insensitive)
export const ALIASES = {
  AAPL: ['Apple', 'iPhone'], MSFT: ['Microsoft'], NVDA: ['Nvidia'], AMZN: ['Amazon', 'AWS'], GOOGL: ['Alphabet', 'Google', 'YouTube', 'Waymo'],
  META: ['Meta', 'Facebook', 'Instagram', 'WhatsApp'], TSLA: ['Tesla', 'Musk'], AVGO: ['Broadcom'], JPM: ['JPMorgan', 'JP Morgan', 'Dimon'],
  V: ['Visa'], MA: ['Mastercard'], BAC: ['Bank of America', 'BofA'], GS: ['Goldman'], UNH: ['UnitedHealth', 'Optum'],
  LLY: ['Lilly'], JNJ: ['Johnson & Johnson', 'J&J'], MRK: ['Merck', 'Keytruda'], ABBV: ['AbbVie', 'Skyrizi', 'Rinvoq'],
  XOM: ['Exxon'], CVX: ['Chevron'], WMT: ['Walmart'], COST: ['Costco'], PG: ['Procter', 'P&G'], KO: ['Coca-Cola', 'Coke'],
  PEP: ['PepsiCo', 'Pepsi'], HD: ['Home Depot'], MCD: ["McDonald"], NKE: ['Nike'], DIS: ['Disney', 'ESPN'], NFLX: ['Netflix'],
  CRM: ['Salesforce'], ORCL: ['Oracle'], ADBE: ['Adobe'], AMD: ['AMD', 'Advanced Micro'], QCOM: ['Qualcomm'], INTC: ['Intel'],
  CSCO: ['Cisco'], IBM: ['IBM'], BA: ['Boeing'], CAT: ['Caterpillar'],
};
// Opinion and stock-tip articles: dropped before Jev sees them (they are not news)
export const OPINION = /\b(should you|stocks? to buy|to buy (now|today|right now)|buy now|buy and hold|prediction|billionaire|millionaire|forever|retire|passive income|top \d+|\d+ (reasons|stocks)|best .*stocks?|dividend stocks?|growth stocks?|is it time to|could make you|smartest|magnificent seven stock|no-brainer|bull vs\.? bear|zacks rank|analyst reports for|key takeaways)\b/i;

export const TICKERS = UNIVERSE.map(u => u[0]);
export const NAME = Object.fromEntries(UNIVERSE.map(u => [u[0], u[2]]));
export const CIK = Object.fromEntries(UNIVERSE.map(u => [u[0], u[1]]));

// 8-K items worth reading. Routine ones (shareholder vote results 5.07, bylaw changes 5.03,
// share issuance 3.02, exhibits only 9.01) are ignored.
export const MATERIAL_ITEMS = {
  '1.01': 'major agreement signed', '1.02': 'major agreement ended', '1.03': 'bankruptcy',
  '2.01': 'acquisition or sale completed', '2.02': 'financial results', '2.05': 'restructuring / job cuts',
  '2.06': 'asset write-down', '3.01': 'delisting notice', '4.02': 'past accounts can no longer be relied on',
  '5.02': 'senior executive or director change', '7.01': 'announcement to investors', '8.01': 'other company announcement',
};

export const STOCK_CONFIG = {
  session_id: 'stocks-2026-10-17',  // change to wipe the paper accounts and start again (old data is archived)
  starting_cash_gbp: 10000,
  min_gap_minutes: 7,               // ignore wake-ups closer together than this
  position_size_pct: 20,            // of account value per share bought, so at most 5 holdings
  max_positions: 5,
  max_buys_per_day: 3,
  stop_loss_pct: 8,                 // sell if a holding falls 8% below the buying price
  trail_after_gain_pct: 8,          // once 8% up, the stop follows 8% below the highest price since buying
  max_hold_days: 28,                // calendar days (about 20 trading days), then sell
  react_minutes: 30,                // wait this long into trading after the news before deciding, so the price reaction is known
  fx_fee_pct: 0.15,                 // ASSUMPTION: currency conversion fee each way (Trading 212 charges 0.15%)
  slippage_pct: 0.05,               // ASSUMPTION: large US shares, small orders
  headline_hours: 8,                // only headlines published in the last 8 hours count as new
  headline_groups: 4,               // headlines are checked for a quarter of the shares each round, taking turns
  filing_text_chars: 14000,         // how much of a results release Jev reads
  jev_model: 'typesafe-ai/jev',
  jev_url: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
  jev_gap_ms: 250,
  round_budget_seconds: 220,
  equity_every_minutes: 60,
  // B (no AI): buy after results only if the shares rose this much since the release, and beat the S&P 500 by this much
  b_min_reaction_pct: 2,
  b_min_vs_market_pct: 1.5,
  // SEC asks automated tools to say who they are (fair-access policy)
  sec_user_agent: process.env.SEC_USER_AGENT || 'JevPaperTrader alancoppin4@gmail.com',
};

export const NEWS_QUESTIONS = {
  material: {
    type: 'noul',
    instructions: "This is genuinely new, company-specific information that would be likely to move the company's share price by more than an ordinary day's movement. Routine filings, opinion pieces, stock-tip articles, recycled news and general market commentary are not material.",
  },
  impact: {
    type: 'choice',
    instructions: 'Effect of this news on the value of the company',
    criteria: {
      positive: 'Good news for the company: results, outlook or developments better than a typical investor would have expected',
      neutral: 'No clear effect, mixed, or in line with what investors already expected',
      negative: 'Bad news for the company: results, outlook or developments worse than a typical investor would have expected',
    },
  },
  priced_in: {
    type: 'noul',
    instructions: 'The share price move since the news was published, given in the state, already fully reflects this news, so little further move in the same direction should be expected',
  },
};

// A's rules, applied to Jev's answers
export const A_RULES = {
  buy: { material_at_least: 0.6, impact: 'positive', impact_confidence: 0.6, priced_in_below: 0.5 },
  sell: { material_at_least: 0.6, impact: 'negative', impact_confidence: 0.6 },
};
