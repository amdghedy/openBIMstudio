import type { Request, Response, NextFunction } from 'express';

const ALLOWED_ORIGINS = new Set(
  (process.env.OBS_ALLOWED_ORIGINS ?? 'http://localhost:3000').split(','));

export function failClosed(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin ?? '';
  if (origin && !ALLOWED_ORIGINS.has(origin))
    return res.status(403).json({ error: 'origin not allowed' });

  if (typeof req.query.token === 'string')  // tokens must travel in headers only
    return res.status(401).json({ error: 'query-string tokens are not accepted' });

  const expected = 'Bearer ' + (process.env.OBS_SERVER_TOKEN ?? '');
  if ((req.headers.authorization ?? '') !== expected)
    return res.status(401).json({ error: 'missing or invalid token' });

  if (!tokenBucket(req.ip ?? 'unknown').tryTake())
    return res.status(429).json({ error: 'rate limited' });
  next();
}

// tokenBucket(ip): fixed-window counter per IP in a Map, 60 requests per minute.
// Server boot rule: if HOST is not loopback and OBS_SERVER_TOKEN is unset, exit(1).
