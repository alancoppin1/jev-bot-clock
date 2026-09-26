// Storage for the bot's state and the dashboard snapshot.
// Uses Upstash Redis (free tier: 500K operations a month) when it's connected, and falls back
// to Vercel Blob, the original store, which on the free plan allows only ~2,000 saves a month.
// The first time Redis has no copy of something, it's read from Blob so nothing is lost.
import { get, head, put } from '@vercel/blob';

export class StoreNotConnected extends Error {}
export class VersionConflict extends Error {}

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const hasRedis = () => !!(REDIS_URL && REDIS_TOKEN);
const hasBlob = () => !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
const PREFIX = 'jev:';

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(10000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(`Redis: ${d.error || 'HTTP ' + r.status}`);
  return d.result;
}

// Writes value and bumps a version number, in one step. Mode: 'always' | 'new' (only if absent) | 'match' (only if version = ARGV[3]).
const WRITE = `
local cur = redis.call('GET', KEYS[2])
if ARGV[2] == 'new' and redis.call('EXISTS', KEYS[1]) == 1 then return 'CONFLICT' end
if ARGV[2] == 'match' and cur ~= ARGV[3] then return 'CONFLICT' end
redis.call('SET', KEYS[1], ARGV[1])
return tostring(redis.call('INCR', KEYS[2]))`;

// ---------------------------------------------------------------- blob (old store, read for migration)
async function blobRead(pathname) {
  if (!hasBlob()) return { data: null, etag: null };
  let meta, r;
  try {
    meta = await head(pathname);
    r = await get(pathname, { access: 'private', useCache: false });
  } catch (e) {
    if (e && e.name === 'BlobNotFoundError') return { data: null, etag: null };
    throw e;
  }
  if (!r || r.statusCode !== 200 || !r.stream) return { data: null, etag: null };
  return { data: JSON.parse(await new Response(r.stream).text()), etag: meta?.etag ?? null };
}

// ---------------------------------------------------------------- public API (same as before)
// Returns { data, etag } or { data: null, etag: null } when nothing is stored yet.
export async function readJsonTagged(pathname) {
  if (hasRedis()) {
    const [raw, ver] = await redis(['MGET', PREFIX + pathname, PREFIX + pathname + ':ver']);
    if (raw != null) return { data: JSON.parse(raw), etag: ver ?? '0' };
    const old = await blobRead(pathname);          // not in Redis yet: carry over from Blob
    return { data: old.data, etag: null };          // etag null => the next write must create it
  }
  if (!hasBlob()) throw new StoreNotConnected('No storage is connected to this project yet.');
  return blobRead(pathname);
}

export async function readJson(pathname) {
  return (await readJsonTagged(pathname)).data;
}

// overwrite=false: fail if it exists. ifMatch: fail unless it's still at that version.
export async function writeJson(pathname, data, { overwrite = true, ifMatch } = {}) {
  if (hasRedis()) {
    const mode = ifMatch ? 'match' : overwrite ? 'always' : 'new';
    const res = await redis(['EVAL', WRITE, '2', PREFIX + pathname, PREFIX + pathname + ':ver', JSON.stringify(data), mode, String(ifMatch || '')]);
    if (res === 'CONFLICT') throw new VersionConflict(`${pathname} was changed by another round`);
    return { etag: String(res) };
  }
  if (!hasBlob()) throw new StoreNotConnected('No storage is connected to this project yet.');
  const opts = { access: 'private', addRandomSuffix: false, allowOverwrite: overwrite, contentType: 'application/json', cacheControlMaxAge: 60 };
  if (ifMatch) opts.ifMatch = ifMatch;
  return put(pathname, JSON.stringify(data), opts);
}

export const storeName = () => (hasRedis() ? 'redis' : hasBlob() ? 'blob' : 'none');
