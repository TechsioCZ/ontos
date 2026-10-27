import type { ReadServiceFactory } from '@app/core-runtime';
import { Effect } from 'effect';

interface RecordsServices {
  readonly read: () => Effect.Effect<string>;
}

export const makeRecordsServices: ReadServiceFactory<RecordsServices> = (_transaction, scope) =>
  Effect.succeed({ read: () => Effect.succeed(scope.tenantId) });

export const makeStandaloneService = () =>
  Effect.succeed({ read: () => Effect.succeed('constructed outside the governed transaction') });
