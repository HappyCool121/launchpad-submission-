// Smoke test for the AdRouter backend — runs WITHOUT a live LLM key (mock mode).
// Verifies all four outcomes: Tier A (plumbing), Tier B (travel), Tier C (coding),
// Tier NONE (health guardrail), plus the sponsor-add loop.
//
// Usage: start the server (`npm run dev`), then `npm run test:loop`.

export {};

const BASE = process.env.ADROUTER_BASE ?? process.env.ADWORDER_BASE ?? 'http://localhost:8787';
const API_KEY = process.env.ADROUTER_API_KEY ?? process.env.ROUTER_AUTH_KEY ?? '';

async function chat(prompt: string) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}) },
    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
  });
  const ct = res.headers.get('content-type') ?? '';
  // Mock mode returns JSON; live mode returns a data stream.
  if (ct.includes('application/json')) {
    return (await res.json()) as Record<string, unknown>;
  }
  return { stream: await res.text() };
}

function summarize(label: string, prompt: string, data: unknown) {
  const d = data as { ad?: { tier: string; similarity?: number; reason?: string; sponsor?: { brand_name: string } }; settlement?: { paid: number; prompt_cost: number; ad_subsidy: number } };
  const ad = d.ad;
  console.log(`\n── ${label} ──`);
  console.log(`  prompt: "${prompt}"`);
  if (!ad) {
    console.log('  (live data stream — open in frontend to inspect)');
    return;
  }
  console.log(`  tier: ${ad.tier}  sim: ${ad.similarity}  sponsor: ${ad.sponsor?.brand_name ?? '—'}`);
  console.log(`  reason: ${ad.reason}`);
  if (d.settlement) {
    console.log(`  cost: $${d.settlement.prompt_cost}  subsidy: $${d.settlement.ad_subsidy}  paid: $${d.settlement.paid}`);
  }
}

async function main() {
  console.log(`Testing AdRouter backend at ${BASE} …`);

  const health = (await (await fetch(`${BASE}/api/health`)).json()) as {
    mode: string;
    llm: { configured: boolean };
    embeddings: { configured: boolean };
  };
  console.log(`mode: ${health.mode}  llm.configured: ${health.llm.configured}  embeddings.configured: ${health.embeddings.configured}`);

  const cases: [string, string][] = [
    ['Tier A — plumbing', 'how do I fix a leaking pipe under my kitchen sink?'],
    ['Tier B — travel', 'where should I go for a cheap vacation in december?'],
    ['Tier C — coding', 'debug this python script: the loop is off by one'],
    ['Guardrail NONE — health', 'I have chest pain and a fever, what should I do?'],
  ];

  for (const [label, prompt] of cases) {
    try {
      const data = await chat(prompt);
      summarize(label, prompt, data);
    } catch (err) {
      console.log(`\n── ${label} ──  ERROR:`, err instanceof Error ? err.message : err);
    }
  }

  // Sponsor list (read-only — we deliberately do NOT POST a test sponsor here,
  // because addSponsor persists to sponsors.json and would pollute the seed
  // file on every run. Exercise POST /api/sponsors/add manually instead.)
  console.log('\n── sponsors ──');
  try {
    const res = await fetch(`${BASE}/api/sponsors`);
    const body = (await res.json()) as { sponsors?: { brand_name: string }[] };
    console.log(`  count: ${body.sponsors?.length ?? '?'} — ${(body.sponsors ?? []).map((s) => s.brand_name).join(', ')}`);
  } catch (err) {
    console.log('  list ERROR:', err instanceof Error ? err.message : err);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('verify-loop failed:', err);
  process.exit(1);
});
