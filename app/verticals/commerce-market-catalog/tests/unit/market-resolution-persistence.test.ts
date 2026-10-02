import type { OperationalScope } from '@app/core-runtime';
import { scopedRoutineInvokerFromTransaction, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { DateTime, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  OperationalScopeTransaction,
  installOperationalScopeFromTransactionService,
} from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import type { OperationalScopeTransactionService } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { readVerifiedGatewayCompositionRevision } from '../../../../packages/core-runtime/src/auth/system-principal-context-provenance.ts';

import { EligibleMarketTuplesRequestSchema } from '../../shared/apis/eligible-market-tuples.ts';
import { marketResolutionPersistenceForScope } from '../../src/persistence/market-resolution-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const scope: OperationalScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:market-resolution-persistence:run:1',
    authMethod: 'system',
    principalId: '22222222-2222-4222-8222-222222222222',
    tenantId,
  }),
  correlationId: 'market-resolution-persistence',
};
const capturedCompositionRevision = readVerifiedGatewayCompositionRevision(scope);
const request = Schema.decodeUnknownSync(EligibleMarketTuplesRequestSchema)({
  channel: 'B2C',
  effectiveAt: '2035-01-01T00:00:00.000Z',
  storefrontRef: { appId: 'storefront-web', tenantId },
});

const unusedDatabaseOperation = (): never => {
  throw new Error('This owner routine fixture does not use CRUD operations');
};

const loadSnapshot = (nextApplicabilityBoundary: null | string) =>
  Effect.gen(function* loadMarketSnapshot() {
    const routineInvoker = scopedRoutineInvokerFromTransaction(
      () =>
        Effect.succeed([
          {
            payload: {
              facts: [],
              generation: 3,
              nextApplicabilityBoundary,
              observedAt: '2034-12-01T00:00:00.000Z',
              predicateRevision: 'revision-3',
            },
          },
        ]),
      scope,
    );
    const transactionService: OperationalScopeTransactionService = {
      delete: unusedDatabaseOperation,
      insert: unusedDatabaseOperation,
      install: () => Effect.void,
      scopedRoutineInvoker: () => routineInvoker,
      select: unusedDatabaseOperation,
      update: unusedDatabaseOperation,
      verify: Effect.succeed(Option.some({ legal_entity_id: '', tenant_id: tenantId })),
    };
    const transaction = yield* installOperationalScopeFromTransactionService(scope).pipe(
      Effect.provideService(OperationalScopeTransaction, transactionService),
    );
    const persistence = yield* marketResolutionPersistenceForScope(transaction, scope, capturedCompositionRevision);
    return yield* persistence.load(request);
  });

it.effect('decodes raw nullable PostgreSQL snapshot boundaries before constructing domain output', () =>
  Effect.gen(function* decodeRawSnapshotBoundary() {
    const withoutBoundary = yield* loadSnapshot(null);
    const withBoundary = yield* loadSnapshot('2035-06-01T00:00:00.000Z');

    expect(withoutBoundary.nextApplicabilityBoundary).toBeUndefined();
    expect(withBoundary.nextApplicabilityBoundary).toBeDefined();
    if (withBoundary.nextApplicabilityBoundary !== undefined) {
      expect(DateTime.formatIso(withBoundary.nextApplicabilityBoundary)).toBe('2035-06-01T00:00:00.000Z');
    }
  }),
);
