// Serves the latest snapshot to the dashboard page.
import { readJson, StoreNotConnected } from './_store.js';

export default async function handler(req, res) {
  // The bot updates every 10 minutes, so let Vercel's cache answer repeat visits (keeps storage reads low).
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=240, stale-while-revalidate=120');
  try {
    const snap = await readJson('snapshot.json');
    return res.status(200).json(snap || { empty: true });
  } catch (e) {
    if (e instanceof StoreNotConnected) return res.status(503).json({ error: e.message });
    console.error('data failed', e);
    return res.status(500).json({ error: 'could not load data' });
  }
}
