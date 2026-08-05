import { SandboxedCommandRunner } from '../runtime/command-runner';
import { DependencyOperationBroker } from '../runtime/dependency-operations';
import { executeGitOperation } from '../runtime/git-operations';
import { fetchApprovedNetworkResource } from '../runtime/network-policy';
import {
  executeRestoreOperation,
  executeStructuredFileOperation,
} from '../runtime/structured-files';
import { executeApprovedScript } from '../runtime/structured-processes';
import type { OperationManifestV1 } from '../shared/contracts';

export class OperationBroker {
  private processTail: Promise<void> = Promise.resolve();
  private readonly dependencyBroker: DependencyOperationBroker;

  public constructor(private readonly commandRunner = new SandboxedCommandRunner()) {
    this.dependencyBroker = new DependencyOperationBroker(commandRunner);
  }

  private async serializeProcess<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.processTail;
    let release = (): void => undefined;
    this.processTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  public async execute(
    manifest: OperationManifestV1,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (
      manifest.capability === 'file.copy' ||
      manifest.capability === 'file.move' ||
      manifest.capability === 'file.delete'
    ) {
      return { ...(await executeStructuredFileOperation(manifest)) };
    }
    if (manifest.capability === 'dependency.preview') {
      return await this.serializeProcess(async () => ({
        ...(await this.dependencyBroker.preview(manifest, signal)),
      }));
    }
    if (manifest.capability === 'dependency.apply') {
      return await this.serializeProcess(() => this.dependencyBroker.apply(manifest));
    }
    if (manifest.capability === 'file.restore') {
      return { ...(await executeRestoreOperation(manifest)) };
    }
    if (manifest.capability === 'network.fetch') {
      const response = await fetchApprovedNetworkResource(manifest, signal);
      return {
        status: response.status,
        headers: response.headers,
        size: response.body.byteLength,
        bodyBase64: Buffer.from(response.body).toString('base64'),
      };
    }
    if (manifest.capability === 'script.run' || manifest.capability === 'dependency.lifecycle') {
      return await this.serializeProcess(() =>
        executeApprovedScript(manifest, this.commandRunner, signal)
      );
    }
    if (manifest.capability.startsWith('git.')) {
      return await this.serializeProcess(() => executeGitOperation(manifest, signal));
    }
    throw new Error(`Structured capability ${manifest.capability} is not implemented.`);
  }
}
