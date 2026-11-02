import { NodeCrypto } from '@effect/platform-node';
import { randomUUID } from 'node:crypto';

import {
  MarketAffectedUseAssessmentRequestSchema,
  MarketAffectedUseAssessmentResponseSchema,
  MarketRetirementReservationRequestSchema,
  ReserveMarketRetirementPayloadSchema,
  ReserveMarketRetirementResultSchema,
} from '@app/customer-market-retirement-contracts';
import type {
  MarketAffectedUseAssessmentResponse,
  ReserveMarketRetirementPayload,
} from '@app/customer-market-retirement-contracts';
import { ActionRuntime, ContextAccess, ReadRuntime } from '@app/core-runtime';
import { OutboxWorkerLegalEntityScopeFanout } from '@app/core-runtime/outbox/worker';
import { GatewayContextResponseSchema } from '@app/shared-contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { PgInsertValue } from 'drizzle-orm/pg-core';
import { Cause, ConfigProvider, DateTime, Effect, Exit, Option, Predicate, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import { FetchHttpClient } from 'effect/http';
import { SqlError, UnknownError } from 'effect/sql/SqlError';

import { loadDatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
import {
  applicationCompositionAuthority,
  coreRelations,
  domainEvents,
  outboxMessages,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { lockApplicationCompositionPublication } from '../../../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { attestOutboxWorkerHandlerContext } from '../../../../packages/core-runtime/src/outbox/definition.ts';
import {
  makeOutboxWorkerLegalEntityScopeFanout,
  makePostgresOutboxWorkerLegalEntityScopeBackend,
} from '../../../../packages/core-runtime/src/outbox/legal-entity-scope-fanout.ts';
import { makeLiveOperationFixture } from '../../../../packages/core-runtime/src/testing/live-operations.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { allowTenantPermissions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import { injectStatementFaults } from '../../../../packages/core-runtime/tests/support/database-faults.ts';
import type { MarketRetirementOutcome } from '../../shared/domain/market-retirement-intent.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/commerce-market-catalog-market-retirement-requested-v1.ts';
import { retireMarketAction } from '../../src/actions/retire-market.action.ts';
import { marketAdministrationRead } from '../../src/api/market-administration.read.ts';
import { marketRetirementStatusRead } from '../../src/api/market-retirement-status.read.ts';
import { commerceMarketCatalogRelations, marketRetirementIntents } from '../../src/database/schema.ts';
import { MarketRetirementImpactAuthorityLive } from '../../src/integrations/market-retirement-impact.ts';
import {
  handleCompleteMarketRetirement,
  MarketRetirementIntentStoreLive,
} from '../../src/workers/complete-market-retirement.worker.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

const RETIRE_ACTION_KEY = 'commerce.market-catalog.retire-market';
const MODULE_KEY = 'commerce.market-catalog';
const REQUESTED_TOPIC = 'commerce.market-catalog.market-retirement-requested.v1';
const RETIRED_EVENT = 'commerce.market-catalog.market-retired.v1';
const WORKER_KEY = 'commerce.market-catalog.complete-market-retirement';
const FIXTURE_COMPOSITION_REVISION = 'a'.repeat(64);
const SHELL_GATEWAY_BASE_URL = 'https://shell.example.test';

type MarketDatabase = TestDatabaseFromClient<typeof commerceMarketCatalogRelations>;
interface MarketRef {
  readonly moduleId: 'commerce.market-catalog';
  readonly resourceId: string;
  readonly resourceType: 'commerce.market-catalog.market';
  readonly tenantId: string;
}

interface ProblemFields {
  readonly code?: string;
  readonly invocationId?: string;
  readonly resolution?: string;
  readonly retryCommand?: boolean;
}

interface FakeReservation {
  digest: string;
  lifecycle: 'COMMITTED' | 'RELEASED' | 'RESERVED';
  token: string;
  version: number;
}

const cleanupMarkets = (database: MarketDatabase, tenantId: string) =>
  database.transaction((transaction) =>
    Effect.gen(function* cleanupMarketRows() {
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
      for (const table of [
        'market_retirement_intents',
        'storefront_association_revisions',
        'storefront_associations',
        'market_lifecycle_periods',
        'market_definition_revisions',
        'markets',
        'market_catalog_completeness_generations',
      ] as const) {
        yield* transaction.execute(
          sql`delete from commerce_market_catalog.${sql.raw(table)} where tenant_id = ${tenantId}::uuid`,
          'objects',
        );
      }
    }),
  );

const seedMarket = (
  database: MarketDatabase,
  input: {
    readonly definitionRevisionId: string;
    readonly legalEntityId: string;
    readonly marketId: string;
    readonly principalId: string;
    readonly tenantId: string;
  },
) =>
  database.transaction((transaction) =>
    Effect.gen(function* seedMarketRows() {
      yield* transaction.execute(sql`
        insert into commerce_market_catalog.markets (
          market_id, tenant_id, selling_legal_entity_id, business_code,
          current_definition_revision, aggregate_revision,
          created_by_action_invocation_id, created_by_principal_id
        ) values (
          ${input.marketId}::uuid, ${input.tenantId}::uuid, ${input.legalEntityId}::uuid,
          ${`RETIRE_${input.marketId.replaceAll('-', '').slice(0, 12).toUpperCase()}`}, 1, 1,
          gen_random_uuid(), ${input.principalId}::uuid
        )
      `);
      yield* transaction.execute(sql`
        insert into commerce_market_catalog.market_definition_revisions (
          market_definition_revision_id, tenant_id, market_id, selling_legal_entity_id,
          revision_number, purpose, channels, jurisdictions, supported_locales,
          effective_from, change_reason, action_invocation_id, acting_principal_id
        ) values (
          ${input.definitionRevisionId}::uuid, ${input.tenantId}::uuid, ${input.marketId}::uuid,
          ${input.legalEntityId}::uuid, 1, 'Durable retirement acceptance',
          '["B2C"]'::jsonb, '[{"code":"CZ","kind":"COUNTRY"}]'::jsonb, '["cs-CZ"]'::jsonb,
          '2020-01-01T00:00:00.000Z'::timestamptz, 'Acceptance fixture', gen_random_uuid(),
          ${input.principalId}::uuid
        )
      `);
      yield* transaction.execute(sql`
        update commerce_market_catalog.markets
           set current_definition_revision_id = ${input.definitionRevisionId}::uuid
         where tenant_id = ${input.tenantId}::uuid and market_id = ${input.marketId}::uuid
      `);
      yield* transaction.execute(sql`
        insert into commerce_market_catalog.market_lifecycle_periods (
          tenant_id, market_id, selling_legal_entity_id, revision_number, lifecycle,
          effective_from, reason, action_invocation_id, acting_principal_id
        ) values (
          ${input.tenantId}::uuid, ${input.marketId}::uuid, ${input.legalEntityId}::uuid,
          1, 'ACTIVE', '2020-01-01T00:00:00.000Z'::timestamptz,
          'Acceptance fixture', gen_random_uuid(), ${input.principalId}::uuid
        )
      `);
    }),
  );

const lifecycles = (database: MarketDatabase, tenantId: string, marketId: string) =>
  database
    .transaction((transaction) =>
      transaction.execute<{ readonly lifecycle: string }>(
        sql`select lifecycle from commerce_market_catalog.market_lifecycle_periods
             where tenant_id = ${tenantId}::uuid and market_id = ${marketId}::uuid order by revision_number`,
        'objects',
      ),
    )
    .pipe(Effect.map((rows) => rows.map(({ lifecycle }) => lifecycle)));

const sourceEvidence = (evaluatedAt: string, nextApplicabilityBoundary: string) => [
  {
    completenessEvidence: {
      nextApplicabilityBoundary,
      observedAt: evaluatedAt,
      ownerRevision: 'customer-context:revision:1',
      scope: { kind: 'EXACT_PREDICATE', predicateRef: 'commerce.customer-context:market-affected-use' },
    },
    currentness: 'CURRENT',
    digest: '1'.repeat(64),
    generation: 'customer-context:g1',
    ownerRevision: 'customer-context:revision:1',
    sourceId: 'commerce.customer-context.market-bootstrap-policy',
  },
];

const verifiedAssessment = (input: {
  readonly evaluatedAt: string;
  readonly liveBootstrap?: boolean;
  readonly marketRef: MarketRef;
  readonly nextApplicabilityBoundary: string;
}): MarketAffectedUseAssessmentResponse =>
  Schema.decodeUnknownSync(MarketAffectedUseAssessmentResponseSchema)({
    assessmentDigest: 'a'.repeat(64),
    evaluatedAt: input.evaluatedAt,
    liveBlockingReferences: {
      bootstrapDefaults:
        input.liveBootstrap === true
          ? [
              {
                kind: 'BOOTSTRAP_DEFAULT',
                marketRef: input.marketRef,
                marketRevision: 1,
                ownerResourceRef: {
                  moduleId: 'commerce.customer-context',
                  resourceId: '4f5cba1e-f3d1-42d6-b1bd-9923d93033a2',
                  resourceType: 'commerce.customer-context.market-bootstrap-policy',
                  tenantId: input.marketRef.tenantId,
                },
                ownerResourceRevision: 'bootstrap:1',
              },
            ]
          : [],
      currentProposals: [],
    },
    marketRef: input.marketRef,
    marketRevision: 1,
    nextApplicabilityBoundary: input.nextApplicabilityBoundary,
    observedAt: input.evaluatedAt,
    outcome: 'VERIFIED',
    retainedHistoryReferences: [],
    sourceEvidence: sourceEvidence(input.evaluatedAt, input.nextApplicabilityBoundary),
    tenantId: input.marketRef.tenantId,
  });

const problem = (tag: string, status: number, fields: ProblemFields) =>
  Response.json(
    { _tag: tag, detail: tag, status, title: tag, type: 'about:blank', ...fields },
    { headers: { 'content-type': 'application/problem+json' }, status },
  );

/**
 * Customer Context over HTTP with Core's Action idempotency semantics: a committed key replays as
 * `action_already_committed` with its original invocation, and a released or committed reservation is final.
 */
const makeCustomerContext = (input: {
  readonly assessment: (marketRef: MarketRef) => MarketAffectedUseAssessmentResponse;
  readonly gatewayExpiresAt: number;
  readonly loseReserveResponseOnce?: boolean;
}) => {
  const committedKeys = new Map<string, string>();
  const reservations = new Map<string, FakeReservation>();
  const reservationsByInvocation = new Map<string, string>();
  const operations: string[] = [];
  let loseReserveResponse = input.loseReserveResponseOnce === true;
  const result = (marketRef: MarketRef, marketRevision: number) => {
    const reservation = reservations.get(marketRef.resourceId);
    return Response.json(
      Schema.encodeSync(ReserveMarketRetirementResultSchema)(
        Schema.decodeUnknownSync(ReserveMarketRetirementResultSchema)({
          assessmentDigest: reservation?.digest ?? '0'.repeat(64),
          lifecycle: reservation?.lifecycle ?? 'RESERVED',
          marketRef,
          marketRevision,
          reservationToken: reservation?.token ?? randomUUID(),
          reservationVersion: reservation?.version ?? 1,
          tenantId: marketRef.tenantId,
        }),
      ),
    );
  };
  const reserveOrFinish = (key: string, payload: ReserveMarketRetirementPayload) => {
    operations.push(payload.operation);
    const committedInvocation = committedKeys.get(key);
    if (committedInvocation !== undefined) {
      return problem('ReserveMarketRetirementActionAlreadyCommittedProblem', 409, {
        code: 'action_already_committed',
        invocationId: committedInvocation,
        resolution: 'REFRESH_GOVERNED_READS',
        retryCommand: false,
      });
    }
    const { marketRef } = payload;
    const current = reservations.get(marketRef.resourceId);
    const invocationId = randomUUID();
    if (payload.operation === 'RESERVE') {
      if (current !== undefined && current.lifecycle !== 'RELEASED') {
        return problem('ReserveMarketRetirementActionConflictProblem', 409, {
          code: 'RETIREMENT_RESERVATION_CONFLICT',
        });
      }
      reservations.set(marketRef.resourceId, {
        digest: payload.assessmentDigest,
        lifecycle: 'RESERVED',
        token: randomUUID(),
        version: 1,
      });
      reservationsByInvocation.set(invocationId, marketRef.resourceId);
    } else {
      if (current?.lifecycle !== 'RESERVED' || current.version !== payload.reservationVersion) {
        return problem('ReserveMarketRetirementActionConflictProblem', 409, { code: 'RESERVATION_STATE_CONFLICT' });
      }
      reservations.set(marketRef.resourceId, {
        ...current,
        lifecycle: payload.operation === 'COMMIT' ? 'COMMITTED' : 'RELEASED',
        version: current.version + 1,
      });
    }
    committedKeys.set(key, invocationId);
    if (payload.operation === 'RESERVE' && loseReserveResponse) {
      loseReserveResponse = false;
      throw new TypeError('fetch failed after Customer Context committed RESERVE');
    }
    return result(marketRef, payload.marketRevision);
  };
  const fetch: typeof globalThis.fetch = (resource, init) => {
    const request = new Request(resource, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith('/auth/api-key/gateway-context')) {
      return Promise.resolve(
        Response.json(
          Schema.encodeSync(GatewayContextResponseSchema)({
            apiBaseUrl: '/module-api/commerce.customer-context/release-a',
            compositionRevision: FIXTURE_COMPOSITION_REVISION,
            expiresAt: input.gatewayExpiresAt,
            token: 'market-retirement-worker-token',
          }),
        ),
      );
    }
    if (url.pathname.endsWith('/reads/market-affected-use-assessment')) {
      return request
        .json()
        .then(Schema.decodeUnknownSync(MarketAffectedUseAssessmentRequestSchema))
        .then(({ marketRef }) => {
          operations.push('ASSESS');
          return Response.json(
            Schema.encodeSync(MarketAffectedUseAssessmentResponseSchema)(input.assessment(marketRef)),
          );
        });
    }
    if (url.pathname.endsWith('/reads/market-retirement-reservation')) {
      return request
        .json()
        .then(Schema.decodeUnknownSync(MarketRetirementReservationRequestSchema))
        .then(({ marketRef, reservationInvocationId }) => {
          operations.push('READ');
          return reservationsByInvocation.get(reservationInvocationId) === marketRef.resourceId
            ? result(marketRef, 1)
            : problem('MarketRetirementReservationNotFoundProblem', 404, {});
        });
    }
    const key = request.headers.get('idempotency-key') ?? '';
    return request
      .json()
      .then(Schema.decodeUnknownSync(ReserveMarketRetirementPayloadSchema))
      .then((payload) => reserveOrFinish(key, payload));
  };
  return {
    fetch,
    lifecycle: (marketId: string) => reservations.get(marketId)?.lifecycle,
    operations,
  };
};

const intentIdOf = (outcome: MarketRetirementOutcome): string =>
  outcome.outcome === 'completed' ? (outcome.retirementIntentId ?? '') : outcome.retirementIntentId;

const hasFailureTag = (exit: Exit.Exit<unknown, unknown>, tag: string): boolean =>
  Exit.isFailure(exit) && Option.exists(Cause.findErrorOption(exit.cause), Predicate.isTagged(tag));

it.live(
  'completes durable Market retirement intents across owner crashes, duplicate deliveries, and concurrent requests',
  () =>
    Effect.scoped(
      Effect.gen(function* durableRetirement() {
        const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
        const fixture = yield* makeLiveOperationFixture({
          actionKeys: [RETIRE_ACTION_KEY],
          authenticationNamespaceId: 'market-retirement-intent-postgres',
          compositionRevision: FIXTURE_COMPOSITION_REVISION,
          databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
          moduleKeys: [MODULE_KEY],
          runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
        });
        yield* Effect.addFinalizer(() => fixture.close().pipe(Effect.orDie));
        const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
        const marketAdmin = yield* makeTestDatabaseFromClient(adminClient, commerceMarketCatalogRelations);
        const coreAdmin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
        const coreRuntime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
        // The worker's verified scope admits only the active composition revision.
        yield* Effect.acquireRelease(
          coreAdmin.transaction((transaction) =>
            Effect.gen(function* admitFixtureComposition() {
              yield* lockApplicationCompositionPublication(transaction);
              const [previous] = yield* transaction
                .select()
                .from(applicationCompositionAuthority)
                .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
              const admitted: PgInsertValue<typeof applicationCompositionAuthority> = {
                authorityKey: 'active',
                durableWorkAdmission: 'open',
                phase: 'active',
                revision: FIXTURE_COMPOSITION_REVISION,
                subscriptionsJson: [],
                validUntil: sql`clock_timestamp() + interval '1 hour'`,
              };
              yield* transaction.insert(applicationCompositionAuthority).values(admitted).onConflictDoUpdate({
                set: admitted,
                target: applicationCompositionAuthority.authorityKey,
              });
              return previous;
            }),
          ),
          (previous) =>
            coreAdmin
              .transaction((transaction) =>
                Effect.gen(function* restoreFixtureComposition() {
                  yield* lockApplicationCompositionPublication(transaction);
                  yield* transaction
                    .delete(applicationCompositionAuthority)
                    .where(eq(applicationCompositionAuthority.revision, FIXTURE_COMPOSITION_REVISION));
                  if (previous !== undefined) {
                    yield* transaction.insert(applicationCompositionAuthority).values(previous);
                  }
                }),
              )
              .pipe(Effect.orDie),
        );
        yield* cleanupMarkets(marketAdmin, fixture.tenantId);
        yield* Effect.addFinalizer(() =>
          Effect.all([
            cleanupMarkets(marketAdmin, fixture.tenantId),
            // Release only this disposable tenant's dispatch queue; retain append-only Core evidence.
            coreAdmin.delete(outboxMessages).where(eq(outboxMessages.tenantId, fixture.tenantId)),
          ]).pipe(Effect.orDie),
        );
        const fanout = makeOutboxWorkerLegalEntityScopeFanout(
          makePostgresOutboxWorkerLegalEntityScopeBackend({ executor: coreRuntime }),
        );
        const now = yield* TestClock.withLive(DateTime.now).pipe(Effect.provide(TestClock.layer()));
        const effectiveAt = DateTime.formatIso(DateTime.subtract(now, { seconds: 1 }));
        const nextApplicabilityBoundary = DateTime.formatIso(DateTime.add(now, { hours: 1 }));
        const gatewayExpiresAt = Math.floor(DateTime.toEpochMillis(DateTime.add(now, { hours: 1 })) / 1000);
        const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };

        const newMarket = Effect.fnUntraced(function* newMarket() {
          const marketId = randomUUID();
          const definitionRevisionId = randomUUID();
          yield* seedMarket(marketAdmin, {
            definitionRevisionId,
            legalEntityId: fixture.legalEntityId,
            marketId,
            principalId: fixture.manager.principalId,
            tenantId: fixture.tenantId,
          });
          const marketRef: MarketRef = {
            moduleId: MODULE_KEY,
            resourceId: marketId,
            resourceType: 'commerce.market-catalog.market',
            tenantId: fixture.tenantId,
          };
          yield* fixture.grantResourceAccess(marketRef, fixture.manager.principalId, 'reader');
          yield* fixture.grantResourceAccess(marketRef, fixture.manager.principalId, 'writer');
          return { definitionRevisionId, marketId, marketRef };
        });

        const retire = (market: { readonly definitionRevisionId: string; readonly marketRef: MarketRef }) =>
          Effect.gen(function* executeRetirement() {
            const runtime = yield* ActionRuntime;
            return yield* runtime.runAction({
              payload: {
                effectiveAt,
                expectedCurrentDefinitionRevisionRef: {
                  moduleId: MODULE_KEY,
                  resourceId: market.definitionRevisionId,
                  resourceType: 'commerce.market-catalog.market-definition-revision',
                  tenantId: fixture.tenantId,
                },
                expectedRevision: 1,
                marketRef: market.marketRef,
                reason: 'Durable Market retirement acceptance.',
              },
              principal,
              registration: retireMarketAction,
              transport: {
                correlationId: `market-retirement-${randomUUID()}`,
                idempotencyKey: randomUUID(),
                targetModuleKey: MODULE_KEY,
                targetResourceId: market.marketRef.resourceId,
                targetResourceType: market.marketRef.resourceType,
              },
            });
          }).pipe(Effect.provide(fixture.layer));

        const status = (marketRef: MarketRef, retirementIntentId: string) =>
          Effect.gen(function* readStatus() {
            const runtime = yield* ReadRuntime;
            return yield* runtime.runRead({
              input: { marketRef, retirementIntentId },
              principal,
              registration: marketRetirementStatusRead,
              transport: { correlationId: 'market-retirement-status' },
            });
          }).pipe(Effect.provide(fixture.layer));

        /** The staff screen's view: the aggregate revision and the newest retirement, found without its intent id. */
        const administration = (marketRef: MarketRef) =>
          Effect.gen(function* readAdministration() {
            const runtime = yield* ReadRuntime;
            const result = yield* runtime.runRead({
              input: { marketRef },
              principal,
              registration: marketAdministrationRead,
              transport: { correlationId: 'market-administration' },
            });
            return result.market;
          }).pipe(Effect.provideService(ContextAccess, allowTenantPermissions), Effect.provide(fixture.layer));

        /** Delivers the exact committed self-outbox request to the owner worker, as Core's claim would. */
        const deliver = Effect.fnUntraced(function* deliver(
          marketId: string,
          customerContext: ReturnType<typeof makeCustomerContext>,
        ) {
          const [message] = yield* coreAdmin
            .select()
            .from(outboxMessages)
            .innerJoin(
              domainEvents,
              and(
                eq(domainEvents.tenantId, outboxMessages.tenantId),
                eq(domainEvents.domainEventId, outboxMessages.domainEventId),
              ),
            )
            .where(
              and(
                eq(outboxMessages.tenantId, fixture.tenantId),
                eq(outboxMessages.topic, REQUESTED_TOPIC),
                eq(domainEvents.subjectResourceId, marketId),
              ),
            );
          if (message === undefined) {
            return yield* Effect.die('The retirement request was not committed to the Outbox');
          }
          const payload = Schema.decodeUnknownSync(OutboxPayloadSchema)(message.outbox_messages.payloadJson);
          const context = attestOutboxWorkerHandlerContext({
            actorPrincipalId: fixture.manager.principalId,
            attemptNumber: 1,
            claimId: randomUUID(),
            compositionRevision: FIXTURE_COMPOSITION_REVISION,
            consumerModuleKey: MODULE_KEY,
            correlationId: `market-retirement-worker-${marketId}`,
            deliveryId: randomUUID(),
            domainEventId: message.outbox_messages.domainEventId,
            legalEntityScope: 'required',
            messageId: message.outbox_messages.outboxMessageId,
            producerModuleKey: MODULE_KEY,
            tenantId: fixture.tenantId,
            tenantSequenceNo: 1n,
            topic: REQUESTED_TOPIC,
            workerKey: WORKER_KEY,
          });
          return handleCompleteMarketRetirement(payload, context).pipe(
            Effect.provide(MarketRetirementIntentStoreLive),
            Effect.provideService(OutboxWorkerLegalEntityScopeFanout, fanout),
            Effect.provide(MarketRetirementImpactAuthorityLive),
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY: 'market-owner-api-key',
                  ONTOS_SHELL_GATEWAY_BASE_URL: SHELL_GATEWAY_BASE_URL,
                }),
              ),
            ),
            Effect.provideService(FetchHttpClient.Fetch, customerContext.fetch),
          );
        });

        const intentRows = (marketId: string) =>
          marketAdmin
            .select()
            .from(marketRetirementIntents)
            .where(
              and(
                eq(marketRetirementIntents.tenantId, fixture.tenantId),
                eq(marketRetirementIntents.marketId, marketId),
              ),
            );
        const retiredEvents = (marketId: string) =>
          coreAdmin
            .select()
            .from(domainEvents)
            .where(
              and(
                eq(domainEvents.tenantId, fixture.tenantId),
                eq(domainEvents.eventType, RETIRED_EVENT),
                eq(domainEvents.subjectResourceId, marketId),
              ),
            );
        const assessment =
          (liveBootstrap = false) =>
          (marketRef: MarketRef) =>
            verifiedAssessment({ evaluatedAt: effectiveAt, liveBootstrap, marketRef, nextApplicabilityBoundary });

        // 1. Success: the guarded Action only records intent + outbox; the worker reserves, retires, commits.
        const success = yield* newMarket();
        const pending = yield* retire(success);
        expect(pending).toMatchObject({ outcome: 'pending', stage: 'REQUESTED' });
        const successIntentId = intentIdOf(pending);
        expect(yield* lifecycles(marketAdmin, fixture.tenantId, success.marketId)).toEqual(['ACTIVE']);
        expect(yield* status(success.marketRef, successIntentId)).toMatchObject({ outcome: 'pending' });
        expect(yield* administration(success.marketRef)).toMatchObject({
          retirement: { outcome: 'pending', retirementIntentId: successIntentId },
          revision: 1,
        });
        const successContext = makeCustomerContext({ assessment: assessment(), gatewayExpiresAt });
        const successWorker = yield* deliver(success.marketId, successContext);
        yield* successWorker;
        expect(successContext.operations).toEqual(['ASSESS', 'RESERVE', 'COMMIT']);
        expect(successContext.lifecycle(success.marketId)).toBe('COMMITTED');
        expect(yield* lifecycles(marketAdmin, fixture.tenantId, success.marketId)).toEqual(['ACTIVE', 'RETIRED']);
        expect(yield* status(success.marketRef, successIntentId)).toMatchObject({
          changed: true,
          lifecycle: 'RETIRED',
          outcome: 'completed',
          retirementIntentId: successIntentId,
          revision: 2,
        });
        expect(yield* administration(success.marketRef)).toMatchObject({
          retirement: { outcome: 'completed', retirementIntentId: successIntentId },
          revision: 2,
        });
        const [completion] = yield* retiredEvents(success.marketId);
        expect(completion).toMatchObject({ domainEventId: successIntentId, producerModuleKey: MODULE_KEY });

        // 2. Duplicate delivery of a completed intent changes nothing and calls nobody.
        yield* successWorker;
        expect(successContext.operations).toEqual(['ASSESS', 'RESERVE', 'COMMIT']);
        expect(yield* retiredEvents(success.marketId)).toHaveLength(1);

        // 3. A live reference fails the intent before any reservation.
        const blocked = yield* newMarket();
        const blockedPending = yield* retire(blocked);
        const blockedContext = makeCustomerContext({ assessment: assessment(true), gatewayExpiresAt });
        yield* yield* deliver(blocked.marketId, blockedContext);
        expect(blockedContext.operations).toEqual(['ASSESS']);
        expect(
          yield* status(
            blocked.marketRef,
            blockedPending.outcome === 'pending' ? blockedPending.retirementIntentId : '',
          ),
        ).toEqual({
          marketRef: blocked.marketRef,
          outcome: 'failed',
          reason: 'replacement_impact_unresolved',
          retirementIntentId: blockedPending.outcome === 'pending' ? blockedPending.retirementIntentId : '',
        });

        // 4. Customer Context fails before COMMIT: the RESERVE response is lost, the Market changes meanwhile, and
        //    the recovered (never-committed) reservation is RELEASED.
        const changed = yield* newMarket();
        yield* retire(changed);
        const changedContext = makeCustomerContext({
          assessment: assessment(),
          gatewayExpiresAt,
          loseReserveResponseOnce: true,
        });
        const changedWorker = yield* deliver(changed.marketId, changedContext);
        const lostReserve = yield* Effect.exit(changedWorker);
        expect(hasFailureTag(lostReserve, 'MarketRetirementWorkerPending')).toBe(true);
        expect((yield* intentRows(changed.marketId))[0]?.stage).toBe('RESERVATION_REQUESTED');
        yield* marketAdmin.transaction((transaction) =>
          transaction.execute(
            sql`update commerce_market_catalog.markets set aggregate_revision = aggregate_revision + 1
                 where tenant_id = ${fixture.tenantId}::uuid and market_id = ${changed.marketId}::uuid`,
            'objects',
          ),
        );
        yield* changedWorker;
        expect(changedContext.operations).toEqual(['ASSESS', 'RESERVE', 'RESERVE', 'READ', 'RELEASE']);
        expect(changedContext.lifecycle(changed.marketId)).toBe('RELEASED');
        expect(yield* lifecycles(marketAdmin, fixture.tenantId, changed.marketId)).toEqual(['ACTIVE']);
        expect((yield* intentRows(changed.marketId))[0]).toMatchObject({
          failureReason: 'revision_conflict',
          stage: 'FAILED',
        });

        // 5. The owner process stops after Customer Context COMMIT but before Market records completion: the
        //    retry repeats only COMMIT under the same key and completes; nothing is ever released.
        const crashed = yield* newMarket();
        yield* retire(crashed);
        const crashContext = makeCustomerContext({ assessment: assessment(), gatewayExpiresAt });
        const crashWorker = yield* deliver(crashed.marketId, crashContext);
        let advances = 0;
        const crash = yield* Effect.exit(
          crashWorker.pipe(
            injectStatementFaults((statement) => {
              if (statement.includes('advance_market_retirement_intent')) {
                advances += 1;
              }
              return statement.includes('advance_market_retirement_intent') && advances === 4
                ? Effect.fail(
                    new SqlError({
                      reason: new UnknownError({
                        cause: new Error('Injected crash after COMMIT'),
                        message: 'Injected crash after Customer Context COMMIT',
                      }),
                    }),
                  )
                : Effect.void;
            }),
          ),
        );
        expect(Exit.isFailure(crash)).toBe(true);
        expect(crashContext.lifecycle(crashed.marketId)).toBe('COMMITTED');
        expect((yield* intentRows(crashed.marketId))[0]?.stage).toBe('COMMIT_PENDING');
        expect(yield* lifecycles(marketAdmin, fixture.tenantId, crashed.marketId)).toEqual(['ACTIVE', 'RETIRED']);
        yield* crashWorker;
        expect(crashContext.operations).toEqual(['ASSESS', 'RESERVE', 'COMMIT', 'COMMIT']);
        expect((yield* intentRows(crashed.marketId))[0]?.stage).toBe('COMPLETED');
        expect(yield* retiredEvents(crashed.marketId)).toHaveLength(1);

        // 6. Two concurrent deliveries of the same intent converge on one retirement and one COMMIT.
        const raced = yield* newMarket();
        yield* retire(raced);
        const raceContext = makeCustomerContext({ assessment: assessment(), gatewayExpiresAt });
        const raceWorker = yield* deliver(raced.marketId, raceContext);
        const raceExits = yield* Effect.all([Effect.exit(raceWorker), Effect.exit(raceWorker)], { concurrency: 2 });
        expect(raceExits.some(Exit.isSuccess)).toBe(true);
        yield* raceWorker;
        expect((yield* intentRows(raced.marketId))[0]?.stage).toBe('COMPLETED');
        expect(yield* lifecycles(marketAdmin, fixture.tenantId, raced.marketId)).toEqual(['ACTIVE', 'RETIRED']);
        expect(yield* retiredEvents(raced.marketId)).toHaveLength(1);
        expect(raceContext.operations.filter((operation) => operation === 'RELEASE')).toEqual([]);
        expect(raceContext.lifecycle(raced.marketId)).toBe('COMMITTED');

        // 7. Concurrent retire requests for one Market record exactly one open intent.
        const contested = yield* newMarket();
        const requests = yield* Effect.all([Effect.exit(retire(contested)), Effect.exit(retire(contested))], {
          concurrency: 2,
        });
        expect(requests.filter(Exit.isSuccess)).toHaveLength(1);
        const rejected = requests.find(Exit.isFailure);
        expect(rejected !== undefined && hasFailureTag(rejected, 'MarketCommandRejected')).toBe(true);
        expect(yield* intentRows(contested.marketId)).toHaveLength(1);
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
  240_000,
);
