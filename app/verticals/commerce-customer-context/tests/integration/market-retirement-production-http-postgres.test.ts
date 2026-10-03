import { createHash, randomUUID } from 'node:crypto';

import { v1 } from '@authzed/authzed-node';
import {
  ActiveApplicationCompositionSnapshotSchema,
  applicationCompositionContentRevision,
  buildApplicationCompositionCatalog,
  closeApplicationCompositionDurableAdmission,
  ContextAccessLive,
  DatabaseConfigLive,
  drainApplicationCompositionAuthority,
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  loadDatabaseConnectionPair,
  lockApplicationCompositionPublication,
  OntosModuleDeploymentContractSchema,
  publishApplicationCompositionAuthority,
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION, GATEWAY_ASSERTION_TTL_SECONDS } from '@app/shared-contracts';
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
import { eq, sql } from 'drizzle-orm';
import { Array as EffectArray, ConfigProvider, Effect, Layer, Order, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { expect, it } from 'effect-rstest';
import { SignJWT } from 'jose';

import { applicationCompositionAuthority, coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { loadSpiceDbConfig } from '../../../../packages/core-runtime/src/permissions/config.ts';
import { newSpiceDbGrpcClient } from '../../../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
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
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { makeAcceptanceGatewayIssuer } from '../support/enrollment-acceptance-identity-gateway-assertion.ts';
import type { AcceptanceGatewayIssuer } from '../support/enrollment-acceptance-identity-gateway-assertion.ts';
import { makeEnrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';
import { jsonBody } from '../support/response.ts';

const ORIGIN = 'http://commerce-customer-context.retirement.test';
const AUDIENCE = 'commerce-customer-context';
const ISSUER = 'http://market-retirement-owner-acceptance.test';
const KEY_ID = 'market-retirement-owner-acceptance';
const ACTION_KEY = 'commerce.customer-context.reserve-market-retirement';
const COMPOSITION_SOURCE_URL = 'https://composition.market-retirement-acceptance.test/active';

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

const compositionSnapshot = Effect.fnUntraced(function* compositionSnapshot(
  clock: AcceptanceClockRow,
  options: Readonly<{ readonly expired?: boolean; readonly installedOwner?: boolean }> = {},
) {
  const snapshot = yield* makeEnrollmentApplicationCompositionSnapshot(
    ultramodernApiMarker.buildMarker,
    options.installedOwner === true ? ['commerce-cart'] : [],
  );
  const cartContract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)(
    makeModuleContractFixture({
      appId: 'commerce-cart',
      buildMarker: ultramodernApiMarker.buildMarker,
      moduleId: 'commerce.cart',
    }),
  );
  const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
    cartContract,
  );
  const sha256 = createHash('sha256').update(contractDocument, 'utf-8').digest('hex');
  const composition = {
    ...snapshot.composition,
    modules: snapshot.composition.modules.map((module) =>
      module.deployment.appId === 'commerce-cart'
        ? {
            ...module,
            contract: { ...module.contract, sha256 },
            contractDocument,
            moduleId: cartContract.manifest.module.id,
            publicContract: { id: cartContract.manifest.module.id, sha256, version: cartContract.schemaVersion },
          }
        : module,
    ),
  };
  const expired = options.expired === true;
  const decodedSnapshot = yield* Schema.decodeUnknownEffect(ActiveApplicationCompositionSnapshotSchema)({
    composition: {
      ...composition,
      revision: yield* applicationCompositionContentRevision(composition),
    },
    observedAt: expired ? clock.expired_observed_at : clock.observed_at,
    validUntil: expired ? clock.expired_valid_until : clock.valid_until,
  });
  yield* buildApplicationCompositionCatalog(decodedSnapshot.composition).pipe(
    Effect.mapError((cause) => new Error(cause.reason, { cause })),
  );
  return decodedSnapshot;
});

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
  const configuration = yield* loadSpiceDbConfig({ envPath: '/dev/null' });
  const { caCertificate } = configuration;
  if (caCertificate === undefined) {
    return yield* Effect.die('SPICEDB_CA_CERT is required to reach SpiceDB over TLS');
  }
  const client = newSpiceDbGrpcClient(configuration);
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
  return { caCertificate, endpoint: configuration.endpoint, preSharedKey: configuration.preSharedKey };
});

const configuredRuntime = (
  gateway: AcceptanceGatewayIssuer,
  environment: Readonly<Record<string, string>>,
  snapshotDocument: string | null,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const configuration = {
        ...environment,
        ONTOS_GATEWAY_ISSUER: gateway.issuer,
        ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [gateway.publicJwk] }),
      };
      const sourceConfiguration =
        snapshotDocument === null
          ? configuration
          : { ...configuration, ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: COMPOSITION_SOURCE_URL };
      return makeCommerceCustomerContextApiRuntime(
        productionReadRuntimeLive,
        productionActionRuntimeLive,
        singleUseRedemptionLive,
        commercePortalAuthRealmUnavailableLive([ORIGIN]),
        Layer.mergeAll(
          ConfigProvider.layer(ConfigProvider.fromUnknown(sourceConfiguration)),
          Layer.succeed(FetchHttpClient.Fetch, async (input, init) => {
            const request = new Request(input, init);
            return request.url === COMPOSITION_SOURCE_URL
              ? new Response(snapshotDocument, { headers: { 'content-type': 'application/json' } })
              : await fetch(request);
          }),
        ),
        DatabaseConfigLive,
        ContextAccessLive,
      ).createHandler();
    }),
    (runtime) => Effect.promise(() => runtime.dispose()).pipe(Effect.orDie),
  );

type CommerceApiRuntime = Effect.Success<ReturnType<typeof configuredRuntime>>;

const send = (runtime: CommerceApiRuntime, request: Request) => Effect.promise(() => runtime.handler(request));

const authorizedRequest = Effect.fnUntraced(function* authorizedRequest(
  database: CommerceCustomerContextDatabase,
  gateway: AcceptanceGatewayIssuer,
  compositionRevision: string,
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
  const epochRows = yield* database.execute<{ readonly epoch: string }>(
    sql`select floor(extract(epoch from statement_timestamp()))::bigint::text as epoch`,
    'objects',
  );
  const issuedAt = Math.trunc(Number(one(epochRows, 'gateway deployment clock row').epoch));
  const gatewayPrincipal = {
    authBindingId: principal.authBindingId,
    authContextRef: `portal-session:${principal.authBindingId}`,
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'session',
    legalEntityId: principal.legalEntityId,
    principalId: principal.principalId,
    tenantId: principal.tenantId,
  };
  const assertion = yield* Effect.promise(
    async () =>
      await new SignJWT({
        compositionRevision,
        principal: gatewayPrincipal,
        targetBuildMarker: ultramodernApiMarker.buildMarker,
        ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: gateway.keyId, typ: 'JWT' })
        .setAudience(AUDIENCE)
        .setExpirationTime(issuedAt + GATEWAY_ASSERTION_TTL_SECONDS)
        .setIssuedAt(issuedAt)
        .setIssuer(gateway.issuer)
        .setJti(randomUUID())
        .setSubject(principal.principalId)
        .sign(gateway.privateKey),
  );
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
        const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
        const { admin: adminClient } = yield* testDatabaseClients;
        const database = yield* makeTestDatabaseFromClient(adminClient, commerceCustomerContextRelations);
        const coreDatabase = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
        const clock = yield* readAcceptanceClock(database);
        const snapshot = yield* compositionSnapshot(clock);
        yield* coreDatabase.transaction((transaction) =>
          Effect.gen(function* publishMarketComposition() {
            yield* lockApplicationCompositionPublication(transaction);
            const [predecessor] = yield* transaction
              .select({ revision: applicationCompositionAuthority.revision })
              .from(applicationCompositionAuthority)
              .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
            if (predecessor !== undefined && predecessor.revision !== snapshot.composition.revision) {
              yield* closeApplicationCompositionDurableAdmission(transaction, predecessor.revision);
              yield* drainApplicationCompositionAuthority(transaction, predecessor.revision);
            }
            yield* publishApplicationCompositionAuthority(transaction, snapshot);
          }),
        );
        const fixture = yield* makeLiveOperationFixture({
          actionKeys: [ACTION_KEY],
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: snapshot.composition.revision,
          runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
        });
        yield* Effect.addFinalizer(() => fixture.close().pipe(Effect.orDie));
        const cleanup = cleanupOwnerRows(database, fixture.tenantId);
        yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
        yield* cleanup();
        yield* activateCustomerContext(database, fixture.tenantId);
        const spiceDb = yield* installAssessmentPermission({
          legalEntityId: fixture.legalEntityId,
          principalId: fixture.manager.principalId,
          tenantId: fixture.tenantId,
        });
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
        const runtime = yield* configuredRuntime(
          gateway,
          {
            DATABASE_URL: connections.runtime.connectionString,
            SPICEDB_CA_CERT: spiceDb.caCertificate,
            SPICEDB_ENDPOINT: spiceDb.endpoint,
            SPICEDB_PRESHARED_KEY: spiceDb.preSharedKey,
          },
          yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(snapshot),
        );
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
          yield* authorizedRequest(
            database,
            gateway,
            snapshot.composition.revision,
            principal,
            '/reads/market-affected-use-assessment',
            {
              evaluatedAt: clock.evaluated_at,
              marketRef,
              marketRevision: 7,
              tenantId: fixture.tenantId,
            },
          ),
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
            snapshot.composition.revision,
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
            snapshot.composition.revision,
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
  'fails production composition closed for missing, invalid, installed-owner, and expired global evidence',
  () =>
    Effect.scoped(
      Effect.gen(function* failClosedComposition() {
        const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
        const { admin: adminClient } = yield* testDatabaseClients;
        const database = yield* makeTestDatabaseFromClient(adminClient, commerceCustomerContextRelations);
        const coreDatabase = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
        const clock = yield* readAcceptanceClock(database);
        const snapshot = yield* compositionSnapshot(clock);
        yield* coreDatabase.transaction((transaction) =>
          Effect.gen(function* publishMarketComposition() {
            yield* lockApplicationCompositionPublication(transaction);
            const [predecessor] = yield* transaction
              .select({ revision: applicationCompositionAuthority.revision })
              .from(applicationCompositionAuthority)
              .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
            if (predecessor !== undefined && predecessor.revision !== snapshot.composition.revision) {
              yield* closeApplicationCompositionDurableAdmission(transaction, predecessor.revision);
              yield* drainApplicationCompositionAuthority(transaction, predecessor.revision);
            }
            yield* publishApplicationCompositionAuthority(transaction, snapshot);
          }),
        );
        const fixture = yield* makeLiveOperationFixture({
          actionKeys: [ACTION_KEY],
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: snapshot.composition.revision,
          runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
        });
        yield* Effect.addFinalizer(() => fixture.close().pipe(Effect.orDie));
        const cleanup = cleanupOwnerRows(database, fixture.tenantId);
        yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
        yield* cleanup();
        yield* activateCustomerContext(database, fixture.tenantId);
        const spiceDb = yield* installAssessmentPermission({
          legalEntityId: fixture.legalEntityId,
          principalId: fixture.manager.principalId,
          tenantId: fixture.tenantId,
        });
        const gateway = yield* makeAcceptanceGatewayIssuer(ISSUER, `${KEY_ID}-fail-closed`);
        const principal = {
          authBindingId: fixture.manager.authBindingId,
          legalEntityId: fixture.legalEntityId,
          principalId: fixture.manager.principalId,
          tenantId: fixture.tenantId,
        };
        const commonEnvironment = {
          DATABASE_URL: connections.runtime.connectionString,
          SPICEDB_CA_CERT: spiceDb.caCertificate,
          SPICEDB_ENDPOINT: spiceDb.endpoint,
          SPICEDB_PRESHARED_KEY: spiceDb.preSharedKey,
        };
        const installedSnapshot = yield* compositionSnapshot(clock, { installedOwner: true });
        const expiredSnapshot = yield* compositionSnapshot(clock, { expired: true });
        const snapshotJson = Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema);
        const cases = [
          {
            authority: snapshot,
            label: 'missing',
            snapshotDocument: null,
            status: 503,
          },
          {
            authority: snapshot,
            label: 'invalid',
            snapshotDocument: '{"not":"a composition"}',
            status: 503,
          },
          {
            authority: installedSnapshot,
            label: 'installed owner',
            snapshotDocument: yield* Schema.encodeEffect(snapshotJson)(installedSnapshot),
            status: 503,
          },
          {
            authority: snapshot,
            label: 'expired global composition',
            snapshotDocument: yield* Schema.encodeEffect(snapshotJson)(expiredSnapshot),
            status: 503,
          },
        ] as const;
        let admittedRevision = snapshot.composition.revision;
        for (const scenario of cases) {
          if (admittedRevision !== scenario.authority.composition.revision) {
            const expectedRevision = admittedRevision;
            yield* coreDatabase.transaction((transaction) =>
              Effect.gen(function* publishCapturedOwnerCatalog() {
                yield* closeApplicationCompositionDurableAdmission(transaction, expectedRevision);
                yield* drainApplicationCompositionAuthority(transaction, expectedRevision);
                yield* publishApplicationCompositionAuthority(transaction, scenario.authority);
              }),
            );
            admittedRevision = scenario.authority.composition.revision;
          }
          const authorityRows = yield* coreDatabase.execute<{ readonly phase: string; readonly revision: string }>(
            sql`select phase, revision from core.application_composition_authority where authority_key = 'active'`,
            'objects',
          );
          expect(one(authorityRows, 'published composition authority'), scenario.label).toMatchObject({
            phase: 'active',
            revision: scenario.authority.composition.revision,
          });
          const runtime = yield* configuredRuntime(gateway, commonEnvironment, scenario.snapshotDocument);
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
            yield* authorizedRequest(
              database,
              gateway,
              scenario.authority.composition.revision,
              principal,
              '/reads/market-affected-use-assessment',
              {
                evaluatedAt: clock.evaluated_at,
                marketRef,
                marketRevision: 1,
                tenantId: fixture.tenantId,
              },
            ),
          );
          expect(response.status, scenario.label).toBe(scenario.status);
          expect(yield* Effect.promise(() => response.clone().json())).toMatchObject({
            retryable: true,
            status: 503,
            type: 'https://ontos.dev/problems/read-unavailable',
          });
          const reservations = yield* database.execute<{ readonly count: string }>(
            sql`select count(*)::text as count from commerce_customer_context.market_retirement_reservations
                where tenant_id = ${fixture.tenantId}::uuid`,
            'objects',
          );
          expect(one(reservations, 'native reservation count').count, scenario.label).toBe('0');
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
        const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
        const { admin: adminClient } = yield* testDatabaseClients;
        const database = yield* makeTestDatabaseFromClient(adminClient, commerceCustomerContextRelations);
        const coreDatabase = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
        const clock = yield* readAcceptanceClock(database);
        const snapshot = yield* compositionSnapshot(clock);
        yield* coreDatabase.transaction((transaction) =>
          Effect.gen(function* publishMarketComposition() {
            yield* lockApplicationCompositionPublication(transaction);
            const [predecessor] = yield* transaction
              .select({ revision: applicationCompositionAuthority.revision })
              .from(applicationCompositionAuthority)
              .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
            if (predecessor !== undefined && predecessor.revision !== snapshot.composition.revision) {
              yield* closeApplicationCompositionDurableAdmission(transaction, predecessor.revision);
              yield* drainApplicationCompositionAuthority(transaction, predecessor.revision);
            }
            yield* publishApplicationCompositionAuthority(transaction, snapshot);
          }),
        );
        const fixture = yield* makeLiveOperationFixture({
          actionKeys: [ACTION_KEY],
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: snapshot.composition.revision,
          runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
        });
        yield* Effect.addFinalizer(() => fixture.close().pipe(Effect.orDie));
        const cleanup = cleanupOwnerRows(database, fixture.tenantId);
        yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));
        yield* cleanup();
        yield* activateCustomerContext(database, fixture.tenantId);
        const spiceDb = yield* installAssessmentPermission({
          legalEntityId: fixture.legalEntityId,
          principalId: fixture.manager.principalId,
          tenantId: fixture.tenantId,
        });
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
        const runtime = yield* configuredRuntime(
          gateway,
          {
            DATABASE_URL: connections.runtime.connectionString,
            SPICEDB_CA_CERT: spiceDb.caCertificate,
            SPICEDB_ENDPOINT: spiceDb.endpoint,
            SPICEDB_PRESHARED_KEY: spiceDb.preSharedKey,
          },
          yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(snapshot),
        );
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
            snapshot.composition.revision,
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
            snapshot.composition.revision,
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
