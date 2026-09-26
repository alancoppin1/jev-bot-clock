// Serves the latest snapshot to the dashboard page.
import { readJson, StoreNotConnected } from './_store.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const snap = await readJson('snapshot.json');
    return res.status(200).json(snap || { empty: true });
  } catch (e) {
    if (e instanceof StoreNotConnected) return res.status(503).json({ error: e.message });
    console.error('data failed', e);
    return res.status(500).json({ error: 'could not load data' });
  }
}
