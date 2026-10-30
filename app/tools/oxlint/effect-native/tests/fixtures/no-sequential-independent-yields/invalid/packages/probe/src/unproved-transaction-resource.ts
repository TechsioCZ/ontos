// expect-count: 11
import { Effect } from 'effect';
import type { ScopedTransactionExecutor as Connection } from '@app/core-runtime';
import { snapshot } from '../../../../support/transaction-barrel.ts';
import { ignored, nestedOnly, shadowedReader, cyclic, closureWrite, generic } from '../../../../support/transaction-readers.ts';
import { missing } from 'unresolved-transaction-reader';

declare const remote: { read(scope?: unknown): Effect.Effect<unknown> };
export const separate = (left: Connection, right: Connection) => Effect.gen(function* () {
  const first = yield* snapshot(left);
  const second = yield* right.select().from({});
  return { first, second };
});
export const unusedParameter = (connection: Connection) => Effect.gen(function* () {
  const first = yield* ignored(connection);
  const second = yield* connection.select().from({});
  return { first, second };
});
export const deferredParameter = (connection: Connection) => Effect.gen(function* () {
  const first = yield* nestedOnly(connection);
  const second = yield* connection.select().from({});
  return { first, second };
});
export const opaqueLocal = (connection: Connection) => Effect.gen(function* () {
  const snapshot = (input: Connection) => remote.read(input.scope);
  const first = yield* snapshot(connection);
  const second = yield* connection.select().from({});
  return { first, second };
});
export const shadowedImportedBody = (connection: Connection) => Effect.gen(function* () {
  const first = yield* shadowedReader(connection);
  const second = yield* connection.select().from({});
  return { first, second };
});
export const recursiveHelper = (connection: Connection) => Effect.gen(function* () {
  const first = yield* cyclic(connection);
  const second = yield* connection.select().from({});
  return { first, second };
});
export const commonScope = (scope: { tenantId: string }) => Effect.gen(function* () {
  const first = yield* remote.read(scope);
  const second = yield* remote.read(scope);
  return { first, second };
});
export const ignoredRemotePair = (connection: Connection) => Effect.gen(function* () {
  const first = yield* ignored(connection);
  const second = yield* ignored(connection);
  return { first, second };
});
export const changedInsideClosure = (connection: Connection) => Effect.gen(function* () {
  const first = yield* closureWrite(connection);
  const second = yield* connection.select().from({});
  return { first, second };
});
export const genericLookalike = (connection: Connection) => Effect.gen(function* () {
  const first = yield* generic(connection);
  const second = yield* connection.select().from({});
  return { first, second };
});
export const unresolvedHelper = (connection: Connection) => Effect.gen(function* () {
  const first = yield* missing(connection);
  const second = yield* connection.select().from({});
  return { first, second };
});
