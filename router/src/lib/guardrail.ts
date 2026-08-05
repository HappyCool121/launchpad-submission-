// Sensitive-category guardrail (pitch §3 pillar 1).
//
// Privacy-Preserving Intent Routing: queries in health, finance, legal, or
// political categories are routed WITHOUT ads — the user still gets the full
// LLM response, but no sponsor is injected and no subsidy is applied.
//
// For the hackathon this is a lightweight keyword/regex blocklist. The raw
// prompt never leaves the gateway for advertisers; only anonymized intent
// vectors are matched (see the embedding path in router.ts).
//
// M7+FIX: normalize hyphens before matching so hyphenated terms match patterns.
function normalizePrompt(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[’']/g, '').replace(/[-–—.,;:!?()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
}

const RULES: { id: string; category: string; regex: RegExp }[] = [
  { id: 'health-emergency-cardiac', category: 'health', regex: /\b(heart attack|cardiac arrest|chest pain|radiating pain)\b/ },
  { id: 'health-emergency-stroke', category: 'health', regex: /\b(stroke|arm numb|numbness|cannot breathe|trouble breathing)\b/ },
  { id: 'health-emergency-overdose', category: 'health', regex: /\b(overdose|suicid|self harm)\b/ },
  { id: 'health-general', category: 'health', regex: /\b(disease|symptom|diagnos|cancer|depress|anxiety|medication|prescription|pain|fever|blood pressure|mental health|therapy|pregnancy|abortion)\b/ },
  { id: 'finance-general', category: 'finance', regex: /\b(invest|stock|portfolio|tax|retirement|mortgage|loan|debt|bankruptc|crypto|bitcoin|securities|401k|insurance claim|banking|credit|salary|immigration|asylum)\b/ },
  { id: 'legal-general', category: 'legal', regex: /\b(lawsuit|attorney|lawyer|litigation|custody|divorce|arrest|criminal|defendant|plaintiff|statute|court order)\b/ },
  { id: 'politics-general', category: 'politics', regex: /\b(election|candidate|senator|congress|presidential|democrat|republican|partisan|vote|ballot|political|religion|faith)\b/ },
];

export interface GuardrailResult {
  sensitive: boolean;
  category?: string;
  rule_id?: string;
}

export function isSensitive(prompt: string): GuardrailResult {
  const normalized = normalizePrompt(prompt);
  for (const rule of RULES) {
    if (rule.regex.test(normalized)) {
      return { sensitive: true, category: rule.category, rule_id: rule.id };
    }
  }
  return { sensitive: false };
}
