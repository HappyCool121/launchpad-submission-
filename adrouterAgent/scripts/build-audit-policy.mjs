const ALLOWED_ADVISORY_URL = 'https://github.com/advisories/GHSA-mh99-v99m-4gvg';
const PRODUCTION_BRACE_PATH =
  'node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion';

function fail(message) {
  throw new Error(`Build dependency audit policy failed: ${message}`);
}

function terminalAdvisories(name, vulnerabilities, visiting = new Set()) {
  if (visiting.has(name)) fail(`cyclic vulnerability graph at ${name}`);
  const vulnerability = vulnerabilities[name];
  if (!vulnerability || !Array.isArray(vulnerability.via)) {
    fail(`missing vulnerability details for ${name}`);
  }
  const next = new Set(visiting);
  next.add(name);
  const terminals = [];
  for (const via of vulnerability.via) {
    if (typeof via === 'string') {
      terminals.push(...terminalAdvisories(via, vulnerabilities, next));
    } else if (via && typeof via === 'object') {
      terminals.push(via);
    } else {
      fail(`invalid advisory reference for ${name}`);
    }
  }
  if (terminals.length === 0) fail(`no terminal advisory for ${name}`);
  return terminals;
}

function assertDevOnly(name, vulnerability, lockPackages) {
  if (!Array.isArray(vulnerability.nodes) || vulnerability.nodes.length === 0) {
    fail(`missing affected lockfile nodes for ${name}`);
  }
  for (const node of vulnerability.nodes) {
    const locked = lockPackages[node];
    if (!locked) fail(`audit node ${node} is absent from package-lock.json`);
    if (locked.dev !== true) fail(`${node} is not exclusively a development dependency`);
  }
}

export function evaluateBuildAudit(report, lock) {
  if (report?.auditReportVersion !== 2 || !report.vulnerabilities) {
    fail('npm returned a malformed or unavailable audit report');
  }
  if (!lock?.packages) fail('package-lock.json is malformed');
  const productionBrace = lock.packages[PRODUCTION_BRACE_PATH];
  if (productionBrace?.version !== '5.0.8') {
    fail('the production Pi brace-expansion path is not patched to 5.0.8');
  }

  const checked = [];
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
    if (!['high', 'critical'].includes(vulnerability.severity)) continue;
    if (vulnerability.severity === 'critical') {
      fail(`${name} has a critical vulnerability`);
    }
    const terminals = terminalAdvisories(name, report.vulnerabilities);
    for (const advisory of terminals) {
      if (advisory.url !== ALLOWED_ADVISORY_URL || advisory.severity !== 'high') {
        fail(`${name} reaches unapproved advisory ${advisory.url ?? advisory.source ?? 'unknown'}`);
      }
    }
    assertDevOnly(name, vulnerability, lock.packages);
    checked.push(name);
  }

  return { allowedAdvisory: ALLOWED_ADVISORY_URL, checked };
}
