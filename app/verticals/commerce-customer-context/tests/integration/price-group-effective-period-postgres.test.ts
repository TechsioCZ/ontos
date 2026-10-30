import {
  classifyPriceGroupReadDiagnostic,
  classifyPriceGroupReadResultDiagnostic,
  PriceGroupCatalogDatabaseCertificateSchema,
  projectPriceGroupCatalogDatabaseCertificate,
} from '../support/price-group-current-receiver.fixture.ts';
import { fileURLToPath } from 'node:url';
import { Reactivity } from 'effect/reactivity';
import {
  describePriceGroupTemporalOwner as describeOwner,
  openPriceGroupTemporalChannel,
  makePriceGroupTemporalComposition,
  preparePriceGroupTemporalRetailAccess,
  priceGroupTemporalSocketEnvironment,
  PriceGroupOwnedDatabaseCertificateSchema,
  PriceGroupTemporalBootstrapSchema,
  PriceGroupTemporalResponseSchema,
  guardPriceGroupOwnedDatabase,
  priceGroupTemporalClosedEnvironment,
  priceGroupTemporalProtocol,
  PriceGroupPreparedArtifactSchema,
  priceGroupPreparedArtifactMatches,
  guardPriceGroupPreparedArtifact,
  priceGroupDedicatedUrlMatches,
} from '../support/price-group-temporal-protocol.ts';

import type { TrustedPrincipalContextSchema } from '@app/core-runtime';
import {
  BusinessPermissionRelationshipMutation,
  BusinessPermissionRelationshipMutationLive,
  defineScopedRoutine,
  ReadResultValidationError,
  ReadEvidenceValidationError,
  ReadHandlerExecutionError,
  loadDatabaseConfig,
  PARTY_REGISTRY_REQUEST_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from '@app/core-runtime';
import {
  STAFF_AUTHENTICATION_NAMESPACE_ID,
  staffAuthenticationNamespaceRegistryLayer,
} from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { PriceGroupCreatedResultSchema } from '@app/price-group-catalog-contracts/price-group';
import {
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
  decodeSupportedGatewayContextClaims,
  SupportedGatewayContextClaimsSchema,
} from '@app/shared-contracts';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import {
  Cause,
  Clock,
  Config,
  Context,
  Crypto,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Result,
  Schema,
  SchemaIssue,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/process';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { executeEnsureRetailCustomerProfileWithAuthorization } from '../../src/api/ensure-retail-customer-profile-action-client.ts';
import { executeCreateCounterpartyPurchasingProfileWithAuthorization } from '../../src/api/create-counterparty-purchasing-profile-action-client.ts';
import { executeAssignCustomerPriceGroupWithAuthorization } from '../../src/api/assign-customer-price-group-action-client.ts';
import { executeAssignCounterpartyPriceGroupWithAuthorization } from '../../src/api/assign-counterparty-price-group-action-client.ts';
import { executeRemoveCustomerPriceGroupWithAuthorization } from '../../src/api/remove-customer-price-group-action-client.ts';
import { executeRemoveCounterpartyPriceGroupWithAuthorization } from '../../src/api/remove-counterparty-price-group-action-client.ts';
import { executeCustomerPriceGroupResolutionWithAuthorization } from '../../src/api/customer-price-group-resolution-client.ts';
import { executeCustomerPriceGroupAssignmentReadWithAuthorization } from '../../src/api/customer-price-group-assignment-read-client.ts';
import {
  AssignCustomerPriceGroupActionConflictProblemSchema,
  AssignCustomerPriceGroupActionIneligibleProblemSchema,
  AssignCustomerPriceGroupActionNotFoundProblemSchema,
  AssignCustomerPriceGroupActionUnavailableProblemSchema,
} from '../../shared/apis/assign-customer-price-group-action.ts';
import {
  AssignCounterpartyPriceGroupActionForbiddenProblemSchema,
  AssignCounterpartyPriceGroupActionNotFoundProblemSchema,
} from '../../shared/apis/assign-counterparty-price-group-action.ts';
import {
  CustomerPriceGroupResolutionCurrentnessEvidenceSchema,
  CustomerPriceGroupResolutionForbiddenProblemSchema,
  CustomerPriceGroupResolutionUnavailableProblemSchema,
} from '../../shared/apis/customer-price-group-resolution.ts';
import {
  RemoveCustomerPriceGroupActionConflictProblemSchema,
  RemoveCustomerPriceGroupActionAlreadyCommittedProblemSchema,
} from '../../shared/apis/remove-customer-price-group-action.ts';
import type {
  CommerceCustomerProfileTargetSchema,
  PriceGroupAuthorizationSubjectSchema,
} from '../../shared/domain/price-group-contracts.ts';
import {
  CustomerPriceGroupAssignedAuditEvidenceSchema,
  CustomerPriceGroupResolutionSchema,
} from '../../shared/domain/price-group-contracts.ts';

const ChildDiagnosticStageSchema = Schema.Literals([
  'C_SOCKET_CONNECTED',
  'C_BOOTSTRAP_VALID',
  'C_CCC_MIGRATION_BEGIN',
  'C_CCC_MIGRATION_DONE',
  'C_PARTY_MIGRATION_BEGIN',
  'C_PARTY_MIGRATION_DONE',
  'C_SCHEMAS_READY_SENT',
  'C_IDENTITIES_READY_RECEIVED',
  'C_AUTHORITY_READY',
  'C_PARTY_ARTIFACT_VERIFIED',
  'C_PARTY_HTTP_READY',
  'C_CATALOG_ARTIFACT_VERIFY_BEGIN',
  'C_CATALOG_ARTIFACT_VERIFIED',
  'C_CATALOG_CHANNEL_READY',
  'C_CATALOG_SPAWNED',
  'C_CATALOG_BOOTSTRAP_SEND_BEGIN',
  'C_CATALOG_BOOTSTRAP_SEND_DONE',
  'C_CATALOG_BOOTED_RECEIVED',
  'C_CATALOG_EXITED_ZERO',
  'C_CATALOG_EXITED_NONZERO',
  'C_CATALOG_HTTP_READY',
  'C_COMMERCE_READY',
  'C_BOOTED_SENT',
  'READ_RESULT_INVALID',
  'READ_EVIDENCE_INVALID',
  'READ_HANDLER_FAILED',
  'READ_OTHER_TYPED',
  'READ_DEFECT',
  'READ_RESULT_TIMESTAMP_SHAPE',
  'READ_RESULT_CURRENTNESS_TIMELINE',
  'READ_RESULT_PREDICATE_BINDING',
  'READ_RESULT_ENVELOPE_TIMES',
  'READ_RESULT_GENERATION_REVISION',
  'READ_RESULT_NEXT_BOUNDARY',
  'READ_RESULT_RESOLUTION_SHAPE',
  'READ_RESULT_UNCLASSIFIED',
]);
const ParentDiagnosticStageSchema = Schema.Literals([
  'P_OPEN_FINITE_NONE_BEGIN',
  'P_OPEN_FINITE_NONE_DONE',
  'P_SAME_START_CANCELLATION_NONE_BEGIN',
  'P_SAME_START_CANCELLATION_NONE_DONE',
  'P_CANCELLATION_NONE_BEGIN',
  'P_CANCELLATION_NONE_DONE',
  'P_BEGIN',
  'P_DESCRIPTIONS_DONE',
  'P_CORE_SCHEMA_DONE',
  'P_COMPOSITION_DONE',
  'P_FIXTURE_DONE',
  'P_RECEIVER_SPAWNED',
  'P_BOOTSTRAP_SENT',
  'P_SCHEMAS_READY',
  'P_IDENTITY_GUARDS_DONE',
  'P_IDENTITIES_READY_SENT',
  'P_BOOTED_RECEIVED',
  'IDENTITY_PASS_1_SPAWNED',
  'IDENTITY_PASS_1_STATUS_VALID',
  'IDENTITY_PASS_1_EXITED',
  'IDENTITY_PASS_1_STDOUT_CLOSED',
  'IDENTITY_PASS_1_STDERR_CLOSED',
  'IDENTITY_PASS_2_SPAWNED',
  'IDENTITY_PASS_2_STATUS_VALID',
  'IDENTITY_PASS_2_EXITED',
  'IDENTITY_PASS_2_STDOUT_CLOSED',
  'IDENTITY_PASS_2_STDERR_CLOSED',
]);
const diagnosticStage = Effect.fn('TemporalNative.parentDiagnosticStage')(function* parentDiagnosticStage(
  stage: typeof ParentDiagnosticStageSchema.Type | typeof ChildDiagnosticStageSchema.Type,
) {
  const parentClock = yield* Clock.Clock;
  const atMs = yield* parentClock.currentTimeMillis;
  yield* Effect.sync(() => {
    process.stdout.write(`PG1248:${stage}:at_ms=${atMs}\n`);
  });
});
const decodeChildDiagnosticStage = Schema.decodeUnknownOption(ChildDiagnosticStageSchema);

it.effect('forwards only exact fixed Price Group child diagnostic stages', () =>
  Effect.sync(() => {
    expect(Option.getOrUndefined(decodeChildDiagnosticStage('C_PARTY_HTTP_READY'))).toBe('C_PARTY_HTTP_READY');
    expect(Option.getOrUndefined(decodeChildDiagnosticStage('C_CATALOG_BOOTSTRAP_SEND_DONE'))).toBe(
      'C_CATALOG_BOOTSTRAP_SEND_DONE',
    );
    for (const line of [
      'C_PARTY_HTTP_READY extra',
      'C_CATALOG_SPAWNED:at_ms=123',
      ' C_PARTY_HTTP_READY',
      'C_PARTY_HTTP_READY\r',
      'P_BEGIN',
      'Bearer fixture-only',
      '{"stage":"C_PARTY_HTTP_READY"}',
      'arbitrary child output',
    ]) {
      expect(Option.isNone(decodeChildDiagnosticStage(line))).toBe(true);
    }
  }),
);

it.effect('classifies Price Group Read failures with only closed diagnostic stages', () =>
  Effect.sync(() => {
    const failures = [
      new ReadResultValidationError({ code: 'read_result_invalid', reason: 'fixture-only' }),
      new ReadEvidenceValidationError({ code: 'read_evidence_invalid', reason: 'fixture-only' }),
      new ReadHandlerExecutionError({ code: 'read_handler_execution_failed', reason: 'fixture-only' }),
    ];
    const expected = ['READ_RESULT_INVALID', 'READ_EVIDENCE_INVALID', 'READ_HANDLER_FAILED'];
    for (const [index, failure] of failures.entries()) {
      const stage = classifyPriceGroupReadDiagnostic(Cause.fail(failure));
      expect(stage).toBe(expected[index]);
      expect(Option.getOrUndefined(decodeChildDiagnosticStage(stage))).toBe(stage);
    }
    expect(classifyPriceGroupReadDiagnostic(Cause.fail({ reason: 'private fixture-only value' }))).toBe(
      'READ_OTHER_TYPED',
    );
    expect(classifyPriceGroupReadDiagnostic(Cause.die(new Error('private fixture-only defect')))).toBe('READ_DEFECT');
    expect(classifyPriceGroupReadDiagnostic(Cause.combine(Cause.fail(failures[0]), Cause.die('fixture-only')))).toBe(
      'READ_DEFECT',
    );
    for (const stage of ['READ_OTHER_TYPED', 'READ_DEFECT']) {
      expect(Option.getOrUndefined(decodeChildDiagnosticStage(stage))).toBe(stage);
    }
    for (const line of ['READ_DEFECT private', 'READ_UNKNOWN', 'READ_RESULT_INVALID\n', 'P_OPEN_FINITE_NONE_BEGIN']) {
      expect(Option.isNone(decodeChildDiagnosticStage(line))).toBe(true);
    }
  }),
);

const preservedReadResultFailure = (issue: SchemaIssue.Issue) =>
  Object.defineProperty(
    new ReadResultValidationError({ code: 'read_result_invalid', reason: 'fixture-only' }),
    'cause',
    { value: new Schema.SchemaError(issue) },
  );

it.effect('classifies only whitelisted Price Group result fields and predicates', () =>
  Effect.sync(() => {
    const cases = [
      {
        flag: 'READ_RESULT_TIMESTAMP_SHAPE',
        message: 'timestamp must be one canonical UTC instant with millisecond precision',
        path: ['observedAt'],
      },
      {
        flag: 'READ_RESULT_CURRENTNESS_TIMELINE',
        message: 'Customer Price Group Current-set evidence must be observed and revalidated after evaluation',
        path: ['currentnessEvidence'],
      },
      {
        flag: 'READ_RESULT_PREDICATE_BINDING',
        message: 'Customer Price Group owner evidence must bind the exact Profile and evaluation instant',
        path: [],
      },
      {
        flag: 'READ_RESULT_ENVELOPE_TIMES',
        message: 'Customer Price Group owner evidence must preserve one evaluation and observation timeline',
        path: [],
      },
      {
        flag: 'READ_RESULT_GENERATION_REVISION',
        message: 'Customer Price Group owner evidence must bind one generation and owner Revision',
        path: [],
      },
      {
        flag: 'READ_RESULT_NEXT_BOUNDARY',
        message: 'Customer Price Group verification must precede the next applicability boundary',
        path: [],
      },
    ];
    for (const entry of cases) {
      const leaf = new SchemaIssue.InvalidValue({ message: entry.message });
      const failure = preservedReadResultFailure(new SchemaIssue.Pointer(entry.path, leaf));
      const originalCause = 'cause' in failure ? failure.cause : undefined;
      expect(classifyPriceGroupReadResultDiagnostic(failure)).toEqual([entry.flag]);
      expect('cause' in failure ? failure.cause : undefined).toBe(originalCause);
      expect(Option.getOrUndefined(decodeChildDiagnosticStage(entry.flag))).toBe(entry.flag);
      expect(Option.isNone(decodeChildDiagnosticStage(`${entry.flag} private`))).toBe(true);
    }
    const timelineError = Schema.decodeUnknownExit(
      Schema.toType(CustomerPriceGroupResolutionCurrentnessEvidenceSchema),
    )({
      evaluatedAt: '2026-10-27T00:00:02.000Z',
      generation: 'fixture-generation',
      observedAt: '2026-10-27T00:00:01.000Z',
      ownerRevision: 'fixture-revision',
      predicateRef: 'fixture-predicate',
      revalidatedAt: '2026-10-27T00:00:01.000Z',
      verificationMode: 'OWNER_CURRENT_SET_REVALIDATED',
    });
    if (Exit.isSuccess(timelineError)) {
      throw new Error('Expected invalid pure currentness fixture');
    }
    for (const reason of timelineError.cause.reasons) {
      if (Cause.isFailReason(reason)) {
        expect(
          classifyPriceGroupReadResultDiagnostic(
            preservedReadResultFailure(new SchemaIssue.Pointer(['currentnessEvidence'], reason.error.issue)),
          ),
        ).toContain('READ_RESULT_CURRENTNESS_TIMELINE');
      }
    }
    const resolutionError = Schema.decodeUnknownExit(CustomerPriceGroupResolutionSchema)({ _tag: 'PRIVATE_UNKNOWN' });
    if (Exit.isSuccess(resolutionError)) {
      throw new Error('Expected invalid pure resolution fixture');
    }
    for (const reason of resolutionError.cause.reasons) {
      if (Cause.isFailReason(reason)) {
        expect(
          classifyPriceGroupReadResultDiagnostic(
            preservedReadResultFailure(new SchemaIssue.Pointer(['resolution'], reason.error.issue)),
          ),
        ).toContain('READ_RESULT_RESOLUTION_SHAPE');
      }
    }
    for (const issue of [
      new SchemaIssue.Pointer(['foreign'], new SchemaIssue.InvalidValue({ message: cases[0]?.message })),
      new SchemaIssue.Pointer(['observedAt'], new SchemaIssue.InvalidValue({ message: 'private unknown predicate' })),
      new SchemaIssue.Pointer(['foreign'], new SchemaIssue.InvalidValue({ message: cases[1]?.message })),
    ]) {
      expect(classifyPriceGroupReadResultDiagnostic(preservedReadResultFailure(issue))).toEqual([
        'READ_RESULT_UNCLASSIFIED',
      ]);
    }
    expect(
      classifyPriceGroupReadResultDiagnostic(
        Object.assign(new ReadResultValidationError({ code: 'read_result_invalid', reason: 'fixture-only' }), {
          cause: { issue: new SchemaIssue.InvalidValue() },
        }),
      ),
    ).toEqual(['READ_RESULT_UNCLASSIFIED']);
    expect(
      classifyPriceGroupReadResultDiagnostic(
        new ReadResultValidationError({ code: 'read_result_invalid', reason: 'fixture-only' }),
      ),
    ).toEqual(['READ_RESULT_UNCLASSIFIED']);
    expect(Option.getOrUndefined(decodeChildDiagnosticStage('READ_RESULT_UNCLASSIFIED'))).toBe(
      'READ_RESULT_UNCLASSIFIED',
    );
  }),
);

it.effect('projects the exact strict Catalog certificate without creator-only fields', () =>
  Effect.sync(() => {
    const name = `ontos_test_party_gateway_${'1'.repeat(32)}`;
    const expanded = {
      adminRole: 'postgres',
      adminUrl: `postgresql://postgres@localhost:5432/${name}`,
      creatorPid: 1,
      name,
      oid: 1,
      owner: 'postgres',
      runtimeRole: 'ontos_runtime',
      runtimeUrl: `postgresql://ontos_runtime@localhost:5432/${name}`,
      serverAddress: '127.0.0.1',
      serverPort: 5432,
      systemIdentifier: '123',
    };
    const projected = projectPriceGroupCatalogDatabaseCertificate(expanded);
    expect(Object.keys(projected)).toEqual([
      'adminRole',
      'adminUrl',
      'name',
      'oid',
      'owner',
      'runtimeRole',
      'runtimeUrl',
      'serverAddress',
      'serverPort',
    ]);
    const decode = Schema.decodeUnknownOption(PriceGroupCatalogDatabaseCertificateSchema, {
      onExcessProperty: 'error',
    });
    expect(Option.isSome(decode(projected))).toBe(true);
    expect(Option.isNone(decode(expanded))).toBe(true);
    expect(Option.isNone(decode({ ...projected, creatorPid: 1 }))).toBe(true);
    expect(Option.isNone(decode({ ...projected, systemIdentifier: '123' }))).toBe(true);
    const { creatorPid: _creatorPid, systemIdentifier: _systemIdentifier, ...catalogFields } = expanded;
    expect(projected).toEqual(catalogFields);
  }),
);

it.effect('rejects changed prepared artifact owner build path and hash observations', () =>
  Effect.sync(() => {
    const artifact = Schema.decodeUnknownSync(PriceGroupPreparedArtifactSchema)({
      appId: 'party-registry',
      artifact: '/fixture/party/.cache/ontos-1248/11111111-1111-1111-1111-111111111111.mjs',
      buildMarker: 'party-build',
      description: '{"appId":"party-registry","buildMarker":"party-build"}',
      directory: '/fixture/party',
      sha256: '1'.repeat(64),
    });
    expect(priceGroupPreparedArtifactMatches(artifact, artifact)).toBe(true);
    for (const changed of [
      { ...artifact, appId: 'price-group-catalog' as const },
      { ...artifact, buildMarker: 'other-build' },
      { ...artifact, artifact: '/foreign/owner.mjs' },
      { ...artifact, directory: '/foreign' },
      { ...artifact, sha256: '2'.repeat(64) },
    ]) {
      expect(priceGroupPreparedArtifactMatches(artifact, changed)).toBe(false);
    }
  }),
);

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const services = NodeServices.layer.pipe(
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
class TemporalNativeFailure extends Schema.TaggedError<TemporalNativeFailure>()('TemporalNativeFailure', {
  stage: Schema.String,
}) {}
const fail = (stage: string) => new TemporalNativeFailure({ stage });
const requireCondition = (condition: boolean, stage: string) => (condition ? Effect.void : Effect.fail(fail(stage)));
const MarkerSchema = Schema.Struct({
  appId: Schema.Literals(['commerce-customer-context', 'party-registry', 'price-group-catalog']),
  buildMarker: Schema.String,
});
const ActionKeySchema = Schema.String.pipe(Schema.brand('TemporalNativeActionKey'), Schema.decodeTo(Schema.String));
const DescriptionSchema = Schema.Struct({ ...MarkerSchema.fields, actionKeys: Schema.Array(ActionKeySchema) });
// Permission setup uses the same real scoped owner routines as existing native entitlement tests.
// These rows are authorization preconditions; every PriceGroup assignment remains a public Action.
const beginOwnerGrant = defineScopedRoutine({
  name: 'begin_access_grant',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'boolean' },
  ],
  resultSchema: Schema.Struct({ grant_id: Schema.String, mutation_id: Schema.String }),
  routineKey: 'test.price-group-period.begin-owner-access',
  schema: 'commerce_customer_context',
});
const activateOwnerGrant = defineScopedRoutine({
  name: 'transition_access_grant',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: Schema.Struct({ state: Schema.String }),
  routineKey: 'test.price-group-period.activate-owner-access',
  schema: 'commerce_customer_context',
});
const PublicKeySchema = Schema.Struct({ crv: Schema.Literal('Ed25519'), kty: Schema.Literal('OKP'), x: Schema.String });
const PublicKeysSchema = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      ...PublicKeySchema.fields,
      alg: Schema.Literal('EdDSA'),
      kid: Schema.String,
      use: Schema.Literal('sig'),
    }),
  ),
});

const digest = Effect.fn('TemporalNative.digest')(function* digest(document: string) {
  const crypto = yield* Crypto.Crypto;
  return Buffer.from(yield* crypto.digest('SHA-256', new TextEncoder().encode(document))).toString('hex');
});

const captureOwnedCertificate = Effect.fn('TemporalNative.captureOwnedCertificate')(function* captureOwnedCertificate(
  isolated: Effect.Success<ReturnType<typeof makeIsolatedNativeDatabaseFixture>>,
) {
  const { admin, runtime } = isolated.connections;
  yield* requireCondition(
    /^ontos_test_party_gateway_[a-f0-9]{32}$/u.test(admin.database) &&
      admin.database === runtime.database &&
      admin.host === runtime.host &&
      admin.port === runtime.port &&
      ['localhost', '127.0.0.1'].includes(admin.host) &&
      admin.user !== runtime.user,
    'core-owned-address',
  );
  const context = yield* Layer.build(PgClient.layer({ maxConnections: 1, url: Redacted.make(admin.connectionString) }));
  const client = Context.get(context, PgClient.PgClient);
  const [actual] = yield* client<{
    database_name: string;
    database_oid: number;
    database_owner: string;
    effective_role: string;
    server_address: string;
    server_port: number;
    session_role: string;
    system_identifier: string;
  }>`select (pg_control_system()).system_identifier::text as system_identifier, current_database() as database_name, d.oid::int as database_oid, pg_get_userbyid(d.datdba) as database_owner,
      inet_server_addr()::text as server_address, inet_server_port() as server_port,
      session_user::text as session_role, current_user::text as effective_role from pg_database d where d.datname=current_database()`;
  yield* requireCondition(
    actual !== undefined &&
      actual.database_name === admin.database &&
      actual.database_owner === admin.user &&
      actual.session_role === admin.user &&
      actual.effective_role === admin.user,
    'core-owned-identity',
  );
  if (actual === undefined) {
    return yield* fail('core-owned-identity');
  }
  const certificate = yield* Schema.decodeUnknownEffect(PriceGroupOwnedDatabaseCertificateSchema)({
    adminRole: admin.user,
    adminUrl: admin.connectionString,
    creatorPid: process.pid,
    name: admin.database,
    oid: actual.database_oid,
    owner: actual.database_owner,
    runtimeRole: runtime.user,
    runtimeUrl: runtime.connectionString,
    serverAddress: actual.server_address,
    serverPort: actual.server_port,
    systemIdentifier: actual.system_identifier,
  });
  // Recheck both actual credentials, roles, server identity, OID and runtime RLS attributes before any receiving child.
  yield* guardPriceGroupOwnedDatabase(certificate);
  return { certificate, client };
});

it.effect('rejects a foreign Price Group dedicated database URL or role without fallback', () =>
  Effect.sync(() => {
    const name = `ontos_test_party_gateway_${'1'.repeat(32)}`;
    const certificate = Schema.decodeUnknownSync(PriceGroupOwnedDatabaseCertificateSchema)({
      adminRole: 'postgres',
      adminUrl: `postgresql://postgres@localhost:5432/${name}`,
      creatorPid: 1,
      name,
      oid: 1,
      owner: 'postgres',
      runtimeRole: 'ontos_runtime',
      runtimeUrl: `postgresql://ontos_runtime@localhost:5432/${name}`,
      serverAddress: '127.0.0.1',
      serverPort: 5432,
      systemIdentifier: '123',
    });
    const party = `postgresql://party_registry_runtime@localhost:5432/${name}`;
    const issuer = `postgresql://shell_gateway_issuer@localhost:5432/${name}`;
    expect(priceGroupDedicatedUrlMatches(party, certificate, 'party_registry_runtime')).toBe(true);
    expect(priceGroupDedicatedUrlMatches(issuer, certificate, 'shell_gateway_issuer')).toBe(true);
    for (const address of [
      party.replace(name, 'foreign_database'),
      party.replace('localhost', 'remote.invalid'),
      party.replace(':5432', ':5433'),
      party.replace('party_registry_runtime', 'ontos_runtime'),
      party.replace('postgresql:', 'https:'),
      `${party}?role=party_registry_runtime`,
      `${party}#scope`,
      'invalid',
      party.replace('party_registry_runtime', '%ZZ'),
    ]) {
      expect(priceGroupDedicatedUrlMatches(address, certificate, 'party_registry_runtime')).toBe(false);
    }
    expect(priceGroupDedicatedUrlMatches(party, certificate, 'shell_gateway_issuer')).toBe(false);
    expect(priceGroupDedicatedUrlMatches(issuer, certificate, 'party_registry_runtime')).toBe(false);
  }),
);

const makeAuthority = Effect.fn('TemporalNative.makeAuthority')(function* makeAuthority(
  actor: typeof TrustedPrincipalContextSchema.Type,
  compositionRevision: string,
  buildMarker: string,
  nativeClock: Clock.Clock,
) {
  const generated = yield* Effect.tryPromise({
    catch: () => fail('issuer-key'),
    try: async () => {
      const keys = await globalThis.crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
      if (!('privateKey' in keys)) {
        throw new Error('Ed25519 key pair required');
      }
      return keys;
    },
  });
  const kid = yield* nextId;
  const exported = yield* Effect.tryPromise({
    catch: () => fail('issuer-public-key'),
    try: async () => await globalThis.crypto.subtle.exportKey('jwk', generated.publicKey),
  });
  const publicKey = yield* Schema.decodeUnknownEffect(PublicKeySchema)(exported);
  const issuer = 'https://temporal-price-group-parent.test';
  const jwks = yield* Schema.encodeEffect(Schema.fromJsonString(PublicKeysSchema))({
    keys: [{ ...publicKey, alg: 'EdDSA', kid, use: 'sig' }],
  });
  const issue = (subject = actor) =>
    Effect.gen(function* issueAssertion() {
      const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
      const header = Buffer.from(
        yield* Schema.encodeEffect(
          Schema.fromJsonString(
            Schema.Struct({ alg: Schema.Literal('EdDSA'), kid: Schema.String, typ: Schema.Literal('JWT') }),
          ),
        )({ alg: 'EdDSA', kid, typ: 'JWT' }),
      ).toString('base64url');
      const claims = yield* decodeSupportedGatewayContextClaims({
        aud: 'commerce-customer-context',
        compositionRevision,
        exp: now + GATEWAY_ASSERTION_TTL_SECONDS,
        iat: now,
        iss: issuer,
        jti: yield* nextId,
        principal: subject,
        sub: subject.principalId,
        targetBuildMarker: buildMarker,
        ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
      });
      const payload = Buffer.from(
        yield* Schema.encodeEffect(Schema.fromJsonString(SupportedGatewayContextClaimsSchema))(claims),
      ).toString('base64url');
      const content = `${header}.${payload}`;
      const signature = yield* Effect.tryPromise({
        catch: () => fail('issuer-signature'),
        try: async () =>
          await globalThis.crypto.subtle.sign('Ed25519', generated.privateKey, new TextEncoder().encode(content)),
      });
      return `Bearer ${content}.${Buffer.from(signature).toString('base64url')}`;
    }).pipe(Effect.provideService(Clock.Clock, nativeClock));
  return { issue, issuer, jwks };
});
const prepareDedicatedIdentities = Effect.fn('TemporalNative.prepareDedicatedIdentities')(
  function* prepareDedicatedIdentities(bootstrap: typeof PriceGroupTemporalBootstrapSchema.Type) {
    yield* requireCondition(bootstrap.database.creatorPid === process.pid, 'identity-setup-creator');
    const pair = yield* guardPriceGroupOwnedDatabase(bootstrap.database);
    yield* requireCondition(
      priceGroupDedicatedUrlMatches(
        Redacted.value(bootstrap.identities.partyUrl),
        bootstrap.database,
        'party_registry_runtime',
      ) &&
        priceGroupDedicatedUrlMatches(
          Redacted.value(bootstrap.identities.issuerUrl),
          bootstrap.database,
          'shell_gateway_issuer',
        ),
      'identity-setup-address',
    );
    const admin = Context.get(
      yield* Layer.build(PgClient.layer({ maxConnections: 1, url: Redacted.make(pair.admin.connectionString) })),
      PgClient.PgClient,
    );
    const [physical] = yield* admin<{ ready: boolean; system_identifier: string }>`select
    (pg_control_system()).system_identifier::text as system_identifier,
    has_schema_privilege('party_registry_runtime','party','USAGE') and
    has_function_privilege('shell_gateway_issuer','trust.register_gateway_scope_grant(text,text,uuid,uuid,uuid,uuid,timestamptz)','EXECUTE') as ready`;
    yield* requireCondition(
      physical?.system_identifier === bootstrap.database.systemIdentifier,
      'identity-setup-system',
    );
    const request = yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          creatorPid: Schema.Int,
          databaseName: Schema.String,
          databaseOid: Schema.String,
          systemIdentifier: Schema.String,
          type: Schema.Literal('prepare-privacy-native-identities'),
        }),
      ),
    )({
      creatorPid: process.pid,
      databaseName: bootstrap.database.name,
      databaseOid: String(bootstrap.database.oid),
      systemIdentifier: bootstrap.database.systemIdentifier,
      type: 'prepare-privacy-native-identities',
    });
    yield* diagnosticStage('P_IDENTITY_GUARDS_DONE');
    // This process created the still-live clone. Both calls run after the child has rebuilt schemas;
    // the unchanged setup CLI independently checks creator PID, actual OID/system and canonical ACLs.
    for (const _pass of [0, 1]) {
      const setup = yield* ChildProcess.make(
        process.execPath,
        [
          fileURLToPath(
            new URL('../../../../scripts/integration/support/privacy-native-database-identities.mts', import.meta.url),
          ),
          request,
        ],
        {
          cwd: process.cwd(),
          env: {
            APP_ENV_PATH: '/dev/null',
            DATABASE_ADMIN_URL: Redacted.value(bootstrap.database.adminUrl),
            DATABASE_URL: Redacted.value(bootstrap.database.runtimeUrl),
            PARTY_REGISTRY_DATABASE_URL: Redacted.value(bootstrap.identities.partyUrl),
            SHELL_GATEWAY_ISSUER_DATABASE_URL: Redacted.value(bootstrap.identities.issuerUrl),
          },
          extendEnv: false,
          stderr: 'pipe',
          stdin: 'ignore',
          stdout: 'pipe',
        },
      );
      yield* diagnosticStage(_pass === 0 ? 'IDENTITY_PASS_1_SPAWNED' : 'IDENTITY_PASS_2_SPAWNED');
      // Observe only the exact already-required receipt; never relay setup output or diagnostics.
      let statusBuffer = '';
      let statusReported = false;
      const decodeStatus = Schema.decodeUnknownOption(
        Schema.fromJsonString(
          Schema.Struct({
            databaseName: Schema.String,
            databaseOid: Schema.String,
            systemIdentifier: Schema.String,
            type: Schema.Literal('privacy-native-identities-prepared'),
          }),
        ),
      );
      const observeStatus = (chunk: string) =>
        Effect.gen(function* observeIdentityStatus() {
          if (statusReported || statusBuffer.length > 4096) {
            return;
          }
          statusBuffer += chunk;
          const candidate = decodeStatus(statusBuffer.trim());
          if (
            Option.isSome(candidate) &&
            candidate.value.databaseName === bootstrap.database.name &&
            candidate.value.databaseOid === String(bootstrap.database.oid) &&
            candidate.value.systemIdentifier === bootstrap.database.systemIdentifier
          ) {
            statusReported = true;
            yield* diagnosticStage(_pass === 0 ? 'IDENTITY_PASS_1_STATUS_VALID' : 'IDENTITY_PASS_2_STATUS_VALID');
          }
        });
      const [exit, chunks] = yield* Effect.all(
        [
          setup.exitCode.pipe(
            Effect.tap(() => diagnosticStage(_pass === 0 ? 'IDENTITY_PASS_1_EXITED' : 'IDENTITY_PASS_2_EXITED')),
          ),
          Stream.runCollect(Stream.decodeText(setup.stdout).pipe(Stream.tap(observeStatus))).pipe(
            Effect.tap(() =>
              diagnosticStage(_pass === 0 ? 'IDENTITY_PASS_1_STDOUT_CLOSED' : 'IDENTITY_PASS_2_STDOUT_CLOSED'),
            ),
          ),
          Stream.runDrain(setup.stderr).pipe(
            Effect.tap(() =>
              diagnosticStage(_pass === 0 ? 'IDENTITY_PASS_1_STDERR_CLOSED' : 'IDENTITY_PASS_2_STDERR_CLOSED'),
            ),
          ),
        ],
        { concurrency: 3 },
      );
      yield* requireCondition(exit === 0, 'dedicated-identity-setup');
      const status = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            databaseName: Schema.String,
            databaseOid: Schema.String,
            systemIdentifier: Schema.String,
            type: Schema.Literal('privacy-native-identities-prepared'),
          }),
        ),
      )(chunks.join('').trim());
      yield* requireCondition(
        status.databaseName === bootstrap.database.name &&
          status.databaseOid === String(bootstrap.database.oid) &&
          status.systemIdentifier === bootstrap.database.systemIdentifier,
        'dedicated-identity-receipt',
      );
    }
    return physical?.ready ? ('existing' as const) : ('fresh' as const);
  },
);

const startReceiver = Effect.fn('TemporalNative.startReceiver')(function* startReceiver(
  bundle: Effect.Success<ReturnType<typeof describeOwner>>,
  bootstrap: typeof PriceGroupTemporalBootstrapSchema.Type,
) {
  // The certificate comes directly from the still-live Core-created handle. This is trusted test
  // composition provenance, not a claim that a serialized handle is cryptographically unforgeable.
  // Repeat both credential/OID/role/server checks immediately before every receiving launch.
  yield* guardPriceGroupOwnedDatabase(bootstrap.database);
  yield* guardPriceGroupPreparedArtifact(bundle.prepared, 'commerce-customer-context');
  const channel = yield* openPriceGroupTemporalChannel(PriceGroupTemporalResponseSchema);
  const child = yield* ChildProcess.make(process.execPath, [bundle.artifact, '--serve-price-group-current'], {
    cwd: bundle.directory,
    env: {
      ...priceGroupTemporalClosedEnvironment(bootstrap),
      [priceGroupTemporalSocketEnvironment]: channel.socketPath,
    },
    extendEnv: true,
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  }).pipe(Effect.provide(NodeServices.layer, { local: true }));
  yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
  yield* diagnosticStage('P_RECEIVER_SPAWNED');
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => {
      const stage = decodeChildDiagnosticStage(line);
      return Option.isSome(stage) ? diagnosticStage(stage.value) : Effect.void;
    }),
    Effect.forkScoped,
  );
  const receive = Effect.raceFirst(
    channel.next,
    child.exitCode.pipe(Effect.flatMap(() => Effect.fail(fail('receiver-exited')))),
  ).pipe(
    Effect.flatMap((response) =>
      response.type === 'FAILED'
        ? Effect.fail(fail(response.code === undefined ? response.stage : `${response.stage}:${response.code}`))
        : Effect.succeed(response),
    ),
  );

  const send = (command: Schema.Json) =>
    Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(command).pipe(
      Effect.flatMap((line) =>
        (Schema.is(Schema.Struct({ type: Schema.Literal('stop') }))(command) ? channel.beginClose : Effect.void).pipe(
          Effect.andThen(channel.send(line)),
          Effect.raceFirst(child.exitCode.pipe(Effect.flatMap(() => Effect.fail(fail('receiver-exited'))))),
        ),
      ),
    );
  yield* send(yield* Schema.encodeEffect(PriceGroupTemporalBootstrapSchema)(bootstrap));
  yield* diagnosticStage('P_BOOTSTRAP_SENT');
  const schemasReady = yield* receive;
  yield* requireCondition(schemasReady.type === 'SCHEMAS_READY', 'owner-schemas-ready');
  yield* diagnosticStage('P_SCHEMAS_READY');
  const partyRuntimeBootstrap = yield* prepareDedicatedIdentities(bootstrap);
  yield* send({ type: 'IDENTITIES_READY', version: priceGroupTemporalProtocol });
  yield* diagnosticStage('P_IDENTITIES_READY_SENT');
  const ready = yield* receive;
  if (ready.type !== 'BOOTED') {
    return yield* fail('receiver-ready-order');
  }
  yield* requireCondition(
    ready.buildMarker === bundle.marker.buildMarker &&
      ready.compositionRevision === bootstrap.composition.composition.revision,
    'receiver-ready-identity',
  );
  yield* diagnosticStage('P_BOOTED_RECEIVED');
  const invoke = Effect.fn('TemporalNative.fixedCommand')(function* fixedCommand(
    type:
      | 'CREATE_RETAIL_PARTY'
      | 'CREATE_COUNTERPARTY'
      | 'CREATE_SECOND_COUNTERPARTY'
      | 'CREATE_G1'
      | 'CREATE_G2'
      | 'CREATE_INCOMPATIBLE'
      | 'REVISE_G2'
      | 'RETIRE_G2'
      | 'UPGRADE'
      | 'STOP_CATALOG'
      | 'stop',
  ) {
    yield* send({ requestId: yield* nextId, type, version: priceGroupTemporalProtocol });
    return yield* receive;
  });
  // ChildProcess scope owns termination even when a public assertion fails. The explicit stop
  // acknowledgement permits successful tests to prove graceful close before database disposal.
  return {
    baseUrl: `http://127.0.0.1:${ready.port}`,
    child,
    invoke,
    partyRuntimeBootstrap,
  };
});

const prepareTemporalArtifacts = Effect.fn('TemporalNative.prepareArtifacts')(function* prepareArtifacts() {
  yield* requireCondition((yield* Config.String('APP_ENV_PATH')) === '/dev/null', 'closed-artifact-environment');
  yield* diagnosticStage('P_BEGIN');
  const commerce = yield* describeOwner('commerce-customer-context');
  const party = yield* describeOwner('party-registry');
  const catalog = yield* describeOwner('price-group-catalog');
  yield* diagnosticStage('P_DESCRIPTIONS_DONE');
  return Object.freeze({ catalog, commerce, party });
});
const PreparedTemporalArtifacts = Context.Service<Effect.Success<ReturnType<typeof prepareTemporalArtifacts>>>(
  'PriceGroupTemporal.preparedArtifacts',
);
const temporalArtifactsLayer = Layer.effect(PreparedTemporalArtifacts, prepareTemporalArtifacts()).pipe(
  Layer.provideMerge(services),
);

const makeTemporalNative = Effect.fn('TemporalNative.make')(function* makeTemporalNative(
  mode: 'before' | 'current',
  nativeClock: Clock.Clock,
  executorControl: 'all-declared' | 'without-catalog-create' = 'all-declared',
) {
  // Public Core fixture infrastructure reads its documented Config seam. Refuse source env-file
  // discovery before creating any owned database or permission relationship.
  yield* requireCondition((yield* Config.String('APP_ENV_PATH')) === '/dev/null', 'closed-parent-environment');
  const { catalog, commerce, party } = yield* PreparedTemporalArtifacts;
  const description = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DescriptionSchema))(commerce.description);
  const snapshot = yield* makePriceGroupTemporalComposition([commerce, party, catalog]);
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1248-price-group-effective-period',
  });
  yield* isolated.migrateCoreSchema();
  yield* diagnosticStage('P_CORE_SCHEMA_DONE');
  yield* isolated.publishInitialComposition(snapshot);
  yield* diagnosticStage('P_COMPOSITION_DONE');
  const owned = yield* captureOwnedCertificate(isolated);
  const coreEvidenceContext = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(coreEvidenceContext));
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionExecutor: 'manager-only',
      actionKeys:
        executorControl === 'all-declared'
          ? description.actionKeys
          : description.actionKeys.filter((key) => key !== 'pricing.price-group-catalog.create-price-group'),
      additionalLegalEntity: 'same-tenant',
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      allowedAudiences: ['commerce-customer-context', 'party-registry', 'price-group-catalog'],
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: snapshot.composition.revision,
      moduleKeys: ['commerce.customer-context', 'party.registry', 'pricing.price-group-catalog'],
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    }),
    (resource) => Effect.orDie(resource.close()),
  );
  yield* diagnosticStage('P_FIXTURE_DONE');
  const actor = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
  const authority = yield* makeAuthority(
    actor,
    snapshot.composition.revision,
    commerce.marker.buildMarker,
    nativeClock,
  );
  const caCertificate = yield* Config.String('SPICEDB_CA_CERT').pipe(Config.option);
  const fixedSpice = {
    endpoint: yield* Config.String('SPICEDB_ENDPOINT'),
    token: yield* Config.Redacted('SPICEDB_PRESHARED_KEY'),
  };
  const spiceDb = Option.match(caCertificate.pipe(Option.filter((value) => value.length > 0)), {
    onNone: () => fixedSpice,
    onSome: (certificate) => ({ ...fixedSpice, caCertificate: certificate }),
  });
  const dedicatedUrl = Effect.fn('TemporalNative.retargetDedicatedUrl')(function* retargetDedicatedUrl(
    identity: typeof PARTY_REGISTRY_REQUEST_IDENTITY,
  ) {
    const configured = yield* loadDatabaseConfig({ envPath: '/dev/null', identity });
    const address = new URL(configured.connectionString);
    address.pathname = `/${owned.certificate.name}`;
    yield* requireCondition(
      priceGroupDedicatedUrlMatches(
        address.href,
        owned.certificate,
        identity.id === PARTY_REGISTRY_REQUEST_IDENTITY.id ? 'party_registry_runtime' : 'shell_gateway_issuer',
      ),
      'dedicated-clone-url',
    );
    return Redacted.make(address.href);
  });
  const identities = {
    issuerUrl: yield* dedicatedUrl(SHELL_GATEWAY_ISSUER_IDENTITY),
    partyUrl: yield* dedicatedUrl(PARTY_REGISTRY_REQUEST_IDENTITY),
  };
  const bootstrap = yield* Schema.decodeUnknownEffect(Schema.toType(PriceGroupTemporalBootstrapSchema))({
    actor,
    artifacts: { catalog: catalog.prepared, party: party.prepared },
    composition: snapshot,
    database: owned.certificate,
    identities,
    issuer: authority.issuer,
    jwks: authority.jwks,
    mode,
    spiceDb,
    type: 'bootstrap',
    version: priceGroupTemporalProtocol,
  });
  const receiver = yield* startReceiver(commerce, bootstrap);
  expect(receiver.partyRuntimeBootstrap).toBe('fresh');
  const options = Effect.fn('TemporalNative.clientOptions')(function* clientOptions() {
    return {
      baseUrl: receiver.baseUrl,
      compositionRevision: snapshot.composition.revision,
      idempotencyKey: yield* nextId,
    };
  });
  const credential = authority.issue;
  return {
    actor,
    authority,
    bootstrap,
    commerce,
    coreEvidenceExecutor,
    credential,
    fixture,
    isolated,
    options,
    owned,
    receiver,
    snapshot,
  };
});
const TemporalCaseInfrastructure = Context.Service<{
  readonly executorControl: 'all-declared' | 'without-catalog-create';
  readonly mode: 'before' | 'current';
  readonly native: Effect.Success<ReturnType<typeof makeTemporalNative>>;
}>('PriceGroupTemporal.caseInfrastructure');
const temporalCaseLayer = (
  mode: 'before' | 'current',
  executorControl: 'all-declared' | 'without-catalog-create' = 'all-declared',
) =>
  Layer.effect(
    TemporalCaseInfrastructure,
    Effect.gen(function* prepareCaseInfrastructure() {
      const nativeClock = yield* Clock.Clock;
      const native = yield* makeTemporalNative(mode, nativeClock, executorControl);
      return { executorControl, mode, native };
    }),
  );

const provisionPublicSubjects = Effect.fn('TemporalNative.publicSubjects')(function* provisionPublicSubjects(
  native: Effect.Success<ReturnType<typeof makeTemporalNative>>,
) {
  const businessContext = yield* Layer.build(BusinessPermissionRelationshipMutationLive);
  const business = Context.get(businessContext, BusinessPermissionRelationshipMutation);
  const principal = { principalId: native.actor.principalId, tenantId: native.actor.tenantId };
  const grant = Effect.fn('TemporalNative.grantExactBusinessPermission')(function* grantExactBusinessPermission(
    permission: Parameters<typeof business.mutate>[0]['permission'],
    target: Parameters<typeof business.mutate>[0]['target'],
  ) {
    const input = { permission, principal, target };
    yield* business.mutate({ ...input, operation: 'grant' });
    yield* Effect.addFinalizer(() => Effect.orDie(business.mutate({ ...input, operation: 'revoke' })));
  });
  const resource = Effect.fn('TemporalNative.grantExactResource')(function* grantExactResource(reference: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
  }) {
    for (const permission of ['reader', 'writer'] as const) {
      yield* native.fixture.grantResourceAccess(reference, principal.principalId, permission);
      yield* Effect.addFinalizer(() =>
        Effect.orDie(native.fixture.revokeResourceAccess(reference, principal.principalId, permission)),
      );
    }
  });
  // The same genuine manager, implicit Tenant catalog and receiving runtime must deny before
  // the exact business Permission is granted; the next invocation is the positive control.
  const businessDenied = yield* Effect.flip(native.receiver.invoke('CREATE_G1'));
  expect(yield* Schema.decodeUnknownEffect(TemporalNativeFailure)(businessDenied)).toMatchObject({
    stage: 'CREATE_FORBIDDEN',
  });
  yield* grant('pricing.price_group.create', {
    kind: 'pricing_catalog',
    pricingCatalogId: principal.tenantId,
    tenantId: principal.tenantId,
  });
  const createGroup = Effect.fn('TemporalNative.createRealCatalogGroup')(function* createRealCatalogGroup(
    type: 'CREATE_G1' | 'CREATE_G2' | 'CREATE_INCOMPATIBLE',
  ) {
    const response = yield* native.receiver.invoke(type);
    if (response.type !== 'CREATED_G1' && response.type !== 'CREATED_G2' && response.type !== 'CREATED_INCOMPATIBLE') {
      return yield* fail('catalog-create-order');
    }
    const result = yield* Schema.decodeUnknownEffect(PriceGroupCreatedResultSchema)(response.result);
    const target = {
      kind: 'price_group' as const,
      priceGroupId: result.identity.priceGroupRef.resourceId,
      pricingCatalogId: principal.tenantId,
      tenantId: principal.tenantId,
    };
    for (const permission of [
      'pricing.price_group.read',
      'pricing.price_group.revision.create',
      'pricing.price_group.retire',
    ] as const) {
      yield* grant(permission, target);
    }
    return result;
  });
  const first = yield* createGroup('CREATE_G1');
  const second = yield* createGroup('CREATE_G2');
  const incompatible = yield* createGroup('CREATE_INCOMPATIBLE');
  const retailParty = yield* native.receiver.invoke('CREATE_RETAIL_PARTY');
  if (retailParty.type !== 'RETAIL_PARTY_CREATED') {
    return yield* fail('retail-party-order');
  }
  yield* resource(retailParty.partyRef);
  const counterparty = yield* native.receiver.invoke('CREATE_COUNTERPARTY');
  if (counterparty.type !== 'COUNTERPARTY_CREATED') {
    return yield* fail('counterparty-order');
  }
  yield* resource(counterparty.partyRef);
  yield* resource(counterparty.counterpartyRef);
  const effectiveAt = DateTime.formatIso(yield* DateTime.now);
  const sellingLegalEntityRef = {
    moduleId: 'core.identity' as const,
    resourceId: native.fixture.legalEntityId,
    resourceType: 'core.identity.legal-entity' as const,
    tenantId: principal.tenantId,
  };
  const retail = yield* executeEnsureRetailCustomerProfileWithAuthorization(
    {
      effectiveAt,
      subject: { kind: 'RETAIL', partyRef: retailParty.partyRef, sellingLegalEntityRef },
      trigger: 'ENSURE_BEFORE_ORDER_ACCEPTANCE',
    },
    yield* native.credential(),
    yield* nextId,
    yield* native.options(),
  );
  const counterpartyProfile = yield* executeCreateCounterpartyPurchasingProfileWithAuthorization(
    {
      effectiveAt,
      subject: { counterpartyRef: counterparty.counterpartyRef, kind: 'COUNTERPARTY', sellingLegalEntityRef },
      trigger: 'AUTHORIZED_ONBOARDING',
    },
    yield* native.credential(),
    yield* nextId,
    yield* native.options(),
  );
  yield* resource(retail.profileRef);
  yield* resource(counterpartyProfile.profileRef);
  yield* grant('retail.profile.read', {
    kind: 'retail_profile',
    legalEntityId: native.fixture.legalEntityId,
    profileId: retail.profileRef.resourceId,
    tenantId: principal.tenantId,
  });
  const bindingDenied = yield* Effect.flip(
    executeCustomerPriceGroupResolutionWithAuthorization(
      {
        authorizationSubject: { kind: 'RETAIL' },
        effectiveAt: DateTime.formatIso(yield* DateTime.now),
        profile: { ...retail.profileRef, kind: 'RETAIL' },
      },
      yield* native.credential(),
      yield* nextId,
      { baseUrl: native.receiver.baseUrl, compositionRevision: native.snapshot.composition.revision },
    ),
  );
  expect(
    yield* Schema.decodeUnknownEffect(CustomerPriceGroupResolutionForbiddenProblemSchema)(bindingDenied),
  ).toMatchObject({ status: 403 });
  yield* preparePriceGroupTemporalRetailAccess({
    certificate: native.owned.certificate,
    effectiveAt: DateTime.formatIso(yield* DateTime.now),
    fixture: native.fixture,
    profileRef: retail.profileRef,
  });
  const counterpartyTarget = {
    counterpartyId: counterparty.counterpartyRef.resourceId,
    kind: 'counterparty' as const,
    legalEntityId: native.fixture.legalEntityId,
    tenantId: principal.tenantId,
  };
  yield* grant('counterparty.profile.read', counterpartyTarget);
  yield* grant('counterparty.settings.price_group.manage', counterpartyTarget);
  // Real Core business/executor permission alone cannot replace the owner-local grant.
  const ownerDenied = yield* Effect.flip(
    executeAssignCounterpartyPriceGroupWithAuthorization(
      {
        counterpartyRef: counterparty.counterpartyRef,
        effectiveFrom: first.initialDefinition.effectivePeriod.effectiveFrom,
        expectedProfileRevision: counterpartyProfile.revision,
        priceGroupRef: first.identity.priceGroupRef,
        profile: { ...counterpartyProfile.profileRef, kind: 'COUNTERPARTY' },
        reason: 'Prove missing durable owner authority fails closed',
      },
      yield* native.credential(),
      yield* nextId,
      yield* native.options(),
    ),
  );
  expect(
    yield* Schema.decodeUnknownEffect(AssignCounterpartyPriceGroupActionForbiddenProblemSchema)(ownerDenied),
  ).toMatchObject({ code: 'action_permission_denied', status: 403 });
  const grantCounterpartyOwner = Effect.fn('TemporalNative.prepareExactOwnerGrant')(function* prepareExactOwnerGrant(
    permission: 'counterparty.profile.read' | 'counterparty.settings.price_group.manage',
    counterpartyRef: typeof counterparty.counterpartyRef,
  ) {
    yield* guardPriceGroupOwnedDatabase(native.owned.certificate);
    const invocationId = yield* nextId;
    const ownerNamespace = staffAuthenticationNamespaceRegistryLayer(['commerce-customer-context']);
    const [intent] = yield* native.fixture
      .prepareOwner(
        (transaction) =>
          transaction.invoke(beginOwnerGrant, [
            counterpartyRef.resourceId,
            principal.principalId,
            permission,
            null,
            principal.principalId,
            invocationId,
            'Scoped native PriceGroup permission precondition',
            false,
          ]),
        'required',
      )
      .pipe(Effect.provide(ownerNamespace));
    if (intent === undefined) {
      return yield* fail('owner-access-intent-missing');
    }
    yield* business.mutate({
      operation: 'grant',
      permission,
      principal,
      target: { ...counterpartyTarget, counterpartyId: counterpartyRef.resourceId },
    });
    const [active] = yield* native.fixture
      .prepareOwner(
        (transaction) =>
          transaction.invoke(activateOwnerGrant, [intent.grant_id, intent.mutation_id, 'grant', 'ACTIVE']),
        'required',
      )
      .pipe(Effect.provide(ownerNamespace));
    expect(active).toEqual({ state: 'ACTIVE' });
    return yield* Effect.void;
  });
  yield* grantCounterpartyOwner('counterparty.profile.read', counterparty.counterpartyRef);
  yield* grantCounterpartyOwner('counterparty.settings.price_group.manage', counterparty.counterpartyRef);

  // Real Catalog Create enforces an effective start after its trusted operation time. Observe
  // the actual returned starts instead of assuming a fixed historic definition is acceptable.
  const starts = [first, second, incompatible].map((group) =>
    DateTime.toEpochMillis(DateTime.makeUnsafe(group.initialDefinition.effectivePeriod.effectiveFrom)),
  );
  const wait = Math.max(...starts) - DateTime.toEpochMillis(yield* DateTime.now);
  if (wait > 0) {
    yield* Effect.sleep(wait + 1);
  }
  return {
    counterparty,
    counterpartyProfile,
    first,
    grant,
    grantCounterpartyOwner,
    incompatible,
    resource,
    retail,
    second,
  };
});
const publicResolution = Effect.fn('TemporalNative.publicResolution')(function* publicResolution(
  native: Effect.Success<ReturnType<typeof makeTemporalNative>>,
  profile: typeof CommerceCustomerProfileTargetSchema.Type,
  effectiveAt: string,
  authorizationSubject: typeof PriceGroupAuthorizationSubjectSchema.Type,
) {
  return yield* executeCustomerPriceGroupResolutionWithAuthorization(
    { authorizationSubject, effectiveAt, profile },
    yield* native.credential(),
    yield* nextId,
    { baseUrl: native.receiver.baseUrl, compositionRevision: native.snapshot.composition.revision },
  );
});
const atOffset = (instant: string, milliseconds: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.makeUnsafe(instant)) + milliseconds));
const observe = Effect.fn('TemporalNative.observeBoundary')(function* observeBoundary(instant: string) {
  const boundary = DateTime.toEpochMillis(DateTime.makeUnsafe(instant));
  const clock = yield* Clock.Clock;
  while (true) {
    const remaining = boundary - (yield* clock.currentTimeMillis);
    if (remaining <= 0) {
      return;
    }
    yield* clock.sleep(Duration.millis(remaining));
  }
});

it.effect('waits for the observed Price Group boundary after an early timer completion', () =>
  Effect.gen(function* observeEarlyTimerCompletion() {
    const clock = yield* Clock.Clock;
    const boundary = DateTime.toEpochMillis(DateTime.makeUnsafe('2026-10-27T00:00:00.000Z'));
    let now = boundary - 100;
    let observations = 0;
    const sleeps: number[] = [];
    const earlyTimerClock: Clock.Clock = {
      currentTimeMillis: Effect.sync(() => {
        observations += 1;
        return now;
      }),
      currentTimeMillisUnsafe: () => now,
      currentTimeNanos: clock.currentTimeNanos,
      currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
      monotonicTimeNanos: clock.monotonicTimeNanos,
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
      sleep: (duration) =>
        Effect.sync(() => {
          sleeps.push(Duration.toMillis(duration));
          now = sleeps.length === 1 ? boundary - 80 : boundary;
        }),
    };
    yield* observe(DateTime.formatIso(DateTime.makeUnsafe(boundary))).pipe(
      Effect.provideService(Clock.Clock, earlyTimerClock),
    );
    expect(now).toBe(boundary);
    expect(observations).toBe(3);
    expect(sleeps).toEqual([100, 80]);
    yield* observe(DateTime.formatIso(DateTime.makeUnsafe(boundary))).pipe(
      Effect.provideService(Clock.Clock, earlyTimerClock),
    );
    expect(observations).toBe(4);
    expect(sleeps).toEqual([100, 80]);
  }),
);
const nativeMetadata = Effect.fn('TemporalNative.metadata')(function* metadata(
  native: Effect.Success<ReturnType<typeof makeTemporalNative>>,
) {
  yield* guardPriceGroupOwnedDatabase(native.owned.certificate);
  const rows = yield* native.owned.client.unsafe<{
    readonly cancellation: string;
    readonly forced: boolean;
    readonly hardened: boolean;
    readonly public_execute: boolean;
    readonly raw_access: boolean;
    readonly rls: boolean;
    readonly runtime_execute: boolean;
    readonly security_definer: boolean;
  }>(
    "select pg_get_constraintdef(k.oid) as cancellation,c.relrowsecurity as rls,c.relforcerowsecurity as forced,p.prosecdef as security_definer, p.proconfig @> array['row_security=on','search_path=pg_catalog, commerce_customer_context, pg_temp'] as hardened, exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE') as public_execute, has_function_privilege($1,p.oid,'EXECUTE') as runtime_execute, (has_table_privilege($1,c.oid,'SELECT') or has_table_privilege($1,c.oid,'INSERT') or has_table_privilege($1,c.oid,'UPDATE') or has_table_privilege($1,c.oid,'DELETE')) as raw_access from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_constraint k on k.conrelid=c.oid and k.conname='ccc_price_assignments_period_ck' cross join pg_proc p where n.nspname='commerce_customer_context' and c.relname='customer_price_group_assignments' and p.oid='commerce_customer_context.resolve_price_group_assignments(uuid,uuid,text,text,timestamptz)'::regprocedure",
    [native.owned.certificate.runtimeRole],
  );
  const [row] = rows;
  if (row === undefined) {
    return yield* fail('metadata-missing');
  }
  expect(row).toMatchObject({
    forced: true,
    hardened: true,
    public_execute: false,
    raw_access: false,
    rls: true,
    runtime_execute: true,
    security_definer: true,
  });
  expect(row.cancellation).toContain('CANCELLED');
  return row;
});
const nativeJournal = Effect.fn('TemporalNative.journal')(function* journal(
  native: Effect.Success<ReturnType<typeof makeTemporalNative>>,
) {
  yield* guardPriceGroupOwnedDatabase(native.owned.certificate);
  return yield* native.owned.client.unsafe<{ readonly receipts: unknown }>(
    'select jsonb_agg(to_jsonb(j) order by j.id) as receipts from drizzle.__drizzle_migrations_commerce_customer_context j',
  );
});
const reapplyOwnerJournal = Effect.fn('TemporalNative.reapplyOwnJournal')(function* reapplyOwnJournal(
  native: Effect.Success<ReturnType<typeof makeTemporalNative>>,
) {
  yield* guardPriceGroupOwnedDatabase(native.owned.certificate);
  const path = yield* Path.Path;
  const migration = yield* ChildProcess.make(
    process.execPath,
    [
      path.join(native.commerce.directory, 'node_modules/drizzle-kit/bin.cjs'),
      'migrate',
      '--config',
      'drizzle.config.ts',
    ],
    {
      cwd: native.commerce.directory,
      env: {
        APP_ENV_PATH: '/dev/null',
        DATABASE_ADMIN_URL: Redacted.value(native.owned.certificate.adminUrl),
        DATABASE_URL: Redacted.value(native.owned.certificate.runtimeUrl),
      },
      extendEnv: false,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    },
  ).pipe(Effect.provide(NodeServices.layer, { local: true }));
  const [code] = yield* Effect.all(
    [migration.exitCode, Stream.runDrain(migration.stderr), Stream.runDrain(migration.stdout)],
    { concurrency: 3 },
  );
  yield* requireCondition(code === 0, 'owned-journal-reapply');
});
const verifyCurrentOwner = Effect.fn('TemporalNative.verifyCurrentOwner')(function* verifyCurrentOwner(
  native: Effect.Success<ReturnType<typeof makeTemporalNative>>,
) {
  yield* guardPriceGroupOwnedDatabase(native.owned.certificate);
  const path = yield* Path.Path;
  const verification = yield* ChildProcess.make(
    process.execPath,
    [path.join(native.commerce.directory, 'scripts/verify-db-schema.mts')],
    {
      cwd: native.commerce.directory,
      env: {
        APP_ENV_PATH: '/dev/null',
        DATABASE_ADMIN_URL: Redacted.value(native.owned.certificate.adminUrl),
        DATABASE_URL: Redacted.value(native.owned.certificate.runtimeUrl),
      },
      extendEnv: false,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    },
  ).pipe(Effect.provide(NodeServices.layer, { local: true }));
  const [code] = yield* Effect.all(
    [verification.exitCode, Stream.runDrain(verification.stderr), Stream.runDrain(verification.stdout)],
    { concurrency: 3 },
  );
  yield* requireCondition(code === 0, 'strict-current-owner-verifier');
});
const normalizeResolverBody = (body: string) => body.replaceAll('\r\n', '\n').trim();
const resolverReceipt = Effect.fn('TemporalNative.resolverReceipt')(function* resolverReceipt(
  native: Effect.Success<ReturnType<typeof makeTemporalNative>>,
  revision: 'original' | 'current',
) {
  yield* guardPriceGroupOwnedDatabase(native.owned.certificate);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder =
    revision === 'original' ? '20260909112237_price-group-routines' : '20261019224642_price_group_effective_current';
  const sql = yield* fs.readFileString(path.join(native.commerce.directory, 'drizzle', folder, 'migration.sql'));
  const declaration = 'CREATE OR REPLACE FUNCTION "commerce_customer_context"."resolve_price_group_assignments"(';
  const offset = sql.indexOf(declaration);
  yield* requireCondition(
    offset !== -1 && !sql.includes(declaration, offset + declaration.length),
    'resolver-source-identity',
  );
  const match = /AS \$\$(?<body>[\s\S]*?)\$\$/u.exec(sql.slice(offset));
  const expected = match?.groups?.body;
  if (expected === undefined) {
    return yield* fail('resolver-source-body');
  }
  const [actual] = yield* native.owned.client.unsafe<{ readonly body: string }>(
    "select p.prosrc::text as body from pg_proc p where p.oid='commerce_customer_context.resolve_price_group_assignments(uuid,uuid,text,text,timestamptz)'::regprocedure",
  );
  if (actual === undefined) {
    return yield* fail('resolver-installed-body');
  }
  expect(normalizeResolverBody(actual.body)).toBe(normalizeResolverBody(expected));
  const receipt = { bodyDigest: yield* digest(normalizeResolverBody(actual.body)), revision };
  yield* Effect.logInfo(receipt);
  return receipt;
});
const nativeOwnerInventory = Effect.fn('TemporalNative.ownerInventory')(function* ownerInventory(
  native: Effect.Success<ReturnType<typeof makeTemporalNative>>,
) {
  yield* guardPriceGroupOwnedDatabase(native.owned.certificate);
  return yield* native.owned.client.unsafe<{ readonly inventory: unknown }>(
    'select jsonb_agg(to_jsonb(a) order by a.customer_price_group_assignment_id) as inventory from commerce_customer_context.customer_price_group_assignments a',
  );
});
const rejectAssignedEvent = Effect.fn('TemporalNative.rejectAssignedEvent')(function* rejectAssignedEvent(
  native: Effect.Success<ReturnType<typeof makeTemporalNative>>,
) {
  // TEST-ONLY infrastructure lease: this exact fixed function and trigger exist solely in the
  // actual Core-created disposable database. All owner constraints, grants and RLS stay enabled.
  // A Core event INSERT failure happens after the separate receiving process mutates owner state,
  // so it proves rollback across the real child transaction, unlike a parent-only executor fault.
  yield* guardPriceGroupOwnedDatabase(native.owned.certificate);
  yield* Effect.addFinalizer(() =>
    Effect.orDie(
      guardPriceGroupOwnedDatabase(native.owned.certificate).pipe(
        Effect.andThen(
          native.owned.client.unsafe(
            'drop trigger if exists stabilization_1248_reject_assigned_event on core.domain_events',
          ),
        ),
        Effect.andThen(
          native.owned.client.unsafe('drop function if exists core.stabilization_1248_reject_assigned_event()'),
        ),
      ),
    ),
  );
  yield* native.owned.client.unsafe(
    "create function core.stabilization_1248_reject_assigned_event() returns trigger language plpgsql set search_path=pg_catalog,pg_temp as $$ begin if new.producer_module_key='commerce.customer-context' and new.event_type='commerce.customer-context.customer-price-group-assigned.v1' then raise exception using errcode='P0001',message='owned 1248 test event failure'; end if; return new; end $$",
  );
  yield* native.owned.client.unsafe(
    'revoke all on function core.stabilization_1248_reject_assigned_event() from public',
  );
  yield* native.owned.client.unsafe(
    'create trigger stabilization_1248_reject_assigned_event before insert on core.domain_events for each row execute function core.stabilization_1248_reject_assigned_event()',
  );
});
const makeTemporalCase = Effect.fn('TemporalNative.case')(function* temporalCase(mode: 'before' | 'current') {
  const infrastructure = yield* TemporalCaseInfrastructure;
  yield* requireCondition(
    infrastructure.mode === mode && infrastructure.executorControl === 'all-declared',
    'case-infrastructure-mode',
  );
  const { native } = infrastructure;
  const subjects = yield* provisionPublicSubjects(native);
  const retail = { ...subjects.retail.profileRef, kind: 'RETAIL' as const };
  const counterparty = { ...subjects.counterpartyProfile.profileRef, kind: 'COUNTERPARTY' as const };
  const { counterpartyRef } = subjects.counterparty;
  const scheduleNow = DateTime.formatIso(yield* DateTime.now);
  const start = atOffset(scheduleNow, 5000);
  const transition = atOffset(scheduleNow, 8000);
  const originalEnd = atOffset(scheduleNow, 120_000);
  const defaultSchedule = { effectiveTo: originalEnd };
  const assignRetail = (
    priceGroupRef: typeof subjects.first.identity.priceGroupRef,
    effectiveFrom: string,
    schedule: { readonly effectiveTo?: string } = defaultSchedule,
  ) =>
    Effect.gen(function* assignRetailThroughPublicClient() {
      return yield* executeAssignCustomerPriceGroupWithAuthorization(
        {
          effectiveFrom,
          ...schedule,
          expectedProfileRevision: subjects.retail.revision,
          priceGroupRef,
          profile: retail,
          reason: 'Native retained effective period',
        },
        yield* native.credential(),
        yield* nextId,
        yield* native.options(),
      );
    });
  const assignCounterparty = (
    priceGroupRef: typeof subjects.first.identity.priceGroupRef,
    effectiveFrom: string,
    schedule: { readonly effectiveTo?: string } = defaultSchedule,
  ) =>
    Effect.gen(function* assignCounterpartyThroughPublicClient() {
      return yield* executeAssignCounterpartyPriceGroupWithAuthorization(
        {
          counterpartyRef,
          effectiveFrom,
          ...schedule,
          expectedProfileRevision: subjects.counterpartyProfile.revision,
          priceGroupRef,
          profile: counterparty,
          reason: 'Native retained effective period',
        },
        yield* native.credential(),
        yield* nextId,
        yield* native.options(),
      );
    });
  return {
    assignCounterparty,
    assignRetail,
    counterparty,
    counterpartyRef,
    native,
    originalEnd,
    retail,
    start,
    subjects,
    transition,
  };
});
const temporalScenario = Effect.fn('TemporalNative.effectivePeriods')(function* effectivePeriods() {
  const {
    assignCounterparty,
    assignRetail,
    counterparty,
    counterpartyRef,
    native,
    originalEnd,
    retail,
    start,
    subjects,
    transition,
  } = yield* makeTemporalCase('before');
  const originalMetadata = yield* nativeMetadata(native);
  const originalReceipt = yield* resolverReceipt(native, 'original');
  const firstRetail = yield* assignRetail(subjects.first.identity.priceGroupRef, start);
  const firstCounterparty = yield* assignCounterparty(subjects.first.identity.priceGroupRef, start);
  const unchanged = yield* assignRetail(subjects.first.identity.priceGroupRef, start);
  expect(unchanged.changed).toBe(false);
  const secondRetail = yield* assignRetail(subjects.second.identity.priceGroupRef, transition);
  const secondCounterparty = yield* assignCounterparty(subjects.second.identity.priceGroupRef, transition);
  expect(secondRetail.replacedAssignmentRef).toEqual(firstRetail.assignment.assignmentRef);
  expect(secondCounterparty.replacedAssignmentRef).toEqual(firstCounterparty.assignment.assignmentRef);
  const beforeOverlap = yield* native.fixture.evidence(native.coreEvidenceExecutor);
  const overlap = yield* Effect.flip(assignRetail(subjects.first.identity.priceGroupRef, atOffset(start, -1)));
  expect(yield* Schema.decodeUnknownEffect(AssignCustomerPriceGroupActionConflictProblemSchema)(overlap)).toMatchObject(
    { code: 'customer_price_group_overlap_conflict', status: 409 },
  );
  expect((yield* native.fixture.evidence(native.coreEvidenceExecutor)).events).toEqual(beforeOverlap.events);
  yield* observe(start);
  const retailSubject = { kind: 'RETAIL' as const };
  const counterpartySubject = { counterpartyRef, kind: 'COUNTERPARTY' as const };
  // Genuine public/native OLD observation after successful native owner writes: the installed
  // ACTIVE-only routine loses the already-ended predecessor. An authentication/setup failure
  // cannot satisfy this assertion because the published client must decode a healthy response.
  expect(
    Schema.is(CustomerPriceGroupResolutionSchema.members[1])(
      (yield* publicResolution(native, retail, start, retailSubject)).resolution,
    ),
  ).toBe(true);
  expect(
    Schema.is(CustomerPriceGroupResolutionSchema.members[1])(
      (yield* publicResolution(native, counterparty, start, counterpartySubject)).resolution,
    ),
  ).toBe(true);
  const upgraded = yield* native.receiver.invoke('UPGRADE');
  expect(upgraded.type).toBe('UPGRADED');
  expect(yield* nativeMetadata(native)).toEqual(originalMetadata);
  const currentReceipt = yield* resolverReceipt(native, 'current');
  expect(currentReceipt.bodyDigest).not.toBe(originalReceipt.bodyDigest);
  const appliedJournal = yield* nativeJournal(native);
  yield* reapplyOwnerJournal(native);
  expect(yield* nativeJournal(native)).toEqual(appliedJournal);
  yield* verifyCurrentOwner(native);
  const beforeRetail = yield* publicResolution(native, retail, start, retailSubject);
  const beforeCounterparty = yield* publicResolution(native, counterparty, start, counterpartySubject);
  expect(
    yield* Schema.decodeUnknownEffect(CustomerPriceGroupResolutionSchema.members[0])(beforeRetail.resolution),
  ).toMatchObject({
    assignmentRef: firstRetail.assignment.assignmentRef,
    priceGroupRef: subjects.first.identity.priceGroupRef,
  });
  expect(
    yield* Schema.decodeUnknownEffect(CustomerPriceGroupResolutionSchema.members[0])(beforeCounterparty.resolution),
  ).toMatchObject({
    assignmentRef: firstCounterparty.assignment.assignmentRef,
    priceGroupRef: subjects.first.identity.priceGroupRef,
  });
  yield* observe(transition);
  expect(
    yield* Schema.decodeUnknownEffect(CustomerPriceGroupResolutionSchema.members[0])(
      (yield* publicResolution(native, retail, transition, retailSubject)).resolution,
    ),
  ).toMatchObject({
    assignmentRef: secondRetail.assignment.assignmentRef,
  });
  expect(
    yield* Schema.decodeUnknownEffect(CustomerPriceGroupResolutionSchema.members[0])(
      (yield* publicResolution(native, counterparty, transition, counterpartySubject)).resolution,
    ),
  ).toMatchObject({
    assignmentRef: secondCounterparty.assignment.assignmentRef,
  });
  yield* observe(atOffset(transition, 1));
  expect(
    yield* Schema.decodeUnknownEffect(CustomerPriceGroupResolutionSchema.members[0])(
      (yield* publicResolution(native, retail, atOffset(transition, 1), retailSubject)).resolution,
    ),
  ).toMatchObject({ assignmentRef: secondRetail.assignment.assignmentRef });
  expect(
    yield* Schema.decodeUnknownEffect(CustomerPriceGroupResolutionSchema.members[0])(
      (yield* publicResolution(native, counterparty, atOffset(transition, 1), counterpartySubject)).resolution,
    ),
  ).toMatchObject({ assignmentRef: secondCounterparty.assignment.assignmentRef });
  const history = yield* executeCustomerPriceGroupAssignmentReadWithAuthorization(
    {
      authorizationSubject: retailSubject,
      profile: retail,
    },
    yield* native.credential(),
    yield* nextId,
    { baseUrl: native.receiver.baseUrl, compositionRevision: native.snapshot.composition.revision },
  );
  expect(
    history.assignments.find(
      (assignment) => assignment.assignmentRef.resourceId === firstRetail.assignment.assignmentRef.resourceId,
    ),
  ).toMatchObject({
    compatibility: firstRetail.assignment.compatibility,
    effectiveFrom: start,
    effectiveTo: transition,
  });
  const counterpartyHistory = yield* executeCustomerPriceGroupAssignmentReadWithAuthorization(
    {
      authorizationSubject: counterpartySubject,
      profile: counterparty,
    },
    yield* native.credential(),
    yield* nextId,
    { baseUrl: native.receiver.baseUrl, compositionRevision: native.snapshot.composition.revision },
  );
  expect(
    counterpartyHistory.assignments.find(
      (assignment) => assignment.assignmentRef.resourceId === firstCounterparty.assignment.assignmentRef.resourceId,
    ),
  ).toMatchObject({
    compatibility: firstCounterparty.assignment.compatibility,
    effectiveFrom: start,
    effectiveTo: transition,
  });
  const originalIds = new Set([
    firstRetail.assignment.assignmentRef.resourceId,
    firstCounterparty.assignment.assignmentRef.resourceId,
  ]);
  const immutable = (yield* native.fixture.evidence(native.coreEvidenceExecutor)).audits.filter(
    (audit) =>
      audit.outcome === 'succeeded' &&
      Schema.is(CustomerPriceGroupAssignedAuditEvidenceSchema)(audit.evidenceJson) &&
      originalIds.has(CustomerPriceGroupAssignedAuditEvidenceSchema.make(audit.evidenceJson).assignmentId),
  );
  const auditedIds = new Set<string>();
  for (const audit of immutable) {
    const evidence = yield* Schema.decodeUnknownEffect(CustomerPriceGroupAssignedAuditEvidenceSchema)(
      audit.evidenceJson,
    );
    auditedIds.add(evidence.assignmentId);
    expect(evidence).toMatchObject({ requestedEffectiveFrom: start, requestedEffectiveTo: originalEnd });
  }
  expect(auditedIds).toEqual(originalIds);
  const removedAt = atOffset(DateTime.formatIso(yield* DateTime.now), 3000);
  const removedRetail = yield* executeRemoveCustomerPriceGroupWithAuthorization(
    {
      assignmentRef: secondRetail.assignment.assignmentRef,
      effectiveAt: removedAt,
      expectedRevision: secondRetail.assignment.revision,
      profile: retail,
      reason: 'Exact exclusive removal boundary',
    },
    yield* native.credential(),
    yield* nextId,
    yield* native.options(),
  );
  const removedCounterparty = yield* executeRemoveCounterpartyPriceGroupWithAuthorization(
    {
      assignmentRef: secondCounterparty.assignment.assignmentRef,
      counterpartyRef,
      effectiveAt: removedAt,
      expectedRevision: secondCounterparty.assignment.revision,
      profile: counterparty,
      reason: 'Exact exclusive removal boundary',
    },
    yield* native.credential(),
    yield* nextId,
    yield* native.options(),
  );
  expect(removedRetail.changed).toBe(true);
  expect(removedCounterparty.changed).toBe(true);
  yield* observe(removedAt);
  expect(
    Schema.is(CustomerPriceGroupResolutionSchema.members[0])(
      (yield* publicResolution(native, retail, atOffset(removedAt, -1), retailSubject)).resolution,
    ),
  ).toBe(true);
  expect(
    Schema.is(CustomerPriceGroupResolutionSchema.members[0])(
      (yield* publicResolution(native, counterparty, atOffset(removedAt, -1), counterpartySubject)).resolution,
    ),
  ).toBe(true);
  expect(
    Schema.is(CustomerPriceGroupResolutionSchema.members[1])(
      (yield* publicResolution(native, retail, removedAt, retailSubject)).resolution,
    ),
  ).toBe(true);
  expect(
    Schema.is(CustomerPriceGroupResolutionSchema.members[1])(
      (yield* publicResolution(native, counterparty, removedAt, counterpartySubject)).resolution,
    ),
  ).toBe(true);
  expect(
    (yield* native.fixture.evidence(native.coreEvidenceExecutor)).audits.filter((audit) =>
      immutable.some((original) => original.auditEventId === audit.auditEventId),
    ),
  ).toEqual(immutable);
  const stopped = yield* native.receiver.invoke('stop');
  expect(stopped.type).toBe('STOPPED');
  expect(yield* native.receiver.child.exitCode).toBe(0);
  const restart = yield* startReceiver(native.commerce, { ...native.bootstrap, mode: 'current' });
  expect(restart.partyRuntimeBootstrap).toBe('existing');
  const restartedHistory = yield* executeCustomerPriceGroupAssignmentReadWithAuthorization(
    {
      authorizationSubject: retailSubject,
      profile: retail,
    },
    yield* native.credential(),
    yield* nextId,
    { baseUrl: restart.baseUrl, compositionRevision: native.snapshot.composition.revision },
  );
  expect(
    restartedHistory.assignments.find(
      (assignment) => assignment.assignmentRef.resourceId === firstRetail.assignment.assignmentRef.resourceId,
    ),
  ).toEqual(
    history.assignments.find(
      (assignment) => assignment.assignmentRef.resourceId === firstRetail.assignment.assignmentRef.resourceId,
    ),
  );
  expect(
    (yield* native.fixture.evidence(native.coreEvidenceExecutor)).audits.filter((audit) =>
      immutable.some((original) => original.auditEventId === audit.auditEventId),
    ),
  ).toEqual(immutable);
  expect((yield* restart.invoke('stop')).type).toBe('STOPPED');
  expect(yield* restart.child.exitCode).toBe(0);
  return yield* Effect.void;
});
const openAndFiniteScenario = Effect.fn('TemporalNative.openAndFinite')(function* openAndFinite() {
  const { assignCounterparty, assignRetail, counterparty, counterpartyRef, native, retail, start, subjects } =
    yield* makeTemporalCase('current');
  const targets = [
    {
      assign: assignRetail,
      authorizationSubject: { kind: 'RETAIL' as const },
      kind: 'RETAIL' as const,
      profile: retail,
    },
    {
      assign: assignCounterparty,
      authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' as const },
      kind: 'COUNTERPARTY' as const,
      profile: counterparty,
    },
  ];
  const scheduled = [];
  for (const target of targets) {
    // Omit effectiveTo on the actual public payload. An arbitrary distant finite end does not
    // exercise the original open-ended schedule or its immutable audit meaning.
    const original = yield* target.assign(subjects.first.identity.priceGroupRef, start, {});
    const replacement = yield* target.assign(subjects.second.identity.priceGroupRef, start, {});
    expect(original.assignment.effectiveTo).toBeNull();
    expect(replacement.assignment.effectiveTo).toBeNull();
    expect(replacement.replacedAssignmentRef).toEqual(original.assignment.assignmentRef);
    yield* guardPriceGroupOwnedDatabase(native.owned.certificate);
    const [cancelled] = yield* native.owned.client<{
      readonly exact_end: boolean;
      readonly exact_start: boolean;
      readonly lifecycle: string;
    }>`select lifecycle::text, effective_from=${start}::timestamptz as exact_start,
        effective_to=${start}::timestamptz as exact_end
      from commerce_customer_context.customer_price_group_assignments
      where customer_price_group_assignment_id=${original.assignment.assignmentRef.resourceId}::uuid`;
    expect(cancelled).toEqual({ exact_end: true, exact_start: true, lifecycle: 'CANCELLED' });
    scheduled.push({ ...target, original, replacement });
  }
  yield* observe(atOffset(start, 1));
  for (const target of scheduled) {
    // Query observed instants only: future-only state is genuinely absent just before its start.
    yield* diagnosticStage('P_OPEN_FINITE_NONE_BEGIN');
    expect(
      Schema.is(CustomerPriceGroupResolutionSchema.members[1])(
        (yield* publicResolution(native, target.profile, atOffset(start, -1), target.authorizationSubject)).resolution,
      ),
    ).toBe(true);
    yield* diagnosticStage('P_OPEN_FINITE_NONE_DONE');
    for (const instant of [start, atOffset(start, 1)]) {
      expect(
        yield* Schema.decodeUnknownEffect(CustomerPriceGroupResolutionSchema.members[0])(
          (yield* publicResolution(native, target.profile, instant, target.authorizationSubject)).resolution,
        ),
      ).toMatchObject({
        assignmentRef: target.replacement.assignment.assignmentRef,
        priceGroupRef: subjects.second.identity.priceGroupRef,
      });
    }
  }
  const removedAt = atOffset(DateTime.formatIso(yield* DateTime.now), 3000);
  for (const target of scheduled) {
    const payload = {
      assignmentRef: target.replacement.assignment.assignmentRef,
      effectiveAt: removedAt,
      expectedRevision: target.replacement.assignment.revision,
      reason: 'Schedule the exclusive end of a genuinely open assignment',
    };
    const removed = yield* target.kind === 'RETAIL'
      ? executeRemoveCustomerPriceGroupWithAuthorization(
          { ...payload, profile: target.profile },
          yield* native.credential(),
          yield* nextId,
          yield* native.options(),
        )
      : executeRemoveCounterpartyPriceGroupWithAuthorization(
          { ...payload, counterpartyRef, profile: target.profile },
          yield* native.credential(),
          yield* nextId,
          yield* native.options(),
        );
    expect(removed.changed).toBe(true);
    expect(removed.assignment).toMatchObject({ effectiveFrom: start, effectiveTo: removedAt, state: 'ACTIVE' });
    yield* guardPriceGroupOwnedDatabase(native.owned.certificate);
    const [ended] = yield* native.owned.client<{
      readonly exact_end: boolean;
      readonly exact_start: boolean;
      readonly lifecycle: string;
    }>`select lifecycle::text, effective_from=${start}::timestamptz as exact_start,
        effective_to=${removedAt}::timestamptz as exact_end
      from commerce_customer_context.customer_price_group_assignments
      where customer_price_group_assignment_id=${target.replacement.assignment.assignmentRef.resourceId}::uuid`;
    expect(ended).toEqual({ exact_end: true, exact_start: true, lifecycle: 'ENDED' });
  }
  yield* observe(atOffset(removedAt, 1));
  for (const target of scheduled) {
    expect(
      yield* Schema.decodeUnknownEffect(CustomerPriceGroupResolutionSchema.members[0])(
        (yield* publicResolution(native, target.profile, atOffset(removedAt, -1), target.authorizationSubject))
          .resolution,
      ),
    ).toMatchObject({ assignmentRef: target.replacement.assignment.assignmentRef });
    for (const instant of [removedAt, atOffset(removedAt, 1)]) {
      expect(
        Schema.is(CustomerPriceGroupResolutionSchema.members[1])(
          (yield* publicResolution(native, target.profile, instant, target.authorizationSubject)).resolution,
        ),
      ).toBe(true);
    }
  }
  const finiteStart = atOffset(DateTime.formatIso(yield* DateTime.now), 3000);
  const finiteEnd = atOffset(finiteStart, 3000);
  const finite = [];
  for (const target of targets) {
    const assignment = yield* target.assign(subjects.first.identity.priceGroupRef, finiteStart, {
      effectiveTo: finiteEnd,
    });
    expect(assignment.replacedAssignmentRef).toBeNull();
    expect(assignment.assignment).toMatchObject({
      effectiveFrom: finiteStart,
      effectiveTo: finiteEnd,
      state: 'ACTIVE',
    });
    finite.push({ ...target, assignment });
  }
  yield* observe(atOffset(finiteEnd, 1));
  for (const target of finite) {
    expect(
      Schema.is(CustomerPriceGroupResolutionSchema.members[1])(
        (yield* publicResolution(native, target.profile, atOffset(finiteStart, -1), target.authorizationSubject))
          .resolution,
      ),
    ).toBe(true);
    for (const instant of [finiteStart, atOffset(finiteEnd, -1)]) {
      expect(
        yield* Schema.decodeUnknownEffect(CustomerPriceGroupResolutionSchema.members[0])(
          (yield* publicResolution(native, target.profile, instant, target.authorizationSubject)).resolution,
        ),
      ).toMatchObject({
        assignmentRef: target.assignment.assignment.assignmentRef,
        priceGroupRef: subjects.first.identity.priceGroupRef,
      });
    }
    for (const instant of [finiteEnd, atOffset(finiteEnd, 1)]) {
      expect(
        Schema.is(CustomerPriceGroupResolutionSchema.members[1])(
          (yield* publicResolution(native, target.profile, instant, target.authorizationSubject)).resolution,
        ),
      ).toBe(true);
    }
    // No Remove or replacement changed this row. Native ACTIVE with a finite past end must
    // expire by its own interval, rather than becoming a false Current after the resolver repair.
    yield* guardPriceGroupOwnedDatabase(native.owned.certificate);
    const [expired] = yield* native.owned.client<{
      readonly exact_end: boolean;
      readonly exact_start: boolean;
      readonly lifecycle: string;
    }>`select lifecycle::text, effective_from=${finiteStart}::timestamptz as exact_start,
        effective_to=${finiteEnd}::timestamptz as exact_end
      from commerce_customer_context.customer_price_group_assignments
      where customer_price_group_assignment_id=${target.assignment.assignment.assignmentRef.resourceId}::uuid`;
    expect(expired).toEqual({ exact_end: true, exact_start: true, lifecycle: 'ACTIVE' });
  }
  const openAssignmentIds = new Set(
    scheduled.flatMap((target) => [
      target.original.assignment.assignmentRef.resourceId,
      target.replacement.assignment.assignmentRef.resourceId,
    ]),
  );
  const openAudits = (yield* native.fixture.evidence(native.coreEvidenceExecutor)).audits.filter(
    (audit) =>
      audit.outcome === 'succeeded' &&
      Schema.is(CustomerPriceGroupAssignedAuditEvidenceSchema)(audit.evidenceJson) &&
      openAssignmentIds.has(CustomerPriceGroupAssignedAuditEvidenceSchema.make(audit.evidenceJson).assignmentId),
  );
  expect(openAudits).toHaveLength(openAssignmentIds.size);
  for (const audit of openAudits) {
    const evidence = yield* Schema.decodeUnknownEffect(CustomerPriceGroupAssignedAuditEvidenceSchema)(
      audit.evidenceJson,
    );
    expect(evidence.requestedEffectiveFrom).toBe(start);
    expect(evidence).not.toHaveProperty('requestedEffectiveTo');
  }
  expect((yield* native.receiver.invoke('stop')).type).toBe('STOPPED');
  expect(yield* native.receiver.child.exitCode).toBe(0);
  return yield* Effect.void;
});
const cancellationScenario = Effect.fn('TemporalNative.cancellations')(function* cancellations() {
  const { assignRetail, native, retail, subjects } = yield* makeTemporalCase('current');
  const retailSubject = { kind: 'RETAIL' as const };
  const cancelAt = atOffset(DateTime.formatIso(yield* DateTime.now), 5000);
  const cancelledAssignment = yield* assignRetail(subjects.first.identity.priceGroupRef, cancelAt);
  const cancellationOptions = yield* native.options();
  const cancellationPayload = {
    assignmentRef: cancelledAssignment.assignment.assignmentRef,
    effectiveAt: cancelAt,
    expectedRevision: cancelledAssignment.assignment.revision,
    profile: retail,
    reason: 'Same-start cancellation retains the exact instant',
  };
  const beforeCas = yield* native.fixture.evidence(native.coreEvidenceExecutor);
  const casFailure = yield* Effect.flip(
    executeRemoveCustomerPriceGroupWithAuthorization(
      {
        ...cancellationPayload,
        expectedRevision: cancelledAssignment.assignment.revision + 10,
      },
      yield* native.credential(),
      yield* nextId,
      yield* native.options(),
    ),
  );
  expect(
    yield* Schema.decodeUnknownEffect(RemoveCustomerPriceGroupActionConflictProblemSchema)(casFailure),
  ).toMatchObject({ code: 'customer_price_group_revision_conflict', status: 409 });
  expect((yield* native.fixture.evidence(native.coreEvidenceExecutor)).events).toEqual(beforeCas.events);
  const cancellation = yield* executeRemoveCustomerPriceGroupWithAuthorization(
    cancellationPayload,
    yield* native.credential(),
    yield* nextId,
    cancellationOptions,
  );
  expect(cancellation.assignment).toMatchObject({ effectiveFrom: cancelAt, effectiveTo: cancelAt, state: 'CANCELLED' });
  const evidenceBeforeReplay = yield* native.fixture.evidence(native.coreEvidenceExecutor);
  const cancellationReplay = yield* Effect.flip(
    executeRemoveCustomerPriceGroupWithAuthorization(
      cancellationPayload,
      yield* native.credential(),
      yield* nextId,
      cancellationOptions,
    ),
  );
  expect(Schema.is(RemoveCustomerPriceGroupActionAlreadyCommittedProblemSchema)(cancellationReplay)).toBe(true);
  expect((yield* native.fixture.evidence(native.coreEvidenceExecutor)).events).toEqual(evidenceBeforeReplay.events);
  yield* observe(cancelAt);
  yield* diagnosticStage('P_SAME_START_CANCELLATION_NONE_BEGIN');
  expect(
    Schema.is(CustomerPriceGroupResolutionSchema.members[1])(
      (yield* publicResolution(native, retail, cancelAt, retailSubject)).resolution,
    ),
  ).toBe(true);
  yield* diagnosticStage('P_SAME_START_CANCELLATION_NONE_DONE');
  const concurrentStart = atOffset(DateTime.formatIso(yield* DateTime.now), 8000);
  const concurrentAssignment = yield* assignRetail(subjects.first.identity.priceGroupRef, concurrentStart);
  const attempts = [atOffset(concurrentStart, -3000), atOffset(concurrentStart, -2000)].map((effectiveAt) => ({
    effectiveAt,
    payload: {
      assignmentRef: concurrentAssignment.assignment.assignmentRef,
      effectiveAt,
      expectedRevision: concurrentAssignment.assignment.revision,
      profile: retail,
      reason: 'Concurrent exact inverted cancellation intent',
    },
  }));
  const beforeRace = yield* native.fixture.evidence(native.coreEvidenceExecutor);
  const raced = yield* Effect.all(
    attempts.map((attempt) =>
      Effect.result(
        Effect.gen(function* publicConcurrentRemoval() {
          return yield* executeRemoveCustomerPriceGroupWithAuthorization(
            attempt.payload,
            yield* native.credential(),
            yield* nextId,
            yield* native.options(),
          );
        }),
      ),
    ),
    { concurrency: 2 },
  );
  const successes = raced.filter(Result.isSuccess);
  const failures = raced.filter(Result.isFailure);
  expect(successes).toHaveLength(1);
  expect(failures).toHaveLength(1);
  const [winner] = successes;
  const [loser] = failures;
  if (winner === undefined || loser === undefined) {
    return yield* fail('concurrent-outcome');
  }
  expect(winner.success.changed).toBe(true);
  expect(winner.success.assignment.state).toBe('CANCELLED');
  expect(winner.success.assignment.effectiveFrom).toBe(concurrentStart);
  expect(attempts.map((attempt) => attempt.effectiveAt)).toContain(winner.success.assignment.effectiveTo);
  expect(
    winner.success.assignment.effectiveTo !== null && winner.success.assignment.effectiveTo < concurrentStart,
  ).toBe(true);
  expect(Schema.is(RemoveCustomerPriceGroupActionConflictProblemSchema)(loser.failure)).toBe(true);
  const afterRace = yield* native.fixture.evidence(native.coreEvidenceExecutor);
  expect(afterRace.events).toHaveLength(beforeRace.events.length + 1);
  expect(afterRace.outbox).toHaveLength(beforeRace.outbox.length + 1);
  expect(afterRace.audits.filter((audit) => audit.outcome === 'succeeded')).toHaveLength(
    beforeRace.audits.filter((audit) => audit.outcome === 'succeeded').length + 1,
  );
  const retainedRace = yield* executeCustomerPriceGroupAssignmentReadWithAuthorization(
    {
      authorizationSubject: retailSubject,
      profile: retail,
    },
    yield* native.credential(),
    yield* nextId,
    { baseUrl: native.receiver.baseUrl, compositionRevision: native.snapshot.composition.revision },
  );
  expect(
    retainedRace.assignments.find(
      (assignment) => assignment.assignmentRef.resourceId === concurrentAssignment.assignment.assignmentRef.resourceId,
    ),
  ).toEqual(winner.success.assignment);
  yield* observe(concurrentStart);
  yield* diagnosticStage('P_CANCELLATION_NONE_BEGIN');
  expect(
    Schema.is(CustomerPriceGroupResolutionSchema.members[1])(
      (yield* publicResolution(native, retail, concurrentStart, retailSubject)).resolution,
    ),
  ).toBe(true);
  yield* diagnosticStage('P_CANCELLATION_NONE_DONE');
  expect((yield* native.receiver.invoke('stop')).type).toBe('STOPPED');
  expect(yield* native.receiver.child.exitCode).toBe(0);
  return yield* Effect.void;
});
const catalogScopeScenario = Effect.fn('TemporalNative.catalogScope')(function* catalogScope() {
  const {
    assignCounterparty,
    assignRetail,
    counterparty,
    counterpartyRef,
    native,
    retail,
    start,
    subjects,
    transition,
  } = yield* makeTemporalCase('current');
  const retailSubject = { kind: 'RETAIL' as const };
  const counterpartySubject = { counterpartyRef, kind: 'COUNTERPARTY' as const };
  yield* assignRetail(subjects.first.identity.priceGroupRef, start);
  yield* assignCounterparty(subjects.first.identity.priceGroupRef, start);
  yield* assignRetail(subjects.second.identity.priceGroupRef, transition);
  const secondCounterparty = yield* assignCounterparty(subjects.second.identity.priceGroupRef, transition);
  yield* observe(transition);
  const futureAt = atOffset(DateTime.formatIso(yield* DateTime.now), 5000);
  const incompatibleFailure = yield* Effect.flip(assignRetail(subjects.incompatible.identity.priceGroupRef, futureAt));
  expect(
    yield* Schema.decodeUnknownEffect(AssignCustomerPriceGroupActionIneligibleProblemSchema)(incompatibleFailure),
  ).toMatchObject({ code: 'customer_price_group_catalog_rejected', status: 422 });
  const missingGroupRef = { ...subjects.first.identity.priceGroupRef, resourceId: yield* nextId };
  yield* subjects.grant('pricing.price_group.read', {
    kind: 'price_group',
    priceGroupId: missingGroupRef.resourceId,
    pricingCatalogId: native.actor.tenantId,
    tenantId: native.actor.tenantId,
  });
  const beforeMissing = yield* nativeOwnerInventory(native);
  const missingGroup = yield* Effect.flip(assignRetail(missingGroupRef, futureAt));
  expect(
    yield* Schema.decodeUnknownEffect(AssignCustomerPriceGroupActionNotFoundProblemSchema)(missingGroup),
  ).toMatchObject({
    code: 'customer_price_group_catalog_rejected',
    status: 404,
  });
  expect(yield* nativeOwnerInventory(native)).toEqual(beforeMissing);
  // Real owner write, followed by a Core flush event failure in the receiving process.
  const inventoryBeforeFault = yield* nativeOwnerInventory(native);
  const evidenceBeforeFault = yield* native.fixture.evidence(native.coreEvidenceExecutor);
  yield* Effect.scoped(
    Effect.gen(function* genuineChildRollback() {
      yield* rejectAssignedEvent(native);
      const rejected = yield* Effect.flip(
        assignRetail(subjects.first.identity.priceGroupRef, atOffset(DateTime.formatIso(yield* DateTime.now), 5000)),
      );
      expect(Schema.is(AssignCustomerPriceGroupActionUnavailableProblemSchema)(rejected)).toBe(true);
    }),
  );
  expect(yield* nativeOwnerInventory(native)).toEqual(inventoryBeforeFault);
  const evidenceAfterFault = yield* native.fixture.evidence(native.coreEvidenceExecutor);
  expect(evidenceAfterFault.events).toEqual(evidenceBeforeFault.events);
  expect(evidenceAfterFault.outbox).toEqual(evidenceBeforeFault.outbox);
  expect(evidenceAfterFault.audits.filter((audit) => audit.outcome === 'succeeded')).toEqual(
    evidenceBeforeFault.audits.filter((audit) => audit.outcome === 'succeeded'),
  );
  const deniedRead = yield* Effect.flip(
    executeCustomerPriceGroupResolutionWithAuthorization(
      {
        authorizationSubject: retailSubject,
        effectiveAt: start,
        profile: retail,
      },
      yield* native.authority.issue({ ...native.fixture.denied, legalEntityId: native.fixture.legalEntityId }),
      yield* nextId,
      { baseUrl: native.receiver.baseUrl, compositionRevision: native.snapshot.composition.revision },
    ),
  );
  expect(Schema.is(CustomerPriceGroupResolutionForbiddenProblemSchema)(deniedRead)).toBe(true);
  const absentProfile = { ...retail, resourceId: yield* nextId };
  yield* subjects.resource(absentProfile);
  yield* subjects.grant('retail.profile.read', {
    kind: 'retail_profile',
    legalEntityId: native.fixture.legalEntityId,
    profileId: absentProfile.resourceId,
    tenantId: native.actor.tenantId,
  });
  const absent = yield* Effect.flip(publicResolution(native, absentProfile, start, retailSubject));
  // The existing owner authorization overlay cannot establish authority over an absent profile;
  // it maps that lookup failure to unavailable before the generated Read handler is entered.
  expect(yield* Schema.decodeUnknownEffect(CustomerPriceGroupResolutionUnavailableProblemSchema)(absent)).toMatchObject(
    { status: 503 },
  );
  const secondary = native.fixture.secondaryLegalEntity;
  if (secondary === undefined) {
    return yield* fail('real-secondary-sle');
  }
  const wrongSle = yield* Effect.flip(
    executeCustomerPriceGroupResolutionWithAuthorization(
      {
        authorizationSubject: retailSubject,
        effectiveAt: start,
        profile: retail,
      },
      yield* native.authority.issue(secondary.manager),
      yield* nextId,
      { baseUrl: native.receiver.baseUrl, compositionRevision: native.snapshot.composition.revision },
    ),
  );
  expect(Schema.is(CustomerPriceGroupResolutionForbiddenProblemSchema)(wrongSle)).toBe(true);
  const foreign = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionExecutor: 'manager-only',
      actionKeys: [],
      adminConnectionString: Redacted.make(native.isolated.connections.admin.connectionString),
      allowedAudiences: ['commerce-customer-context'],
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: native.snapshot.composition.revision,
      moduleKeys: ['commerce.customer-context'],
      runtimeConnectionString: Redacted.make(native.isolated.connections.runtime.connectionString),
    }),
    (resource) => Effect.orDie(resource.close()),
  );
  expect(foreign.tenantId).not.toBe(native.actor.tenantId);
  const foreignRead = yield* Effect.flip(
    executeCustomerPriceGroupResolutionWithAuthorization(
      {
        authorizationSubject: retailSubject,
        effectiveAt: start,
        profile: retail,
      },
      yield* native.authority.issue({ ...foreign.manager, legalEntityId: foreign.legalEntityId }),
      yield* nextId,
      { baseUrl: native.receiver.baseUrl, compositionRevision: native.snapshot.composition.revision },
    ),
  );
  expect(Schema.is(CustomerPriceGroupResolutionForbiddenProblemSchema)(foreignRead)).toBe(true);
  const wrongKind = { ...counterparty, resourceId: retail.resourceId };
  yield* subjects.resource(wrongKind);
  const kindInventory = yield* nativeOwnerInventory(native);
  const kindFailure = yield* Effect.flip(
    executeAssignCounterpartyPriceGroupWithAuthorization(
      {
        counterpartyRef,
        effectiveFrom: atOffset(DateTime.formatIso(yield* DateTime.now), 5000),
        expectedProfileRevision: subjects.retail.revision,
        priceGroupRef: subjects.first.identity.priceGroupRef,
        profile: wrongKind,
        reason: 'An actual Retail row is not a Counterparty profile',
      },
      yield* native.credential(),
      yield* nextId,
      yield* native.options(),
    ),
  );
  expect(
    yield* Schema.decodeUnknownEffect(AssignCounterpartyPriceGroupActionNotFoundProblemSchema)(kindFailure),
  ).toMatchObject({
    code: 'customer_price_group_profile_not_found',
    status: 404,
  });
  expect(yield* nativeOwnerInventory(native)).toEqual(kindInventory);
  const siblingCounterparty = yield* native.receiver.invoke('CREATE_SECOND_COUNTERPARTY');
  if (siblingCounterparty.type !== 'COUNTERPARTY_CREATED') {
    return yield* fail('second-counterparty-order');
  }
  expect(siblingCounterparty.counterpartyRef.resourceId).not.toBe(counterpartyRef.resourceId);
  expect(siblingCounterparty.counterpartyRef.tenantId).toBe(counterpartyRef.tenantId);
  yield* subjects.resource(siblingCounterparty.partyRef);
  yield* subjects.resource(siblingCounterparty.counterpartyRef);
  const siblingProfile = yield* executeCreateCounterpartyPurchasingProfileWithAuthorization(
    {
      effectiveAt: DateTime.formatIso(yield* DateTime.now),
      subject: {
        counterpartyRef: siblingCounterparty.counterpartyRef,
        kind: 'COUNTERPARTY',
        sellingLegalEntityRef: {
          moduleId: 'core.identity',
          resourceId: native.fixture.legalEntityId,
          resourceType: 'core.identity.legal-entity',
          tenantId: native.actor.tenantId,
        },
      },
      trigger: 'AUTHORIZED_ONBOARDING',
    },
    yield* native.credential(),
    yield* nextId,
    yield* native.options(),
  );
  expect(siblingProfile.profileRef.resourceId).not.toBe(subjects.counterpartyProfile.profileRef.resourceId);
  yield* subjects.resource(siblingProfile.profileRef);
  yield* subjects.grant('counterparty.settings.price_group.manage', {
    counterpartyId: siblingCounterparty.counterpartyRef.resourceId,
    kind: 'counterparty',
    legalEntityId: native.fixture.legalEntityId,
    tenantId: native.actor.tenantId,
  });
  yield* subjects.grantCounterpartyOwner(
    'counterparty.settings.price_group.manage',
    siblingCounterparty.counterpartyRef,
  );
  const associationInventory = yield* nativeOwnerInventory(native);
  const association = yield* Effect.flip(
    executeAssignCounterpartyPriceGroupWithAuthorization(
      {
        counterpartyRef: siblingCounterparty.counterpartyRef,
        effectiveFrom: atOffset(DateTime.formatIso(yield* DateTime.now), 5000),
        expectedProfileRevision: subjects.counterpartyProfile.revision,
        priceGroupRef: subjects.first.identity.priceGroupRef,
        profile: counterparty,
        reason: 'A genuine second Counterparty does not own this profile',
      },
      yield* native.credential(),
      yield* nextId,
      yield* native.options(),
    ),
  );
  expect(
    yield* Schema.decodeUnknownEffect(AssignCounterpartyPriceGroupActionNotFoundProblemSchema)(association),
  ).toMatchObject({
    code: 'customer_price_group_profile_not_found',
    status: 404,
  });
  expect(yield* nativeOwnerInventory(native)).toEqual(associationInventory);
  const revisionResponse = yield* native.receiver.invoke('REVISE_G2');
  if (revisionResponse.type !== 'REVISED_G2') {
    return yield* fail('revision-order');
  }
  yield* observe(revisionResponse.result.effectivePeriod.effectiveFrom);
  const originalAsOf = yield* Schema.decodeUnknownEffect(CustomerPriceGroupResolutionSchema.members[0])(
    (yield* publicResolution(native, counterparty, transition, counterpartySubject)).resolution,
  );
  expect(originalAsOf.compatibility.definitionRevisionNumber).toBe(subjects.second.initialDefinition.revisionNumber);
  const revisedCurrent = yield* Schema.decodeUnknownEffect(CustomerPriceGroupResolutionSchema.members[0])(
    (yield* publicResolution(
      native,
      counterparty,
      revisionResponse.result.effectivePeriod.effectiveFrom,
      counterpartySubject,
    )).resolution,
  );
  expect(revisedCurrent.compatibility.definitionRevisionNumber).toBe(revisionResponse.result.revisionNumber);
  expect(secondCounterparty.assignment.compatibility?.definitionRevisionNumber).toBe(
    subjects.second.initialDefinition.revisionNumber,
  );
  const retirementResponse = yield* native.receiver.invoke('RETIRE_G2');
  if (retirementResponse.type !== 'RETIRED_G2') {
    return yield* fail('retirement-order');
  }
  yield* observe(retirementResponse.result.retirementEffectiveAt);
  expect(
    yield* Schema.decodeUnknownEffect(CustomerPriceGroupResolutionSchema.members[2])(
      (yield* publicResolution(
        native,
        counterparty,
        retirementResponse.result.retirementEffectiveAt,
        counterpartySubject,
      )).resolution,
    ),
  ).toMatchObject({ priceGroupRef: subjects.second.identity.priceGroupRef, reason: 'RETIRED' });
  const unavailable = yield* native.receiver.invoke('STOP_CATALOG');
  expect(unavailable.type).toBe('CATALOG_STOPPED');
  const unavailableRead = yield* Effect.flip(publicResolution(native, retail, start, retailSubject));
  expect(Schema.is(CustomerPriceGroupResolutionUnavailableProblemSchema)(unavailableRead)).toBe(true);
  expect((yield* native.receiver.invoke('stop')).type).toBe('STOPPED');
  expect(yield* native.receiver.child.exitCode).toBe(0);
  return yield* Effect.void;
});
const executorDeniedScenario = Effect.fn('TemporalNative.executorDenied')(function* executorDeniedScenario() {
  const infrastructure = yield* TemporalCaseInfrastructure;
  yield* requireCondition(
    infrastructure.mode === 'current' && infrastructure.executorControl === 'without-catalog-create',
    'case-executor-control',
  );
  const { native } = infrastructure;
  const business = Context.get(
    yield* Layer.build(BusinessPermissionRelationshipMutationLive),
    BusinessPermissionRelationshipMutation,
  );
  const grant = {
    permission: 'pricing.price_group.create' as const,
    principal: { principalId: native.actor.principalId, tenantId: native.actor.tenantId },
    target: {
      kind: 'pricing_catalog' as const,
      pricingCatalogId: native.actor.tenantId,
      tenantId: native.actor.tenantId,
    },
  };
  yield* business.mutate({ ...grant, operation: 'grant' });
  yield* Effect.addFinalizer(() => Effect.orDie(business.mutate({ ...grant, operation: 'revoke' })));
  const denied = yield* Effect.flip(native.receiver.invoke('CREATE_G1'));
  expect(yield* Schema.decodeUnknownEffect(TemporalNativeFailure)(denied)).toMatchObject({
    stage: 'CREATE_FORBIDDEN',
  });
  const stopped = yield* native.receiver.invoke('stop');
  expect(stopped.type).toBe('STOPPED');
});

const temporalArtifactMemoMap = Layer.makeMemoMapUnsafe();
it.layer(temporalArtifactsLayer, { excludeTestServices: true, memoMap: temporalArtifactMemoMap, timeout: 120_000 })(
  () => {
    it.layer(temporalCaseLayer('before').pipe(Layer.provideMerge(temporalArtifactsLayer)), {
      excludeTestServices: true,
      memoMap: temporalArtifactMemoMap,
      timeout: 120_000,
    })((caseIt) => {
      caseIt.effect(
        'preserves actual Retail and Counterparty effective periods, forward journal identity, and restarted original audit',
        () => Effect.scoped(temporalScenario()),
        // Native scenario bodies measure 19–31s locally; keep headroom for the slower CI runner.
        120_000,
      );
    });

    it.layer(temporalCaseLayer('current').pipe(Layer.provideMerge(temporalArtifactsLayer)), {
      excludeTestServices: true,
      memoMap: temporalArtifactMemoMap,
      timeout: 120_000,
    })((caseIt) => {
      caseIt.effect(
        'retains same-start and inverted cancellation intent with one genuine concurrent removal winner',
        () => Effect.scoped(cancellationScenario()),
        120_000,
      );
    });

    it.layer(temporalCaseLayer('current').pipe(Layer.provideMerge(temporalArtifactsLayer)), {
      excludeTestServices: true,
      memoMap: temporalArtifactMemoMap,
      timeout: 120_000,
    })((caseIt) => {
      caseIt.effect(
        'separates genuine missing incompatible retired unavailable Catalog, wrong scope, and child rollback outcomes',
        () => Effect.scoped(catalogScopeScenario()),
        120_000,
      );
    });

    it.layer(temporalCaseLayer('current').pipe(Layer.provideMerge(temporalArtifactsLayer)), {
      excludeTestServices: true,
      memoMap: temporalArtifactMemoMap,
      timeout: 120_000,
    })((caseIt) => {
      caseIt.effect(
        'preserves open and finite Retail and Counterparty schedules through same-start replacement and exclusive expiry',
        () => Effect.scoped(openAndFiniteScenario()),
        120_000,
      );
    });

    it.layer(temporalCaseLayer('current', 'without-catalog-create').pipe(Layer.provideMerge(temporalArtifactsLayer)), {
      excludeTestServices: true,
      memoMap: temporalArtifactMemoMap,
      timeout: 120_000,
    })((caseIt) => {
      caseIt.effect(
        'keeps the real Price Group create executor gate independent of its granted business Permission',
        () => Effect.scoped(executorDeniedScenario()),
      );
    });
  },
);
