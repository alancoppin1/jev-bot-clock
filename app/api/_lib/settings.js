// Bot settings and trading rules (cloud copy of config.yaml + rules.yaml).
export const CONFIG = {
  markets: [
    'BTC-GBP', 'ETH-GBP', 'SOL-GBP', 'ADA-GBP', 'DOGE-GBP', 'LTC-GBP', 'LINK-GBP', 'DOT-GBP',
    'SHIB-GBP', 'UNI-GBP', 'ATOM-GBP', 'BCH-GBP', 'AAVE-GBP', 'ALGO-GBP', 'ETC-GBP', 'FIL-GBP',
    'CRV-GBP', 'XTZ-GBP', 'SNX-GBP', 'CHZ-GBP',
  ],
  starting_cash_gbp: 10000,
  check_every_minutes: 15,
  min_gap_minutes: 10,          // ignore wake-ups closer together than this
  candle_seconds: 3600,
  position_size_pct: 10,
  stop_loss_pct: 3,
  take_profit_pct: 6,
  daily_loss_limit_pct: 3,
  cooldown_minutes: 60,
  fee_pct: 0.6,                 // ASSUMPTION - set to your real broker's fee
  slippage_pct: 0.05,           // big, busy coins
  slippage_pct_other: 0.3,      // smaller coins - estimate
  major_markets: ['BTC-GBP', 'ETH-GBP'],
  jev_model: 'typesafe-ai/jev',
  jev_url: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
  market_concurrency: 2,        // Coinbase public data - kept gentle to avoid rate limits
  jev_concurrency: 1,           // one Jev question at a time - Jev throttles parallel calls
  jev_gap_ms: 250,              // short pause between Jev questions
  round_budget_seconds: 200,    // stop asking Jev after this long so a round never overruns
};

export const RULES = {
  questions: {
    trend: {
      type: 'choice',
      instructions: 'Direction of the price trend over the last 72 hours',
      criteria: {
        up: 'Price is making higher highs and higher lows and sits above its moving averages',
        sideways: 'Price is ranging without a clear direction',
        down: 'Price is making lower highs and lower lows and sits below its moving averages',
      },
    },
    momentum: {
      type: 'score',
      instructions: 'Strength of short-term price momentum over the last 6 hours',
      criteria: ['Strongly falling', 'Falling', 'Flat', 'Rising', 'Strongly rising'],
    },
    overextended: {
      type: 'noul',
      instructions: 'Price has risen sharply and looks stretched or overbought relative to its recent range',
    },
    breakdown: {
      type: 'noul',
      instructions: 'Price is breaking down below recent support levels',
    },
  },
  entry: [
    { question: 'trend', is: 'up', min_confidence: 0.7 },
    { question: 'momentum', at_least: 3, min_confidence: 0.6 },
    { question: 'overextended', below: 0.5 },
  ],
  exit: [
    { question: 'trend', is: 'down', min_confidence: 0.6 },
    { question: 'breakdown', at_least: 0.7 },
  ],
};
