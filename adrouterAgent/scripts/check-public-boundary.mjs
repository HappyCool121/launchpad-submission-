import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);
const forbiddenNames = [
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)node_modules\//,
  /(^|\/)(?:out|dist|coverage|test-results|playwright-report)\//,
  /\.(?:db|sqlite|log)$/i,
  /(^|\/)\.DS_Store$/,
];
const absoluteMacHomePrefix = ['', 'Users', ''].join('/');
const privateKeyMarker = ['BEGIN', 'PRIVATE', 'KEY'].join(' ');
const retiredStagingCredential = ['ADROUTER', 'STAGING', 'API', 'KEY'].join('_');
const canonicalPlatformAuthFixture = 'tests/fixtures/platform-auth-v1.json';
for (const filename of tracked) {
  for (const pattern of forbiddenNames) {
    assert.ok(!pattern.test(filename), `public boundary includes forbidden file ${filename}`);
  }
  if (statSync(filename).isDirectory() || /\.(?:icns|png|jpg|zip|dmg|tgz)$/i.test(filename)) {
    continue;
  }
  const text = readFileSync(filename, 'utf8');
  assert.ok(
    !text.includes(absoluteMacHomePrefix),
    `${filename} contains an absolute developer path`
  );
  assert.ok(!text.includes(privateKeyMarker), `${filename} contains private key material`);
  assert.ok(!/npm_[A-Za-z0-9]{30,}/.test(text), `${filename} contains a possible npm token`);
  if (filename === canonicalPlatformAuthFixture) {
    assert.equal(
      createHash('sha256').update(text).digest('hex'),
      '93a8ec8d4eba38f9165179aa0cdfe3316f8134a882bd0426bd83339af55d17f8',
      'canonical platform-auth fixture bytes changed'
    );
  } else {
    assert.ok(
      !/"d"\s*:\s*"[A-Za-z0-9_-]{40,}"/.test(text),
      `${filename} contains a possible private JWK`
    );
  }
  assert.ok(
    !/adr_(?:live|test)_[A-Za-z0-9_-]{16,}/.test(text),
    `${filename} contains a possible AdRouter token`
  );
  if (!filename.includes('platform-auth') && !filename.includes('authentication-acceptance')) {
    assert.ok(
      !/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text),
      `${filename} contains JWT-shaped proof material`
    );
  }
  const assignmentPattern = new RegExp(
    `(?:DEEPSEEK_API_KEY|${retiredStagingCredential})\\s*=\\s*([^\\s"'\\x60]+)`,
    'g'
  );
  for (const match of text.matchAll(assignmentPattern)) {
    assert.match(
      match[1],
      /^(?:your_|the_|example|redacted|local|\$|<|\{)/i,
      `${filename} contains a possible live credential`
    );
  }
}

console.log(`Public boundary passed for ${tracked.length} repository files.`);
