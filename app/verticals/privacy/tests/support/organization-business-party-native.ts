import type { DatabaseConnectionPair } from '@app/core-runtime';
import { configureDatabasePool, parseDatabaseConnectionPair } from '@app/core-runtime';
import { requireOwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import type { OwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { PgClient } from '@effect/sql-pg';
import {
  OrganizationBusinessNameExportFields,
  organizationBusinessNameExportInputDigest,
} from '@app/party-registry/apis/organization-business-name-export';
import {
  OrganizationBusinessSourceReferenceSchema,
  OrganizationBusinessUpdateFields,
  OrganizationBusinessUpdateInputSchema,
  organizationBusinessRecordInputDigest,
} from '@app/party-registry/apis/organization-record-facts';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { and, asc, eq, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, Crypto, DateTime, Effect, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import {
  OrganizationBusinessApplicabilityContextSchema,
  OrganizationBusinessApplicabilityIntentSchema,
} from '../../shared/apis/organization-business-applicability.ts';
import { RecordPrivacyApplicabilityPayloadSchema } from '../../shared/actions/record-privacy-applicability.ts';
import {
  PrivacyApplicabilityAuthoritySchema,
  PrivacyApplicabilityDecisionSchema,
  PrivacyApplicabilityPolicySchema,
} from '../../shared/domain/privacy-applicability.ts';
import { PrivacyResponsibilityAssignmentSchema } from '../../shared/domain/privacy-responsibility-assignment.ts';
import { PrivacyLegalHoldSchema } from '../../shared/domain/privacy-retention-disposition.ts';
import { organizationBusinessCanonicalContentScope } from '../../src/services/organization-business-applicability.service.ts';
import {
  applicabilityDecisions,
  applicabilityPolicies,
  legalHolds,
  privacyRelations,
  processingPurposes,
  purposeVersions,
  responsibilityAssignments,
} from '../../src/database/schema.ts';

const PRIVACY_MODULE_ID = 'privacy.core';
const Uuid = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('OrganizationBusinessPartyFixtureUuid'),
  Schema.decodeTo(Schema.String),
);
const { 1: UpdateIntentSchema, 14: NameExportIntentSchema } = OrganizationBusinessApplicabilityIntentSchema.members;
const StrictUpdateIntentSchema = Schema.Struct({
  ...UpdateIntentSchema.fields,
  sourceReference: OrganizationBusinessSourceReferenceSchema,
});
const PartyIntentSchema = Schema.Union([NameExportIntentSchema, StrictUpdateIntentSchema]);
const sameParty = Schema.toEquivalence(PartyRefSchema);
const sameSource = Schema.toEquivalence(OrganizationBusinessSourceReferenceSchema);
const fieldsByOperation = {
  ORGANIZATION_BUSINESS_NAME_EXPORT: OrganizationBusinessNameExportFields,
  UPDATE: OrganizationBusinessUpdateFields,
};
const SeedSchema = Schema.Struct({
  callers: Schema.Array(
    Schema.Struct({
      authMethod: Schema.Literals(['session', 'api_key', 'system', 'support_impersonation']),
      principalId: Uuid,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  expectedPartyRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  governancePrincipalId: Uuid,
  intent: PartyIntentSchema,
  legalEntityId: Uuid,
  nativeUpdateInput: Schema.optionalKey(Schema.Json),
  purpose: Schema.Literal('implementation-1096-registered-workload-gateway'),
  tenantId: Uuid,
}).check(
  Schema.makeFilter((seed) => {
    if (seed.intent.partyRef.tenantId !== seed.tenantId) {
      return 'The actual Party must belong to the exact Tenant';
    }
    if (
      seed.intent.expectedPartyRevision !== undefined &&
      seed.intent.expectedPartyRevision !== seed.expectedPartyRevision
    ) {
      return 'Expected Party revisions must match';
    }
    const expectedFields = fieldsByOperation[seed.intent.operation];
    const fields = new Set<string>(seed.intent.fields);
    if (fields.size !== expectedFields.length || !expectedFields.every((field) => fields.has(field))) {
      return 'The full actual native operation field contract is required';
    }
    if ((seed.intent.operation === 'UPDATE') !== (seed.nativeUpdateInput !== undefined)) {
      return 'Native corporate input is required exclusively for UPDATE';
    }
    return new Set(seed.callers.map(({ authMethod, principalId }) => `${authMethod}:${principalId}`)).size ===
      seed.callers.length
      ? undefined
      : 'Each exact caller must occur once';
  }),
);
export type OrganizationBusinessPartyNativeFixtureInput = Omit<typeof SeedSchema.Type, 'nativeUpdateInput'> & {
  readonly connections: DatabaseConnectionPair;
  readonly nativeUpdateInput?: typeof OrganizationBusinessUpdateInputSchema.Encoded;
  readonly ownedDatabase: OwnedNativeDatabaseFixture;
};
type Seed = typeof SeedSchema.Type;
export class OrganizationBusinessPartyNativeFixtureError extends Schema.TaggedError<OrganizationBusinessPartyNativeFixtureError>()(
  'OrganizationBusinessPartyNativeFixtureError',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}
const unavailable = (cause?: unknown) => {
  const reason = 'The owned known-Party Name Export governance fixture is unavailable';
  if (cause === undefined) {
    return new OrganizationBusinessPartyNativeFixtureError({ reason });
  }
  return new OrganizationBusinessPartyNativeFixtureError({ cause: Redacted.make(cause), reason });
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
const assertIsolatedConnections = Effect.fn('PrivacyOrganizationBusinessPartyNative.assertIsolatedConnections')(
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
  input: OrganizationBusinessPartyNativeFixtureInput,
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

const prepare = Effect.fn('PrivacyOrganizationBusinessPartyNative.prepare')(function* prepare(
  transaction: PrivacyTransaction,
  seed: Seed,
) {
  const { intent } = seed;
  const crypto = yield* Crypto.Crypto;
  const id = yield* crypto.randomUUIDv4();
  const purposeId = yield* crypto.randomUUIDv4();
  const versionId = yield* crypto.randomUUIDv4();
  const now = yield* DateTime.now;
  const from = DateTime.formatIso(DateTime.subtract(now, { minutes: 1 }));
  const until = DateTime.formatIso(DateTime.add(now, { hours: 1 }));
  const scope = { legalEntityId: seed.legalEntityId, tenantId: seed.tenantId };
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
    scopeId: `internal:organization-party-scope:${id}`,
    scopeType: 'privacy.processing-scope',
  };
  const facts = [
    { dimension: 'OWNER_RESOURCE', value: `${intent.partyRef.resourceType}:${intent.partyRef.resourceId}` },
    { dimension: 'OWNER_RESOURCE_REVISION', value: String(seed.expectedPartyRevision) },
    { dimension: 'OWNER_PARTY_KIND', value: 'ORGANIZATION' },
    { dimension: 'CATEGORY', value: intent.projectionVersion },
    { dimension: 'INTENDED_USE', value: intent.operation },
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
    jurisdictionProfile: { profileKey: 'INTERNAL_KNOWN_PARTY_NAME_EXPORT', profileVersion: '1' },
    mandatoryDimensions: facts.map(({ dimension }) => dimension),
    nonPersonalApplicability: {
      allowedFields: intent.fields,
      classification: 'CANONICAL_ORGANIZATION',
      consumerModuleId: intent.consumerModuleId,
      holdBehavior: 'NO_ACTIVE_SCOPE_HOLD',
      kind: 'ORGANIZATION_BUSINESS_ONLY',
      operation: intent.operation,
      projectionVersion: intent.projectionVersion,
    },
    policyKey: `internal:organization-party-policy:${id}`,
    policyVersion: '1',
    scopeKey: `privacy.processing-scope:${processingScopeRef.scopeId}:${intent.operation}`,
    sourceEvidenceRefs: [`internal:explicit-known-party-name-policy:${id}`],
  });
  const responsibility = yield* Schema.decodeUnknownEffect(PrivacyResponsibilityAssignmentSchema)({
    actor: { principalId: seed.governancePrincipalId, tenantId: seed.tenantId },
    assignmentRef: {
      moduleId: PRIVACY_MODULE_ID,
      resourceId: `internal:organization-party-controller:${id}`,
      resourceType: 'privacy.core.privacy-responsibility-assignment',
      tenantId: seed.tenantId,
    },
    effectiveFrom: from,
    effectiveTo: null,
    holder: { holder: authority.controllerRef, holderKind: 'LEGAL_ENTITY' },
    provenance: {
      decisionEvidenceRefs: [`internal:explicit-controller:${id}`],
      reason: 'INTERNAL ONLY exact known-Party business-name export governance fixture',
      recordedAt: from,
    },
    role: 'CONTROLLER',
    scopeRef: processingScopeRef,
  });
  const decisionRef = `internal:organization-party-decision:${id}`;
  const recordPayload = yield* Schema.decodeUnknownEffect(RecordPrivacyApplicabilityPayloadSchema)({
    decisionId: decisionRef,
    proposedActivity: false,
    responsibilityAssignmentRefs: [responsibility.assignmentRef],
    scope: { operation: intent.operation, processingScopeRef },
  });
  const contexts = [];
  for (const caller of seed.callers) {
    contexts.push(
      yield* Schema.decodeUnknownEffect(OrganizationBusinessApplicabilityContextSchema)({
        ...scope,
        ...caller,
        authority,
        authorityIncarnation: `internal:organization-party-incarnation:${id}`,
        authorityRevision: 'internal:1',
        decisionRef,
        effectiveFrom: from,
        processingScopeRef,
        request: intent,
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
    meaning: 'INTERNAL ONLY explicit known-Party business-name export classification',
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
    contentScopeRef: organizationBusinessCanonicalContentScope(intent.projectionVersion, intent.partyRef.resourceId),
    contexts,
    decisionRef,
    holdRef: `internal:organization-party-hold:${id}`,
    intent,
    policyRef: policy.policyKey,
    processingScopeRef,
    purposeRef: authority.purposeRef,
    recordPayload,
  };
});
type Identity = Effect.Success<ReturnType<typeof prepare>>;
const changeHold = Effect.fn('PrivacyOrganizationBusinessPartyNative.setHold')(function* changeHold(
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
    contentScopeRefs: [identity.contentScopeRef],
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

const observe = Effect.fn('PrivacyOrganizationBusinessPartyNative.observe')(function* observe(
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
      authorityReceiptRef: Option.fromUndefinedOr(record.authorityReceiptRef),
      decisionRef: identity.decisionRef,
      evaluatedAt: record.evaluatedAt,
      evidenceRefs: record.evidenceRefs,
      outcome: record.outcome,
    }),
  };
});

/** INTERNAL policy-only preparation between independent jobs, using an actual acknowledged Party/ref revision.
 * Actual public RecordPrivacyApplicability independently fetches current Party and original source proofs.
 */
export const seedOrganizationBusinessPartyNativeFixture = Effect.fn('PrivacyOrganizationBusinessPartyNative.seed')(
  function* seedOrganizationBusinessPartyNativeFixture(input: OrganizationBusinessPartyNativeFixtureInput) {
    const seed = yield* Schema.decodeUnknownEffect(SeedSchema)(input).pipe(Effect.mapError(unavailable));
    if (seed.intent.operation === 'UPDATE') {
      const body = yield* Schema.decodeUnknownEffect(OrganizationBusinessUpdateInputSchema, {
        onExcessProperty: 'error',
      })(seed.nativeUpdateInput).pipe(Effect.mapError(unavailable));
      if (body.expectedRevision !== seed.expectedPartyRevision || !sameParty(body.partyRef, seed.intent.partyRef)) {
        return yield* unavailable();
      }
      const payload = yield* Schema.encodeEffect(OrganizationBusinessUpdateInputSchema)(body).pipe(
        Effect.mapError(unavailable),
      );
      const digest = yield* organizationBusinessRecordInputDigest({ operation: 'UPDATE', payload }).pipe(
        Effect.mapError(unavailable),
      );
      if (
        digest.inputDigest !== seed.intent.inputDigest ||
        !sameSource(digest.sourceReference, seed.intent.sourceReference)
      ) {
        return yield* unavailable();
      }
    } else {
      const digest = yield* organizationBusinessNameExportInputDigest({
        partyRef: seed.intent.partyRef,
        sourceReference: seed.intent.sourceReference,
      }).pipe(Effect.mapError(unavailable));
      if (digest.inputDigest !== seed.intent.inputDigest) {
        return yield* unavailable();
      }
    }
    const identity = yield* withNativeTransaction(input, (transaction) => prepare(transaction, seed));
    return {
      ...identity,
      observe: () => withNativeTransaction(input, (transaction) => observe(transaction, seed, identity)),
      setHold: (active: boolean) =>
        withNativeTransaction(input, (transaction) => changeHold(transaction, seed, identity, active)),
    };
  },
);
