import { createHash } from 'node:crypto';
import express, { type Request, type RequestHandler } from 'express';
import { getRuntimeConfig } from './config.js';

const digests = new WeakMap<Request, Buffer>();

const parser = express.json({
  limit: getRuntimeConfig().maxBodyBytes,
  strict: true,
  verify(request, _response, body) {
    digests.set(request as Request, createHash('sha256').update(body).digest());
  },
});

export const platformJsonBody: RequestHandler = (req, res, next) => {
  parser(req, res, (error) => {
    if (error) {
      res.setHeader('Cache-Control', 'no-store');
      const oversized = error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large';
      res.status(oversized ? 413 : 400).json(oversized
        ? { error: 'The JSON request body exceeds the configured transport bound.', code: 'request_body_too_large' }
        : { error: 'The JSON request body is invalid.', code: 'invalid_request' });
      return;
    }
    next();
  });
};

export function rawBodyDigest(req: Request): Buffer | undefined { return digests.get(req); }
