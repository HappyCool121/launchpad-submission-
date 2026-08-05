import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalJson } from './canonical-json.mjs';
import { TRUSTED_RELEASE_KEYS } from './trusted-release-keys.mjs';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const REPOSITORY = 'adrouter/adrouterAgent';
const BUNDLE_IDENTIFIER = 'com.adrouter.agent';
const AUTHENTICATION = Object.freeze({
  fixture: 'tests/fixtures/platform-auth-v1.json',
  fixtureSha256: '93a8ec8d4eba38f9165179aa0cdfe3316f8134a882bd0426bd83339af55d17f8',
  acceptanceAsset: 'authentication-acceptance.json',
});

export const RELEASE_ARTIFACTS = Object.freeze({
  'darwin-universal': Object.freeze({
    platform: 'darwin',
    architectures: Object.freeze(['arm64', 'x64']),
    archiveRoot: 'AdRouter Agent.app',
    executablePath: 'Contents/MacOS/AdRouter Agent',
    legacyVerificationMode: 'macos-adhoc',
    verificationMode: 'macos-developer-id',
    signatureType: 'developer-id',
    suffix: 'darwin-universal',
  }),
  'linux-x64': Object.freeze({
    platform: 'linux',
    architectures: Object.freeze(['x64']),
    archiveRoot: 'AdRouter Agent-linux-x64',
    executablePath: 'AdRouter Agent',
    verificationMode: 'portable-checksum',
    signatureType: 'none',
    suffix: 'linux-x64',
  }),
  'win32-x64': Object.freeze({
    platform: 'win32',
    architectures: Object.freeze(['x64']),
    archiveRoot: '.',
    executablePath: 'AdRouter Agent.exe',
    legacyVerificationMode: 'portable-checksum',
    verificationMode: 'windows-authenticode',
    signatureType: 'authenticode',
    suffix: 'win32-x64',
  }),
});

const exactKeys = (value, expected, label) => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
};

const requiredString = (value, field, label = 'The release manifest') => {
  if (typeof value[field] !== 'string' || value[field].length === 0) {
    throw new Error(`${label} has an invalid ${field}.`);
  }
};

const validateIdentity = (value) => {
  for (const key of [
    'releaseVersion',
    'releaseTag',
    'repository',
    'distributionMode',
    'bundleIdentifier',
    'bundleShortVersion',
    'bundleVersion',
  ]) {
    requiredString(value, key, 'The embedded release manifest');
  }
  if (!VERSION_PATTERN.test(value.releaseVersion)) {
    throw new Error('The embedded release version is not a supported SemVer.');
  }
  if (value.releaseTag !== `v${value.releaseVersion}`) {
    throw new Error('The embedded release tag does not match the version.');
  }
  if (value.repository !== REPOSITORY) {
    throw new Error('The embedded repository is not canonical.');
  }
  if (value.bundleIdentifier !== BUNDLE_IDENTIFIER) {
    throw new Error('The embedded bundle identifier is not canonical.');
  }
  if (!/^\d+\.\d+\.\d+$/.test(value.bundleShortVersion)) {
    throw new Error('The embedded short bundle version is invalid.');
  }
  if (!/^\d+(?:\.\d+){0,2}$/.test(value.bundleVersion)) {
    throw new Error('The embedded numeric bundle version is invalid.');
  }
  if (
    value.authentication?.fixture !== AUTHENTICATION.fixture ||
    value.authentication?.fixtureSha256 !== AUTHENTICATION.fixtureSha256 ||
    value.authentication?.acceptanceAsset !== AUTHENTICATION.acceptanceAsset
  ) {
    throw new Error('The embedded platform authentication metadata is not canonical.');
  }
};

const validateArtifactBase = (artifact, expected, manifest, schema) => {
  for (const field of [
    'platform',
    'assetName',
    'assetUrl',
    'sha256',
    'archiveRoot',
    'executablePath',
    'verificationMode',
  ]) {
    requiredString(artifact, field, `Artifact ${artifact.key}`);
  }
  const expectedMode =
    schema === 3
      ? (expected.legacyVerificationMode ?? expected.verificationMode)
      : expected.verificationMode;
  if (
    artifact.platform !== expected.platform ||
    JSON.stringify(artifact.architectures) !== JSON.stringify(expected.architectures) ||
    artifact.archiveRoot !== expected.archiveRoot ||
    artifact.executablePath !== expected.executablePath ||
    artifact.verificationMode !== expectedMode
  ) {
    throw new Error(`Artifact ${artifact.key} does not match its canonical target metadata.`);
  }
  const expectedName = `AdRouter-Agent-${manifest.releaseVersion}-${expected.suffix}.zip`;
  if (artifact.assetName !== expectedName) {
    throw new Error(`Artifact ${artifact.key} has a non-canonical asset name.`);
  }
  const expectedUrl =
    `https://github.com/${manifest.repository}/releases/download/` +
    `${manifest.releaseTag}/${expectedName}`;
  if (artifact.assetUrl !== expectedUrl) {
    throw new Error(`Artifact ${artifact.key} has a non-canonical asset URL.`);
  }
  if (!SHA256_PATTERN.test(artifact.sha256)) {
    throw new Error(`Artifact ${artifact.key} checksum is not a SHA-256 digest.`);
  }
};

const freezeManifest = (value) =>
  Object.freeze({
    ...value,
    authentication: Object.freeze({ ...value.authentication }),
    health: value.health ? Object.freeze({ ...value.health }) : undefined,
    artifacts: Object.freeze(
      value.artifacts.map((artifact) =>
        Object.freeze({
          ...artifact,
          architectures: Object.freeze([...artifact.architectures]),
          signature: artifact.signature ? Object.freeze({ ...artifact.signature }) : undefined,
        })
      )
    ),
    signatures: value.signatures
      ? Object.freeze(value.signatures.map((signature) => Object.freeze({ ...signature })))
      : undefined,
  });

const validateLegacyManifest = (value) => {
  if (value.distributionMode !== 'credential-free-portable') {
    throw new Error('The embedded release distribution mode is not supported.');
  }
  validateIdentity(value);
  if (!Array.isArray(value.artifacts) || value.artifacts.length !== 3) {
    throw new Error('The embedded release manifest must contain exactly three artifacts.');
  }
  const legacyKeys = new Set(['darwin-universal', 'linux-x64', 'win32-x64']);
  const seen = new Set();
  for (const artifact of value.artifacts) {
    const expected = RELEASE_ARTIFACTS[artifact?.key];
    if (!expected || !legacyKeys.has(artifact.key) || seen.has(artifact.key)) {
      throw new Error(
        `The embedded release manifest has an invalid artifact key: ${artifact?.key}.`
      );
    }
    seen.add(artifact.key);
    validateArtifactBase(artifact, expected, value, 3);
  }
  return freezeManifest(value);
};

const decodePublicKey = (key) => {
  if (
    key?.algorithm !== 'Ed25519' ||
    key?.publicKey?.kty !== 'OKP' ||
    key.publicKey.crv !== 'Ed25519' ||
    !BASE64URL_PATTERN.test(key.publicKey.x)
  ) {
    throw new Error('A trusted release key is not a canonical Ed25519 public JWK.');
  }
  const raw = Buffer.from(key.publicKey.x, 'base64url');
  if (raw.byteLength !== 32 || createHash('sha256').update(raw).digest('hex') !== key.keyId) {
    throw new Error('A trusted release key ID does not match its public key.');
  }
  return createPublicKey({ key: key.publicKey, format: 'jwk' });
};

const verifyEnvelopeSignature = (envelope, payload, options) => {
  const keys = options.trustedKeys ?? TRUSTED_RELEASE_KEYS;
  if (!Array.isArray(keys)) throw new Error('The trusted release keyring is invalid.');
  const issuedAt = Date.parse(payload.issuedAt);
  const signatures = envelope.signatures;
  for (const signature of signatures) {
    if (
      signature?.algorithm !== 'Ed25519' ||
      !SHA256_PATTERN.test(signature.keyId) ||
      !SIGNATURE_PATTERN.test(signature.signature) ||
      Buffer.from(signature.signature, 'base64').byteLength !== 64
    ) {
      throw new Error('The release manifest has an invalid signature record.');
    }
    const trusted = keys.find(
      (key) =>
        key.keyId === signature.keyId && (key.status === 'active' || key.status === 'retired')
    );
    if (!trusted?.channels?.includes(payload.channel)) continue;
    const notBefore = Date.parse(trusted.notBefore);
    const notAfter = Date.parse(trusted.notAfter);
    if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) {
      throw new Error('A trusted release key has an invalid validity interval.');
    }
    if (issuedAt < notBefore || issuedAt > notAfter) continue;
    if (
      verify(
        null,
        Buffer.from(canonicalJson({ schema: 4, signed: payload })),
        decodePublicKey(trusted),
        Buffer.from(signature.signature, 'base64')
      )
    ) {
      return;
    }
  }
  throw new Error('The release manifest is not signed by an active trusted key.');
};

const validateSignedManifest = (envelope, options) => {
  exactKeys(envelope, ['schema', 'signed', 'signatures'], 'The schema-4 release envelope');
  const payload = envelope.signed;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('The signed release payload is not an object.');
  }
  exactKeys(
    payload,
    [
      'distributionMode',
      'channel',
      'releaseVersion',
      'releaseTag',
      'repository',
      'bundleIdentifier',
      'bundleShortVersion',
      'bundleVersion',
      'minimumAgentVersion',
      'issuedAt',
      'expiresAt',
      'authentication',
      'health',
      'artifacts',
    ],
    'The signed release payload'
  );
  if (payload.distributionMode !== 'signed-release-metadata') {
    throw new Error('The signed release distribution mode is not supported.');
  }
  validateIdentity(payload);
  if (!['beta', 'stable'].includes(payload.channel)) {
    throw new Error('The signed release channel is invalid.');
  }
  if (!VERSION_PATTERN.test(payload.minimumAgentVersion)) {
    throw new Error('The signed release minimum Agent version is invalid.');
  }
  if (!ISO_DATE_PATTERN.test(payload.issuedAt) || !ISO_DATE_PATTERN.test(payload.expiresAt)) {
    throw new Error('The signed release validity interval is invalid.');
  }
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 180 * 24 * 60 * 60 * 1000) {
    throw new Error('The signed release validity interval is unsafe.');
  }
  const now =
    options.now instanceof Date
      ? options.now.getTime()
      : new Date(options.now ?? Date.now()).getTime();
  if (
    !Number.isFinite(now) ||
    now < issuedAt - 5 * 60 * 1000 ||
    (options.enforceExpiry === true && now > expiresAt)
  ) {
    throw new Error('The signed release manifest is not currently valid.');
  }
  exactKeys(
    payload.health ?? {},
    ['deadlineSeconds', 'markerProtocol', 'rollbackRequired'],
    'The release health policy'
  );
  if (
    !Number.isSafeInteger(payload.health.deadlineSeconds) ||
    payload.health.deadlineSeconds < 30 ||
    payload.health.deadlineSeconds > 600 ||
    payload.health.markerProtocol !== 1 ||
    payload.health.rollbackRequired !== true
  ) {
    throw new Error('The signed release health policy is invalid.');
  }
  if (!Array.isArray(payload.artifacts) || payload.artifacts.length !== 3) {
    throw new Error('The signed release manifest must contain exactly three artifacts.');
  }
  const seen = new Set();
  for (const artifact of payload.artifacts) {
    const expected = RELEASE_ARTIFACTS[artifact?.key];
    if (!expected || seen.has(artifact.key)) {
      throw new Error(`The signed release manifest has an invalid artifact key: ${artifact?.key}.`);
    }
    seen.add(artifact.key);
    exactKeys(
      artifact,
      [
        'key',
        'platform',
        'architectures',
        'assetName',
        'assetUrl',
        'bytes',
        'sha256',
        'archiveRoot',
        'executablePath',
        'verificationMode',
        'signature',
      ],
      `Artifact ${artifact.key}`
    );
    validateArtifactBase(artifact, expected, payload, 4);
    if (
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      artifact.bytes > 512 * 1024 * 1024
    ) {
      throw new Error(`Artifact ${artifact.key} has an invalid byte size.`);
    }
    exactKeys(
      artifact.signature ?? {},
      ['type', 'required', 'expectedSigner'],
      `Artifact ${artifact.key} signature metadata`
    );
    if (
      artifact.signature.type !== expected.signatureType ||
      artifact.signature.required !== (expected.signatureType !== 'none') ||
      (expected.signatureType === 'none'
        ? artifact.signature.expectedSigner !== null
        : typeof artifact.signature.expectedSigner !== 'string' ||
          artifact.signature.expectedSigner.length < 2)
    ) {
      throw new Error(`Artifact ${artifact.key} has invalid signature metadata.`);
    }
  }
  if (
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length < 1 ||
    envelope.signatures.length > 3
  ) {
    throw new Error('The release manifest must contain one to three signatures.');
  }
  verifyEnvelopeSignature(envelope, payload, options);
  return freezeManifest({ schema: 4, ...payload, signatures: envelope.signatures });
};

export function artifactKey(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return 'darwin-universal';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  throw new Error(`Unsupported operating system/architecture combination: ${platform}/${arch}.`);
}

export function selectArtifact(manifest, platform = process.platform, arch = process.arch) {
  const key = artifactKey(platform, arch);
  const artifact = manifest.artifacts.find((candidate) => candidate.key === key);
  if (!artifact) throw new Error(`The release manifest does not contain ${key}.`);
  return artifact;
}

export function validateManifest(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The embedded release manifest is not an object.');
  }
  if (value.schema === 3) return validateLegacyManifest(value);
  if (value.schema === 4) return validateSignedManifest(value, options);
  throw new Error('Unsupported release manifest schema.');
}

export async function readManifest(
  url = new URL('../release-manifest.json', import.meta.url),
  options = {}
) {
  const text = await readFile(url, 'utf8');
  return validateManifest(JSON.parse(text), options);
}

export const releaseManifestSigningBytes = (signed) =>
  Buffer.from(canonicalJson({ schema: 4, signed }));

export const trustedReleaseKeyId = (publicJwk) => {
  if (
    publicJwk?.kty !== 'OKP' ||
    publicJwk?.crv !== 'Ed25519' ||
    !BASE64URL_PATTERN.test(publicJwk.x)
  ) {
    throw new Error('Release signing requires a canonical Ed25519 public JWK.');
  }
  return createHash('sha256').update(Buffer.from(publicJwk.x, 'base64url')).digest('hex');
};
