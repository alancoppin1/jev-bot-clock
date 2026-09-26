import { get, head, put } from '@vercel/blob';

export class StoreNotConnected extends Error {}

function checkConfigured() {
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    throw new StoreNotConnected('Blob storage is not connected to this project yet.');
  }
}

// Returns { data, etag } or { data: null, etag: null } when the blob doesn't exist.
export async function readJsonTagged(pathname) {
  checkConfigured();
  // The version tag comes from the storage API (head), in the same form put's ifMatch expects.
  // Read it BEFORE the content: if the blob changes in between, the later ifMatch write fails safely.
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

export async function readJson(pathname) {
  return (await readJsonTagged(pathname)).data;
}

// overwrite=false: fail if it exists. ifMatch: fail unless the blob is still at that version.
export async function writeJson(pathname, data, { overwrite = true, ifMatch } = {}) {
  checkConfigured();
  const opts = {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: overwrite,
    contentType: 'application/json',
    cacheControlMaxAge: 60,
  };
  if (ifMatch) opts.ifMatch = ifMatch;
  return put(pathname, JSON.stringify(data), opts);
}
