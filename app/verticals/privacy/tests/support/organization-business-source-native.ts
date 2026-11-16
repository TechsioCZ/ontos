import type { DatabaseConnectionPair } from '@app/core-runtime';
import { configureDatabasePool, parseDatabaseConnectionPair } from '@app/core-runtime';
import { requireOwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import type { OwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { PgClient } from '@effect/sql-pg';
import {
  OrganizationBusinessOnboardFields,
  OrganizationBusinessSourceFields,
  OrganizationBusinessSourceReferenceSchema,
} from '@app/party-registry/apis/organization-record-facts';
import { ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS } from '@app/commerce-customer-context/domain/organization-profile-source';
import { SymmySourceOrganizationFactsGovernanceSelectorSchema } from '@app/symmy-integration/api/symmy-source-organization-facts';
import { and, eq, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, Crypto, DateTime, Effect, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import {
  OrganizationBusinessApplicabilityContextSchema,
  OrganizationBusinessSourceIntentSchema,
} from '../../shared/apis/organization-business-applicability.ts';
import { RecordPrivacyApplicabilityPayloadSchema } from '../../shared/actions/record-privacy-applicability.ts';
import {
  PrivacyApplicabilityAuthoritySchema,
  PrivacyApplicabilityDecisionSchema,
  PrivacyApplicabilityPolicySchema,
} from '../../shared/domain/privacy-applicability.ts';
import { PrivacyResponsibilityAssignmentSchema } from '../../shared/domain/privacy-responsibility-assignment.ts';
import { PrivacySubjectRecordSchema, privacySourceSubjectIdentityKey } from '../../shared/domain/privacy-subject.ts';
import { organizationBusinessSourceAuthorityForScope } from '../../src/services/organization-business-applicability.service.ts';
import {
  applicabilityDecisions,
  applicabilityPolicies,
  privacyRelations,
  privacySubjects,
  processingPurposes,
  purposeVersions,
  responsibilityAssignments,
} from '../../src/database/schema.ts';

const PRIVACY_MODULE_ID = 'privacy.core';
const Uuid = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('OrganizationBusinessSourceFixtureUuid'),
  Schema.decodeTo(Schema.String),
);
const fieldsByOperation = {
  COUNTERPARTY_PROFILE_CREATE: ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS,
  CREATE: OrganizationBusinessSourceFields,
  MATCH: OrganizationBusinessSourceFields,
  ONBOARD_COUNTERPARTY_CUSTOMER: OrganizationBusinessOnboardFields,
};
const sameSource = Schema.toEquivalence(OrganizationBusinessSourceReferenceSchema);
const SeedSchema = Schema.Struct({
  callers: Schema.Array(
    Schema.Struct({
      authMethod: Schema.Literals(['session', 'api_key', 'system', 'support_impersonation']),
      principalId: Uuid,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  governancePrincipalId: Uuid,
  governanceSelector: SymmySourceOrganizationFactsGovernanceSelectorSchema,
  intent: OrganizationBusinessSourceIntentSchema,
  legalEntityId: Uuid,
  purpose: Schema.Literal('implementation-1096-registered-workload-gateway'),
  tenantId: Uuid,
}).check(
  Schema.makeFilter((seed) => {
    if (!sameSource(seed.intent.sourceReference, seed.governanceSelector.sourceReference)) {
      return 'Governance selector must name the exact source occurrence';
    }
    const fields = new Set<string>(seed.intent.fields);
    const expectedFields = fieldsByOperation[seed.intent.operation];
    if (fields.size !== expectedFields.length || !expectedFields.every((field) => fields.has(field))) {
      return 'The full actual source projection field contract is required';
    }
    return new Set(seed.callers.map(({ authMethod, principalId }) => `${authMethod}:${principalId}`)).size ===
      seed.callers.length
      ? undefined
      : 'Each actual caller must occur once';
  }),
);
export type OrganizationBusinessSourceNativeFixtureInput = typeof SeedSchema.Type & {
  readonly connections: DatabaseConnectionPair;
  readonly ownedDatabase: OwnedNativeDatabaseFixture;
};
type Seed = typeof SeedSchema.Type;
export class OrganizationBusinessSourceNativeFixtureError extends Schema.TaggedError<OrganizationBusinessSourceNativeFixtureError>()(
  'OrganizationBusinessSourceNativeFixtureError',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}
const unavailable = (cause?: unknown) => {
  const reason = 'The owned organization source governance fixture is unavailable';
  if (cause === undefined) {
    return new OrganizationBusinessSourceNativeFixtureError({ reason });
  }
  return new OrganizationBusinessSourceNativeFixtureError({ cause: Redacted.make(cause), reason });
};
type PrivacyExecutor = Effect.Success<ReturnType<typeof makeWithDefaults<typeof privacyRelations>>>;
type PrivacyTransaction = Parameters<Parameters<PrivacyExecutor['transaction']>[0]>[0];
const asDate = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));
const IdentitySchema = Schema.Struct({
  address: Schema.OptionFromNullOr(Schema.String),
  bypass: Schema.Boolean,
  database: Schema.String,
  databaseOid: Schema.String,
  port: Schema.OptionFromNullOr(Schema.Number),
  role: Schema.String,
  roleOid: Schema.String,
  superuser: Schema.Boolean,
});
const sameNativePair = (
  administrative: readonly (typeof IdentitySchema.Type)[],
  operational: readonly (typeof IdentitySchema.Type)[],
  connections: DatabaseConnectionPair,
) => {
  const a = administrative.at(0);
  const r = operational.at(0);
  return (
    administrative.length === 1 &&
    operational.length === 1 &&
    a !== undefined &&
    r !== undefined &&
    a.database === connections.admin.database &&
    r.database === connections.runtime.database &&
    a.databaseOid === r.databaseOid &&
    a.role === connections.admin.user &&
    r.role === connections.runtime.user &&
    a.roleOid !== r.roleOid &&
    (a.superuser || a.bypass) &&
    !r.superuser &&
    !r.bypass &&
    Option.getOrElse(a.address, () => '') === Option.getOrElse(r.address, () => '') &&
    Option.getOrElse(a.port, () => 0) === Option.getOrElse(r.port, () => 0)
  );
};
const assertIsolatedConnections = Effect.fn('PrivacyOrganizationBusinessSourceNative.assertIsolatedConnections')(
  function* assertIsolatedConnections(connections: DatabaseConnectionPair) {
    const deployment = yield* Config.option(Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'));
    const { admin, runtime } = connections;
    const parsed = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: admin.connectionString,
      DATABASE_URL: runtime.connectionString,
    }).pipe(Effect.mapError(unavailable));
    const metadataMatches = (actual: typeof admin, declared: typeof admin) =>
      actual.database === declared.database &&
      actual.host === declared.host &&
      actual.port === declared.port &&
      actual.user === declared.user;
    if (!metadataMatches(parsed.admin, admin) || !metadataMatches(parsed.runtime, runtime)) {
      return yield* unavailable();
    }
    if (
      (Option.isSome(deployment) && ['stage', 'production'].includes(deployment.value)) ||
      !/^ontos_test_party_gateway_[a-f\d]{32}$/u.test(admin.database) ||
      admin.database !== runtime.database ||
      admin.user === runtime.user ||
      admin.host !== runtime.host ||
      admin.port !== runtime.port ||
      !['localhost', '127.0.0.1'].includes(admin.host)
    ) {
      return yield* unavailable();
    }
    return yield* Effect.void;
  },
);

const withNativeTransaction = <A, E, R>(
  input: OrganizationBusinessSourceNativeFixtureInput,
  work: (transaction: PrivacyTransaction) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* verifiedTransaction() {
    const { connections } = input;
    const requireOwnership = requireOwnedNativeDatabaseFixture(input.ownedDatabase, {
      adminConnectionString: Redacted.make(connections.admin.connectionString),
      purpose: input.purpose,
      runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
    }).pipe(Effect.mapError(unavailable));
    yield* requireOwnership;
    yield* assertIsolatedConnections(connections);
    const { admin, runtime } = connections;
    const [adminConfiguration, runtimeConfiguration] = yield* Effect.all([
      configureDatabasePool(Redacted.make(admin.connectionString)),
      configureDatabasePool(Redacted.make(runtime.connectionString)),
    ]).pipe(Effect.mapError(unavailable));
    const adminClient = yield* PgClient.make({ ...adminConfiguration, maxConnections: 1 }).pipe(
      Effect.mapError(unavailable),
    );
    const runtimeClient = yield* PgClient.make({ ...runtimeConfiguration, maxConnections: 1 }).pipe(
      Effect.mapError(unavailable),
    );
    const [adminRows, runtimeRows] = yield* Effect.all([
      adminClient`select current_database() as database, current_user as role,
        d.oid::text as "databaseOid", r.oid::text as "roleOid", r.rolsuper as superuser,
        r.rolbypassrls as bypass, inet_server_addr()::text as address, inet_server_port() as port
        from pg_database d cross join pg_roles r where d.datname=current_database() and r.rolname=current_user`,
      runtimeClient`select current_database() as database, current_user as role,
        d.oid::text as "databaseOid", r.oid::text as "roleOid", r.rolsuper as superuser,
        r.rolbypassrls as bypass, inet_server_addr()::text as address, inet_server_port() as port
        from pg_database d cross join pg_roles r where d.datname=current_database() and r.rolname=current_user`,
    ]).pipe(Effect.mapError(unavailable));
    const [administrative, operational] = yield* Effect.all([
      Schema.decodeUnknownEffect(Schema.Array(IdentitySchema))(adminRows),
      Schema.decodeUnknownEffect(Schema.Array(IdentitySchema))(runtimeRows),
    ]).pipe(Effect.mapError(unavailable));
    if (!sameNativePair(administrative, operational, connections)) {
      return yield* unavailable();
    }
    const database = yield* makeWithDefaults({ relations: privacyRelations }).pipe(
      Effect.provideService(PgClient.PgClient, adminClient),
    );

    return yield* database.transaction((transaction) =>
      Effect.gen(function* verifiedWork() {
        const challengeRows = yield* transaction.execute(
          sql`select hashtextextended(gen_random_uuid()::text, 0)::text as key`,
          'objects',
        );
        const challenges = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ key: Schema.String.check(Schema.isPattern(/^-?\d+$/u)) })),
        )(challengeRows);
        const challenge = challenges.at(0);
        if (challenges.length !== 1 || challenge === undefined) {
          return yield* unavailable();
        }
        yield* transaction.execute(sql`select pg_advisory_xact_lock(${challenge.key}::bigint)`, 'objects');
        const response = yield* runtimeClient.withTransaction(
          runtimeClient`select pg_try_advisory_xact_lock(${challenge.key}::bigint) as acquired`,
        );
        const matched = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ acquired: Schema.Literal(false) })),
        )(response);
        if (matched.length !== 1) {
          return yield* unavailable();
        }

        yield* requireOwnership;
        return yield* work(transaction);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(Reactivity.layer), Effect.mapError(unavailable));

const prepare = Effect.fn('PrivacyOrganizationBusinessSourceNative.prepare')(function* prepare(
  transaction: PrivacyTransaction,
  seed: Seed,
) {
  const crypto = yield* Crypto.Crypto;
  const id = yield* crypto.randomUUIDv4();
  const purposeId = yield* crypto.randomUUIDv4();
  const versionId = yield* crypto.randomUUIDv4();
  const now = yield* DateTime.now;
  const from = DateTime.formatIso(DateTime.subtract(now, { minutes: 1 }));
  const until = DateTime.formatIso(DateTime.add(now, { hours: 1 }));
  const scope = { legalEntityId: seed.legalEntityId, tenantId: seed.tenantId };
  const source = seed.intent.sourceReference;
  const sourceLocator = { ...source.source, recordId: source.recordId };
  const sourceKey = privacySourceSubjectIdentityKey(sourceLocator);
  const sourceLockKey = `${seed.tenantId}:${seed.legalEntityId}:${sourceKey}`;
  // Serialize admission of this exact source identity; the original source record is immutable.
  yield* transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${sourceLockKey},0))`, 'objects');
  const existing = yield* transaction
    .select({ id: privacySubjects.privacySubjectId })
    .from(privacySubjects)
    .where(
      and(
        eq(privacySubjects.tenantId, seed.tenantId),
        eq(privacySubjects.legalEntityId, seed.legalEntityId),
        eq(privacySubjects.subjectKind, 'SOURCE_ASSERTED'),
        eq(privacySubjects.sourceIdentityKey, sourceKey),
      ),
    )
    .limit(1);
  if (existing.length === 0) {
    const subjectId = yield* crypto.randomUUIDv4();
    const record = yield* Schema.decodeUnknownEffect(PrivacySubjectRecordSchema)({
      createdAt: from,
      subject: { kind: 'SOURCE_ASSERTED', source: sourceLocator },
      subjectRef: {
        moduleId: PRIVACY_MODULE_ID,
        resourceId: subjectId,
        resourceType: 'privacy.core.privacy-subject',
        tenantId: seed.tenantId,
      },
      updatedAt: from,
    });
    yield* transaction.insert(privacySubjects).values({
      ...scope,
      privacySubjectId: subjectId,
      sourceIdentityKey: sourceKey,
      subjectKind: 'SOURCE_ASSERTED',
      subjectRecord: yield* Schema.encodeEffect(PrivacySubjectRecordSchema)(record),
    });
  }
  const snapshot = yield* organizationBusinessSourceAuthorityForScope(transaction, scope).read(source);
  if (snapshot.reconciled || snapshot.protections.length !== 0) {
    return yield* unavailable();
  }
  const authority = yield* Schema.decodeUnknownEffect(PrivacyApplicabilityAuthoritySchema)({
    ...scope,
    controllerRef: {
      moduleId: 'core.identity',
      resourceId: seed.legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId: seed.tenantId,
    },
    purposeRef: {
      moduleId: PRIVACY_MODULE_ID,
      resourceId: purposeId,
      resourceType: 'privacy.core.processing-purpose',
      tenantId: seed.tenantId,
    },
    purposeVersionRef: {
      moduleId: PRIVACY_MODULE_ID,
      resourceId: versionId,
      resourceType: 'privacy.core.processing-purpose-version',
      tenantId: seed.tenantId,
    },
  });
  const processingScopeRef = {
    scopeId: `internal:organization-source-scope:${id}`,
    scopeType: 'privacy.processing-scope',
  };
  const facts = [
    {
      dimension: 'OWNER_RESOURCE',
      value: `${snapshot.record.subjectRef.resourceType}:${snapshot.record.subjectRef.resourceId}`,
    },
    { dimension: 'OWNER_RESOURCE_REVISION', value: snapshot.revision },
    { dimension: 'SOURCE_CLASSIFICATION', value: 'SOURCE_ASSERTED_ORGANIZATION' },
    { dimension: 'SOURCE_OCCURRENCE', value: source.occurrenceId },
    { dimension: 'SOURCE_PROJECTION_DIGEST', value: seed.intent.inputDigest },
    { dimension: 'CATEGORY', value: seed.intent.projectionVersion },
    { dimension: 'INTENDED_USE', value: seed.intent.operation },
    { dimension: 'CONTROLLER_SCOPE', value: seed.legalEntityId },
    { dimension: 'PROCESSING_PURPOSE', value: purposeId },
    { dimension: 'PROCESSING_PURPOSE_VERSION', value: versionId },
    { dimension: 'TENANT', value: seed.tenantId },
  ];
  const policy = yield* Schema.decodeUnknownEffect(PrivacyApplicabilityPolicySchema)({
    composition: { precedence: 10, strategy: 'EXPLICIT_PRECEDENCE' },
    effectiveFrom: from,
    effectiveTo: until,
    factPredicates: facts.map(({ dimension, value }) => ({ dimension, operator: 'EQUALS', values: [value] })),
    jurisdictionProfile: { profileKey: 'INTERNAL_ORGANIZATION_SOURCE_CLASSIFICATION', profileVersion: '1' },
    mandatoryDimensions: facts.map(({ dimension }) => dimension),
    nonPersonalApplicability: {
      allowedFields: seed.intent.fields,
      classification: 'SOURCE_ASSERTED_ORGANIZATION',
      consumerModuleId: seed.intent.consumerModuleId,
      holdBehavior: 'NO_ACTIVE_SCOPE_HOLD',
      kind: 'ORGANIZATION_BUSINESS_ONLY',
      operation: seed.intent.operation,
      projectionVersion: seed.intent.projectionVersion,
    },
    policyKey: `internal:organization-source-policy:${id}`,
    policyVersion: '1',
    scopeKey: `privacy.processing-scope:${processingScopeRef.scopeId}:${seed.intent.operation}`,
    sourceEvidenceRefs: [`internal:explicit-organization-source-policy:${id}`],
  });
  const responsibility = yield* Schema.decodeUnknownEffect(PrivacyResponsibilityAssignmentSchema)({
    actor: { principalId: seed.governancePrincipalId, tenantId: seed.tenantId },
    assignmentRef: {
      moduleId: PRIVACY_MODULE_ID,
      resourceId: `internal:organization-source-controller:${id}`,
      resourceType: 'privacy.core.privacy-responsibility-assignment',
      tenantId: seed.tenantId,
    },
    effectiveFrom: from,
    effectiveTo: null,
    holder: { holder: authority.controllerRef, holderKind: 'LEGAL_ENTITY' },
    provenance: {
      decisionEvidenceRefs: [`internal:explicit-controller:${id}`],
      reason: 'INTERNAL ONLY exact source organization governance fixture',
      recordedAt: from,
    },
    role: 'CONTROLLER',
    scopeRef: processingScopeRef,
  });
  const decisionRef = `internal:organization-source-decision:${id}`;
  const recordPayload = yield* Schema.decodeUnknownEffect(RecordPrivacyApplicabilityPayloadSchema)({
    decisionId: decisionRef,
    proposedActivity: false,
    responsibilityAssignmentRefs: [responsibility.assignmentRef],
    scope: { operation: seed.intent.operation, processingScopeRef },
  });
  const contexts = [];
  for (const caller of seed.callers) {
    contexts.push(
      yield* Schema.decodeUnknownEffect(OrganizationBusinessApplicabilityContextSchema)({
        ...scope,
        ...caller,
        authority,
        authorityIncarnation: `internal:organization-source-incarnation:${id}`,
        authorityRevision: 'internal:1',
        decisionRef,
        effectiveFrom: from,
        governanceSelector: seed.governanceSelector,
        processingScopeRef,
        request: seed.intent,
        validUntil: until,
      }),
    );
  }
  yield* transaction.insert(processingPurposes).values({
    ...scope,
    businessCode: `INTERNAL_${purposeId.replaceAll('-', '').toUpperCase()}`,
    governanceOwnerId: seed.governancePrincipalId,
    lifecycle: 'ACTIVE',
    processingPurposeId: purposeId,
  });
  yield* transaction.insert(purposeVersions).values({
    ...scope,
    actionInvocationId: yield* crypto.randomUUIDv4(),
    effectiveFrom: asDate(from),
    effectiveTo: asDate(until),
    meaning: 'INTERNAL ONLY explicit source organization processing classification',
    processingPurposeId: purposeId,
    purposeVersionId: versionId,
    requiredConsentDimensions: [],
    versionNumber: 1,
  });
  yield* transaction.insert(responsibilityAssignments).values({
    ...scope,
    actionInvocationId: yield* crypto.randomUUIDv4(),
    assignmentRecord: yield* Schema.encodeEffect(PrivacyResponsibilityAssignmentSchema)(responsibility),
    assignmentRef: responsibility.assignmentRef.resourceId,
    effectiveFrom: asDate(from),
    effectiveTo: null,
    role: 'CONTROLLER',
    scopeRef: processingScopeRef.scopeId,
  });
  yield* transaction.insert(applicabilityPolicies).values({
    ...scope,
    actionInvocationId: yield* crypto.randomUUIDv4(),
    effectiveFrom: asDate(from),
    effectiveTo: asDate(until),
    policyKey: policy.policyKey,
    policyRecord: yield* Schema.encodeEffect(PrivacyApplicabilityPolicySchema)(policy),
    policyVersion: '1',
    scopeKey: policy.scopeKey,
  });
  return {
    authority,
    contexts,
    decisionRef,
    intent: seed.intent,
    policyRef: policy.policyKey,
    processingScopeRef,
    purposeRef: authority.purposeRef,
    recordPayload,
    sourceSubjectRef: snapshot.record.subjectRef,
    sourceSubjectRevision: snapshot.revision,
  };
});
type Identity = Effect.Success<ReturnType<typeof prepare>>;
const observe = Effect.fn('PrivacyOrganizationBusinessSourceNative.observe')(function* observe(
  transaction: PrivacyTransaction,
  seed: Seed,
  identity: Identity,
) {
  const snapshot = yield* organizationBusinessSourceAuthorityForScope(transaction, {
    legalEntityId: seed.legalEntityId,
    tenantId: seed.tenantId,
  }).read(seed.intent.sourceReference);
  const [row] = yield* transaction
    .select({
      actionInvocationId: applicabilityDecisions.actionInvocationId,
      record: applicabilityDecisions.decisionRecord,
    })
    .from(applicabilityDecisions)
    .where(
      and(
        eq(applicabilityDecisions.tenantId, seed.tenantId),
        eq(applicabilityDecisions.legalEntityId, seed.legalEntityId),
        eq(applicabilityDecisions.decisionId, identity.decisionRef),
      ),
    )
    .limit(1);
  if (row === undefined) {
    return { decision: Option.none(), sourceSubjectRevision: snapshot.revision };
  }
  const record = yield* Schema.decodeUnknownEffect(PrivacyApplicabilityDecisionSchema)(row.record);
  return {
    decision: Option.some({
      actionInvocationId: row.actionInvocationId,
      authorityReceiptRef: Option.fromUndefinedOr(record.authorityReceiptRef),
      decisionRef: identity.decisionRef,
      evaluatedAt: record.evaluatedAt,
      evidenceRefs: record.evidenceRefs,
      outcome: record.outcome,
    }),
    sourceSubjectRevision: snapshot.revision,
  };
});
/** INTERNAL policy-only setup. It provides no source classification proof, basis, permission or decision.
 * Actual public RecordPrivacyApplicability must resolve the live native Symmy GOVERNANCE provider.
 */
export const seedOrganizationBusinessSourceNativeFixture = Effect.fn('PrivacyOrganizationBusinessSourceNative.seed')(
  function* seedOrganizationBusinessSourceNativeFixture(input: OrganizationBusinessSourceNativeFixtureInput) {
    const seed = yield* Schema.decodeUnknownEffect(SeedSchema)(input).pipe(Effect.mapError(unavailable));
    const identity = yield* withNativeTransaction(input, (transaction) => prepare(transaction, seed));
    return {
      ...identity,
      observe: () => withNativeTransaction(input, (transaction) => observe(transaction, seed, identity)),
    };
  },
);
