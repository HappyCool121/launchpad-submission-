import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateBuildAudit } from './build-audit-policy.mjs';

const advisory = {
  source: 1101969,
  name: 'brace-expansion',
  dependency: 'brace-expansion',
  title: 'Regular Expression Denial of Service in brace-expansion',
  url: 'https://github.com/advisories/GHSA-mh99-v99m-4gvg',
  severity: 'high',
};

function fixture() {
  return {
    report: {
      auditReportVersion: 2,
      vulnerabilities: {
        'brace-expansion': {
          name: 'brace-expansion',
          severity: 'high',
          via: [advisory],
          nodes: ['node_modules/dev-tool/node_modules/brace-expansion'],
        },
        minimatch: {
          name: 'minimatch',
          severity: 'high',
          via: ['brace-expansion'],
          nodes: ['node_modules/dev-tool/node_modules/minimatch'],
        },
      },
    },
    lock: {
      packages: {
        'node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion': {
          version: '5.0.8',
        },
        'node_modules/dev-tool/node_modules/brace-expansion': { version: '1.1.12', dev: true },
        'node_modules/dev-tool/node_modules/minimatch': { version: '3.1.2', dev: true },
      },
    },
  };
}

test('allows only the reviewed dev-only Forge advisory chain', () => {
  const { report, lock } = fixture();
  assert.deepEqual(evaluateBuildAudit(report, lock).checked.sort(), [
    'brace-expansion',
    'minimatch',
  ]);
});

test('rejects an unapproved high advisory', () => {
  const { report, lock } = fixture();
  report.vulnerabilities['brace-expansion'].via[0] = {
    ...advisory,
    url: 'https://github.com/advisories/GHSA-unknown',
  };
  assert.throws(() => evaluateBuildAudit(report, lock), /unapproved advisory/);
});

test('rejects a critical advisory even if its URL is allowlisted', () => {
  const { report, lock } = fixture();
  report.vulnerabilities['brace-expansion'].severity = 'critical';
  assert.throws(() => evaluateBuildAudit(report, lock), /critical vulnerability/);
});

test('rejects an affected production node', () => {
  const { report, lock } = fixture();
  lock.packages['node_modules/dev-tool/node_modules/brace-expansion'].dev = false;
  assert.throws(() => evaluateBuildAudit(report, lock), /not exclusively a development dependency/);
});

test('rejects a missing production Pi patch', () => {
  const { report, lock } = fixture();
  lock.packages[
    'node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion'
  ].version = '2.0.1';
  assert.throws(() => evaluateBuildAudit(report, lock), /not patched to 5.0.8/);
});
