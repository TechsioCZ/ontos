#!/usr/bin/env node
import { startProcessDatabasePools } from './process-database-pools.mts';
/**
 * Serves the named units in this one Node process, each unit's own Modern.js production server on its loopback
 * port. Every unit resolves its packages through the installed workspace, so their shared dependencies load once.
 * A unit that fails to start stops the process; the app host then stops the container.
 *
 *   node scripts/zerops/serve-units.mts <appId> [...]
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Effect, Layer, Predicate, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';

import { UNIT_ENTRY, readHostedUnits, workspaceRoot } from './hosted-units.mts';
import type { HostedUnit } from './hosted-units.mts';

export class ServeUnitsError extends Schema.TaggedError<ServeUnitsError>()('ServeUnitsError', {
  reason: Schema.String,
}) {}

/** The generated entry's contract: `start(port)` resolves once the unit's server listens on that port. */
// oxlint-disable-next-line effect-native/no-promise-shaped-port -- start(port) is the Modern.js entry's own Promise API, the driver boundary that the Effect code wraps. expires: 2027-03-31.
type UnitStart = (port: number) => Promise<void>;

const isUnitStart = (cause: unknown): cause is UnitStart => Predicate.isFunction(cause);

const UnitModuleSchema = Schema.Struct({ start: Schema.declare(isUnitStart) });

const loadUnitModule = (unit: HostedUnit) =>
  Effect.tryPromise({
    catch: () => new ServeUnitsError({ reason: `${unit.id} entry could not be loaded` }),
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

const startUnitServer = (unit: HostedUnit, start: UnitStart) =>
  Effect.tryPromise({
    catch: () => new ServeUnitsError({ reason: `${unit.id} server failed to start` }),
    try: async () => {
      await start(unit.port);
    },
  });

const serveUnit = (unit: HostedUnit) =>
  Effect.gen(function* startUnit() {
    const { start } = yield* loadUnitModule(unit);
    yield* startUnitServer(unit, start);
    return yield* Console.log(`[serve-units] ${unit.id} on 127.0.0.1:${String(unit.port)}`);
  });

const command = Command.make('serve-units', { ids: Argument.String('app-id').pipe(Argument.atLeast(1)) }, ({ ids }) =>
  Effect.gen(function* serveUnits() {
    const units = yield* readHostedUnits;
    const selected = ids.map((id) => units.find((unit) => unit.id === id));
    const unknown = ids.filter((_, index) => selected[index] === undefined);
    if (unknown.length > 0) {
      return yield* new ServeUnitsError({ reason: `unknown units: ${unknown.join(', ')}` });
    }
    yield* Effect.forEach(selected.filter(Predicate.isNotUndefined), serveUnit, { discard: true });
    // The listening servers keep serving; this process ends only when the host stops it.
    return yield* Effect.never;
  }),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Effect.andThen(
      startProcessDatabasePools,
      Layer.build(
        Layer.effectDiscard(Command.run({ version: '1.0.0' })(command)).pipe(Layer.provide(NodeServices.layer)),
      ),
    ).pipe(Effect.scoped),
  );
}
