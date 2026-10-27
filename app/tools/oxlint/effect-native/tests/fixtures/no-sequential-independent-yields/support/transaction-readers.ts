import { Effect } from 'effect';
import type { ScopedTransactionExecutor } from '@app/core-runtime';

declare const remote: { read(): Effect.Effect<unknown> };
export const directory = Effect.fn('Directory.snapshot')(function* directory(connection: ScopedTransactionExecutor) {
  const rows = yield* connection.select().from({});
  return rows;
});
export const ignored = Effect.fn('Directory.remote')(function* ignored(connection: ScopedTransactionExecutor) {
  return yield* remote.read();
});
export const nestedOnly = Effect.fn('Directory.nested')(function* nestedOnly(connection: ScopedTransactionExecutor) {
  const deferred = () => connection.select().from({});
  return deferred;
});
export const shadowedReader = Effect.fn('Directory.shadowed')(function* shadowedReader(connection: ScopedTransactionExecutor) {
  const directory = () => remote.read();
  return yield* directory(connection);
});
export const returned = (connection: ScopedTransactionExecutor) => connection.select().from({});
export const cyclic = Effect.fn('Directory.cyclic')(function* cyclic(connection: ScopedTransactionExecutor) {
  return yield* cyclic(connection);
});
export const closureWrite = Effect.fn('Directory.changed')(function* closureWrite(connection: ScopedTransactionExecutor) {
  const replace = () => { connection = {} as ScopedTransactionExecutor; };
  replace();
  return yield* connection.select().from({});
});
export const generic = Effect.fn('Directory.generic')(function* generic<ScopedTransactionExecutor>(connection: ScopedTransactionExecutor) {
  return yield* connection.select().from({});
});
