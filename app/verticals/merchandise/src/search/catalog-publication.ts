import { OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Effect } from 'effect';
import { loadHead } from '../services/merchandise-store.ts';
import type { MerchandiseDb } from '../services/merchandise-store.ts';

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new OperationContextUnavailable({
      code: 'operation_context_unavailable',
      reason: 'The merchandise catalog is not published for search',
    }),
    'cause',
    { value: cause },
  );

/** Check the published head inside the provider's scoped transaction before consulting the Core index. */
export const assertMerchandiseSearchPublished = Effect.fn('Merchandise.assertSearchPublished')(
  function* assertPublished(db: MerchandiseDb, scope: OperationalScope) {
    if (scope.legalEntityId === undefined) {
      return yield* unavailable();
    }
    const head = yield* loadHead(db, { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId }).pipe(
      Effect.mapError(unavailable),
    );
    if (head === undefined) {
      return yield* unavailable();
    }
    return yield* Effect.void;
  },
);
