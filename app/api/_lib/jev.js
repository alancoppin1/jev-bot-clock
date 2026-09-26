// Jev via Vercel AI Gateway. Authenticates with the project's own Vercel OIDC
// token (no API key stored anywhere), or AI_GATEWAY_API_KEY if one is set.
import { getVercelOidcToken } from '@vercel/oidc';

export class JevError extends Error {}
const RETRY = new Set([408, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function gatewayToken() {
  if (process.env.AI_GATEWAY_API_KEY) return process.env.AI_GATEWAY_API_KEY;
  return getVercelOidcToken();
}

export async function askJev({ url, model, token, state, questions, retries = 5, timeoutMs = 20000 }) {
  const body = JSON.stringify({ state, model, questions });
  let lastErr = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = Date.now();
    let r;
    try {
      r = await fetch(url, {
        method: 'POST', body, signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
    } catch (e) {
      lastErr = `connection error: ${e.message}`;
      await sleep(Math.min(1000 * 2 ** attempt, 8000));
      continue;
    }
    const secs = (Date.now() - t0) / 1000;
    if (r.ok) {
      const d = await r.json();
      const usage = { ...(d.usage || {}) };
      const cost = d.provider_metadata?.gateway?.cost;
      if (cost != null) usage.cost_usd = parseFloat(cost);
      return { answers: d.answers || {}, usage, secs, attempts: attempt + 1 };
    }
    if (r.status === 401 || r.status === 403) throw new JevError(`AI Gateway refused access (HTTP ${r.status})`);
    if (r.status === 402) throw new JevError('Out of AI Gateway credit (HTTP 402)');
    let msg = '';
    try { const j = await r.json(); msg = j.message || j.error?.message || JSON.stringify(j); } catch { msg = await r.text().catch(() => ''); }
    if (!RETRY.has(r.status)) throw new JevError(`Jev returned HTTP ${r.status}: ${String(msg).slice(0, 200)}`);
    lastErr = `HTTP ${r.status}`;
    const ra = parseFloat(r.headers.get('retry-after') || '');
    await sleep(Number.isFinite(ra) ? Math.min(ra * 1000, 15000) : Math.min(1500 * 2 ** attempt, 12000) + Math.random() * 500);
  }
  throw new JevError(`Jev unavailable after ${retries + 1} attempts (${lastErr})`);
}
