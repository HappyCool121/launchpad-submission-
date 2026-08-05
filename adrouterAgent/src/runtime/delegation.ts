import { realpath } from 'node:fs/promises';
import type { OperationManifestV1 } from '../shared/contracts';
import { OperationManifestV1Schema } from '../shared/contracts';
import { assertOperationManifest, createOperationManifest } from './operation-manifest';

export const createDelegationManifest = async (input: {
  threadId: string;
  turnId: string;
  workspaceRoot: string;
  title: string;
  prompt: string;
}): Promise<OperationManifestV1> => {
  const title = input.title.trim();
  const prompt = input.prompt.trim();
  if (!title || title.length > 120 || /[\r\n\0]/.test(title)) {
    throw new Error('Delegated task titles must be a bounded single line.');
  }
  if (!prompt || prompt.length > 8_192 || prompt.includes('\0')) {
    throw new Error('Delegated task prompts must contain between one and 8,192 safe characters.');
  }
  return createOperationManifest({
    capability: 'delegation.start',
    threadId: input.threadId,
    turnId: input.turnId,
    workspace: await realpath(input.workspaceRoot),
    argv: [title, prompt],
  });
};

export const delegationArguments = (
  rawManifest: unknown
): { manifest: OperationManifestV1; title: string; prompt: string } => {
  const parsed = OperationManifestV1Schema.parse(rawManifest);
  const manifest = assertOperationManifest(parsed, {
    operationId: parsed.operationId,
    threadId: parsed.threadId,
    turnId: parsed.turnId,
    capability: 'delegation.start',
  });
  if (
    manifest.targets.length !== 0 ||
    manifest.network !== null ||
    manifest.git !== null ||
    manifest.argv?.length !== 2
  ) {
    throw new Error('The delegated task manifest has invalid authority.');
  }
  const [title = '', prompt = ''] = manifest.argv;
  if (!title || title.length > 120 || /[\r\n\0]/.test(title)) {
    throw new Error('The delegated task title binding is invalid.');
  }
  if (!prompt || prompt.length > 8_192 || prompt.includes('\0')) {
    throw new Error('The delegated task prompt binding is invalid.');
  }
  return { manifest, title, prompt };
};
