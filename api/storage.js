// Serverless replacement for Claude's window.storage, backed by Redis
// (Upstash, either via a standalone account or Vercel's Storage tab).
//
// GET    /api/storage?room=X&key=Y            -> { value: string|null }
// POST   /api/storage?room=X&key=Y  {value}    -> { ok: true }
// DELETE /api/storage?room=X&key=Y             -> { ok: true }

const ALLOWED_KEYS = new Set(['league_config', 'league_draft']);
const ROOM_RE = /^[a-zA-Z0-9]{4,12}$/;
const MAX_VALUE_LENGTH = 200_000;
const TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days

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
      const value = req.body && req.body.value;
      if (typeof value !== 'string') {
        return res.status(400).json({ error: 'value must be a string' });
      }
      if (value.length > MAX_VALUE_LENGTH) {
        return res.status(413).json({ error: 'value too large' });
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
