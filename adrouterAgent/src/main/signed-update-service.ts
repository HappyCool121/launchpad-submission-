import type { TrustedReleaseKey } from '../../packages/agent-launcher/lib/manifest.mjs';
import { TRUSTED_RELEASE_KEYS } from '../../packages/agent-launcher/lib/trusted-release-keys.mjs';
import {
  checkForUpdate,
  type UpdateCheckResult,
  updateManifestUrl,
} from '../../packages/agent-launcher/lib/update.mjs';

export class SignedUpdateService {
  constructor(
    private readonly currentVersion: string,
    private readonly trustedKeys: readonly TrustedReleaseKey[] = TRUSTED_RELEASE_KEYS
  ) {}

  diagnostics(): {
    schema: 1;
    applicationEnabled: false;
    activeTrustedKeyCount: number;
    origins: { beta: string; stable: string };
  } {
    return {
      schema: 1,
      applicationEnabled: false,
      activeTrustedKeyCount: this.trustedKeys.filter((key) => key.status === 'active').length,
      origins: {
        beta: updateManifestUrl('beta') as string,
        stable: updateManifestUrl('stable') as string,
      },
    };
  }

  check(
    channel: 'beta' | 'stable',
    options: { fetchImpl?: typeof fetch; now?: Date | string | number } = {}
  ): Promise<UpdateCheckResult> {
    return checkForUpdate(this.currentVersion, channel, {
      ...options,
      trustedKeys: [...this.trustedKeys],
    });
  }
}
