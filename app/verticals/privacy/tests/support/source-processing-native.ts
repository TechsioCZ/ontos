import type { DatabaseConnectionPair } from '@app/core-runtime';
import { configureDatabasePool } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import {
  CustomerProfileSourceRequestSchema,
  CustomerProfileSourceResponseSchema,
} from '@app/commerce-customer-context/api/customer-profile-source';
import { executeCustomerProfileSourceWithAuthorization } from '@app/commerce-customer-context/api/customer-profile-source/client';
import { and, eq, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, Crypto, DateTime, Effect, Match, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';

import {
  SourceProcessingContextSchema,
  SourceProcessingEligibilityRequestSchema,
} from '../../shared/apis/source-processing-eligibility.ts';
import type { SourceProcessingContext } from '../../shared/apis/source-processing-eligibility.ts';
import {
  PrivacyApplicabilityAuthoritySchema,
  PrivacyApplicabilityDecisionSchema,
  PrivacyApplicabilityPolicySchema,
  PrivacyApplicabilityScopeSchema,
  resolvePrivacyApplicability,
} from '../../shared/domain/privacy-applicability.ts';
import { PrivacyLegalBasisAssignmentSchema } from '../../shared/domain/privacy-legal-basis.ts';
import { PrivacyPartyRefSchema } from '../../shared/domain/party-reference.ts';
import {
  PrivacySourcePersonReferenceSchema,
  PrivacySubjectRecordSchema,
  privacySourceSubjectIdentityKey,
} from '../../shared/domain/privacy-subject.ts';
import type { PrivacySubjectOwnerEvidence, PrivacySourcePersonReference } from '../../shared/domain/privacy-subject.ts';
import { admitCurrentSourcePersonProof } from '../../src/persistence/privacy-subject-party-owner.ts';
import {
  applicabilityDecisions,
  applicabilityPolicies,
  legalBasisAssignments,
  privacyRelations,
  privacySubjects,
  processingPurposes,
  purposeVersions,
} from '../../src/database/schema.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const PrincipalId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('PrivacyFixturePrincipalId'),
  Schema.decodeTo(Schema.String),
);
const LegalEntityId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('PrivacyFixtureLegalEntityId'),
  Schema.decodeTo(Schema.String),
);
const TenantId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('PrivacyFixtureTenantId'),
  Schema.decodeTo(Schema.String),
);
const PRIVACY_MODULE_ID = 'privacy.core';
const PRIVACY_SUBJECT_TYPE = 'privacy.core.privacy-subject';
const PlanSchema = Schema.Struct({
  authMethod: Ref,
  principalId: PrincipalId,
  request: SourceProcessingEligibilityRequestSchema,
  targetAdmission: Schema.optionalKey(Schema.Literal('CURRENT_SOURCE_PERSON')),
});
const SeedSchema = Schema.Struct({
  contexts: Schema.Array(PlanSchema).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  contractEvidenceRef: Ref,
  controllerRef: Ref,
  dataCategoryRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  governancePrincipalId: PrincipalId,
  legalEntityId: LegalEntityId,
  meaning: Ref,
  tenantId: TenantId,
});

export class SourceProcessingNativeFixtureError extends Schema.TaggedError<SourceProcessingNativeFixtureError>()(
  'SourceProcessingNativeFixtureError',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}
const unavailable = (cause?: unknown, reason = 'The isolated Privacy native fixture could not be prepared') => {
  if (cause === undefined) {
    return new SourceProcessingNativeFixtureError({ reason });
  }
  return new SourceProcessingNativeFixtureError({ cause: Redacted.make(cause), reason });
};

type SeedInput = typeof SeedSchema.Type & { readonly connections: DatabaseConnectionPair };
interface AdmittedProfile {
  readonly ownerAdmission: PrivacySubjectOwnerEvidence;
  readonly profileId: string;
  readonly sourceReference: PrivacySourcePersonReference;
}
type PrivacyExecutor = Effect.Success<ReturnType<typeof makeWithDefaults<typeof privacyRelations>>>;
type PrivacyTransaction = Parameters<Parameters<PrivacyExecutor['transaction']>[0]>[0];
type FixtureScope = Pick<typeof SeedSchema.Type, 'tenantId' | 'legalEntityId'>;
const subjectForSource = Effect.fn('PrivacyNativeFixture.subjectForSource')(function* subjectForSource(
  transaction: PrivacyTransaction,
  scope: FixtureScope,
  source: NonNullable<typeof SourceProcessingEligibilityRequestSchema.Type.source>,
  from: string,
  nextId: () => Effect.Effect<string, SourceProcessingNativeFixtureError>,
  subjects: Map<string, string>,
) {
  const identityKey = privacySourceSubjectIdentityKey(source);
  const cached = subjects.get(identityKey);
  if (cached !== undefined) {
    return cached;
  }
  const [existing] = yield* transaction
    .select({ id: privacySubjects.privacySubjectId })
    .from(privacySubjects)
    .where(
      and(
        eq(privacySubjects.tenantId, scope.tenantId),
        eq(privacySubjects.legalEntityId, scope.legalEntityId),
        eq(privacySubjects.subjectKind, 'SOURCE_ASSERTED'),
        eq(privacySubjects.sourceIdentityKey, identityKey),
      ),
    )
    .limit(1);
  if (existing !== undefined) {
    subjects.set(identityKey, existing.id);
    return existing.id;
  }
  const subjectId = yield* nextId();
  const record = yield* Schema.decodeUnknownEffect(PrivacySubjectRecordSchema)({
    createdAt: from,
    subject: { kind: 'SOURCE_ASSERTED', source },
    subjectRef: {
      moduleId: PRIVACY_MODULE_ID,
      resourceId: subjectId,
      resourceType: PRIVACY_SUBJECT_TYPE,
      tenantId: scope.tenantId,
    },
    updatedAt: from,
  });
  yield* transaction.insert(privacySubjects).values({
    ...scope,
    privacySubjectId: subjectId,
    sourceIdentityKey: identityKey,
    subjectKind: 'SOURCE_ASSERTED',
    subjectRecord: yield* Schema.encodeEffect(PrivacySubjectRecordSchema)(record),
  });
  subjects.set(identityKey, subjectId);
  return subjectId;
});
const dataSubjectForProfile = Effect.fn('PrivacyNativeFixture.dataSubjectForProfile')(function* dataSubjectForProfile(
  transaction: PrivacyTransaction,
  scope: FixtureScope,
  admission: AdmittedProfile,
  from: string,
  nextId: () => Effect.Effect<string, SourceProcessingNativeFixtureError>,
) {
  const locator = { ...admission.sourceReference.source, recordId: admission.sourceReference.recordId };
  const [origin] = yield* transaction
    .select({ record: privacySubjects.subjectRecord })
    .from(privacySubjects)
    .where(
      and(
        eq(privacySubjects.tenantId, scope.tenantId),
        eq(privacySubjects.legalEntityId, scope.legalEntityId),
        eq(privacySubjects.subjectKind, 'SOURCE_ASSERTED'),
        eq(privacySubjects.sourceIdentityKey, privacySourceSubjectIdentityKey(locator)),
      ),
    )
    .limit(1);
  if (origin === undefined) {
    return yield* unavailable();
  }
  const sourceSubject = yield* Schema.decodeUnknownEffect(PrivacySubjectRecordSchema)(origin.record);
  if (
    sourceSubject.subject.kind !== 'SOURCE_ASSERTED' ||
    sourceSubject.subjectRef.tenantId !== scope.tenantId ||
    privacySourceSubjectIdentityKey(sourceSubject.subject.source) !== privacySourceSubjectIdentityKey(locator)
  ) {
    return yield* unavailable();
  }
  const subjectId = yield* nextId();
  const record = yield* Schema.decodeUnknownEffect(PrivacySubjectRecordSchema)({
    createdAt: from,
    ownerAdmission: admission.ownerAdmission,
    subject: {
      kind: 'DATA_SUBJECT',
      partyRef: admission.ownerAdmission.partyRef,
      sourceAdmission: {
        occurrenceId: admission.sourceReference.occurrenceId,
        sourceSubjectRef: sourceSubject.subjectRef,
      },
    },
    subjectRef: {
      moduleId: PRIVACY_MODULE_ID,
      resourceId: subjectId,
      resourceType: PRIVACY_SUBJECT_TYPE,
      tenantId: scope.tenantId,
    },
    updatedAt: from,
  });
  yield* transaction.insert(privacySubjects).values({
    ...scope,
    privacySubjectId: subjectId,
    sourceIdentityKey: null,
    subjectKind: 'DATA_SUBJECT',
    subjectRecord: yield* Schema.encodeEffect(PrivacySubjectRecordSchema)(record),
  });
  return subjectId;
});
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
const assertIsolatedConnections = Effect.fn('PrivacyNativeFixture.assertIsolatedConnections')(
  function* assertIsolatedConnections(connections: DatabaseConnectionPair) {
    const deployment = yield* Config.option(Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'));
    const { admin, runtime } = connections;
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

/** INTERNAL ONLY. Opens both connections itself; no executor or production grant escapes.
 * This creates explicit fixture governance, not a claim of a real customer's contract or consent.
 * Production receiving still uses the normal public Read, current ledgers and owner proof.
 */
const seedNativeProcessing = Effect.fn('PrivacyNativeFixture.seedSourceProcessing')(
  function* seedSourceProcessingNativeFixture(input: SeedInput, admission?: AdmittedProfile) {
    const seed = yield* Schema.decodeUnknownEffect(SeedSchema)(input).pipe(Effect.mapError(unavailable));
    if (new Set(seed.dataCategoryRefs).size !== 1) {
      return yield* unavailable(
        undefined,
        'The existing applicability model requires one explicit internal processing category per fixture scope',
      );
    }
    yield* assertIsolatedConnections(input.connections);
    const { admin, runtime } = input.connections;
    if (
      seed.contexts.some(
        ({ request, targetAdmission }) =>
          request.source === null ||
          (admission === undefined
            ? request.target !== null && request.organizationBusinessUse === undefined
            : !(
                (request.target?.kind === 'RETAIL_CUSTOMER_PROFILE' &&
                  request.target.resourceId === admission.profileId) ||
                (request.target?.kind === 'PARTY' &&
                  request.target.resourceId === admission.ownerAdmission.partyRef.resourceId)
              ) || targetAdmission !== undefined),
      )
    ) {
      return yield* unavailable();
    }
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
    if (!sameNativePair(administrative, operational, input.connections)) {
      return yield* unavailable();
    }
    const database = yield* makeWithDefaults({ relations: privacyRelations }).pipe(
      Effect.provideService(PgClient.PgClient, adminClient),
    );
    const crypto = yield* Crypto.Crypto;
    const nextId = () => crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
    const now = yield* DateTime.now;
    const from = DateTime.formatIso(DateTime.subtract(now, { minutes: 1 }));
    const until = DateTime.formatIso(DateTime.add(now, { hours: 1 }));
    const purposeId = yield* nextId();
    const versionId = yield* nextId();
    const scope = { legalEntityId: seed.legalEntityId, tenantId: seed.tenantId };
    const purposeRef = {
      moduleId: PRIVACY_MODULE_ID,
      resourceId: purposeId,
      resourceType: 'privacy.core.processing-purpose' as const,
      tenantId: seed.tenantId,
    };
    const subjects = new Map<string, string>();
    const contexts: SourceProcessingContext[] = [];
    let stage = 'native connection challenge';
    yield* database
      .transaction(
        Effect.fn('PrivacyNativeFixture.prepareOwner')(function* prepareOwner(transaction) {
          // An unpredictable live lock challenge proves both actual connections reach this
          // transaction's database, independently of matching configured names and catalog OIDs.
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
          stage = 'processing purpose';
          yield* transaction.insert(processingPurposes).values({
            ...scope,
            businessCode: `INTERNAL_${purposeId.replaceAll('-', '').toUpperCase()}`,
            governanceOwnerId: seed.governancePrincipalId,
            lifecycle: 'ACTIVE',
            processingPurposeId: purposeId,
          });
          yield* transaction.insert(purposeVersions).values({
            ...scope,
            actionInvocationId: yield* nextId(),
            effectiveFrom: new Date(from),
            effectiveTo: new Date(until),
            meaning: `INTERNAL FIXTURE: ${seed.meaning}`,
            processingPurposeId: purposeId,
            purposeVersionId: versionId,
            requiredConsentDimensions: [],
            versionNumber: 1,
          });
          stage = 'Privacy subject';
          const dataSubjectId =
            admission === undefined
              ? undefined
              : yield* dataSubjectForProfile(transaction, scope, admission, from, nextId);
          if (dataSubjectId !== undefined) {
            subjects.set('DATA_SUBJECT', dataSubjectId);
          }
          for (const plan of seed.contexts) {
            const { source } = plan.request;
            if (source === null) {
              return yield* unavailable();
            }
            stage = 'source subject';
            const subjectId =
              dataSubjectId ?? (yield* subjectForSource(transaction, scope, source, from, nextId, subjects));
            const fixtureId = yield* nextId();
            const processingScopeRef = {
              scopeId: `internal-source:${fixtureId}`,
              scopeType: 'privacy.processing-scope',
            };
            const subjectRef = {
              moduleId: PRIVACY_MODULE_ID,
              resourceId: subjectId,
              resourceType: PRIVACY_SUBJECT_TYPE,
              tenantId: seed.tenantId,
            };
            stage = 'applicability authority';
            const authority = yield* Schema.decodeUnknownEffect(PrivacyApplicabilityAuthoritySchema)({
              ...scope,
              controllerRef: {
                moduleId: PRIVACY_MODULE_ID,
                resourceId: seed.controllerRef,
                resourceType: 'privacy.core.controller',
                tenantId: seed.tenantId,
              },
              purposeRef,
              purposeVersionRef: {
                moduleId: PRIVACY_MODULE_ID,
                resourceId: versionId,
                resourceType: 'privacy.core.processing-purpose-version',
                tenantId: seed.tenantId,
              },
            });
            stage = 'applicability policy';
            const policy = yield* Schema.decodeUnknownEffect(PrivacyApplicabilityPolicySchema)({
              composition: { precedence: 1, strategy: 'EXPLICIT_PRECEDENCE' },
              effectiveFrom: from,
              effectiveTo: until,
              factPredicates: [{ dimension: 'CATEGORY', operator: 'ONE_OF', values: seed.dataCategoryRefs }],
              jurisdictionProfile: { profileKey: 'internal-fixture:explicit', profileVersion: '1' },
              mandatoryDimensions: ['CATEGORY'],
              policyKey: `internal-source-policy:${fixtureId}`,
              policyVersion: '1',
              scopeKey: `${processingScopeRef.scopeType}:${processingScopeRef.scopeId}:${plan.request.operation}`,
              sourceEvidenceRefs: [seed.contractEvidenceRef],
            });
            stage = 'applicability facts';
            const applicabilityScope = yield* Schema.decodeUnknownEffect(PrivacyApplicabilityScopeSchema)({
              facts: [
                ...seed.dataCategoryRefs.map((value) => ({ dimension: 'CATEGORY', value })),
                { dimension: 'CONTROLLER_SCOPE', value: seed.controllerRef },
                { dimension: 'PRIVACY_SUBJECT', value: subjectId },
                { dimension: 'PROCESSING_PURPOSE', value: purposeId },
                { dimension: 'PROCESSING_PURPOSE_VERSION', value: versionId },
                { dimension: 'RECIPIENT', value: plan.request.consumerModuleId },
              ],
              operation: plan.request.operation,
              processingScopeRef,
            });
            const receiptRef = `internal-source-authority:${fixtureId}`;
            const evidenceRefs = [seed.contractEvidenceRef];
            const decision = resolvePrivacyApplicability({
              authority,
              authorityEvidenceRefs: evidenceRefs,
              authorityReceiptRef: receiptRef,
              evaluatedAt: from,
              policies: [policy],
              proposedActivity: true,
              scope: applicabilityScope,
            });
            if (decision.outcome !== 'APPLICABLE') {
              return yield* unavailable(undefined, `Internal explicit fixture applicability is ${decision.outcome}`);
            }
            const decisionRef = `internal-source-decision:${fixtureId}`;
            stage = 'applicability ledger';
            yield* transaction.insert(applicabilityPolicies).values({
              ...scope,
              actionInvocationId: yield* nextId(),
              effectiveFrom: new Date(from),
              effectiveTo: new Date(until),
              policyKey: policy.policyKey,
              policyRecord: yield* Schema.encodeEffect(PrivacyApplicabilityPolicySchema)(policy),
              policyVersion: policy.policyVersion,
              scopeKey: policy.scopeKey,
            });
            yield* transaction.insert(applicabilityDecisions).values({
              ...scope,
              actionInvocationId: yield* nextId(),
              decisionId: decisionRef,
              decisionRecord: yield* Schema.encodeEffect(PrivacyApplicabilityDecisionSchema)(decision),
              evaluatedAt: new Date(from),
              operation: plan.request.operation,
              outcome: decision.outcome,
              processingScopeRef: processingScopeRef.scopeId,
            });
            const assignmentId = yield* nextId();
            stage = 'explicit contract basis';
            const assignment = yield* Schema.decodeUnknownEffect(PrivacyLegalBasisAssignmentSchema)({
              actor: { principalId: seed.governancePrincipalId, tenantId: seed.tenantId },
              applicabilityDecision: decision,
              assignmentRef: {
                moduleId: PRIVACY_MODULE_ID,
                resourceId: assignmentId,
                resourceType: 'privacy.core.legal-basis-assignment',
                tenantId: seed.tenantId,
              },
              basis: 'CONTRACT',
              basisVersion: 'INTERNAL_EXPLICIT_CONTRACT_FIXTURE_V1',
              decision: 'APPROVED',
              effectiveFrom: from,
              effectiveTo: until,
              provenance: {
                decisionEvidenceRefs: evidenceRefs,
                policyRef: policy.policyKey,
                policyVersion: policy.policyVersion,
                reason: 'INTERNAL ONLY explicit contract fixture; no production customer or consent assertion',
                recordedAt: from,
              },
              scope: {
                controllerRef: seed.controllerRef,
                operation: plan.request.operation,
                processingScopeRef,
                purposeRef,
                purposeVersionId: versionId,
              },
            });
            yield* transaction.insert(legalBasisAssignments).values({
              ...scope,
              actionInvocationId: yield* nextId(),
              assignmentRecord: yield* Schema.encodeEffect(PrivacyLegalBasisAssignmentSchema)(assignment),
              assignmentRef: assignmentId,
              decision: 'APPROVED',
              effectiveFrom: new Date(from),
              effectiveTo: new Date(until),
              processingScopeRef: processingScopeRef.scopeId,
            });
            stage = 'source processing context';
            contexts.push(
              yield* Schema.decodeUnknownEffect(SourceProcessingContextSchema)({
                ...scope,
                ...plan,
                applicabilityAuthority: {
                  asOf: from,
                  authority,
                  decisionEvaluatedAt: from,
                  decisionOutcome: decision.outcome,
                  decisionRef,
                  evidenceRefs,
                  receiptRef,
                  scope: applicabilityScope,
                  status: 'CURRENT',
                  validUntil: until,
                },
                authorityIncarnation: `internal-source:${fixtureId}`,
                authorityRevision: 'internal:1',
                contentScopeRefs: seed.dataCategoryRefs,
                effectiveFrom: from,
                intendedScope: {
                  controllerRef: seed.controllerRef,
                  dataCategoryRefs: seed.dataCategoryRefs,
                  operation: plan.request.operation,
                  processingScopeRef,
                  purposeRef: purposeId,
                  purposeVersionId: versionId,
                  recipientRefs: [plan.request.consumerModuleId],
                  subjectRef,
                },
                resourceRefs: plan.request.target === null ? [subjectId] : [subjectId, plan.request.target.resourceId],
                validUntil: until,
              }),
            );
          }
          return yield* Effect.void;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(SourceProcessingNativeFixtureError)(cause)
            ? cause
            : unavailable(cause, `The isolated Privacy native fixture failed at ${stage}`),
        ),
      );
    return { contexts, purposeRef, subjectRefs: [...subjects.values()] };
  },
  Effect.scoped,
  Effect.provide(Reactivity.layer),
);

export const seedSourceProcessingNativeFixture = (input: SeedInput) => seedNativeProcessing(input);

interface NativeOwnerProofTransport {
  readonly authorization: Redacted.Redacted;
  readonly baseUrl: string;
  readonly compositionRevision: string;
  readonly requestCorrelation: string;
}
type CommittedProfileSeedInput = SeedInput & {
  readonly personAdmission?: NativeOwnerProofTransport;
  readonly profileReceipt: NativeOwnerProofTransport & {
    readonly request: typeof CustomerProfileSourceRequestSchema.Type;
  };
};

/** Separate INTERNAL governance setup BETWEEN independent jobs. A fresh public CCC receipt
 * projects the actual Party proof made under its live lease; no caller-supplied receipt is authority.
 * The original source anchor stays immutable; a new DATA_SUBJECT, purpose and basis are recorded.
 */
export const seedCommittedProfileSourceProcessingNativeFixture = Effect.fn('PrivacyNativeFixture.seedCommittedProfile')(
  function* seedCommittedProfile(input: CommittedProfileSeedInput) {
    yield* assertIsolatedConnections(input.connections);
    const request = yield* Schema.decodeUnknownEffect(CustomerProfileSourceRequestSchema)(
      input.profileReceipt.request,
    ).pipe(Effect.mapError((cause) => unavailable(cause, 'The committed Profile fixture request is invalid')));
    if (request.mode !== 'MINIMAL_RECEIPT') {
      return yield* unavailable(undefined, 'A minimal current Profile receipt is required');
    }
    const transport = input.profileReceipt;
    const result = yield* executeCustomerProfileSourceWithAuthorization(
      request,
      Redacted.value(transport.authorization),
      transport.requestCorrelation,
      { baseUrl: transport.baseUrl, compositionRevision: transport.compositionRevision },
    ).pipe(Effect.mapError((cause) => unavailable(cause, 'The current committed Profile receipt could not be read')));
    const decoded = yield* Schema.decodeUnknownEffect(Schema.toType(CustomerProfileSourceResponseSchema))(result).pipe(
      Effect.mapError((cause) => unavailable(cause, 'The decoded current committed Profile receipt is invalid')),
    );
    const admission = yield* Match.value(decoded).pipe(
      Match.tag('MINIMAL_RECEIPT', ({ currentAdmission, receipt }) =>
        Effect.gen(function* verifyCommittedProfile() {
          const { partySourceReference, source, subject } = receipt.intent;
          const { profileRef } = receipt.result;
          if (
            receipt.result.outcome !== 'PROFILE_CREATED' ||
            source === undefined ||
            partySourceReference === undefined ||
            profileRef.tenantId !== input.tenantId ||
            subject.partyRef.tenantId !== input.tenantId ||
            subject.sellingLegalEntityRef.resourceId !== input.legalEntityId ||
            source.issuer !== request.issuer ||
            source.namespace !== request.namespace ||
            source.recordType !== request.recordType ||
            source.mappingRevision !== request.mappingRevision ||
            source.route.id !== request.route.id ||
            source.route.revision !== request.route.revision ||
            source.effectId !== request.effectId ||
            receipt.result.sourceEffect?.effectId !== request.effectId
          ) {
            return yield* unavailable(
              undefined,
              'The current receipt does not attest the isolated committed Retail Profile',
            );
          }
          const partyRef = yield* Schema.decodeUnknownEffect(PrivacyPartyRefSchema)(subject.partyRef).pipe(
            Effect.mapError(unavailable),
          );
          const sourceEquivalent = Schema.toEquivalence(PrivacySourcePersonReferenceSchema);
          if (!sourceEquivalent(currentAdmission.sourceReference, partySourceReference)) {
            return yield* unavailable(
              undefined,
              'The projected Party citation does not match the committed Profile receipt',
            );
          }
          const resolvedPerson = yield* admitCurrentSourcePersonProof(partyRef, input.tenantId, currentAdmission).pipe(
            Effect.mapError((cause) => unavailable(cause, 'The committed Profile current Party proof is unavailable')),
          );
          return {
            ownerAdmission: resolvedPerson.evidence,
            personAdmission: resolvedPerson.proof,
            profileId: profileRef.resourceId,
            profileReceipt: receipt,
            sourceReference: partySourceReference,
          };
        }),
      ),
      Match.orElse(() => Effect.fail(unavailable(undefined, 'A current minimal Retail Profile receipt is required'))),
    );
    const seeded = yield* seedNativeProcessing(input, admission);
    return { ...seeded, personAdmission: admission.personAdmission, profileReceipt: admission.profileReceipt };
  },
);
