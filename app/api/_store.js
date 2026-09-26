import { get, put } from '@vercel/blob';

export class StoreNotConnected extends Error {}

function checkConfigured() {
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    throw new StoreNotConnected('Blob storage is not connected to this project yet.');
  }
}

// Returns { data, etag } or { data: null, etag: null } when the blob doesn't exist.
export async function readJsonTagged(pathname) {
  checkConfigured();
  let r;
  try {
    r = await get(pathname, { access: 'private', useCache: false });
  } catch (e) {
    if (e && e.name === 'BlobNotFoundError') return { data: null, etag: null };
    throw e;
  }
  if (!r || r.statusCode !== 200 || !r.stream) return { data: null, etag: null };
  return { data: JSON.parse(await new Response(r.stream).text()), etag: r.blob?.etag ?? null };
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
