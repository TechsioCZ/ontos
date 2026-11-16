import type { DatabaseConnectionPair } from '@app/core-runtime';
import { configureDatabasePool, parseDatabaseConnectionPair } from '@app/core-runtime';
import { requireOwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import type { OwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { PgClient } from '@effect/sql-pg';
import { OrganizationIcoFieldContractVersion } from '@app/party-registry/apis/organization-ico-facts';
import { and, asc, eq, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, Crypto, DateTime, Effect, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import {
  OrganizationIcoApplicabilityContextSchema,
  OrganizationIcoApplicabilityRequestSchema,
} from '../../shared/apis/organization-ico-applicability.ts';
import {
  OrganizationProfileIcoApplicabilityContextSchema,
  OrganizationProfileIcoApplicabilityRequestSchema,
} from '../../shared/apis/organization-profile-ico-applicability.ts';
import { RecordPrivacyApplicabilityPayloadSchema } from '../../shared/actions/record-privacy-applicability.ts';
import {
  OrganizationProfileIcoFieldContractVersion,
  PrivacyApplicabilityAuthoritySchema,
  PrivacyApplicabilityDecisionSchema,
  PrivacyApplicabilityPolicySchema,
} from '../../shared/domain/privacy-applicability.ts';
import { PrivacyResponsibilityAssignmentSchema } from '../../shared/domain/privacy-responsibility-assignment.ts';
import { PrivacyLegalHoldSchema } from '../../shared/domain/privacy-retention-disposition.ts';
import {
  applicabilityDecisions,
  applicabilityPolicies,
  legalHolds,
  privacyRelations,
  processingPurposes,
  purposeVersions,
  responsibilityAssignments,
} from '../../src/database/schema.ts';

const Uuid = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('OrganizationIcoFixtureUuid'),
  Schema.decodeTo(Schema.String),
);
const PRIVACY_MODULE_ID = 'privacy.core';
const Revision = Schema.Int.check(Schema.isGreaterThan(0));
const SeedSchema = Schema.Struct({
  callers: Schema.Array(
    Schema.Struct({
      authMethod: Schema.Literals(['session', 'api_key', 'system', 'support_impersonation']),
      principalId: Uuid,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  governancePrincipalId: Uuid,
  legalEntityId: Uuid,
  purpose: Schema.Literal('implementation-1096-registered-workload-gateway'),
  target: Schema.Union([
    Schema.Struct({
      expectedRevision: Revision,
      kind: Schema.Literal('PARTY'),
      request: OrganizationIcoApplicabilityRequestSchema,
    }),
    Schema.Struct({
      expectedRevision: Revision,
      kind: Schema.Literal('PROFILE'),
      request: OrganizationProfileIcoApplicabilityRequestSchema,
    }),
  ]),
  tenantId: Uuid,
}).check(
  Schema.makeFilter((seed) => {
    const ref = seed.target.kind === 'PARTY' ? seed.target.request.partyRef : seed.target.request.profileRef;
    if (ref.tenantId !== seed.tenantId) {
      return 'Actual target must belong to the exact tenant';
    }
    return new Set(seed.callers.map(({ authMethod, principalId }) => `${authMethod}:${principalId}`)).size ===
      seed.callers.length
      ? undefined
      : 'Each exact caller must occur once';
  }),
);
export type OrganizationIcoNativeFixtureInput = typeof SeedSchema.Type & {
  readonly connections: DatabaseConnectionPair;
  readonly ownedDatabase: OwnedNativeDatabaseFixture;
};
type Seed = typeof SeedSchema.Type;
export class OrganizationIcoNativeFixtureError extends Schema.TaggedError<OrganizationIcoNativeFixtureError>()(
  'OrganizationIcoNativeFixtureError',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}
const unavailable = (cause?: unknown) => {
  const reason = 'The owned isolated organization ICO governance fixture is unavailable';
  if (cause === undefined) {
    return new OrganizationIcoNativeFixtureError({ reason });
  }
  return new OrganizationIcoNativeFixtureError({ cause: Redacted.make(cause), reason });
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
const assertIsolatedConnections = Effect.fn('PrivacyOrganizationIcoNativeFixture.assertIsolatedConnections')(
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
  input: OrganizationIcoNativeFixtureInput,
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

const prepare = Effect.fn('PrivacyOrganizationIcoNativeFixture.prepare')(function* prepare(
  transaction: PrivacyTransaction,
  seed: Seed,
) {
  const crypto = yield* Crypto.Crypto;
  const fixtureId = yield* crypto.randomUUIDv4();
  const purposeId = yield* crypto.randomUUIDv4();
  const versionId = yield* crypto.randomUUIDv4();
  const now = yield* DateTime.now;
  const from = DateTime.formatIso(DateTime.subtract(now, { minutes: 1 }));
  const until = DateTime.formatIso(DateTime.add(now, { hours: 1 }));
  const scope = { legalEntityId: seed.legalEntityId, tenantId: seed.tenantId };
  const resource = seed.target.kind === 'PARTY' ? seed.target.request.partyRef : seed.target.request.profileRef;
  const fieldVersion =
    seed.target.kind === 'PARTY' ? OrganizationIcoFieldContractVersion : OrganizationProfileIcoFieldContractVersion;
  const processingScopeRef = {
    scopeId: `${fieldVersion}:${resource.resourceId}`,
    scopeType: 'privacy.processing-scope',
  };
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
  const facts = [
    { dimension: 'OWNER_RESOURCE', value: `${resource.resourceType}:${resource.resourceId}` },
    { dimension: 'OWNER_RESOURCE_REVISION', value: String(seed.target.expectedRevision) },
    { dimension: 'OWNER_PARTY_KIND', value: 'ORGANIZATION' },
    { dimension: 'CATEGORY', value: fieldVersion },
    { dimension: 'INTENDED_USE', value: seed.target.request.operation },
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
    jurisdictionProfile: { profileKey: 'INTERNAL_ORGANIZATION_ICO_CLASSIFICATION', profileVersion: '1' },
    mandatoryDimensions: facts.map(({ dimension }) => dimension),
    nonPersonalApplicability: {
      allowedFields: seed.target.request.fields,
      fieldContractVersion: fieldVersion,
      holdBehavior: 'NO_ACTIVE_SCOPE_HOLD',
      kind: 'ORGANIZATION_ICO_ONLY',
    },
    policyKey: `internal:organization-ico-policy:${fixtureId}`,
    policyVersion: '1',
    scopeKey: `privacy.processing-scope:${processingScopeRef.scopeId}:${seed.target.request.operation}`,
    sourceEvidenceRefs: [`internal:explicit-ico-classification:${fixtureId}`],
  });
  const responsibility = yield* Schema.decodeUnknownEffect(PrivacyResponsibilityAssignmentSchema)({
    actor: { principalId: seed.governancePrincipalId, tenantId: seed.tenantId },
    assignmentRef: {
      moduleId: PRIVACY_MODULE_ID,
      resourceId: `internal:organization-ico-controller:${fixtureId}`,
      resourceType: 'privacy.core.privacy-responsibility-assignment',
      tenantId: seed.tenantId,
    },
    effectiveFrom: from,
    effectiveTo: null,
    holder: { holder: authority.controllerRef, holderKind: 'LEGAL_ENTITY' },
    provenance: {
      decisionEvidenceRefs: [`internal:explicit-controller:${fixtureId}`],
      reason: 'INTERNAL ONLY exact organization ICO governance fixture',
      recordedAt: from,
    },
    role: 'CONTROLLER',
    scopeRef: processingScopeRef,
  });
  const decisionRef = `internal:organization-ico-decision:${fixtureId}`;
  const recordPayload = yield* Schema.decodeUnknownEffect(RecordPrivacyApplicabilityPayloadSchema)({
    decisionId: decisionRef,
    proposedActivity: false,
    responsibilityAssignmentRefs: [responsibility.assignmentRef],
    scope: { operation: seed.target.request.operation, processingScopeRef },
  });
  const common = {
    authority,
    authorityIncarnation: `internal:organization-ico-incarnation:${fixtureId}`,
    authorityRevision: 'internal:1',
    decisionRef,
    effectiveFrom: from,
    ...scope,
    processingScopeRef,
    validUntil: until,
  };
  const organizationContexts = [];
  const profileContexts = [];
  for (const caller of seed.callers) {
    if (seed.target.kind === 'PARTY') {
      organizationContexts.push(
        yield* Schema.decodeUnknownEffect(OrganizationIcoApplicabilityContextSchema)({
          ...common,
          ...caller,
          request: seed.target.request,
        }),
      );
    } else {
      profileContexts.push(
        yield* Schema.decodeUnknownEffect(OrganizationProfileIcoApplicabilityContextSchema)({
          ...common,
          ...caller,
          request: seed.target.request,
        }),
      );
    }
  }
  yield* transaction.insert(processingPurposes).values({
    ...scope,
    businessCode: `INTERNAL_ICO_${fixtureId.replaceAll('-', '').toUpperCase()}`,
    governanceOwnerId: seed.governancePrincipalId,
    lifecycle: 'ACTIVE',
    processingPurposeId: purposeId,
  });
  yield* transaction.insert(purposeVersions).values({
    ...scope,
    actionInvocationId: yield* crypto.randomUUIDv4(),
    effectiveFrom: asDate(from),
    effectiveTo: asDate(until),
    meaning: 'INTERNAL ONLY explicit organization ICO classification',
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
    decisionRef,
    holdRef: `internal:organization-ico-hold:${fixtureId}`,
    organizationContexts,
    policyRef: policy.policyKey,
    processingScopeRef,
    profileContexts,
    recordPayload,
  };
});
type Identity = Effect.Success<ReturnType<typeof prepare>>;
const changeHold = Effect.fn('PrivacyOrganizationIcoNativeFixture.setHold')(function* changeHold(
  transaction: PrivacyTransaction,
  seed: Seed,
  identity: Identity,
  active: boolean,
) {
  const scope = { legalEntityId: seed.legalEntityId, tenantId: seed.tenantId };
  yield* transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identity.holdRef},0))`, 'objects');
  const history = yield* transaction
    .select({ record: legalHolds.holdRecord, recordedAt: legalHolds.recordedAt })
    .from(legalHolds)
    .where(
      and(
        eq(legalHolds.tenantId, seed.tenantId),
        eq(legalHolds.legalEntityId, seed.legalEntityId),
        eq(legalHolds.holdRef, identity.holdRef),
      ),
    )
    .orderBy(asc(legalHolds.recordedAt));
  const last = history.at(-1);
  const previous =
    last === undefined ? undefined : yield* Schema.decodeUnknownEffect(PrivacyLegalHoldSchema)(last.record);
  if (
    (previous === undefined && !active) ||
    (previous !== undefined && Option.isNone(previous.releasedAt) === active)
  ) {
    return active;
  }
  // A released hold is never resurrected under an existing history identity.
  if (previous !== undefined && active) {
    return yield* unavailable();
  }
  const now = yield* DateTime.now;
  if (last !== undefined && DateTime.toEpochMillis(now) <= last.recordedAt.getTime()) {
    return yield* unavailable();
  }
  const at = DateTime.formatIso(now);
  const crypto = yield* Crypto.Crypto;
  const release = active
    ? {
        releaseConditionRef: null,
        releasedAt: null,
        releasedByPrincipalRef: null,
        releaseEvidenceRefs: [],
        releaseReasonRef: null,
        releaseRef: null,
      }
    : {
        releaseConditionRef: 'internal:acceptance-review-complete',
        releasedAt: at,
        releasedByPrincipalRef: seed.governancePrincipalId,
        releaseEvidenceRefs: ['internal:acceptance-release-evidence'],
        releaseReasonRef: 'internal:acceptance-release-reason',
        releaseRef: `${identity.holdRef}:release`,
      };
  const record = yield* Schema.decodeUnknownEffect(PrivacyLegalHoldSchema)({
    ...release,
    actorPrincipalRef: seed.governancePrincipalId,
    authorityKind: 'LEGAL_HOLD_AUTHORITY',
    authorityRef: seed.governancePrincipalId,
    contentScopeRefs: [identity.processingScopeRef.scopeId],
    controllerRef: seed.legalEntityId,
    effectiveFrom: previous?.effectiveFrom ?? DateTime.formatIso(DateTime.subtract(now, { minutes: 1 })),
    effectiveTo: previous?.effectiveTo ?? DateTime.formatIso(DateTime.add(now, { days: 1 })),
    evidenceRefs: [identity.holdRef],
    holdRef: identity.holdRef,
    policyRef: identity.policyRef,
    policyVersion: 1,
    provenanceRef: identity.holdRef,
    reasonTypeRef: 'internal:measure-acceptance-hold',
    reasonTypeVersion: 1,
    reviewDueAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
    reviewedAt: null,
    reviewEvidenceRefs: [],
    reviewRef: `${identity.holdRef}:review`,
  });
  yield* transaction.insert(legalHolds).values({
    ...scope,
    actionInvocationId: yield* crypto.randomUUIDv4(),
    effectiveFrom: asDate(record.effectiveFrom),
    effectiveTo: asDate(record.effectiveTo),
    holdRecord: yield* Schema.encodeEffect(PrivacyLegalHoldSchema)(record),
    holdRef: identity.holdRef,
    recordedAt: asDate(at),
    releasedAt: active ? null : asDate(at),
  });
  return active;
});

const observe = Effect.fn('PrivacyOrganizationIcoNativeFixture.observe')(function* observe(
  transaction: PrivacyTransaction,
  seed: Seed,
  identity: Identity,
) {
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
    return { decision: Option.none() };
  }
  const record = yield* Schema.decodeUnknownEffect(PrivacyApplicabilityDecisionSchema)(row.record);
  return {
    decision: Option.some({
      actionInvocationId: row.actionInvocationId,
      authorityEvidenceRefs: record.authorityEvidenceRefs ?? [],
      authorityReceiptRef: Option.fromUndefinedOr(record.authorityReceiptRef),
      decisionRef: identity.decisionRef,
      evaluatedAt: record.evaluatedAt,
      evidenceRefs: record.evidenceRefs,
      nonPersonalApplicability: Option.fromUndefinedOr(record.nonPersonalApplicability),
      outcome: record.outcome,
      policyIdentities: record.policyIdentities,
    }),
  };
});
/** INTERNAL ONLY: prepares exact native governance but never a decision, owner proof or permission.
 * The actual public Action must obtain fresh receiving-owner evidence and record its own decision.
 */
export const seedOrganizationIcoNativeFixture = Effect.fn('PrivacyOrganizationIcoNativeFixture.seed')(
  function* seedOrganizationIcoNativeFixture(input: OrganizationIcoNativeFixtureInput) {
    const seed = yield* Schema.decodeUnknownEffect(SeedSchema)(input).pipe(Effect.mapError(unavailable));
    const identity = yield* withNativeTransaction(input, (transaction) => prepare(transaction, seed));
    return {
      ...identity,
      observe: () => withNativeTransaction(input, (transaction) => observe(transaction, seed, identity)),
      setHold: (active: boolean) =>
        withNativeTransaction(input, (transaction) => changeHold(transaction, seed, identity, active)),
    };
  },
);
