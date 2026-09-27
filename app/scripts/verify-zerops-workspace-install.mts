import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, ManagedRuntime, Path, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

// Zerops deploys the installed workspace, so every dependency link must resolve inside it.
// A global virtual store links into the build user's pnpm cache, which the runtime never receives.

class ZeropsWorkspaceInstallInvalid extends Schema.TaggedError<ZeropsWorkspaceInstallInvalid>()(
  'ZeropsWorkspaceInstallInvalid',
  { reason: Schema.String },
) {}

const importerScopes = ['apps', 'packages', 'verticals'];

const directoryEntries = (directory: string) =>
  Effect.gen(function* readEntries() {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.exists(directory)) ? yield* fs.readDirectory(directory) : [];
  });

export const findEscapingDependencyLinks = (root: string) =>
  Effect.gen(function* findEscapingLinks() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = yield* fs.realPath(root);
    const importers = [root];
    for (const scope of importerScopes) {
      for (const name of yield* directoryEntries(path.join(root, scope))) {
        importers.push(path.join(root, scope, name));
      }
    }
    const escaping: string[] = [];
    for (const importer of importers) {
      const modules = path.join(importer, 'node_modules');
      for (const name of yield* directoryEntries(modules)) {
        const packages = name.startsWith('@')
          ? (yield* directoryEntries(path.join(modules, name))).map((scoped) => path.join(name, scoped))
          : [name];
        for (const packageName of packages) {
          const link = path.join(modules, packageName);
          const target = yield* fs.realPath(link).pipe(Effect.orElseSucceed(() => null));
          const relative = target === null ? '..' : path.relative(workspace, target);
          if (relative.startsWith('..') || path.isAbsolute(relative)) {
            escaping.push(`${path.relative(root, link)} -> ${target ?? 'unresolvable'}`);
          }
        }
      }
    }
    return escaping;
  });

const verifyZeropsWorkspaceInstall = (root: string) =>
  Effect.gen(function* verifyInstall() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const globalVirtualStore = yield* spawner.string(
      ChildProcess.make('pnpm', ['config', 'get', 'enable-global-virtual-store'], { cwd: root }),
    );
    if (globalVirtualStore.trim() !== 'false') {
      return yield* new ZeropsWorkspaceInstallInvalid({
        reason: `pnpm resolves enable-global-virtual-store to "${globalVirtualStore.trim()}"; keep enableGlobalVirtualStore: false in pnpm-workspace.yaml and remove any PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE override`,
      });
    }
    const escaping = yield* findEscapingDependencyLinks(root);
    if (escaping.length > 0) {
      return yield* new ZeropsWorkspaceInstallInvalid({
        reason: `Dependency links resolve outside the deployed workspace:\n${escaping.join('\n')}`,
      });
    }
    return escaping;
  });

if (import.meta.main) {
  void ManagedRuntime.make(NodeServices.layer).runPromise(verifyZeropsWorkspaceInstall(process.cwd()));
}
