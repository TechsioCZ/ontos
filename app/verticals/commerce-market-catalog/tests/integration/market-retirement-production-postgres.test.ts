import { randomUUID } from 'node:crypto';

import {
  MarketAffectedUseAssessmentResponseSchema,
  ReserveMarketRetirementPayloadSchema,
  ReserveMarketRetirementResultSchema,
} from '@app/customer-market-retirement-contracts';
import type {
  MarketAffectedUseAssessmentResponse,
  ReserveMarketRetirementPayload,
} from '@app/customer-market-retirement-contracts';
import { ActionRuntime } from '@app/core-runtime';
import { GatewayContextResponseSchema } from '@app/shared-contracts';
import { sql } from 'drizzle-orm';
import { Cause, ConfigProvider, DateTime, Effect, Exit, Option, Predicate, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import { FetchHttpClient } from 'effect/unstable/http';

import { makeCoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
import { makeLiveOperationFixture } from '../../../../packages/core-runtime/src/testing/live-operations.ts';
import {
  makeTestDatabaseFromPool,
  testDatabasePools,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import { retireMarketAction } from '../../src/actions/retire-market.action.ts';
import { commerceMarketCatalogRelations } from '../../src/database/schema.ts';
import { MarketRetirementImpactAuthorityLive } from '../../src/integrations/market-retirement-impact.ts';

const RETIRE_ACTION_KEY = 'commerce.market-catalog.retire-market';
const CUSTOMER_CONTEXT_BASE_URL = 'https://customer-context.example.test';
const SHELL_GATEWAY_BASE_URL = 'https://shell.example.test';
const RESERVATION_TOKEN = '8c9bed83-a49d-4f21-b1e8-12efb2526174';
const OWNER_RESOURCE_ID = '4f5cba1e-f3d1-42d6-b1bd-9923d93033a2';

type MarketDatabase = TestDatabaseFromPool<typeof commerceMarketCatalogRelations>;

interface ScenarioTransport {
  readonly assessmentRequests: readonly Request[];
  readonly fetch: typeof globalThis.fetch;
  readonly reservationRequests: readonly ReserveMarketRetirementPayload[];
}

const cleanupMarket = (database: MarketDatabase, tenantId: string) => () =>
  database.transaction((transaction) =>
    Effect.gen(function* cleanupMarketRows() {
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
      for (const table of [
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
          ${`ACCEPTANCE_${input.marketId.replaceAll('-', '').slice(0, 12).toUpperCase()}`}, 1, 1,
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
          ${input.legalEntityId}::uuid, 1, 'Production-composed retirement acceptance',
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

const lifecycleRows = (database: MarketDatabase, tenantId: string, marketId: string) =>
  database.transaction((transaction) =>
    transaction.execute<{
      lifecycle: string;
      retirement_impact_assessment: null | {
        readonly providers: readonly { readonly retainedHistoryEvidence: { readonly count: number } }[];
      };
    }>(
      sql`select lifecycle, retirement_impact_assessment
            from commerce_market_catalog.market_lifecycle_periods
           where tenant_id = ${tenantId}::uuid and market_id = ${marketId}::uuid
           order by revision_number`,
      'objects',
    ),
  );

const sourceEvidence = (evaluatedAt: string, nextApplicabilityBoundary: string) => [
  {
    completenessEvidence: {
      nextApplicabilityBoundary,
      observedAt: evaluatedAt,
      ownerRevision: 'customer-context:revision:1',
      scope: {
        kind: 'EXACT_PREDICATE',
        predicateRef: 'commerce.customer-context:market-affected-use',
      },
    },
    currentness: 'CURRENT',
    digest: '1'.repeat(64),
    generation: 'customer-context:g1',
    ownerRevision: 'customer-context:revision:1',
    sourceId: 'commerce.customer-context.market-bootstrap-policy',
  },
  ...(['commerce.cart', 'commerce.order'] as const).map((moduleId, index) => ({
    completenessEvidence: {
      nextApplicabilityBoundary,
      observedAt: evaluatedAt,
      ownerRevision: 'composition:revision:1',
      scope: {
        declaredScopeRef: 'application-composition:revision:1',
        kind: 'SAFELY_BROADER_SCOPE' as const,
        predicateRef: `application-composition:module:${moduleId}:absent`,
      },
    },
    currentness: 'CURRENT' as const,
    digest: String(index + 2).repeat(64),
    generation: 'composition:revision:1',
    ownerRevision: 'composition:revision:1',
    sourceId: `application-composition:${moduleId}:UNIMPLEMENTED`,
  })),
];

const verifiedAssessment = (input: {
  readonly digest: string;
  readonly evaluatedAt: string;
  readonly liveBootstrap?: boolean;
  readonly marketRef: {
    readonly moduleId: 'commerce.market-catalog';
    readonly resourceId: string;
    readonly resourceType: 'commerce.market-catalog.market';
    readonly tenantId: string;
  };
  readonly nextApplicabilityBoundary: string;
  readonly retainedHistory?: boolean;
}): MarketAffectedUseAssessmentResponse =>
  Schema.decodeUnknownSync(MarketAffectedUseAssessmentResponseSchema)({
    assessmentDigest: input.digest,
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
                  resourceId: OWNER_RESOURCE_ID,
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
    retainedHistoryReferences:
      input.retainedHistory === true
        ? [
            {
              kind: 'RETAINED_HISTORY',
              marketRef: input.marketRef,
              marketRevision: 1,
              ownerResourceRef: {
                moduleId: 'commerce.customer-context',
                resourceId: OWNER_RESOURCE_ID,
                resourceType: 'commerce.customer-context.purchase-proposal-revision',
                tenantId: input.marketRef.tenantId,
              },
              ownerResourceRevision: 'proposal:1',
            },
          ]
        : [],
    sourceEvidence: sourceEvidence(input.evaluatedAt, input.nextApplicabilityBoundary),
    tenantId: input.marketRef.tenantId,
  });

const makeTransport = (
  assessmentResponses: readonly MarketAffectedUseAssessmentResponse[],
  gatewayExpiresAt: number,
): ScenarioTransport => {
  const assessmentRequests: Request[] = [];
  const reservationRequests: ReserveMarketRetirementPayload[] = [];
  let assessmentIndex = 0;
  let reservedDigest = '0'.repeat(64);
  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith('/auth/gateway-context')) {
      return Promise.resolve(
        Response.json(
          Schema.encodeSync(GatewayContextResponseSchema)({
            expiresAt: gatewayExpiresAt,
            token: 'market-retirement-production-token',
          }),
        ),
      );
    }
    if (url.pathname.endsWith('/reads/market-affected-use-assessment')) {
      assessmentRequests.push(request);
      const response = assessmentResponses[Math.min(assessmentIndex, assessmentResponses.length - 1)];
      assessmentIndex += 1;
      return Promise.resolve(Response.json(Schema.encodeSync(MarketAffectedUseAssessmentResponseSchema)(response)));
    }
    if (url.pathname.endsWith('/commerce-customer-context/actions/reserve-market-retirement')) {
      return request.json().then((body) => {
        const payload = Schema.decodeUnknownSync(ReserveMarketRetirementPayloadSchema)(body);
        reservationRequests.push(payload);
        if (payload.operation === 'RESERVE') {
          reservedDigest = payload.assessmentDigest;
        }
        const lifecycle = {
          COMMIT: 'COMMITTED',
          RELEASE: 'RELEASED',
          RESERVE: 'RESERVED',
        } as const;
        const result = Schema.decodeUnknownSync(ReserveMarketRetirementResultSchema)({
          assessmentDigest: reservedDigest,
          lifecycle: lifecycle[payload.operation],
          marketRef: payload.marketRef,
          marketRevision: payload.marketRevision,
          reservationToken: RESERVATION_TOKEN,
          reservationVersion: payload.operation === 'RESERVE' ? 1 : payload.reservationVersion + 1,
          tenantId: payload.tenantId,
        });
        return Response.json(Schema.encodeSync(ReserveMarketRetirementResultSchema)(result));
      });
    }
    return Promise.reject(new Error(`Unexpected Market retirement request: ${url.toString()}`));
  };
  return { assessmentRequests, fetch, reservationRequests };
};

const hasFailureTag = (exit: Exit.Exit<unknown, unknown>, tag: string): boolean =>
  Exit.isFailure(exit) && Option.exists(Cause.findErrorOption(exit.cause), Predicate.isTagged(tag));

it.live(
  'persists retirement only after production published-client reservation evidence',
  () =>
    Effect.scoped(
      Effect.gen(function* productionRetirement() {
        const connections = yield* loadDatabaseConnectionPair();
        const fixture = yield* makeLiveOperationFixture({
          actionKeys: [RETIRE_ACTION_KEY],
          authenticationNamespaceId: 'market-retirement-production-postgres',
          runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
        });
        yield* Effect.addFinalizer(() => fixture.close().pipe(Effect.orDie));
        const coreAdmin = yield* makeCoreDatabase(connections.admin);
        yield* coreAdmin.executor.execute(sql`
          insert into core.tenant_module_states (tenant_id, module_key, state)
          values (${fixture.tenantId}::uuid, 'commerce.market-catalog', 'active')
          on conflict (tenant_id, module_key) do update set state = excluded.state
        `);
        const { admin: adminPool } = yield* testDatabasePools;
        const marketAdmin = yield* makeTestDatabaseFromPool(adminPool, commerceMarketCatalogRelations);
        const now = yield* TestClock.withLive(DateTime.now).pipe(Effect.provide(TestClock.layer()));
        const effectiveAt = DateTime.formatIso(DateTime.subtract(now, { seconds: 1 }));
        const nextApplicabilityBoundary = DateTime.formatIso(DateTime.add(now, { hours: 1 }));
        const gatewayExpiresAt = Math.floor(DateTime.toEpochMillis(DateTime.add(now, { hours: 1 })) / 1000);

        const runScenario = Effect.fnUntraced(function* runScenario(input: {
          readonly assessments: (marketRef: {
            readonly moduleId: 'commerce.market-catalog';
            readonly resourceId: string;
            readonly resourceType: 'commerce.market-catalog.market';
            readonly tenantId: string;
          }) => readonly MarketAffectedUseAssessmentResponse[];
          readonly expectFailureTag?: string;
        }) {
          const marketId = randomUUID();
          const definitionRevisionId = randomUUID();
          const cleanup = cleanupMarket(marketAdmin, fixture.tenantId);
          yield* cleanup();
          yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
          yield* seedMarket(marketAdmin, {
            definitionRevisionId,
            legalEntityId: fixture.legalEntityId,
            marketId,
            principalId: fixture.manager.principalId,
            tenantId: fixture.tenantId,
          });
          const marketRef = {
            moduleId: 'commerce.market-catalog',
            resourceId: marketId,
            resourceType: 'commerce.market-catalog.market',
            tenantId: fixture.tenantId,
          } as const;
          yield* fixture.grantResourceAccess(marketRef, fixture.manager.principalId, 'reader');
          yield* fixture.grantResourceAccess(marketRef, fixture.manager.principalId, 'writer');
          const transport = makeTransport(input.assessments(marketRef), gatewayExpiresAt);
          const payload = {
            effectiveAt,
            expectedCurrentDefinitionRevisionRef: {
              moduleId: 'commerce.market-catalog',
              resourceId: definitionRevisionId,
              resourceType: 'commerce.market-catalog.market-definition-revision',
              tenantId: fixture.tenantId,
            },
            expectedRevision: 1,
            marketRef,
            reason: 'Production-composed Market retirement acceptance.',
          };
          const result = yield* Effect.gen(function* executeRetirement() {
            const runtime = yield* ActionRuntime;
            return yield* runtime.runAction({
              payload,
              principal: { ...fixture.manager, legalEntityId: fixture.legalEntityId },
              registration: retireMarketAction,
              transport: {
                correlationId: `market-retirement-${randomUUID()}`,
                idempotencyKey: randomUUID(),
                targetModuleKey: 'commerce.market-catalog',
                targetResourceId: marketId,
                targetResourceType: 'commerce.market-catalog.market',
              },
            });
          }).pipe(
            Effect.provide(MarketRetirementImpactAuthorityLive),
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  ONTOS_COMMERCE_CUSTOMER_CONTEXT_BASE_URL: CUSTOMER_CONTEXT_BASE_URL,
                  ONTOS_SHELL_GATEWAY_BASE_URL: SHELL_GATEWAY_BASE_URL,
                }),
              ),
            ),
            Effect.provideService(FetchHttpClient.Fetch, transport.fetch),
            Effect.provide(fixture.layer),
            Effect.exit,
          );
          const rows = yield* lifecycleRows(marketAdmin, fixture.tenantId, marketId);
          if (input.expectFailureTag === undefined) {
            expect(Exit.isSuccess(result)).toBe(true);
            expect(rows.map(({ lifecycle }) => lifecycle)).toEqual(['ACTIVE', 'RETIRED']);
          } else {
            expect(Exit.isFailure(result)).toBe(true);
            expect(hasFailureTag(result, input.expectFailureTag)).toBe(true);
            expect(rows.map(({ lifecycle }) => lifecycle)).toEqual(['ACTIVE']);
          }
          return { rows, transport };
        });

        const successDigest = 'a'.repeat(64);
        const success = yield* runScenario({
          assessments: (marketRef) => [
            verifiedAssessment({
              digest: successDigest,
              evaluatedAt: effectiveAt,
              marketRef,
              nextApplicabilityBoundary,
              retainedHistory: true,
            }),
          ],
        });
        expect(success.transport.reservationRequests.map(({ operation }) => operation)).toEqual(['RESERVE', 'COMMIT']);
        const [reserve] = success.transport.reservationRequests;
        expect(reserve?.operation === 'RESERVE' ? reserve.sourceEvidence.map(({ sourceId }) => sourceId) : []).toEqual([
          'commerce.customer-context.market-bootstrap-policy',
          'application-composition:commerce.cart:UNIMPLEMENTED',
          'application-composition:commerce.order:UNIMPLEMENTED',
        ]);
        expect(success.rows[1]?.retirement_impact_assessment).toMatchObject({
          assessmentDigest: successDigest,
          providers: [{ retainedHistoryEvidence: { count: 1 } }],
          reservation: { token: RESERVATION_TOKEN, version: 1 },
        });

        const liveReference = yield* runScenario({
          assessments: (marketRef) => [
            verifiedAssessment({
              digest: 'b'.repeat(64),
              evaluatedAt: effectiveAt,
              liveBootstrap: true,
              marketRef,
              nextApplicabilityBoundary,
            }),
          ],
          expectFailureTag: 'MarketCommandRejected',
        });
        expect(liveReference.transport.reservationRequests).toEqual([]);

        const stale = yield* runScenario({
          assessments: (marketRef) => [
            Schema.decodeUnknownSync(MarketAffectedUseAssessmentResponseSchema)({
              code: 'stale-owner-evidence',
              evaluatedAt: effectiveAt,
              marketRef,
              marketRevision: 1,
              observedAt: effectiveAt,
              outcome: 'STALE',
              reason: 'Owner evidence changed',
              staleSourceIds: ['commerce.customer-context.market-bootstrap-policy'],
              tenantId: marketRef.tenantId,
            }),
          ],
          expectFailureTag: 'MarketRetirementImpactAssessmentStale',
        });
        expect(stale.transport.reservationRequests).toEqual([]);

        const concurrentChange = yield* runScenario({
          assessments: (marketRef) => [
            verifiedAssessment({
              digest: 'c'.repeat(64),
              evaluatedAt: effectiveAt,
              marketRef,
              nextApplicabilityBoundary,
            }),
            verifiedAssessment({
              digest: 'd'.repeat(64),
              evaluatedAt: effectiveAt,
              liveBootstrap: true,
              marketRef,
              nextApplicabilityBoundary,
            }),
          ],
          expectFailureTag: 'MarketCommandRejected',
        });
        expect(concurrentChange.transport.assessmentRequests).toHaveLength(2);
        expect(concurrentChange.transport.reservationRequests.map(({ operation }) => operation)).toEqual([
          'RESERVE',
          'RELEASE',
        ]);
      }),
    ),
  240_000,
);
