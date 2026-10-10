// Serverless replacement for Claude's window.storage, backed by Redis
// (Upstash, either via a standalone account or Vercel's Storage tab).
//
// GET    /api/storage?room=X&key=Y                     -> { value: string|null }
// POST   /api/storage?room=X&key=Y  {value}             -> { ok: true }
// POST   /api/storage?room=X&key=Y  {value, expected}   -> compare-and-set:
//   only writes if the key's current raw value equals `expected` (a string
//   previously returned by GET, or null to mean "key must not exist yet").
//   Runs as a single atomic Redis script, so two clients racing to write
//   (e.g. two people drafting the same player at once) can't both succeed —
//   the loser gets { ok:false, conflict:true, current } with the value that
//   actually won, instead of silently clobbering it.
//   -> 200 { ok: true }  or  409 { ok:false, conflict:true, current }
// DELETE /api/storage?room=X&key=Y                     -> { ok: true }

const ALLOWED_KEYS = new Set(['league_config', 'league_draft', 'pickem']);
const ROOM_RE = /^[a-zA-Z0-9]{4,12}$/;
const MAX_VALUE_LENGTH = 200_000;
const TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days

// KEYS[1] = redis key, ARGV[1] = "1"/"0" (whether a CAS check is requested),
// ARGV[2] = expected raw value ('' means "key must not currently exist"),
// ARGV[3] = new value to store, ARGV[4] = TTL in seconds.
// Returns {1, ''} on a successful write, or {0, current-value-or-''} if the
// expected value didn't match (current-value-or-'' lets the caller pick up
// the winning write without a second round trip).
const CAS_SET_SCRIPT = `
local current = redis.call('GET', KEYS[1])
local matches = true
if ARGV[1] == '1' then
  if ARGV[2] == '' then
    matches = (current == false)
  else
    matches = (current == ARGV[2])
  end
end
if matches then
  redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
  return {1, ''}
else
  return {0, current or ''}
end
`;

async function redisCommand(command) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('Redis is not configured (missing KV_REST_API_URL/TOKEN env vars)');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data && data.error) || 'Redis request failed');
  return data.result;
}

module.exports = async function handler(req, res) {
  // Public, unauthenticated, validated-by-room-code+key-allowlist endpoint —
  // safe to open up to any origin (e.g. a GitHub Pages-hosted frontend)
  // since there are no cookies/credentials involved.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    const { room, key } = req.query;
    if (typeof room !== 'string' || !ROOM_RE.test(room)) {
      return res.status(400).json({ error: 'invalid room code' });
    }
    if (typeof key !== 'string' || !ALLOWED_KEYS.has(key)) {
      return res.status(400).json({ error: 'invalid key' });
    }
    const redisKey = `room:${room}:${key}`;

    if (req.method === 'GET') {
      const value = await redisCommand(['GET', redisKey]);
      return res.status(200).json({ value: value ?? null });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const value = body.value;
      if (typeof value !== 'string') {
        return res.status(400).json({ error: 'value must be a string' });
      }
      if (value.length > MAX_VALUE_LENGTH) {
        return res.status(413).json({ error: 'value too large' });
      }

      if (Object.prototype.hasOwnProperty.call(body, 'expected')) {
        const expected = body.expected;
        if (expected !== null && typeof expected !== 'string') {
          return res.status(400).json({ error: 'expected must be a string or null' });
        }
        const [success, current] = await redisCommand([
          'EVAL', CAS_SET_SCRIPT, '1', redisKey,
          '1', expected === null ? '' : expected, value, String(TTL_SECONDS),
        ]);
        if (Number(success) === 1) {
          return res.status(200).json({ ok: true });
        }
        return res.status(409).json({ ok: false, conflict: true, current: current || null });
      }

      await redisCommand(['SET', redisKey, value, 'EX', String(TTL_SECONDS)]);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      await redisCommand(['DEL', redisKey]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('storage api error', e);
    return res.status(500).json({ error: (e && e.message) || 'internal error' });
  }
};
