import { Router } from 'express';

export const turnRouter = Router();

turnRouter.all('/turn', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(404).json({ error: 'Not found.', code: 'route_not_available' });
});
