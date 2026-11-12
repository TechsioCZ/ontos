/**
 * The platform services of a process that holds a module credential channel: the owners process and the Outbox Worker
 * host keep their handover channel open on file descriptor 3 for the host's later handovers, and a subprocess would
 * inherit it. Such a process starts none: its spawner refuses every command, and no code it loads spawns one
 * (`scripts/tests/module-credential-channel-subprocesses.test.mts`).
 */
import { NodeFileSystem, NodePath, NodeStdio, NodeTerminal } from '@effect/platform-node';
import { Effect, Layer, PlatformError } from 'effect';
import { ChildProcessSpawner } from 'effect/process';

export const NoSubprocessSpawnerLive = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() =>
    Effect.fail(
      PlatformError.systemError({
        _tag: 'PermissionDenied',
        description: 'A process holding a module credential channel starts no subprocess',
        method: 'spawn',
        module: 'ChildProcess',
      }),
    ),
  ),
);

/** `NodeServices.layer` without a working spawner, for a process holding a module credential channel. */
export const NoSubprocessServicesLive = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  NodeStdio.layer,
  NodeTerminal.layer,
  NoSubprocessSpawnerLive,
);
