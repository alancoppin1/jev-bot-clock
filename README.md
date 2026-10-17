# jev-bot-clock

The Jev paper-trading bot: its cloud code and the timer that wakes it.

**Current experiment (from 17 Oct 2026): US stock news.** Jev (TypeSafe AI) reads company news for 40 large US shares and the bot paper-trades on its verdicts, side by side with a no-AI rule, random picks, buy-and-hold of the 40 and the S&P 500.

- `app/` is the bot and dashboard, deployed to Vercel at https://jev-paper-trader-dashboard.vercel.app (Vercel project root directory: `app`). Pushing to `main` deploys it.
- `/api/tick` runs one round. cron-job.org calls it every 10-15 minutes; `.github/workflows/wake-bot.yml` and a daily Vercel cron are backstops. Calls less than 7 minutes apart are ignored.
- Stock bot code: `app/api/_lib/stocks/` (settings, trading hours, data sources, engine).
- News sources: SEC EDGAR 8-K filings (results releases etc.), Nasdaq and Seeking Alpha headlines. Prices: Yahoo Finance 5-minute bars.
- News is decided 30 minutes into US trading after it was published, so the price reaction is known to every account.
- The retired crypto bot's final results: https://jev-paper-trader-dashboard.vercel.app/crypto.html (code in `app/api/_lib/*.js`, kept for the backtest in `app/api/bt.js`).

To start the stock test again from £10,000: change `session_id` in `app/api/_lib/stocks/settings.js` (the old run is archived).

There are no keys or passwords here: the bot signs in to Vercel AI Gateway with the project's own short-lived Vercel token, and its data lives in the project's Upstash Redis store.

Paper trading only. No real money.
