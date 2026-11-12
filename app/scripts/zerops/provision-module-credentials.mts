#!/usr/bin/env node
/**
 * The platform's module credential provisioning, run with the Shell's settings (its Better Auth secret and database).
 * Every environment runs this same program: the app host on each boot, the local demo on each start.
 *
 *   node scripts/zerops/provision-module-credentials.mts issue --operation <id> --host <host> --boot <id> --revision <rev> <app-id>=<build> ...
 *     Issues each module a fresh 24-hour key attested for that module build, that composition revision (the release
 *     the issuing host serves) and that host and boot, and writes the pass's output (keys included) to file
 *     descriptor 3, the private handover channel its parent opened. Standard output and standard error stay logs.
 *     Nothing is written to a file.
 *   node scripts/zerops/provision-module-credentials.mts issue-installed --operation <id> --host <host> --boot <id>
 *     The same, for every calling module of the release the Shell serves now (the local demo serves them all).
 *   node scripts/zerops/provision-module-credentials.mts retire --operation <id> --host <host> --boot <id> --revision <rev> [<provider-key-id> ...]
 *     When <revision> holds the authority, revokes every module credential bound before it took the authority, except
 *     the named ones the host holds (none, when its boot pass issued nothing).
 *   node scripts/zerops/provision-module-credentials.mts retire-own --operation <id> --host <host> --boot <id> --revision <rev> --earlier-boots <id,...> [<replaced-provider-key-id> ...]
 *     Revokes the host's own module credentials it no longer holds: the named keys this boot replaced (attested for
 *     <host> and this boot), and every key attested for <host> and one of the ended earlier boots its container
 *     recorded. No other key is ever touched, whatever host name it carries.
 *
 * Logs name modules and counts only, never a key. Every pass is audited in the platform tenant.
 */
import { Socket } from 'node:net';

import { CorePersistenceLive, DatabaseConfigLive } from '@app/core-runtime';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { FetchHttpClient } from 'effect/http';
import { NodeServices } from '@effect/platform-node';
import { fromWritable } from '@effect/platform-node/NodeSink';
import { Console, Effect, Exit, Layer, Schema, Stream } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';

import { ApiKeyServiceLive } from '../../apps/shell-super-app/api/auth/api-key-service.ts';
import { AuthConfigLive } from '../../apps/shell-super-app/api/auth/config.ts';
import { ShellCryptoLive } from '../../apps/shell-super-app/api/auth/gateway-issuer.ts';
import type { ModuleCredentialRelease } from '../../apps/shell-super-app/api/auth/module-credential-attestation.ts';
import {
  provisionModuleCredentials,
  retireOwnModuleCredentials,
  retireSupersededModuleCredentials,
} from '../../apps/shell-super-app/api/auth/module-credential-provisioning.service.ts';
import { AuthPersistenceLive } from '../../apps/shell-super-app/api/auth/runtime-infrastructure.ts';
import {
  installedModuleCatalog,
  ShellInstalledModuleCatalogLive,
} from '../../apps/shell-super-app/api/modules/installed-module-catalog.ts';
import {
  MODULE_CREDENTIAL_CALLERS,
  MODULE_CREDENTIAL_CHANNEL_FD,
  MODULE_INTERNAL_WORKLOADS,
  ModuleCredentialHandoverError,
  ProvisioningOutputJsonSchema,
} from './module-credentials.mts';

const authPersistenceLive = AuthPersistenceLive.pipe(Layer.provide(AuthConfigLive));
const ProvisioningLive = Layer.mergeAll(
  ApiKeyServiceLive.pipe(Layer.provide(Layer.merge(authPersistenceLive, ShellCryptoLive))),
  authPersistenceLive,
  CorePersistenceLive.pipe(Layer.provide(DatabaseConfigLive)),
);

/** The release the Shell serves now, read the way the Shell reads it. */
const InstalledReleaseLive = ShellInstalledModuleCatalogLive.pipe(
  Layer.provide(ActiveApplicationCompositionConfigLive),
  Layer.provide(ActiveApplicationCompositionSourceLive),
  Layer.provide(FetchHttpClient.layer),
);

/** Writes the pass's output to the private channel and closes it; the parent reads it to its end. */
const writeChannel = (output: string) =>
  Stream.make(new TextEncoder().encode(output)).pipe(
    Stream.run(
      fromWritable({
        evaluate: () => new Socket({ fd: MODULE_CREDENTIAL_CHANNEL_FD, readable: false, writable: true }),
        onError: () => new ModuleCredentialHandoverError({ reason: 'The handover channel could not be written' }),
      }),
    ),
  );

const BUILD_ARGUMENT = /^(?<appId>[a-z][a-z0-9-]*)=(?<buildMarker>\S+)$/u;

const releaseOf = (compositionRevision: string, builds: readonly string[]) => {
  const entries = builds.flatMap((argument) => {
    const groups = BUILD_ARGUMENT.exec(argument)?.groups;
    return groups?.appId === undefined || groups.buildMarker === undefined
      ? []
      : [[groups.appId, groups.buildMarker] as const];
  });
  return entries.length === builds.length
    ? Effect.succeed<ModuleCredentialRelease>({ buildMarkers: Object.fromEntries(entries), compositionRevision })
    : Effect.fail(new ModuleCredentialHandoverError({ reason: 'Each module is named as <app-id>=<build-marker>' }));
};

const OPERATION_ID = Flag.String('operation');
const HOST_ID = Flag.String('host');
const BOOT_ID = Flag.String('boot');
const REVISION = Flag.String('revision');

const issueFor = (input: {
  readonly appIds: readonly string[];
  readonly bootId: string;
  readonly hostId: string;
  readonly operationId: string;
  readonly release: ModuleCredentialRelease;
}) =>
  Effect.gen(function* issueModuleCredentials() {
    const provisioned = yield* provisionModuleCredentials({ ...input, workloads: MODULE_INTERNAL_WORKLOADS });
    const output = yield* Schema.encodeUnknownEffect(ProvisioningOutputJsonSchema)({
      credentials: Object.fromEntries(provisioned.credentials),
      failedAppIds: provisioned.failedAppIds,
      keys: Object.fromEntries(provisioned.keys),
      schemaVersion: 1,
      workloadCredentials: Object.fromEntries(provisioned.workloadCredentials),
    });
    // Standard output is a log stream here; only the private channel carries keys.
    yield* Console.log(
      provisioned.failedAppIds.length === 0
        ? `[module-credentials] issued for ${[...provisioned.credentials.keys()].join(', ')}; ${String(provisioned.workloadCredentials.size)} internal workload credential(s)`
        : `[module-credentials] NOT issued for ${provisioned.failedAppIds.join(', ')}`,
    );
    return yield* writeChannel(output);
  });

const issue = Command.make(
  'issue',
  {
    bootId: BOOT_ID,
    builds: Argument.String('app-id=build-marker').pipe(Argument.atLeast(1)),
    hostId: HOST_ID,
    operationId: OPERATION_ID,
    revision: REVISION,
  },
  ({ bootId, builds, hostId, operationId, revision }) =>
    Effect.gen(function* issueForRelease() {
      const release = yield* releaseOf(revision, builds);
      return yield* issueFor({ appIds: Object.keys(release.buildMarkers), bootId, hostId, operationId, release });
    }),
);

const issueInstalled = Command.make(
  'issue-installed',
  { bootId: BOOT_ID, hostId: HOST_ID, operationId: OPERATION_ID },
  ({ bootId, hostId, operationId }) =>
    Effect.gen(function* issueForInstalledRelease() {
      const installed = yield* installedModuleCatalog;
      const callers = installed.contracts.filter(({ deployment }) =>
        MODULE_CREDENTIAL_CALLERS.includes(deployment.appId),
      );
      return yield* issueFor({
        appIds: callers.map(({ deployment }) => deployment.appId),
        bootId,
        hostId,
        operationId,
        release: {
          buildMarkers: Object.fromEntries(
            callers.map(({ deployment }) => [deployment.appId, deployment.buildMarker] as const),
          ),
          compositionRevision: installed.composition.revision,
        },
      });
    }),
).pipe(Command.provide(InstalledReleaseLive));

const retire = Command.make(
  'retire',
  {
    bootId: BOOT_ID,
    hostId: HOST_ID,
    operationId: OPERATION_ID,
    providerKeyIds: Argument.String('provider-key-id').pipe(Argument.variadic()),
    revision: REVISION,
  },
  ({ bootId, hostId, operationId, providerKeyIds, revision }) =>
    retireSupersededModuleCredentials({
      bootId,
      compositionRevision: revision,
      current: new Set(providerKeyIds),
      hostId,
      operationId,
    }).pipe(
      Effect.flatMap((outcome) =>
        Console.log(
          outcome.holdsAuthority
            ? `[module-credentials] retired ${String(outcome.retired)} superseded credential(s); ${String(outcome.failed)} could not be`
            : '[module-credentials] this release does not hold the authority; nothing retired',
        ),
      ),
    ),
);

const retireOwn = Command.make(
  'retire-own',
  {
    bootId: BOOT_ID,
    earlierBoots: Flag.String('earlier-boots').pipe(Flag.withDefault('')),
    hostId: HOST_ID,
    operationId: OPERATION_ID,
    providerKeyIds: Argument.String('provider-key-id').pipe(Argument.variadic()),
    revision: REVISION,
  },
  ({ bootId, earlierBoots, hostId, operationId, providerKeyIds, revision }) =>
    retireOwnModuleCredentials({
      bootId,
      compositionRevision: revision,
      earlierBoots: new Set(earlierBoots.split(',').filter((earlierBoot) => earlierBoot.length > 0)),
      hostId,
      operationId,
      replaced: new Set(providerKeyIds),
    }).pipe(
      Effect.flatMap((outcome) =>
        Console.log(
          `[module-credentials] retired ${String(outcome.retired)} of this host's own earlier credential(s); ${String(outcome.failed)} could not be`,
        ),
      ),
    ),
);

const command = Command.make('provision-module-credentials').pipe(
  Command.withSubcommands([issue, issueInstalled, retire, retireOwn]),
  // The pools live in this provided scope and close as soon as the pass ends, so the process exits at once.
  Command.provide(ProvisioningLive),
);

if (import.meta.main) {
  const result = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      // Never print a failure's details: a provider error can carry request material.
      Effect.tapError(() => Console.error('[module-credentials] provisioning failed; details withheld')),
      Effect.provide(NodeServices.layer),
    ),
  );
  process.exitCode = Exit.isFailure(result) ? 1 : 0;
}
