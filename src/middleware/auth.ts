import { Request, Response, NextFunction } from 'express';
import { verifyToken, getTokenFromRequest } from '../secret';

// Общий JWT-guard. Раньше жил локально в routes/api.ts; вынесен сюда, чтобы его
// мог переиспользовать и agent-роутер (routes/agent.ts).
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = getTokenFromRequest(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const payload = verifyToken(token);
  if (!payload || typeof payload !== 'object' || !('username' in payload)) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  (req as any).user = { username: (payload as any).username };
  next();
}
