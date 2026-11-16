import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { ConfigProvider, Crypto, DateTime, Effect, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { organizationBusinessApplicabilityRead } from '../../src/api/organization-business-applicability.read.ts';
import { antiResurrectionProtections, legalHolds } from '../../src/database/schema.ts';
import { privacyOperationRepositoryForScope } from '../../src/persistence/privacy-operation-postgres-repository.ts';
import { processingPurposeRepositoryForScope } from '../../src/persistence/processing-purpose-postgres-repository.ts';
import {
  OrganizationBusinessFactsOwner,
  organizationBusinessContentScope,
  organizationBusinessSourceAuthorityForScope,
} from '../../src/services/organization-business-applicability.service.ts';
import {
  PrivacyApplicabilityPolicySchema,
  resolvePrivacyApplicability,
} from '../../shared/domain/privacy-applicability.ts';
import { PrivacyResponsibilityAssignmentSchema } from '../../shared/domain/privacy-responsibility-assignment.ts';
import { AntiResurrectionProtectionSchema } from '../../shared/domain/anti-resurrection.ts';
import { privacyOrganizationBusinessNativeContext } from '../support/privacy-ico-native-composition.ts';
import { makeOrganizationBusinessApplicabilityFixture } from '../support/organization-business-applicability.fixture.ts';

type Native = Effect.Success<ReturnType<typeof privacyOrganizationBusinessNativeContext>>;

const seedClassification = Effect.fn('PrivacyTests.seedOrganizationBusinessClassification')(function* seed(
  native: Native,
  mode: 'SOURCE_CREATE' | 'MEMBERSHIP' | 'PRICE',
) {
  const crypto = yield* Crypto.Crypto;
  const { principalId, tenantId } = native.principal;
  const legalEntityId = Option.getOrThrow(Option.fromUndefinedOr(native.principal.legalEntityId));
  return yield* native
    .prepareOwner((transaction, scope) =>
      Effect.gen(function* nativeGovernance() {
        const purposes = yield* processingPurposeRepositoryForScope(transaction, scope);
        const purpose = yield* purposes.create(tenantId, legalEntityId, yield* crypto.randomUUIDv4(), {
          businessCode: `INTERNAL_ORGANIZATION_${mode}`,
          effectiveFrom: '2026-11-01T00:00:00.000Z',
          governanceOwnerId: principalId,
          meaning: 'Explicit finite organization business projection classification',
        });
        const version = Option.getOrThrow(Option.fromUndefinedOr(purpose.versions.at(0)));
        const fixture = yield* makeOrganizationBusinessApplicabilityFixture(mode, {
          authMethod: native.principal.authMethod,
          evaluatedAt: DateTime.formatIso(yield* DateTime.now),
          legalEntityId,
          principalId,
          purposeId: purpose.purposeRef.resourceId,
          tenantId,
          versionId: version.versionId,
        });
        const responsibility = Schema.decodeUnknownSync(PrivacyResponsibilityAssignmentSchema)({
          ...(yield* Schema.encodeEffect(PrivacyResponsibilityAssignmentSchema)(fixture.responsibility)),
          assignmentRef: {
            ...fixture.responsibility.assignmentRef,
            resourceId: `internal:organization-controller:${mode}:${tenantId}`,
          },
        });
        const decision = resolvePrivacyApplicability({
          authority: fixture.business.authority,
          authorityEvidenceRefs: fixture.business.evidenceRefs,
          authorityReceiptRef: fixture.business.receiptRef,
          evaluatedAt: fixture.evaluatedAt,
          policies: [fixture.policy],
          proposedActivity: false,
          responsibilityAssignmentRefs: [responsibility.assignmentRef],
          scope: fixture.business.scope,
        });
        const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
        if (mode === 'SOURCE_CREATE') {
          yield* repository.createSubject(
            { legalEntityId, tenantId },
            { actionInvocationId: yield* crypto.randomUUIDv4(), subject: fixture.sourceSnapshot.record },
          );
          const snapshot = yield* organizationBusinessSourceAuthorityForScope(transaction, scope).read(
            fixture.sourceProof.source.sourceReference,
          );
          expect(snapshot.revision).toBe(fixture.sourceProof.sourceSubjectRevision);
          expect(snapshot.record.subject.kind).toBe('SOURCE_ASSERTED');
        }
        yield* repository.assignResponsibility(tenantId, legalEntityId, yield* crypto.randomUUIDv4(), responsibility);
        yield* repository.recordApplicabilityPolicy(
          tenantId,
          legalEntityId,
          yield* crypto.randomUUIDv4(),
          fixture.policy,
        );
        yield* repository.recordApplicability(
          tenantId,
          legalEntityId,
          yield* crypto.randomUUIDv4(),
          fixture.context.decisionRef,
          decision,
        );
        return { ...fixture, decision, responsibility };
      }),
    )
    .pipe(Effect.provide(native.layer));
});

/** Real protected Core Read and Privacy ledgers. OrganizationBusinessFactsOwner supplies explicit
 * trusted foreign DTOs only; this does not prove public RecordApplicability, clients or transport. */
it.live('rechecks native organization classification, source protection, exact holds and policy revisions', () =>
  Effect.gen(function* liveNativeClock() {
    const currentTime = yield* DateTime.now;
    return yield* Effect.gen(function* nativeOrganizationBusiness() {
      yield* TestClock.setTime(DateTime.toEpochMillis(currentTime));
      const native = yield* privacyOrganizationBusinessNativeContext(
        'privacy.core.organization-business-applicability.read',
      );
      const crypto = yield* Crypto.Crypto;
      const { principalId, tenantId } = native.principal;
      const legalEntityId = Option.getOrThrow(Option.fromUndefinedOr(native.principal.legalEntityId));
      const source = yield* seedClassification(native, 'SOURCE_CREATE');
      const profile = yield* seedClassification(native, 'MEMBERSHIP');
      const price = yield* seedClassification(native, 'PRICE');
      const read = (fixture: typeof source, contexts = [fixture.context], proof = fixture.proof) =>
        native.runtime
          .runRead({
            input: fixture.request,
            principal: native.principal,
            registration: organizationBusinessApplicabilityRead,
            transport: { correlationId: 'internal:organization-business-native' },
          })
          .pipe(
            Effect.provide(native.layer),
            Effect.provideService(OrganizationBusinessFactsOwner, { resolve: () => Effect.succeed(proof) }),
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({
                ONTOS_PRIVACY_ORGANIZATION_BUSINESS_CONTEXTS: JSON.stringify(contexts),
              }),
            ),
          );
      expect(yield* read(source)).toMatchObject({
        allowedFields: source.request.fields,
        classification: 'SOURCE_ASSERTED_ORGANIZATION',
        outcome: 'NOT_APPLICABLE',
      });
      expect((yield* read(source, [])).outcome).toBe('DENIED');
      expect((yield* read(source, [{ ...source.context, authorityRevision: 'internal:revoked' }])).outcome).toBe(
        'DENIED',
      );
      const holdAt = yield* DateTime.now;
      yield* native
        .prepareOwner((transaction) =>
          Effect.gen(function* erasedSource() {
            const { protection } = source;
            yield* transaction.insert(antiResurrectionProtections).values({
              legalEntityId,
              measure: protection.measure,
              protectedAt: DateTime.toDateUtc(DateTime.makeUnsafe(protection.protectedAt)),
              protectionId: protection.protectionId,
              protectionRecord: yield* Schema.encodeEffect(AntiResurrectionProtectionSchema)(protection),
              subjectRef: protection.subjectRef,
              tenantId,
            });
          }),
        )
        .pipe(Effect.provide(native.layer));
      expect(yield* read(source)).toMatchObject({ outcome: 'DENIED', reason: 'SOURCE_PROTECTED' });
      expect(yield* read(profile)).toMatchObject({
        allowedFields: profile.request.fields,
        classification: 'CANONICAL_ORGANIZATION',
        outcome: 'NOT_APPLICABLE',
      });
      const contentScope = yield* organizationBusinessContentScope(profile.intent, profile.profileProof);
      yield* native
        .prepareOwner((transaction) =>
          Effect.gen(function* currentProfileHold() {
            const hold = {
              actorPrincipalRef: principalId,
              authorityKind: 'LEGAL_HOLD_AUTHORITY',
              authorityRef: 'internal:organization-business-hold-authority',
              contentScopeRefs: [contentScope],
              controllerRef: legalEntityId,
              effectiveFrom: DateTime.formatIso(DateTime.add(holdAt, { minutes: -1 })),
              effectiveTo: DateTime.formatIso(DateTime.add(holdAt, { minutes: 30 })),
              evidenceRefs: ['internal:organization-business-hold-evidence'],
              holdRef: `internal:organization-business-hold:${tenantId}`,
              policyRef: 'internal:organization-business-hold-policy',
              policyVersion: 1,
              provenanceRef: 'internal:organization-business-hold-provenance',
              reasonTypeRef: 'internal:organization-business-hold-reason',
              reasonTypeVersion: 1,
              releaseConditionRef: null,
              releasedAt: null,
              releasedByPrincipalRef: null,
              releaseEvidenceRefs: [],
              releaseReasonRef: null,
              releaseRef: null,
              reviewDueAt: DateTime.formatIso(DateTime.add(holdAt, { minutes: 10 })),
              reviewedAt: null,
              reviewEvidenceRefs: [],
              reviewRef: 'internal:organization-business-hold-review',
            };
            yield* transaction.insert(legalHolds).values({
              actionInvocationId: yield* crypto.randomUUIDv4(),
              effectiveFrom: DateTime.toDateUtc(DateTime.makeUnsafe(hold.effectiveFrom)),
              effectiveTo: DateTime.toDateUtc(DateTime.makeUnsafe(hold.effectiveTo)),
              holdRecord: hold,
              holdRef: hold.holdRef,
              legalEntityId,
              recordedAt: DateTime.toDateUtc(yield* DateTime.now),
              tenantId,
            });
          }),
        )
        .pipe(Effect.provide(native.layer));
      expect(yield* read(profile)).toMatchObject({ outcome: 'DENIED', reason: 'CURRENT_SCOPE_HOLD' });
      expect((yield* read(price)).outcome).toBe('NOT_APPLICABLE');
      yield* native
        .prepareOwner((transaction, scope) =>
          Effect.gen(function* changedNativePolicy() {
            const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
            yield* repository.recordApplicabilityPolicy(
              tenantId,
              legalEntityId,
              yield* crypto.randomUUIDv4(),
              Schema.decodeUnknownSync(PrivacyApplicabilityPolicySchema)({ ...price.policy, policyVersion: '2' }),
            );
          }),
        )
        .pipe(Effect.provide(native.layer));
      expect(yield* read(price)).toMatchObject({
        outcome: 'DENIED',
        reason: 'CURRENT_EXPLICIT_CLASSIFICATION_REQUIRED',
      });
    }).pipe(Effect.provide(TestClock.layer()));
  }).pipe(Effect.provide(NodeServices.layer), Effect.provide(NodeCrypto.layer)),
);
