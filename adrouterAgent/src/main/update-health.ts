import { mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const argumentValue = (argv: string[], prefix: string): string | undefined => {
  const matches = argv.filter((argument) => argument.startsWith(prefix));
  if (matches.length > 1) throw new Error(`Duplicate launcher health argument ${prefix}.`);
  return matches[0]?.slice(prefix.length);
};

export const launcherSupportDirectory = (
  platform = process.platform,
  homeDirectory = homedir(),
  environment: NodeJS.ProcessEnv = process.env
): string => {
  if (platform === 'darwin') {
    return join(homeDirectory, 'Library', 'Application Support', 'adrouter-agent-launcher');
  }
  if (platform === 'linux') {
    return join(
      environment.XDG_DATA_HOME ?? join(homeDirectory, '.local', 'share'),
      'adrouter-agent-launcher'
    );
  }
  if (platform === 'win32') {
    return join(
      environment.LOCALAPPDATA ?? join(homeDirectory, 'AppData', 'Local'),
      'adrouter-agent-launcher'
    );
  }
  throw new Error(`Unsupported launcher health platform ${platform}.`);
};

export const writeLauncherHealthMarker = async (
  releaseVersion: string,
  options: {
    argv?: string[];
    platform?: NodeJS.Platform;
    homeDirectory?: string;
    environment?: NodeJS.ProcessEnv;
    now?: Date;
  } = {}
): Promise<boolean> => {
  const argv = options.argv ?? process.argv;
  const token = argumentValue(argv, '--adrouter-launcher-health-token=');
  const markerArgument = argumentValue(argv, '--adrouter-launcher-health-marker=');
  if (!token && !markerArgument) return false;
  if (!token || !markerArgument || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error('The launcher healthy-start arguments are invalid.');
  }
  const supportDirectory = launcherSupportDirectory(
    options.platform,
    options.homeDirectory,
    options.environment
  );
  const markerPath = resolve(markerArgument);
  if (markerPath !== resolve(supportDirectory, 'health-marker.json')) {
    throw new Error('The launcher healthy-start marker path is outside launcher state.');
  }
  if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(releaseVersion)) {
    throw new Error('The packaged Agent version is invalid.');
  }
  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 });
  const temporary = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({
          schema: 1,
          protocol: 1,
          releaseVersion,
          token,
          healthyAt: (options.now ?? new Date()).toISOString(),
        })}\n`,
        'utf8'
      );
    } finally {
      await handle.close();
    }
    await rename(temporary, markerPath);
    return true;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};
