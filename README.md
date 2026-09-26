# jev-bot-clock

The Jev paper-trading bot: its cloud code and the timer that wakes it.

- `app/` is the bot and dashboard, deployed to Vercel at https://jev-paper-trader-dashboard.vercel.app (Vercel project root directory: `app`).
- `.github/workflows/wake-bot.yml` calls `/api/tick` every 15 minutes, which runs one trading round.

There are no keys or passwords here: the bot signs in to Vercel AI Gateway with the project's own short-lived Vercel token, and its data lives in private Vercel Blob storage.

- **Run a round now:** Actions → "Wake the Jev bot" → Run workflow.
- **Pause the bot:** Actions → "Wake the Jev bot" → ⋯ → Disable workflow.
- The bot ignores calls less than 10 minutes apart, so late or doubled runs are harmless.
- Paper trading only. No real money.
