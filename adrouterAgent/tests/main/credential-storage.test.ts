import { describe, expect, it } from 'vitest';
import { assertSecureCredentialStorage } from '@/main/credential-storage';

describe('credential storage policy', () => {
  it('accepts encrypted native stores and rejects Linux basic text', async () => {
    await expect(
      assertSecureCredentialStorage(
        {
          isAsyncEncryptionAvailable: async () => true,
          getSelectedStorageBackend: () => 'gnome_libsecret',
        },
        'linux'
      )
    ).resolves.toBeUndefined();
    await expect(
      assertSecureCredentialStorage(
        {
          isAsyncEncryptionAvailable: async () => true,
          getSelectedStorageBackend: () => 'basic_text',
        },
        'linux'
      )
    ).rejects.toThrow(/secure Linux desktop secret store/);
    await expect(
      assertSecureCredentialStorage(
        {
          isAsyncEncryptionAvailable: async () => false,
          getSelectedStorageBackend: () => 'unknown',
        },
        'win32'
      )
    ).rejects.toThrow(/Windows Data Protection API/);
  });
});
