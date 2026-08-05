import { safeStorage } from 'electron';

type SafeStorageFacade = Pick<
  typeof safeStorage,
  'getSelectedStorageBackend' | 'isAsyncEncryptionAvailable'
>;

const platformCredentialStoreName = (platform: NodeJS.Platform): string => {
  if (platform === 'darwin') return 'macOS Keychain';
  if (platform === 'win32') return 'Windows Data Protection API';
  if (platform === 'linux') return 'Linux desktop secret store';
  return 'operating-system credential store';
};

export async function assertSecureCredentialStorage(
  storage: SafeStorageFacade = safeStorage,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (!(await storage.isAsyncEncryptionAvailable())) {
    throw new Error(
      `${platformCredentialStoreName(platform)} encryption is unavailable; AdRouter credentials cannot be stored or read safely.`
    );
  }
  if (platform === 'linux') {
    const backend = storage.getSelectedStorageBackend();
    if (backend === 'basic_text' || backend === 'unknown') {
      throw new Error(
        'A secure Linux desktop secret store is unavailable. Install and unlock GNOME Keyring/libsecret or KWallet, then restart AdRouter Agent.'
      );
    }
  }
}
