#!/usr/bin/env node
import { startProcessObservability } from './process-observability.mts';
import { startProcessDatabasePools } from './process-database-pools.mts';
import { startProcessCompositionValidation } from './process-composition-validation.mts';
import { startProcessCompositionSourceReads } from './process-composition-source-reads.mts';
import { startProcessBootWarmUpImports } from './process-boot-warm-up-imports.mts';
/**
 * Serves the named units in this one Node process, each unit's own Modern.js production server on its loopback
 * port. Every unit resolves its packages through the installed workspace, so their shared dependencies load once.
 * A unit that fails to start stops the process; the app host then stops the container. The host hands the owners'
 * module credentials over on the private channel (file descriptor 3). Each unit's bundle carries its own credential
 * store copy: this program claims it for that unit's module, through the claim the unit's entry exports, right after
 * loading the unit and before it serves, and hands it every key line from then on.
 *
 *   node scripts/zerops/serve-units.mts <appId> [...]
 */
import type { Server } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeRuntime } from '@effect/platform-node';
import { Console, Effect, FileSystem, Layer, Predicate, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import { ActiveApplicationCompositionConfigLive } from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionSourceLive } from '../../packages/core-runtime/src/modules/active-application-composition-source.node.ts';
import { nodeHostBootWarmUp } from '../../packages/core-runtime/src/runtime/node-host-boot-warm-up.ts';

import { UNIT_ENTRY, readHostedUnits, workspaceRoot } from './hosted-units.mts';
import type { HostedUnit } from './hosted-units.mts';
import { keepConnectionsAlive } from './http-keep-alive.mts';
import { API_BUNDLE, ENTRY_CLAIM_EXPORT, storeCopiesIn } from './hosted-credential-claim.mts';
import {
  holdUnitStoreCopy,
  moduleCredentialChannelLost,
  receiveModuleCredentialHandover,
  UnitCredentialClaimSchema,
} from './module-credentials.mts';
import type { HostedCredentialHolders, UnitCredentialClaim } from './module-credentials.mts';
import { NoSubprocessServicesLive } from './no-subprocess-services.mts';
import { ownerWarmState } from './owner-warm-state.mts';

export class ServeUnitsError extends Schema.TaggedError<ServeUnitsError>()('ServeUnitsError', {
  reason: Schema.String,
}) {}

/**
 * The generated entry's contract (owner-entry.mts): `start(port, configureServer)` hands the unit's Node server to
 * `configureServer` before it listens, and resolves once the server listens on that port.
 */
const isUnitStart = (
  cause: unknown,
): cause is (port: number, configureServer: (server: Server) => Server) => Promise<void> => Predicate.isFunction(cause);

const UnitModuleSchema = Schema.Struct({
  start: Schema.declare(isUnitStart),
  /** The unit's own credential store copy claim; present exactly when its API bundle carries a copy. */
  [ENTRY_CLAIM_EXPORT]: Schema.optional(UnitCredentialClaimSchema),
});

/** A module that cannot load names only modules and paths; without it a failed deploy tells nobody why. */
const loadFailureDetail = (cause: unknown) => (Predicate.isError(cause) ? cause.message : 'no error was reported');

const loadUnitModule = (unit: HostedUnit) =>
  Effect.tryPromise({
    catch: (cause) =>
      new ServeUnitsError({ reason: `${unit.id} entry could not be loaded: ${loadFailureDetail(cause)}` }),
    // SAFETY: a dynamically imported module namespace is opaque until Schema decodes its `start` export below.
    try: async () =>
      (await import(pathToFileURL(path.join(workspaceRoot, unit.directory, UNIT_ENTRY)).href)) as unknown,
  }).pipe(
    Effect.flatMap((loaded) =>
      Schema.decodeUnknownEffect(UnitModuleSchema)(loaded).pipe(
        Effect.mapError(() => new ServeUnitsError({ reason: `${unit.id} entry exports no start(port)` })),
      ),
    ),
  );

/** The Modern.js entry's Promise is converted here, at the driver edge; the rest stays Effect. */
const startUnitServer = (unit: HostedUnit, start: (typeof UnitModuleSchema.Type)['start']) =>
  Effect.tryPromise({
    catch: () => new ServeUnitsError({ reason: `${unit.id} server failed to start` }),
    try: async () => {
      await start(unit.port, keepConnectionsAlive);
    },
  });

/**
 * Claims the unit's own credential store copy before it serves. A unit whose API bundle carries a copy but whose
 * entry exports no claim is refused: its module could never hold a key (`hosted-credential-claim.mts` fails such a
 * build, this keeps an older build from serving silently without keys).
 */
const holdUnitCredentials = (
  holders: HostedCredentialHolders,
  unit: HostedUnit,
  claim: UnitCredentialClaim | undefined,
) =>
  Effect.gen(function* claimUnitCopy() {
    if (claim !== undefined) {
      return yield* holdUnitStoreCopy(holders, unit.id, claim).pipe(
        Effect.mapError((problem) => new ServeUnitsError({ reason: problem.reason })),
      );
    }
    const fs = yield* FileSystem.FileSystem;
    const bundle = yield* fs
      .readFileString(path.join(workspaceRoot, unit.directory, API_BUNDLE))
      .pipe(Effect.orElseSucceed(() => ''));
    if (storeCopiesIn(bundle) > 0) {
      return yield* new ServeUnitsError({
        reason: `${unit.id} carries a credential store copy its entry does not let the host claim; rebuild it`,
      });
    }
    return yield* Effect.void;
  });

const serveUnit = (holders: HostedCredentialHolders) => (unit: HostedUnit) =>
  Effect.gen(function* startUnit() {
    ownerWarmState.register(unit.id);
    const loaded = yield* loadUnitModule(unit);
    yield* holdUnitCredentials(holders, unit, loaded[ENTRY_CLAIM_EXPORT]);
    yield* startUnitServer(unit, loaded.start);
    return yield* Console.log(`[serve-units] ${unit.id} on 127.0.0.1:${String(unit.port)}`);
  });

export const ServedProcessSchema = Schema.Literals(['owners', 'shell']);
export type ServedProcess = typeof ServedProcessSchema.Type;

export const servedProcessOf = (ids: readonly string[]): ServedProcess =>
  ids.length === 1 && ids[0] === 'shell-super-app' ? 'shell' : 'owners';

/** The warm-up reads the composition as the units do: the loopback source, through the process-shared reads. */
const HostBootWarmUpLive = ActiveApplicationCompositionConfigLive.pipe(
  Layer.provide(ActiveApplicationCompositionSourceLive),
  Layer.provide(FetchHttpClient.layer),
);

/**
 * Forks the process's boot warm-up into the host scope and returns at once: the units load and serve without waiting
 * for it, and a failed warm-up only logs (`packages/core-runtime/src/runtime/boot-warm-up.ts`).
 */
export const startBootWarmUp = Effect.fn('ServeUnits.startBootWarmUp')(function* forkBootWarmUp<Requirements>(
  served: ServedProcess,
  warmUp: Effect.Effect<void, never, Requirements>,
) {
  yield* Effect.forkScoped(warmUp.pipe(Effect.annotateLogs({ process: served })));
});

const command = Command.make('serve-units', { ids: Argument.String('app-id').pipe(Argument.atLeast(1)) }, ({ ids }) =>
  Effect.gen(function* serveUnits() {
    const served = servedProcessOf(ids);
    yield* startProcessObservability(served);
    // Background only: it waits for the published composition, then opens what the first requests would.
    yield* startBootWarmUp(served, nodeHostBootWarmUp());
    // Before any owner loads: the host hands keys over on the private channel now and replaces them later (late,
    // renewed, rotated); each unit's own store copy is claimed as it loads and gets them from then on.
    const holders = yield* receiveModuleCredentialHandover(ids);
    const units = yield* readHostedUnits;
    const selected = ids.map((id) => units.find((unit) => unit.id === id));
    const unknown = ids.filter((_, index) => selected[index] === undefined);
    if (unknown.length > 0) {
      return yield* new ServeUnitsError({ reason: `unknown units: ${unknown.join(', ')}` });
    }
    yield* Effect.forEach(selected.filter(Predicate.isNotUndefined), serveUnit(holders), { discard: true });
    // The listening servers keep serving; this process ends when the host stops it, or when its module credential
    // channel can no longer be read (the host then stops and the container restarts with fresh keys).
    return yield* moduleCredentialChannelLost;
  }),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Effect.andThen(
      Effect.andThen(
        Effect.andThen(
          Effect.andThen(startProcessDatabasePools, startProcessCompositionValidation),
          startProcessCompositionSourceReads,
        ),
        startProcessBootWarmUpImports,
      ),
      Layer.build(
        // This process keeps its credential channel open on file descriptor 3, which a subprocess would inherit.
        Layer.effectDiscard(Command.run({ version: '1.0.0' })(command)).pipe(
          Layer.provide(NoSubprocessServicesLive),
          Layer.provide(HostBootWarmUpLive),
        ),
      ),
    ).pipe(Effect.scoped),
  );
}
