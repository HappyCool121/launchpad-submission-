import { execFileSync } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeConfig } from '@electron-forge/shared-types';

const enableInspectorForE2E = process.env.ADROUTER_E2E_BUILD === '1';

const requireCompleteEnvironment = (name: string, fields: string[]): boolean => {
  const present = fields.filter((field) => Boolean(process.env[field]));
  if (present.length > 0 && present.length !== fields.length) {
    throw new Error(`${name} requires all of: ${fields.join(', ')}.`);
  }
  return present.length === fields.length;
};

const protectedMacSigning = requireCompleteEnvironment('Protected macOS signing', [
  'ADROUTER_APPLE_SIGNING_IDENTITY',
  'ADROUTER_APPLE_TEAM_IDENTIFIER',
  'ADROUTER_APPLE_API_KEY_PATH',
  'ADROUTER_APPLE_API_KEY_ID',
  'ADROUTER_APPLE_API_ISSUER',
]);
const protectedWindowsSigning = requireCompleteEnvironment('Protected Windows signing', [
  'ADROUTER_WINDOWS_SIGN_TOOL',
  'ADROUTER_WINDOWS_SIGN_ARGUMENTS_FILE',
  'ADROUTER_WINDOWS_SIGNER_SUBJECT',
]);

async function removeEmbeddedCodeSignatures(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const child = join(directory, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return;
      if (entry.name === '_CodeSignature') {
        await rm(child, { recursive: true, force: true });
        return;
      }
      await removeEmbeddedCodeSignatures(child);
    })
  );
}

async function finalizeMacSignatures(
  buildPath: string,
  platform: string,
  arch: string
): Promise<void> {
  if (platform !== 'darwin') return;

  // The prebuilt Electron archives carry architecture-specific ad-hoc resource
  // signatures. They must be removed before @electron/universal joins the two
  // slices; the final universal app is then ad-hoc signed without Apple
  // credentials.
  const isUniversalSlice = buildPath.includes('electron-packager-universal-');
  if ((arch === 'x64' || arch === 'arm64') && isUniversalSlice) {
    await removeEmbeddedCodeSignatures(buildPath);
    return;
  }

  const entries = await readdir(buildPath, { withFileTypes: true });
  if (protectedMacSigning) {
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
      const appPath = join(buildPath, entry.name);
      execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
      execFileSync('xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' });
    }
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', join(buildPath, entry.name)], {
      stdio: 'inherit',
    });
  }
}

function finalizeMacSignaturesHook(
  buildPath: string,
  _electronVersion: string,
  platform: string,
  arch: string,
  done: (error?: Error | null) => void
): void {
  finalizeMacSignatures(buildPath, platform, arch).then(
    () => done(),
    (error: unknown) => done(error instanceof Error ? error : new Error(String(error)))
  );
}

function hardenMacInfoPlistHook(
  buildPath: string,
  _electronVersion: string,
  platform: string,
  _arch: string,
  done: (error?: Error | null) => void
): void {
  if (platform !== 'darwin') {
    done();
    return;
  }

  try {
    const infoPlist = join(buildPath, 'AdRouter Agent.app', 'Contents', 'Info.plist');
    for (const key of [
      'NSAudioCaptureUsageDescription',
      'NSBluetoothAlwaysUsageDescription',
      'NSBluetoothPeripheralUsageDescription',
      'NSCameraUsageDescription',
      'NSMicrophoneUsageDescription',
    ]) {
      execFileSync('plutil', ['-remove', key, infoPlist]);
    }
    done();
  } catch (error: unknown) {
    done(error instanceof Error ? error : new Error(String(error)));
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    afterComplete: [finalizeMacSignaturesHook],
    beforeCopyExtraResources: [hardenMacInfoPlistHook],
    appBundleId: 'com.adrouter.agent',
    appVersion: '0.1.0',
    buildVersion: '10012',
    appCategoryType: 'public.app-category.developer-tools',
    appCopyright: 'Copyright 2026 AdRouter Agent contributors',
    extraResource: ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'PRIVACY.md'],
    icon: 'assets/icon',
    extendInfo: {
      LSMinimumSystemVersion: '12.0.0',
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: false,
        NSAllowsLocalNetworking: true,
      },
      NSHighResolutionCapable: true,
    },
    osxSign: protectedMacSigning
      ? {
          identity: process.env.ADROUTER_APPLE_SIGNING_IDENTITY,
          optionsForFile: () => ({
            hardenedRuntime: true,
            entitlements: resolve('entitlements.mac.plist'),
          }),
        }
      : {
          identity: '-',
          identityValidation: false,
          optionsForFile: () => ({ hardenedRuntime: false }),
        },
    ...(protectedMacSigning
      ? {
          osxNotarize: {
            appleApiKey: resolve(process.env.ADROUTER_APPLE_API_KEY_PATH as string),
            appleApiKeyId: process.env.ADROUTER_APPLE_API_KEY_ID as string,
            appleApiIssuer: process.env.ADROUTER_APPLE_API_ISSUER as string,
          },
        }
      : {}),
    ...(protectedWindowsSigning
      ? {
          windowsSign: {
            hookModulePath: resolve('scripts', 'windows-azure-sign-hook.cjs'),
          },
        }
      : {}),
  },
  rebuildConfig: {},
  makers: [new MakerZIP({}, ['darwin', 'linux', 'win32'])],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
        },
        {
          entry: 'src/preload/index.ts',
          config: 'vite.preload.config.ts',
        },
        {
          entry: 'src/runtime/index.ts',
          config: 'vite.runtime.config.ts',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      // Playwright's Electron driver attaches through --inspect. This opt-in
      // build flag is used only by `npm run test:e2e`; release builds keep the
      // inspector disabled.
      [FuseV1Options.EnableNodeCliInspectArguments]: enableInspectorForE2E,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      // Electron 43's universal Forge output fails to launch when this fuse
      // is enabled, even though the same ASAR passes embedded-integrity
      // validation. Keep archive integrity validation on and do not emit an
      // unpacked application directory; revisit this when Electron fixes the
      // universal package interaction.
      [FuseV1Options.OnlyLoadAppFromAsar]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};

export default config;
