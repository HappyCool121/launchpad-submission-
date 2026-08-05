// Minimal .env loader for the hackathon backend.
//
// Keep environment-file loading dependency-free. Service and demo secrets are
// deliberately isolated so the default process never reads the demo file.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(__dirname, '../..');

// Service mode is the default. The archived demo must be selected explicitly
// before process startup so it cannot accidentally inherit service secrets.
const profile = process.env.ROUTER_RUNTIME_PROFILE ?? 'service';
loadEnvFile(resolve(BACKEND_ROOT, profile === 'demo' ? '.env.local' : '.env.service.local'));

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;

  const lines = readFileSync(path, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = unquote(trimmed.slice(separator + 1).trim());
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
