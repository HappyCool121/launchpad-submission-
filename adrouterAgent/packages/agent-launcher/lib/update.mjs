import { validateManifest } from './manifest.mjs';

const MAX_UPDATE_MANIFEST_BYTES = 1024 * 1024;
const UPDATE_CHANNEL_URLS = Object.freeze({
  beta: 'https://raw.githubusercontent.com/adrouter/adrouterAgent/release-channels/beta/release-manifest.json',
  stable:
    'https://raw.githubusercontent.com/adrouter/adrouterAgent/release-channels/stable/release-manifest.json',
});

// This must stay false until protected signing and exact native/physical acceptance are complete.
export const UPDATE_APPLICATION_ENABLED = false;

const parseVersion = (version) => {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/);
  if (!match) throw new Error(`Unsupported Agent version ${version}.`);
  return {
    core: match.slice(1, 4).map(Number),
    beta: match[4] === undefined ? null : Number(match[4]),
  };
};

export const compareAgentVersions = (leftVersion, rightVersion) => {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (left.beta === right.beta) return 0;
  if (left.beta === null) return 1;
  if (right.beta === null) return -1;
  return left.beta - right.beta;
};

const readBoundedBody = async (response) => {
  if (!response.body) throw new Error('The update manifest response has no body.');
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_UPDATE_MANIFEST_BYTES) {
      throw new Error('The update manifest exceeds the permitted size.');
    }
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_UPDATE_MANIFEST_BYTES) {
        throw new Error('The update manifest exceeds the permitted size.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (received < 1 || (declared !== null && received !== Number(declared))) {
    throw new Error('The update manifest response is incomplete.');
  }
  return Buffer.concat(chunks).toString('utf8');
};

export async function checkForUpdate(currentVersion, channel, options = {}) {
  const url = UPDATE_CHANNEL_URLS[channel];
  if (!url) throw new Error('Update channel must be beta or stable.');
  const response = await (options.fetchImpl ?? fetch)(url, {
    redirect: 'manual',
    headers: { 'user-agent': `@adrouter/agent/${currentVersion}` },
    signal: AbortSignal.timeout(15_000),
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    throw new Error('The fixed-origin update endpoint must not redirect.');
  }
  if (!response.ok) throw new Error(`Update check failed with HTTP ${response.status}.`);
  let parsed;
  try {
    parsed = JSON.parse(await readBoundedBody(response));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('The update manifest is not valid JSON.');
    throw error;
  }
  const manifest = validateManifest(parsed, {
    trustedKeys: options.trustedKeys,
    now: options.now,
    enforceExpiry: true,
  });
  if (manifest.schema !== 4 || manifest.channel !== channel) {
    throw new Error('The signed update manifest does not match the requested channel.');
  }
  if (compareAgentVersions(currentVersion, manifest.minimumAgentVersion) < 0) {
    throw new Error(
      `This update requires Agent ${manifest.minimumAgentVersion} or newer for safe activation.`
    );
  }
  const versionComparison = compareAgentVersions(manifest.releaseVersion, currentVersion);
  if (versionComparison < 0) {
    throw new Error('The signed update endpoint attempted a version downgrade.');
  }
  return {
    channel,
    currentVersion,
    latestVersion: manifest.releaseVersion,
    available: versionComparison > 0,
    manifest,
  };
}

export async function applySignedUpdate(currentVersion, channel, options = {}) {
  if (options.userConfirmed !== true) {
    throw new Error('Applying an update requires explicit user confirmation.');
  }
  if ((options.applicationEnabled ?? UPDATE_APPLICATION_ENABLED) !== true) {
    throw new Error(
      'Signed update application is disabled until exact platform-signing and physical acceptance complete.'
    );
  }
  const result = await checkForUpdate(currentVersion, channel, options);
  if (!result.available) return { ...result, applied: false };
  let pendingActivation;
  const appPath = await options.installImpl(result.manifest, {
    requireHealthyStart: true,
    onPendingActivation: (pending) => {
      pendingActivation = pending;
    },
  });
  if (!pendingActivation) {
    throw new Error('The update installer did not create a healthy-start rollback record.');
  }
  await options.launchImpl(appPath, {
    artifact: options.selectArtifactImpl(result.manifest),
    args: [
      `--adrouter-launcher-health-token=${pendingActivation.token}`,
      `--adrouter-launcher-health-marker=${pendingActivation.markerPath}`,
    ],
  });
  return { ...result, applied: true, applicationPath: appPath };
}

export const updateManifestUrl = (channel) => UPDATE_CHANNEL_URLS[channel] ?? null;
