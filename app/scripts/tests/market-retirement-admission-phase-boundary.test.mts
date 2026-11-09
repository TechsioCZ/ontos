import { NodeCrypto } from '@effect/platform-node';
import type { ActionServicePreparationContext, OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import {
  ActiveApplicationCompositionService,
  InstalledModuleCatalogService,
  InstalledModuleCatalogServiceLive,
  TrustedPrincipalContextSchema,
  scopedRoutineInvokerFromTransaction,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import { makeOwnerApplicationCompositionFixture } from '@app/core-runtime/testing/module-contract';
import { GatewayDelegatedContextRequestSchema } from '@app/shared-contracts';
import { Cause, ConfigProvider, DateTime, Effect, Exit, Layer, Option, Redacted, Result, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { describe, expect, it } from 'effect-rstest';

import { commerceCustomerContextRegistration } from '../../verticals/commerce-customer-context/vertical.registration.ts';
import {
  OperationalScopeTransaction,
  installOperationalScopeFromTransactionService,
} from '../../packages/core-runtime/src/db/scoped-transaction.ts';
import type { OperationalScopeTransactionService } from '../../packages/core-runtime/src/db/scoped-transaction.ts';
import { insideDatabaseTransaction } from '../../packages/core-runtime/src/db/transaction-io-guard.ts';
import { withModuleOperationExecution } from '../../packages/core-runtime/src/modules/module-operation-execution.ts';
import { manageMarketRetirementAdmissionAction } from '../../verticals/commerce-market-catalog/src/actions/manage-market-retirement-admission.action.ts';
import type { marketRetirementAdmissions } from '../../verticals/commerce-market-catalog/src/database/schema.ts';
import { MarketRetirementImpactAuthorityLive } from '../../verticals/commerce-market-catalog/src/integrations/market-retirement-impact.ts';
import { prepareMarketRetirementAdmissionServices } from '../../verticals/commerce-market-catalog/src/services/market-retirement-admission-preflight.ts';
import { makeMarketRetirementAdmissionService } from '../../verticals/commerce-market-catalog/src/services/market-retirement-admission.service.ts';
import { commerceMarketCatalogBackendRegistration } from '../../verticals/commerce-market-catalog/vertical.runtime-declaration.ts';
import {
  ManageMarketRetirementAdmissionPayloadSchema,
  MarketRetirementStoredBasisSchema,
} from '../../verticals/commerce-market-catalog/shared/market-retirement-admission.ts';

/**
 * The reported defect: the delegated gateway issuance ran inside the owner's database transaction of
 * `commerce.market-catalog.manage-market-retirement-admission`. These cases drive the registered
 * Action's own staged preparation against scripted transports and the runtime's own transaction IO
 * guard, so remote work is refused exactly where production refuses it.
 */

type AdmissionRow = typeof marketRetirementAdmissions.$inferSelect;
type AdmissionInsert = typeof marketRetirementAdmissions.$inferInsert;

const actionKey = 'commerce.market-catalog.manage-market-retirement-admission';
const tenantId = '11111111-1111-4111-8111-111111111111';
const marketId = '22222222-2222-4222-8222-222222222222';
const sourceActionInvocationId = '33333333-3333-4333-8333-333333333333';
const legalEntityId = '44444444-4444-4444-8444-444444444444';
const principalId = '55555555-5555-4555-8555-555555555555';
const requestCorrelation = 'retirement-admission-phase-boundary';
const effectiveAt = '2026-12-01T00:00:00.000Z';
const observedAt = '2026-11-30T23:59:59.000Z';
const assessmentDigest = 'd'.repeat(64);
const customerContextRevision = 'customer-context:revision:17';
const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: marketId,
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;

const payload = Schema.decodeUnknownSync(ManageMarketRetirementAdmissionPayloadSchema)({
  operation: 'PREPARE',
  retirement: {
    effectiveAt,
    expectedCurrentDefinitionRevisionRef: {
      ...marketRef,
      resourceType: 'commerce.market-catalog.market-definition-revision',
    },
    expectedRevision: 3,
    marketRef,
    reason: 'Retire replaced Market.',
  },
  sourceActionInvocationId,
});

const storedBasis = Schema.decodeUnknownSync(MarketRetirementStoredBasisSchema)({
  assessment: {
    assessedMarketRef: marketRef,
    assessedMarketRevision: 3,
    assessmentDigest,
    effectiveAt,
    providers: [],
    requiredProviderModuleKeys: ['commerce.customer-context'],
  },
  reserve: {
    assessmentDigest,
    evaluatedAt: effectiveAt,
    sourceEvidence: [
      {
        completenessEvidence: {
          observedAt,
          ownerRevision: customerContextRevision,
          scope: { kind: 'EXACT_PREDICATE', predicateRef: 'market:exact' },
        },
        currentness: 'CURRENT',
        digest: 'e'.repeat(64),
        generation: 'customer-context:g17',
        ownerRevision: customerContextRevision,
        sourceId: 'commerce.customer-context.market-bootstrap-policy',
      },
    ],
  },
});

const admissionRow = (compositionRevision: string): AdmissionRow => ({
  abortProof: '77777777-7777-4777-8777-777777777777',
  basis: storedBasis,
  committedResult: null,
  compositionRevision,
  createdAt: DateTime.toDateUtc(DateTime.makeUnsafe(observedAt)),
  marketId,
  principalId,
  releaseGuardHash: 'c'.repeat(64),
  retirementAssessment: null,
  retirementPayload: payload.retirement,
  sellingLegalEntityId: legalEntityId,
  sourceActionInvocationId,
  status: 'PENDING',
  tenantId,
});

/** The encoded Customer Context answer the scripted transport returns to the real published client. */
const assessmentResponse = {
  assessmentDigest,
  evaluatedAt: effectiveAt,
  liveBlockingReferences: { bootstrapDefaults: [], currentProposals: [] },
  marketRef,
  marketRevision: 3,
  observedAt,
  outcome: 'VERIFIED',
  retainedHistoryReferences: [],
  sourceEvidence: [
    {
      completenessEvidence: {
        observedAt,
        ownerRevision: customerContextRevision,
        scope: { kind: 'EXACT_PREDICATE', predicateRef: 'market:exact' },
      },
      currentness: 'CURRENT',
      digest: 'e'.repeat(64),
      generation: 'customer-context:g17',
      ownerRevision: customerContextRevision,
      sourceId: 'commerce.customer-context.market-bootstrap-policy',
    },
  ],
  tenantId,
} as const;

const gatewayConfiguration = ConfigProvider.fromUnknown({
  ONTOS_GATEWAY_MODULE_API_KEY: 'module-credential',
  ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
});

const gatewayRequests: {
  readonly correlation: string | null;
  readonly request: typeof GatewayDelegatedContextRequestSchema.Type;
}[] = [];
const assessmentRequests: {
  readonly authorization: string | null;
  readonly correlation: string | null;
  readonly request: unknown;
}[] = [];
const transportCalls: string[] = [];

/** The real delegated issuance and assessment transports, scripted at the fetch primitive. */
const scriptedFetchFor =
  (compositionRevision: string): typeof globalThis.fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    transportCalls.push(path);
    if (path.endsWith('/auth/delegated/gateway-context')) {
      expect(request.headers.get('x-api-key')).toBe('module-credential');
      gatewayRequests.push({
        correlation: request.headers.get('x-correlation-id'),
        request: Schema.decodeUnknownSync(GatewayDelegatedContextRequestSchema)(await request.json()),
      });
      return Response.json({
        apiBaseUrl: '/module-api/commerce.customer-context',
        compositionRevision,
        expiresAt: 2_000_000_000,
        token: 'delegated-original-requester-token',
      });
    }
    if (path.endsWith('/reads/market-affected-use-assessment')) {
      assessmentRequests.push({
        authorization: request.headers.get('authorization'),
        correlation: request.headers.get('x-correlation-id'),
        request: await request.json(),
      });
      return Response.json(assessmentResponse);
    }
    return Response.json({ reason: 'Unexpected retirement transport request' }, { status: 503 });
  };

const unusedDatabaseOperation = (): never => {
  throw new Error('This owner transaction fixture does not use that database operation');
};

/**
 * The owner's own admission table over a real scoped executor. The fixture installs its own statement
 * builders on the service the executor binds, so the real owner persistence reads and writes typed
 * in-memory rows. This exercises its consumer path, not PostgreSQL or RLS.
 */
const ownerTable = (scope: OperationalScope, initialRows: readonly AdmissionRow[]) => {
  const rows: AdmissionInsert[] = [...initialRows];
  const inserted: AdmissionInsert[] = [];
  const statement = (take: () => readonly object[], onValues?: (values: AdmissionInsert) => void) => {
    const effect = Object.assign(Effect.sync(take), {
      for: () => effect,
      from: () => effect,
      onConflictDoNothing: () => effect,
      returning: () => effect,
      set: () => effect,
      values: (values: AdmissionInsert) => {
        onValues?.(values);
        return effect;
      },
      where: () => effect,
    });
    return effect;
  };
  const service: OperationalScopeTransactionService = {
    delete: unusedDatabaseOperation,
    insert: unusedDatabaseOperation,
    install: () => Effect.void,
    scopedRoutineInvoker: () => scopedRoutineInvokerFromTransaction(() => Effect.succeed([]), scope),
    select: unusedDatabaseOperation,
    update: unusedDatabaseOperation,
    verify: Effect.succeed(Option.some({ legal_entity_id: legalEntityId, tenant_id: tenantId })),
  };
  Reflect.set(service, 'insert', () =>
    statement(
      () => [],
      (values) => {
        inserted.push(values);
        rows.push(values);
      },
    ),
  );
  Reflect.set(service, 'select', () => statement(() => [...rows]));
  Reflect.set(service, 'update', () => statement(() => []));
  return {
    inserted,
    transaction: installOperationalScopeFromTransactionService(scope).pipe(
      Effect.provideService(OperationalScopeTransaction, service),
    ),
  };
};

/**
 * The native owner deployment: this module plus the Customer Context provider its retirement
 * requirement names, and the original requester's own verified admission.
 */
const ownerFixture = Effect.fn('MarketRetirementAdmissionPhaseBoundary.ownerFixture')(function* ownerFixture() {
  const owner = yield* makeOwnerApplicationCompositionFixture({
    additionalOwners: [{ appId: 'commerce-customer-context', ownerRegistration: commerceCustomerContextRegistration }],
    appId: 'commerce-market-catalog',
    ownerRegistration: commerceMarketCatalogBackendRegistration,
  });
  const compositionRevision = owner.snapshot.composition.revision;
  const scope: OperationalScope = trustVerifiedGatewayPrincipalContext(
    {
      ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
        authBindingId: '66666666-6666-4666-8666-666666666666',
        authContextRef: 'session:original-requester',
        authMethod: 'session',
        legalEntityId,
        principalId,
        tenantId,
      }),
      correlationId: requestCorrelation,
    },
    compositionRevision,
    { assertion: Redacted.make('original-requester-assertion'), audience: 'commerce-market-catalog' },
  );
  const catalog = yield* InstalledModuleCatalogService.pipe(
    Effect.flatMap((service) => service.loadForRevision(compositionRevision)),
    Effect.provide(
      InstalledModuleCatalogServiceLive.pipe(
        Layer.provide(Layer.succeed(ActiveApplicationCompositionService, owner.applicationComposition)),
      ),
    ),
  );
  return { catalog, compositionRevision, scope };
});

/** The registered preparation, inside the genuine execution lease and with the real transports. */
const preparedFactory = (
  fixture: Effect.Success<ReturnType<typeof ownerFixture>>,
  snapshotTransaction: ScopedTransactionExecutor,
) => {
  const context: ActionServicePreparationContext = {
    actionInvocationId: sourceActionInvocationId,
    compositionRevision: fixture.compositionRevision,
    scope: fixture.scope,
    transaction: (apply) => insideDatabaseTransaction(actionKey)(apply(snapshotTransaction)),
  };
  return withModuleOperationExecution(
    {
      loadCatalog: Effect.succeed(fixture.catalog),
      ownerRegistration: commerceMarketCatalogBackendRegistration,
      phase: 'execution',
      registration: manageMarketRetirementAdmissionAction,
      revision: fixture.compositionRevision,
      scope: fixture.scope,
    },
    prepareMarketRetirementAdmissionServices(payload, context).pipe(
      Effect.provide(MarketRetirementImpactAuthorityLive.pipe(Layer.provide(NodeCrypto.layer))),
      Effect.provide(NodeCrypto.layer),
      Effect.provideService(ConfigProvider.ConfigProvider, gatewayConfiguration),
      Effect.provideService(FetchHttpClient.Fetch, scriptedFetchFor(fixture.compositionRevision)),
    ),
  );
};

/** The owner write services need the same process Crypto the Action runtime provides. */
const ownerServices = <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
  effect.pipe(Effect.provide(NodeCrypto.layer));

/** The transaction IO guard's own defect text, so a case can prove the boundary is genuinely guarded. */
const guardDefect = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) {
    return 'succeeded';
  }
  const [reason] = exit.cause.reasons;
  if (reason === undefined || !Cause.isDieReason(reason)) {
    return 'no defect';
  }
  return Schema.is(Schema.instanceOf(Error))(reason.defect) ? reason.defect.message : String(reason.defect);
};

describe('Market retirement admission phase boundary', () => {
  it.effect('refuses an outbound fetch inside the owner transaction exactly as the reported defect', () =>
    Effect.gen(function* guardedOwnerTransaction() {
      const fixture = yield* ownerFixture();
      const exit = yield* Effect.exit(
        insideDatabaseTransaction(actionKey)(
          Effect.gen(function* fetchInsideOwnerTransaction() {
            const fetch = yield* FetchHttpClient.Fetch;
            yield* Effect.tryPromise({
              catch: () => 'refused',
              try: () => fetch('http://127.0.0.1:1/auth/delegated/gateway-context'),
            });
          }),
        ).pipe(Effect.provideService(FetchHttpClient.Fetch, scriptedFetchFor(fixture.compositionRevision))),
      );
      const defect = guardDefect(exit);
      expect(defect).toContain('outbound-fetch');
      expect(defect).toContain(actionKey);
    }),
  );

  it.effect(
    'issues the delegated gateway context and assessment before the guarded owner transaction, for the original requester',
    () =>
      Effect.gen(function* preparedRemoteBasis() {
        transportCalls.length = 0;
        gatewayRequests.length = 0;
        assessmentRequests.length = 0;
        const fixture = yield* ownerFixture();
        const snapshot = ownerTable(fixture.scope, []);
        const write = ownerTable(fixture.scope, []);
        const factory = yield* preparedFactory(fixture, yield* snapshot.transaction);
        const writeTransaction = yield* write.transaction;
        const services = yield* ownerServices(factory(writeTransaction, fixture.scope, fixture.compositionRevision));
        const outcome = yield* services.manage(payload).pipe(insideDatabaseTransaction(actionKey));

        // Both remote facts were already resolved on the unguarded fiber, and the owner write committed.
        expect(transportCalls).toEqual([
          '/shell-super-app-api/auth/delegated/gateway-context',
          '/module-api/commerce.customer-context/reads/market-affected-use-assessment',
        ]);
        expect(Result.isSuccess(outcome.result)).toBe(true);
        expect(outcome.basisRead).toBe(true);
        expect(write.inserted).toHaveLength(1);
        expect(write.inserted[0]).toMatchObject({
          basis: {
            assessment: { assessedMarketRef: marketRef, assessedMarketRevision: 3, assessmentDigest, effectiveAt },
          },
          compositionRevision: fixture.compositionRevision,
          marketId,
          principalId,
          sellingLegalEntityId: legalEntityId,
          sourceActionInvocationId,
          status: 'PENDING',
          tenantId,
        });
      }),
  );

  it.effect('issues the original requester assertion, correlation and admitted revision on the delegated wire', () =>
    Effect.gen(function* originalRequesterMetadata() {
      transportCalls.length = 0;
      gatewayRequests.length = 0;
      assessmentRequests.length = 0;
      const fixture = yield* ownerFixture();
      const snapshot = ownerTable(fixture.scope, []);
      yield* preparedFactory(fixture, yield* snapshot.transaction);

      expect(gatewayRequests).toHaveLength(1);
      expect(gatewayRequests[0]?.correlation).toBe(requestCorrelation);
      const delegated = gatewayRequests[0]?.request;
      expect(delegated).toMatchObject({
        audience: 'commerce-customer-context',
        compositionRevision: fixture.compositionRevision,
        legalEntityScope: 'subject',
      });
      expect(delegated?.subject._tag).toBe('Assertion');
      expect(delegated?.subject._tag === 'Assertion' ? Redacted.value(delegated.subject.sourceAssertion) : null).toBe(
        'original-requester-assertion',
      );
      expect(assessmentRequests).toHaveLength(1);
      expect(assessmentRequests[0]?.authorization).toBe('Bearer delegated-original-requester-token');
      expect(assessmentRequests[0]?.correlation).toBe(requestCorrelation);
      expect(assessmentRequests[0]?.request).toEqual({
        evaluatedAt: effectiveAt,
        marketRef,
        marketRevision: 3,
        tenantId,
      });
    }),
  );

  it.effect('refuses to transfer the prepared basis to another requester, correlation or release', () =>
    Effect.gen(function* preparedContextFence() {
      const fixture = yield* ownerFixture();
      const snapshot = ownerTable(fixture.scope, []);
      const write = ownerTable(fixture.scope, []);
      const factory = yield* preparedFactory(fixture, yield* snapshot.transaction);
      const transaction = yield* write.transaction;
      for (const candidate of [
        { revision: fixture.compositionRevision, scope: { ...fixture.scope, principalId: marketId } },
        { revision: fixture.compositionRevision, scope: { ...fixture.scope, correlationId: 'another-invocation' } },
        { revision: 'f'.repeat(64), scope: fixture.scope },
      ]) {
        const failure = yield* ownerServices(factory(transaction, candidate.scope, candidate.revision)).pipe(
          Effect.flip,
        );
        expect(failure).toMatchObject({
          _tag: 'OperationContextUnavailable',
          reason: 'Prepared retirement basis belongs to another operation context',
        });
      }
      expect(write.inserted).toEqual([]);
    }),
  );

  it.effect('fails a fresh PREPARE closed instead of reaching the network without a prepared basis', () =>
    Effect.gen(function* unpreparedFreshPrepare() {
      transportCalls.length = 0;
      const fixture = yield* ownerFixture();
      const write = ownerTable(fixture.scope, []);
      const writeTransaction = yield* write.transaction;
      const services = yield* ownerServices(
        makeMarketRetirementAdmissionService(Option.none())(
          writeTransaction,
          fixture.scope,
          fixture.compositionRevision,
        ),
      );
      const outcome = yield* services.manage(payload).pipe(insideDatabaseTransaction(actionKey));

      expect(transportCalls).toEqual([]);
      expect(write.inserted).toEqual([]);
      expect(outcome.basisRead).toBe(false);
      expect(Result.isFailure(outcome.result)).toBe(true);
      if (Result.isFailure(outcome.result)) {
        expect(outcome.result.failure).toMatchObject({
          _tag: 'MarketRetirementImpactAssessmentUnavailable',
          reason: 'The original retirement basis must be prepared before the owner transaction',
        });
      }
    }),
  );

  it.effect('skips remote preparation entirely when the owner snapshot already answers the command', () =>
    Effect.gen(function* existingAdmission() {
      transportCalls.length = 0;
      const fixture = yield* ownerFixture();
      const existingRow = admissionRow(fixture.compositionRevision);
      const snapshot = ownerTable(fixture.scope, [existingRow]);
      const write = ownerTable(fixture.scope, [existingRow]);
      const factory = yield* preparedFactory(fixture, yield* snapshot.transaction);
      const writeTransaction = yield* write.transaction;
      const services = yield* ownerServices(factory(writeTransaction, fixture.scope, fixture.compositionRevision));
      const outcome = yield* services.manage(payload).pipe(insideDatabaseTransaction(actionKey));

      expect(transportCalls).toEqual([]);
      expect(write.inserted).toEqual([]);
      expect(outcome.basisRead).toBe(false);
      expect(outcome.admissionReadCount).toEqual(Option.some(1));
      expect(Result.isSuccess(outcome.result)).toBe(true);
      if (Result.isSuccess(outcome.result)) {
        expect(outcome.result.success).toMatchObject({
          compositionRevision: fixture.compositionRevision,
          marketRef,
          outcome: 'PENDING',
          sourceActionInvocationId,
        });
      }
    }),
  );
});
