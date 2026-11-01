import type { ReadServiceFactory, ScopedRoutineInvocationError, ScopedRoutineInvoker } from '@app/core-runtime';
import { PersistenceFailure, defineScopedRoutine } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import type {
  StorefrontApplicationsRequest,
  StorefrontApplicationsResponse,
} from '../../shared/apis/storefront-applications.ts';
import { StorefrontApplicationsResponseSchema } from '../../shared/apis/storefront-applications.ts';

const ListRowSchema = Schema.Struct({ payload: Schema.Unknown });

const readStorefrontApplicationsRoutine = defineScopedRoutine({
  name: 'read_storefront_applications',
  ownerModuleKey: 'commerce.storefront-registry',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: ListRowSchema,
  routineKey: 'storefront-application.read-list',
  schema: 'storefront_registry',
});

export interface StorefrontApplicationsPersistence {
  readonly list: (
    input: StorefrontApplicationsRequest,
  ) => Effect.Effect<StorefrontApplicationsResponse, PersistenceFailure>;
}

const unavailable = (cause: unknown): PersistenceFailure =>
  new PersistenceFailure({ cause, reason: 'Storefront application registrations are temporarily unavailable' });

/** The owner routine already emits canonical UTC instants; decoding proves the payload is the public contract. */
const decodeList = Schema.decodeUnknownEffect(StorefrontApplicationsResponseSchema);

export const storefrontApplicationsPersistence = (
  transaction: ScopedRoutineInvoker,
  tenantId: string,
): StorefrontApplicationsPersistence => ({
  list: (input) =>
    transaction.invoke(readStorefrontApplicationsRoutine, [{ at: input.at }]).pipe(
      Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
      Effect.flatMap(([row]) =>
        row === undefined
          ? Effect.fail(unavailable('The Storefront Registry owner routine returned no list'))
          : decodeList(row.payload).pipe(Effect.mapError(unavailable)),
      ),
      Effect.filterOrFail(
        (response) =>
          response.applications.every(({ storefrontApplicationRef }) => storefrontApplicationRef.tenantId === tenantId),
        () => unavailable('The Storefront Registry owner routine returned another Tenant registration'),
      ),
    ),
});

export const storefrontApplicationsPersistenceForScope: ReadServiceFactory<StorefrontApplicationsPersistence> = (
  transaction,
  scope,
) => Effect.succeed(storefrontApplicationsPersistence(transaction, scope.tenantId));
