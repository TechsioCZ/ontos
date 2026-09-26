import { randomUUID } from 'node:crypto';

import { v1 } from '@authzed/authzed-node';
import {
  ActiveApplicationCompositionSnapshotSchema,
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  loadDatabaseConnectionPair,
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import {
  MarketAffectedUseAssessmentResponseSchema,
  ReserveMarketRetirementConflictProblemSchema,
  ReserveMarketRetirementResultSchema,
} from '@app/customer-market-retirement-contracts';
import type {
  MarketAffectedUseAssessmentRequest,
  MarketAffectedUseAssessmentResponse,
  ReserveMarketRetirementPayload,
  ReserveMarketRetirementResult,
} from '@app/customer-market-retirement-contracts';
import { sql } from 'drizzle-orm';
import { Array as EffectArray, ConfigProvider, Effect, Layer, Order, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { loadSpiceDbConfig } from '../../../../packages/core-runtime/src/permissions/config.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  makeCommerceCustomerContextApiRuntime,
  productionActionRuntimeLive,
  productionReadRuntimeLive,
} from '../../api/index.ts';
import { commercePortalAuthRealmUnavailableLive } from '../../api/portal-auth/realm-unavailable.ts';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import {
  issueAcceptanceGatewayAssertion,
  makeAcceptanceGatewayIssuer,
} from '../support/enrollment-acceptance-identity-gateway-assertion.ts';
import type { AcceptanceGatewayIssuer } from '../support/enrollment-acceptance-identity-gateway-assertion.ts';
import { jsonBody } from '../support/response.ts';

const ORIGIN = 'http://commerce-customer-context.retirement.test';
const AUDIENCE = 'commerce-customer-context';
const ISSUER = 'http://market-retirement-owner-acceptance.test';
const KEY_ID = 'market-retirement-owner-acceptance';
const ACTION_KEY = 'commerce.customer-context.reserve-market-retirement';
const COMPOSITION_REVISION = 'a'.repeat(64);

type CommerceCustomerContextDatabase = TestDatabaseFromClient<typeof commerceCustomerContextRelations>;
type VerifiedAssessment = Extract<MarketAffectedUseAssessmentResponse, { readonly outcome: 'VERIFIED' }>;

interface AcceptanceClockRow extends Record<string, unknown> {
  readonly evaluated_at: string;
  readonly expired_observed_at: string;
  readonly expired_valid_until: string;
  readonly observed_at: string;
  readonly valid_until: string;
}

interface ReservationRow extends Record<string, unknown> {
  readonly assessment_digest: string;
  readonly lifecycle: string;
  readonly reservation_version: number;
  readonly source_evidence: readonly { readonly sourceId: string }[];
}

const one = <Value>(values: readonly Value[], description: string): Value => {
  const [value] = values;
  if (value === undefined) {
    throw new Error(`Expected one ${description}`);
  }
  return value;
};

const singleUseRedemptionLive = Layer.sync(GatewayAssertionRedemptionService, () => {
  const consumed = new Set<string>();
  return {
    consume: ({ jti }) =>
      consumed.has(jti)
        ? Effect.fail(new GatewayAssertionReplayError({ reason: 'The Bearer assertion was already redeemed' }))
        : Effect.sync(() => {
            consumed.add(jti);
          }),
  };
});

const ownerModule = (moduleId: 'commerce.cart' | 'commerce.order') => ({
  allowedContributions: [],
  contract: { sha256: 'b'.repeat(64), url: `https://${moduleId}.example.test/contract.json` },
  dependencies: [],
  deployment: { appId: moduleId.replace('.', '-'), buildMarker: `${moduleId}-build-1` },
  federation: {
    execution: 'browser',
    exposes: [],
    manifest: { sha256: 'c'.repeat(64), url: `https://${moduleId}.example.test/mf-manifest.json` },
    remoteName: moduleId === 'commerce.cart' ? 'commerceCart' : 'commerceOrder',
  },
  moduleId,
  publicContract: { id: moduleId, sha256: 'd'.repeat(64), version: '1' },
  requiredCoreCapabilities: [],
  requiredShellAbi: { id: 'ontos.shell-contributions', version: '1' },
  sharedSingletons: [],
});

const compositionSnapshot = (
  clock: AcceptanceClockRow,
  options: Readonly<{ readonly expired?: boolean; readonly installedOwner?: boolean }> = {},
): string => {
  const expired = options.expired === true;
  const snapshot = Schema.decodeUnknownSync(ActiveApplicationCompositionSnapshotSchema)({
    composition: {
      modules: options.installedOwner === true ? [ownerModule('commerce.cart')] : [],
      revision: COMPOSITION_REVISION,
      schemaVersion: '1',
      shell: {
        contributionAbi: { id: 'ontos.shell-contributions', version: '1' },
        coreCapabilities: [],
        sharedSingletons: [],
      },
    },
    observedAt: expired ? clock.expired_observed_at : clock.observed_at,
    validUntil: expired ? clock.expired_valid_until : clock.valid_until,
  });
  return Schema.encodeSync(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(snapshot);
};

const readAcceptanceClock = (database: CommerceCustomerContextDatabase) =>
  database.transaction((transaction) =>
    transaction
      .execute<AcceptanceClockRow>(
        sql`select
              to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as evaluated_at,
              to_char((statement_timestamp() - interval '2 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expired_observed_at,
              to_char((statement_timestamp() - interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expired_valid_until,
              to_char((statement_timestamp() - interval '1 minute') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as observed_at,
              to_char((statement_timestamp() + interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as valid_until`,
        'objects',
      )
      .pipe(Effect.map((rows) => one(rows, 'acceptance clock row'))),
  );

const cleanupOwnerRows = (database: CommerceCustomerContextDatabase, tenantId: string) => () =>
  database.transaction((transaction) =>
    Effect.gen(function* cleanRetirementRows() {
      yield* transaction.execute(
        sql`delete from commerce_customer_context.market_retirement_reservations
             where tenant_id = ${tenantId}::uuid`,
        'objects',
      );
    }),
  );

const activateCustomerContext = (database: CommerceCustomerContextDatabase, tenantId: string) =>
  database.transaction((transaction) =>
    transaction.execute(
      sql`insert into core.tenant_module_states (tenant_id, module_key, state)
          values (${tenantId}::uuid, 'commerce.customer-context', 'active')
          on conflict (tenant_id, module_key) do update set state = excluded.state`,
      'objects',
    ),
  );

const seedBootstrapReference = (
  database: CommerceCustomerContextDatabase,
  input: Readonly<{
    readonly evaluatedAt: VerifiedAssessment['evaluatedAt'];
    readonly legalEntityId: string;
    readonly lifecycle: 'ACTIVE' | 'RETIRED';
    readonly marketId: string;
    readonly principalId: string;
    readonly tenantId: string;
  }>,
) =>
  database.transaction((transaction) => {
    const retained = input.lifecycle === 'RETIRED';
    return transaction.execute(
      sql`insert into commerce_customer_context.market_bootstrap_policy_revisions (
            policy_revision_id, legal_entity_id, tenant_id, scope_kind,
            effective_from, effective_to, lifecycle, idempotency_key,
            action_invocation_id, actor_principal_id, reason, default_channel_id,
            default_commerce_market_id, default_selling_legal_entity_id,
            applicable_from, applicable_to
          ) values (
            gen_random_uuid(), ${input.legalEntityId}::uuid, ${input.tenantId}::uuid, 'SELLER',
            (${input.evaluatedAt}::timestamptz - interval '2 days'),
            ${retained ? sql`(${input.evaluatedAt}::timestamptz - interval '1 day')` : sql`null`},
            ${input.lifecycle}, ${`market-retirement-http-${randomUUID()}`}, gen_random_uuid(),
            ${input.principalId}::uuid, 'Production HTTP Market retirement acceptance fixture',
            'web', ${input.marketId}, ${input.legalEntityId}::uuid,
            ${retained ? sql`null` : sql`(${input.evaluatedAt}::timestamptz - interval '2 days')`},
            ${retained ? sql`(${input.evaluatedAt}::timestamptz - interval '1 day')` : sql`null`}
          )`,
      'objects',
    );
  });

const relationship = (
  resourceType: string,
  resourceId: string,
  relation: string,
  subjectType: string,
  subjectId: string,
) =>
  v1.Relationship.create({
    relation,
    resource: { objectId: resourceId, objectType: resourceType },
    subject: { object: { objectId: subjectId, objectType: subjectType } },
  });

const installAssessmentPermission = Effect.fnUntraced(function* installAssessmentPermission(input: {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}) {
  const objectId = toContextPermissionAccessObjectId(input.tenantId, input.legalEntityId, {
    moduleId: 'commerce.customer-context',
    permission: 'market.catalog.read',
  });
  if (objectId === undefined) {
    return yield* Effect.die('Could not encode the Market assessment context permission');
  }
  const legalEntityObjectId = toLegalEntityAccessObjectId(input.tenantId, input.legalEntityId);
  const moduleObjectId = toModuleAccessObjectId(input.tenantId, input.legalEntityId, 'commerce.customer-context');
  if (legalEntityObjectId === undefined || moduleObjectId === undefined) {
    return yield* Effect.die('Could not encode the Customer Context module permission');
  }
  const configuration = yield* loadSpiceDbConfig();
  const client = v1.NewClient(
    configuration.preSharedKey,
    configuration.endpoint,
    configuration.insecureLocal ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED : v1.ClientSecurity.SECURE,
  );
  const relationships = [
    relationship('module_access', moduleObjectId, 'legal_entity', 'legal_entity', legalEntityObjectId),
    relationship('module_access', moduleObjectId, 'accessor', 'principal', input.principalId),
    relationship('context_permission', objectId, 'tenant', 'tenant', input.tenantId),
    relationship('context_permission', objectId, 'grantee', 'principal', input.principalId),
  ];
  const write = (operation: v1.RelationshipUpdate_Operation) =>
    Effect.promise(() =>
      client.promises.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          updates: relationships.map((item) => v1.RelationshipUpdate.create({ operation, relationship: item })),
        }),
      ),
    );
  yield* write(v1.RelationshipUpdate_Operation.TOUCH);
  const permission = yield* Effect.promise(() =>
    client.promises.checkPermission(
      v1.CheckPermissionRequest.create({
        consistency: v1.Consistency.create({
          requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' },
        }),
        permission: 'access',
        resource: { objectId, objectType: 'context_permission' },
        subject: { object: { objectId: input.principalId, objectType: 'principal' } },
      }),
    ),
  );
  if (permission.permissionship !== v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION) {
    return yield* Effect.die('The Market assessment context permission could not be installed');
  }
  yield* Effect.addFinalizer(() =>
    write(v1.RelationshipUpdate_Operation.DELETE).pipe(
      Effect.ensuring(Effect.sync(() => client.close())),
      Effect.asVoid,
      Effect.orDie,
    ),
  );
  return configuration;
});

const configuredRuntime = (gateway: AcceptanceGatewayIssuer, environment: Readonly<Record<string, string>>) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      makeCommerceCustomerContextApiRuntime(
        productionReadRuntimeLive,
        productionActionRuntimeLive,
        singleUseRedemptionLive,
        commercePortalAuthRealmUnavailableLive([ORIGIN]),
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ...environment,
            ONTOS_GATEWAY_ISSUER: gateway.issuer,
            ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [gateway.publicJwk] }),
          }),
        ),
      ).createHandler(),
    ),
    (runtime) => Effect.promise(() => runtime.dispose()).pipe(Effect.orDie),
  );

type CommerceApiRuntime = Effect.Success<ReturnType<typeof configuredRuntime>>;

const send = (runtime: CommerceApiRuntime, request: Request) => Effect.promise(() => runtime.handler(request));

const authorizedRequest = Effect.fnUntraced(function* authorizedRequest(
  database: CommerceCustomerContextDatabase,
  gateway: AcceptanceGatewayIssuer,
  principal: Readonly<{
    readonly authBindingId: string;
    readonly legalEntityId: string;
    readonly principalId: string;
    readonly tenantId: string;
  }>,
  path: string,
  payload: MarketAffectedUseAssessmentRequest | ReserveMarketRetirementPayload,
  idempotencyKey?: string,
) {
  const assertion = yield* issueAcceptanceGatewayAssertion(database, gateway, AUDIENCE, {
    authBindingId: principal.authBindingId,
    authContextRef: `portal-session:${principal.authBindingId}`,
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'session',
    legalEntityId: principal.legalEntityId,
    principalId: principal.principalId,
    tenantId: principal.tenantId,
  });
  const requestHeaders = {
    authorization: `Bearer ${assertion}`,
    'content-type': 'application/json',
    origin: ORIGIN,
    'x-correlation-id': `market-retirement-${randomUUID()}`,
  };
  return new Request(`${ORIGIN}${path}`, {
    body: JSON.stringify(payload),
    headers: idempotencyKey === undefined ? requestHeaders : { ...requestHeaders, 'idempotency-key': idempotencyKey },
    method: 'POST',
  });
});

const reservePayload = (assessment: VerifiedAssessment): ReserveMarketRetirementPayload => ({
  assessmentDigest: assessment.assessmentDigest,
  evaluatedAt: assessment.evaluatedAt,
  marketRef: assessment.marketRef,
  marketRevision: assessment.marketRevision,
  operation: 'RESERVE',
  reason: 'Production HTTP Market retirement acceptance.',
  sourceEvidence: assessment.sourceEvidence,
  tenantId: assessment.tenantId,
});

const commitPayload = (reservation: ReserveMarketRetirementResult): ReserveMarketRetirementPayload => ({
  marketRef: reservation.marketRef,
  marketRevision: reservation.marketRevision,
  operation: 'COMMIT',
  reason: 'Production HTTP Market retirement acceptance committed.',
  reservationToken: reservation.reservationToken,
  reservationVersion: reservation.reservationVersion,
  tenantId: reservation.tenantId,
});

it.live(
  'serves production HTTP assessment and persists a retained-history-safe reservation through commit',
  () =>
    Effect.scoped(
      Effect.gen(function* productionHttpReservation() {
        const connections = yield* loadDatabaseConnectionPair();
        const fixture = yield* makeLiveOperationFixture({
          actionKeys: [ACTION_KEY],
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
        });
        yield* Effect.addFinalizer(() => fixture.close().pipe(Effect.orDie));
        const { admin: adminClient } = yield* testDatabaseClients;
        const database = yield* makeTestDatabaseFromClient(adminClient, commerceCustomerContextRelations);
        yield* activateCustomerContext(database, fixture.tenantId);
        const cleanup = cleanupOwnerRows(database, fixture.tenantId);
        yield* cleanup();
        yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
        const spiceDb = yield* installAssessmentPermission({
          legalEntityId: fixture.legalEntityId,
          principalId: fixture.manager.principalId,
          tenantId: fixture.tenantId,
        });
        const clock = yield* readAcceptanceClock(database);
        const marketId = randomUUID();
        yield* seedBootstrapReference(database, {
          evaluatedAt: clock.evaluated_at,
          legalEntityId: fixture.legalEntityId,
          lifecycle: 'RETIRED',
          marketId,
          principalId: fixture.manager.principalId,
          tenantId: fixture.tenantId,
        });
        const gateway = yield* makeAcceptanceGatewayIssuer(ISSUER, KEY_ID);
        const runtime = yield* configuredRuntime(gateway, {
          DATABASE_URL: connections.runtime.connectionString,
          ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON: compositionSnapshot(clock),
          SPICEDB_ENDPOINT: spiceDb.endpoint,
          SPICEDB_INSECURE: String(spiceDb.insecureLocal),
          SPICEDB_PRESHARED_KEY: spiceDb.preSharedKey,
        });
        const principal = {
          authBindingId: fixture.manager.authBindingId,
          legalEntityId: fixture.legalEntityId,
          principalId: fixture.manager.principalId,
          tenantId: fixture.tenantId,
        };
        const marketRef = {
          moduleId: 'commerce.market-catalog',
          resourceId: marketId,
          resourceType: 'commerce.market-catalog.market',
          tenantId: fixture.tenantId,
        } as const;
        yield* fixture.grantResourceAccess(marketRef, fixture.manager.principalId, 'reader');
        const assessmentResponse = yield* send(
          runtime,
          yield* authorizedRequest(database, gateway, principal, '/reads/market-affected-use-assessment', {
            evaluatedAt: clock.evaluated_at,
            marketRef,
            marketRevision: 7,
            tenantId: fixture.tenantId,
          }),
        );
        const assessmentBody = yield* jsonBody(assessmentResponse);
        expect(assessmentResponse.status, JSON.stringify(assessmentBody)).toBe(200);
        const assessment = yield* Schema.decodeUnknownEffect(MarketAffectedUseAssessmentResponseSchema)(assessmentBody);
        expect(assessment.outcome).toBe('VERIFIED');
        const verified = yield* assessment.outcome === 'VERIFIED'
          ? Effect.succeed(assessment)
          : Effect.die(`Expected VERIFIED assessment, received ${assessment.outcome}`);
        expect(verified.liveBlockingReferences).toEqual({ bootstrapDefaults: [], currentProposals: [] });
        expect(verified.retainedHistoryReferences).toHaveLength(1);
        expect(
          EffectArray.sort(
            verified.sourceEvidence.map(({ sourceId }) => sourceId),
            Order.String,
          ),
        ).toEqual([
          'application-composition:commerce.cart:UNIMPLEMENTED',
          'application-composition:commerce.order:UNIMPLEMENTED',
          'commerce.customer-context.market-bootstrap-policy',
          'commerce.customer-context.purchase-proposals',
        ]);

        const reserveResponse = yield* send(
          runtime,
          yield* authorizedRequest(
            database,
            gateway,
            principal,
            '/commerce-customer-context/actions/reserve-market-retirement',
            reservePayload(verified),
            randomUUID(),
          ),
        );
        expect(reserveResponse.status).toBe(200);
        const reservation = yield* jsonBody(reserveResponse).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ReserveMarketRetirementResultSchema)),
        );
        expect(reservation.lifecycle).toBe('RESERVED');
        expect(reservation.reservationVersion).toBe(1);

        const commitResponse = yield* send(
          runtime,
          yield* authorizedRequest(
            database,
            gateway,
            principal,
            '/commerce-customer-context/actions/reserve-market-retirement',
            commitPayload(reservation),
            randomUUID(),
          ),
        );
        expect(commitResponse.status).toBe(200);
        const committed = yield* jsonBody(commitResponse).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ReserveMarketRetirementResultSchema)),
        );
        expect(committed).toMatchObject({ lifecycle: 'COMMITTED', reservationVersion: 2 });

        const rows = yield* database.transaction((transaction) =>
          transaction.execute<ReservationRow>(
            sql`select assessment_digest, lifecycle, reservation_version, source_evidence
                  from commerce_customer_context.market_retirement_reservations
                 where tenant_id = ${fixture.tenantId}::uuid
                   and market_resource_id = ${marketId}`,
            'objects',
          ),
        );
        const row = one(rows, 'Market retirement reservation row');
        expect(row).toMatchObject({
          assessment_digest: verified.assessmentDigest,
          lifecycle: 'COMMITTED',
          reservation_version: 2,
        });
        expect(
          EffectArray.sort(
            row.source_evidence.map(({ sourceId }) => sourceId),
            Order.String,
          ),
        ).toEqual(
          EffectArray.sort(
            verified.sourceEvidence.map(({ sourceId }) => sourceId),
            Order.String,
          ),
        );
      }),
    ),
  30_000,
);

it.live(
  'fails production composition closed for missing, invalid, installed-owner, and expired evidence',
  () =>
    Effect.scoped(
      Effect.gen(function* failClosedComposition() {
        const connections = yield* loadDatabaseConnectionPair();
        const fixture = yield* makeLiveOperationFixture({
          actionKeys: [ACTION_KEY],
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
        });
        yield* Effect.addFinalizer(() => fixture.close().pipe(Effect.orDie));
        const { admin: adminClient } = yield* testDatabaseClients;
        const database = yield* makeTestDatabaseFromClient(adminClient, commerceCustomerContextRelations);
        yield* activateCustomerContext(database, fixture.tenantId);
        const cleanup = cleanupOwnerRows(database, fixture.tenantId);
        yield* cleanup();
        yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
        const spiceDb = yield* installAssessmentPermission({
          legalEntityId: fixture.legalEntityId,
          principalId: fixture.manager.principalId,
          tenantId: fixture.tenantId,
        });
        const clock = yield* readAcceptanceClock(database);
        const gateway = yield* makeAcceptanceGatewayIssuer(ISSUER, `${KEY_ID}-fail-closed`);
        const principal = {
          authBindingId: fixture.manager.authBindingId,
          legalEntityId: fixture.legalEntityId,
          principalId: fixture.manager.principalId,
          tenantId: fixture.tenantId,
        };
        const commonEnvironment = {
          DATABASE_URL: connections.runtime.connectionString,
          SPICEDB_ENDPOINT: spiceDb.endpoint,
          SPICEDB_INSECURE: String(spiceDb.insecureLocal),
          SPICEDB_PRESHARED_KEY: spiceDb.preSharedKey,
        };
        const cases = [
          { label: 'missing', status: 503 },
          { label: 'invalid', snapshot: '{"not":"a composition"}', status: 503 },
          { label: 'installed owner', snapshot: compositionSnapshot(clock, { installedOwner: true }), status: 503 },
          { label: 'expired', snapshot: compositionSnapshot(clock, { expired: true }), status: 200 },
        ] as const;
        for (const scenario of cases) {
          const environment =
            'snapshot' in scenario
              ? {
                  ...commonEnvironment,
                  ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON: scenario.snapshot,
                }
              : commonEnvironment;
          const runtime = yield* configuredRuntime(gateway, environment);
          const marketId = randomUUID();
          const marketRef = {
            moduleId: 'commerce.market-catalog',
            resourceId: marketId,
            resourceType: 'commerce.market-catalog.market',
            tenantId: fixture.tenantId,
          } as const;
          yield* fixture.grantResourceAccess(marketRef, fixture.manager.principalId, 'reader');
          const response = yield* send(
            runtime,
            yield* authorizedRequest(database, gateway, principal, '/reads/market-affected-use-assessment', {
              evaluatedAt: clock.evaluated_at,
              marketRef,
              marketRevision: 1,
              tenantId: fixture.tenantId,
            }),
          );
          expect(response.status, scenario.label).toBe(scenario.status);
          if (scenario.label === 'expired') {
            const assessment = yield* jsonBody(response).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(MarketAffectedUseAssessmentResponseSchema)),
            );
            expect(assessment.outcome).toBe('STALE');
            if (assessment.outcome === 'STALE') {
              expect(assessment.staleSourceIds).toEqual([
                'application-composition:commerce.cart:UNIMPLEMENTED',
                'application-composition:commerce.order:UNIMPLEMENTED',
              ]);
            }
          } else {
            expect(yield* Effect.promise(() => response.clone().json())).toMatchObject({
              retryable: true,
              status: 503,
              type: 'https://ontos.dev/problems/read-unavailable',
            });
          }
        }
      }),
    ),
  30_000,
);

it.live(
  'rejects a live bootstrap reference through the production HTTP reservation',
  () =>
    Effect.scoped(
      Effect.gen(function* liveReferenceRejection() {
        const connections = yield* loadDatabaseConnectionPair();
        const fixture = yield* makeLiveOperationFixture({
          actionKeys: [ACTION_KEY],
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
        });
        yield* Effect.addFinalizer(() => fixture.close().pipe(Effect.orDie));
        const { admin: adminClient } = yield* testDatabaseClients;
        const database = yield* makeTestDatabaseFromClient(adminClient, commerceCustomerContextRelations);
        yield* activateCustomerContext(database, fixture.tenantId);
        const cleanup = cleanupOwnerRows(database, fixture.tenantId);
        yield* cleanup();
        yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
        const spiceDb = yield* installAssessmentPermission({
          legalEntityId: fixture.legalEntityId,
          principalId: fixture.manager.principalId,
          tenantId: fixture.tenantId,
        });
        const clock = yield* readAcceptanceClock(database);
        const marketId = randomUUID();
        yield* seedBootstrapReference(database, {
          evaluatedAt: clock.evaluated_at,
          legalEntityId: fixture.legalEntityId,
          lifecycle: 'ACTIVE',
          marketId,
          principalId: fixture.manager.principalId,
          tenantId: fixture.tenantId,
        });
        const gateway = yield* makeAcceptanceGatewayIssuer(ISSUER, `${KEY_ID}-live-reference`);
        const runtime = yield* configuredRuntime(gateway, {
          DATABASE_URL: connections.runtime.connectionString,
          ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON: compositionSnapshot(clock),
          SPICEDB_ENDPOINT: spiceDb.endpoint,
          SPICEDB_INSECURE: String(spiceDb.insecureLocal),
          SPICEDB_PRESHARED_KEY: spiceDb.preSharedKey,
        });
        const marketRef = {
          moduleId: 'commerce.market-catalog',
          resourceId: marketId,
          resourceType: 'commerce.market-catalog.market',
          tenantId: fixture.tenantId,
        } as const;
        yield* fixture.grantResourceAccess(marketRef, fixture.manager.principalId, 'reader');
        const response = yield* send(
          runtime,
          yield* authorizedRequest(
            database,
            gateway,
            {
              authBindingId: fixture.manager.authBindingId,
              legalEntityId: fixture.legalEntityId,
              principalId: fixture.manager.principalId,
              tenantId: fixture.tenantId,
            },
            '/reads/market-affected-use-assessment',
            {
              evaluatedAt: clock.evaluated_at,
              marketRef,
              marketRevision: 1,
              tenantId: fixture.tenantId,
            },
          ),
        );
        expect(response.status).toBe(200);
        const assessment = yield* jsonBody(response).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(MarketAffectedUseAssessmentResponseSchema)),
        );
        expect(assessment.outcome, JSON.stringify(assessment)).toBe('VERIFIED');
        const verified = yield* assessment.outcome === 'VERIFIED'
          ? Effect.succeed(assessment)
          : Effect.die(`Expected VERIFIED assessment, received ${assessment.outcome}`);
        expect(verified.liveBlockingReferences.bootstrapDefaults).toHaveLength(1);
        const reserveResponse = yield* send(
          runtime,
          yield* authorizedRequest(
            database,
            gateway,
            {
              authBindingId: fixture.manager.authBindingId,
              legalEntityId: fixture.legalEntityId,
              principalId: fixture.manager.principalId,
              tenantId: fixture.tenantId,
            },
            '/commerce-customer-context/actions/reserve-market-retirement',
            reservePayload(verified),
            randomUUID(),
          ),
        );
        expect(reserveResponse.status).toBe(409);
        expect(
          yield* jsonBody(reserveResponse).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ReserveMarketRetirementConflictProblemSchema)),
          ),
        ).toMatchObject({ code: 'LIVE_REFERENCE_CONFLICT', status: 409 });
      }),
    ),
  30_000,
);
