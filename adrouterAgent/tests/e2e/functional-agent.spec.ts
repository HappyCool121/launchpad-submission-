import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const executablePath = process.env.ADROUTER_E2E_APP;

test.describe('packaged functional agent', () => {
  test.skip(!executablePath, 'Set ADROUTER_E2E_APP to a packaged app executable for this check.');

  test('onboards, opens a non-Git folder, approves tools, and reviews the result', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'adrouter-e2e-workspace-'));
    const userData = await mkdtemp(join(tmpdir(), 'adrouter-e2e-user-data-'));
    const original = 'status=old\n';
    await writeFile(join(workspace, 'status.txt'), original);
    const expectedBeforeHash = createHash('sha256').update(original).digest('hex');
    let agentTurns = 0;

    const server = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      if (request.url === '/v1/profile') {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            models: [
              {
                id: 'fixture-model',
                provider: 'fixture',
                model_class: 'pro',
                display_name: 'Fixture Model',
                provider_label: 'Packaged E2E',
                description: 'Deterministic local model used only by packaged acceptance.',
                thinking_levels: ['none', 'medium', 'high'],
                default_thinking_level: 'medium',
                context_window: 131_072,
                max_input_tokens: 126_976,
                max_output_tokens: 4_096,
                configured: true,
              },
            ],
          })
        );
        return;
      }
      if (request.url !== '/v1/agent/turn' || request.method !== 'POST') {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        if (!body.context || body.messages || body.tools) {
          response
            .writeHead(400, { 'content-type': 'application/json' })
            .end('{"error":"invalid context"}');
          return;
        }
        agentTurns += 1;
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const send = (event: unknown): void => {
          response.write(`${JSON.stringify(event)}\n`);
        };
        if (JSON.stringify(body).includes('stop this run')) {
          send({ type: 'thinking', content: 'Waiting for cancellation.' });
          return;
        }
        if (agentTurns === 1) {
          send({
            type: 'ad',
            ad: {
              turn_id: 'fixture-turn',
              tier: 'C',
              sponsor: {
                brand_name: 'Fixture Cloud',
                ad_copy: 'Deterministic sponsored compute.',
                click_url: 'https://example.com/fixture',
              },
              provisional_savings: 0.05,
            },
          });
          send({ type: 'thinking', content: 'Checking the requested file.' });
          send({
            type: 'tool_call',
            tool_call: {
              id: 'patch-1',
              name: 'apply_patch',
              arguments: {
                path: 'status.txt',
                expectedBeforeHash,
                replacements: [{ original: 'status=old', replacement: 'status=new' }],
              },
            },
          });
        } else if (agentTurns === 2) {
          send({
            type: 'tool_call',
            tool_call: {
              id: 'patch-2',
              name: 'apply_patch',
              arguments: {
                path: 'status.txt',
                expectedBeforeHash,
                replacements: [{ original: 'status=old', replacement: 'status=new' }],
              },
            },
          });
        } else if (agentTurns === 3) {
          send({
            type: 'tool_call',
            tool_call: { id: 'command-1', name: 'run_command', arguments: { argv: ['pwd'] } },
          });
        } else {
          send({ type: 'text', content: 'The approved edit and verification command completed.' });
          send({
            type: 'settlement',
            turn_id: 'fixture-turn-final',
            settlement: {
              prompt_cost: 0.02,
              ad_subsidy: 0.01,
              paid: 0.01,
              input_tokens: 10,
              output_tokens: 5,
              usage: { total_tokens: 15 },
            },
          });
        }
        send({ type: 'done' });
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture router did not bind.');

    const app = await electron.launch({
      executablePath: executablePath ?? '',
      args: [`--user-data-dir=${userData}`],
      env: {
        ...process.env,
        ADROUTER_E2E_BUILD: '1',
        ADROUTER_E2E_WORKSPACE: workspace,
        ADROUTER_E2E_TOKEN: 'fixture-token',
      },
    });
    try {
      const page = await app.firstWindow();
      await page.getByLabel('AdRouter server URL').fill(`http://127.0.0.1:${address.port}`);
      await page.getByText('Advanced: connect a custom or local router').click();
      await page.getByLabel('Custom router access token').fill('fixture-token');
      await page.getByRole('button', { name: 'Save custom router' }).click();
      await expect(page.getByRole('button', { name: 'Choose folder' })).toBeVisible();
      await page.getByRole('button', { name: 'Choose folder' }).click();
      await expect(page.getByLabel('Current project')).toHaveValue(/.+/);
      await page
        .getByLabel('Task message')
        .fill('Update the fixture status and verify the workspace.');
      await page.getByLabel('Thinking level').selectOption('high');
      await page.getByLabel('Task message').press('Enter');

      await expect(page.getByLabel('Sponsored compute tier C')).toHaveCount(2);
      await page.getByText('Thinking', { exact: true }).click();
      await expect(page.getByText('Checking the requested file.')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Edit file' })).toBeVisible();
      await page.getByRole('switch', { name: 'Switch to dark theme' }).click();
      const approvalCard = page.locator('.approval-card');
      await expect(approvalCard).toHaveCSS('background-color', 'rgb(37, 41, 48)');
      await expect(approvalCard).toHaveCSS('color', 'rgb(255, 255, 255)');
      await expect(approvalCard.locator('code')).toHaveCSS('color', 'rgb(255, 255, 255)');
      await expect(approvalCard.locator('small')).toHaveCSS('color', 'rgb(255, 255, 255)');
      await page.getByRole('button', { name: 'Deny' }).click();
      await expect.poll(() => readFile(join(workspace, 'status.txt'), 'utf8')).toBe('status=old\n');
      await expect(page.getByRole('heading', { name: 'Edit file' })).toBeVisible();
      await page.getByRole('button', { name: 'Allow once' }).click();
      await expect.poll(() => readFile(join(workspace, 'status.txt'), 'utf8')).toBe('status=new\n');
      await page.getByRole('button', { name: 'Allow once' }).click();
      await expect(
        page.getByText('The approved edit and verification command completed.')
      ).toBeVisible();
      await expect(page.getByLabel('Sponsored compute tier C')).toHaveCount(1);
      await page.getByText('Run command').click();
      await expect(
        page.locator('pre').filter({ hasText: 'adrouter-e2e-workspace' }).first()
      ).toBeVisible();
      await page.getByRole('button', { name: /Changes/ }).click();
      await expect(page.getByRole('button', { name: 'status.txt modified' })).toBeVisible();
      await expect(page.getByLabel('Unified changes for status.txt')).toBeVisible();
      await expect(page.getByRole('table', { name: 'Changed lines' })).toContainText('status=old');
      await expect(page.getByRole('table', { name: 'Changed lines' })).toContainText('status=new');
      expect(agentTurns).toBe(4);
      await page.getByRole('button', { name: 'Close' }).click();
      await page.getByRole('button', { name: 'New Chat' }).click();
      await expect(
        page.getByRole('heading', { level: 1, name: 'What should we build?' })
      ).toBeVisible();
      await expect(
        page.getByText('The approved edit and verification command completed.')
      ).toHaveCount(0);
      await page.getByLabel('Task message').fill('stop this run');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
      await expect(page.evaluate(() => window.adrouter.configuration.signOut())).rejects.toThrow(
        'Stop all active or queued agent tasks before signing out.'
      );
      await page.getByRole('button', { name: 'Settings' }).click();
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeDisabled();
      await page.getByRole('button', { name: 'Close' }).click();
      await page.getByRole('button', { name: 'Stop' }).click();
      await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 15_000 });
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page.getByRole('dialog')).toContainText('try to revoke this installation');
      await page.getByRole('button', { name: 'Sign out and remove' }).click();
      await expect(page.getByRole('heading', { name: 'Connect AdRouter' })).toBeVisible();
      await expect(page.getByLabel('AdRouter server URL')).toHaveValue(
        `http://127.0.0.1:${address.port}`
      );
      await expect(page.getByLabel('Custom router access token')).toHaveValue('');
    } finally {
      await app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await Promise.all([
        rm(workspace, { recursive: true, force: true }),
        rm(userData, { recursive: true, force: true }),
      ]);
    }
  });
});
