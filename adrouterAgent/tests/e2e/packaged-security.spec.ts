import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const executablePath = process.env.ADROUTER_E2E_APP;

test.describe('packaged Electron security', () => {
  test.skip(!executablePath, 'Set ADROUTER_E2E_APP to a packaged app executable for this check.');

  test('loads only the app protocol and does not expose raw Node APIs', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'adrouter-security-e2e-user-data-'));
    const app = await electron.launch({
      executablePath: executablePath ?? '',
      args: [`--user-data-dir=${userData}`],
    });
    try {
      const page = await app.firstWindow();
      await expect(page).toHaveURL(/^app:\/\//);
      await expect(page.getByLabel('AdRouter server URL')).toHaveValue(
        'https://api-staging.adrouter.co'
      );
      await expect(
        page.evaluate(() => typeof (window as { require?: unknown }).require)
      ).resolves.toBe('undefined');
      await expect(page.evaluate(() => typeof window.adrouter?.projects?.list)).resolves.toBe(
        'function'
      );
      await expect(
        page.evaluate(() =>
          Object.keys(window.adrouter?.configuration ?? {}).some((key) =>
            /authoriz|signRequest|proof|token|key/i.test(key)
          )
        )
      ).resolves.toBe(false);
      await expect(page.evaluate(() => window.adrouter.app.getInfo())).resolves.toMatchObject({
        name: 'AdRouter Agent',
        platform: 'darwin',
      });
      await expect(
        page.evaluate(
          async () => (await navigator.permissions.query({ name: 'geolocation' })).state
        )
      ).resolves.toBe('denied');
    } finally {
      await app.close();
      await rm(userData, { recursive: true, force: true });
    }
  });
});
