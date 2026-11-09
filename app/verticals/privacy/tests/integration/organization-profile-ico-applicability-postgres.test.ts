import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { ConfigProvider, Crypto, DateTime, Effect, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { organizationProfileIcoApplicabilityRead } from '../../src/api/organization-profile-ico-applicability.read.ts';
import { OrganizationProfileIcoFactsOwner } from '../../src/services/organization-profile-ico-applicability.service.ts';
import { privacyOperationRepositoryForScope } from '../../src/persistence/privacy-operation-postgres-repository.ts';
import { processingPurposeRepositoryForScope } from '../../src/persistence/processing-purpose-postgres-repository.ts';
import { legalHolds } from '../../src/database/schema.ts';
import { privacyIcoNativeContext } from '../support/privacy-ico-native-composition.ts';
import { makeOrganizationProfileIcoApplicabilityFixture } from '../support/organization-profile-ico-applicability.fixture.ts';

/** Real Privacy ledgers and governed Read; the two owner facts are an explicit INTERNAL contract seam.
 * Actual cross-owner receiving/persistence belongs to the combined conformance proof. */
it.live(
  'requires current native profile ICO classification and rechecks exact role revision, configuration and hold',
  () =>
    Effect.gen(function* nativeProfileIco() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-11-07T12:00:00.000Z')));
      const native = yield* privacyIcoNativeContext('privacy.core.organization-profile-ico-applicability.read');
      const crypto = yield* Crypto.Crypto;
      const { principalId, tenantId } = native.principal;
      const legalEntityId = Option.getOrThrow(Option.fromUndefinedOr(native.principal.legalEntityId));
      const fixture = yield* native
        .prepareOwner((transaction, scope) =>
          Effect.gen(function* currentNativeGovernance() {
            const purposes = yield* processingPurposeRepositoryForScope(transaction, scope);
            const purpose = yield* purposes.create(tenantId, legalEntityId, yield* crypto.randomUUIDv4(), {
              businessCode: 'INTERNAL_PROFILE_ICO',
              effectiveFrom: '2026-11-01T00:00:00.000Z',
              governanceOwnerId: principalId,
              meaning: 'Explicit organization profile ICO-only field classification',
            });
            const version = Option.getOrThrow(Option.fromUndefinedOr(purpose.versions.at(0)));
            const facts = makeOrganizationProfileIcoApplicabilityFixture({
              authMethod: native.principal.authMethod,
              legalEntityId,
              principalId,
              purposeId: purpose.purposeRef.resourceId,
              tenantId,
              versionId: version.versionId,
            });
            const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
            yield* repository.assignResponsibility(
              tenantId,
              legalEntityId,
              yield* crypto.randomUUIDv4(),
              facts.responsibility,
            );
            yield* repository.recordApplicabilityPolicy(
              tenantId,
              legalEntityId,
              yield* crypto.randomUUIDv4(),
              facts.policy,
            );
            yield* repository.recordApplicability(
              tenantId,
              legalEntityId,
              yield* crypto.randomUUIDv4(),
              facts.context.decisionRef,
              facts.decision,
            );
            return facts;
          }),
        )
        .pipe(Effect.provide(native.layer));
      const read = (contexts = [fixture.context], proof = fixture.proof) =>
        native.runtime
          .runRead({
            input: fixture.request,
            principal: native.principal,
            registration: organizationProfileIcoApplicabilityRead,
            transport: { correlationId: 'internal:profile-ico' },
          })
          .pipe(
            Effect.provide(native.layer),
            Effect.provideService(OrganizationProfileIcoFactsOwner, { resolve: () => Effect.succeed(proof) }),
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({ ONTOS_PRIVACY_ORGANIZATION_PROFILE_ICO_CONTEXTS: JSON.stringify(contexts) }),
            ),
          );
      expect(yield* read()).toMatchObject({
        allowedFields: fixture.request.fields,
        outcome: 'NOT_APPLICABLE',
        partyRevision: 7,
        profileRevision: 5,
      });
      expect((yield* read([])).outcome).toBe('DENIED');
      expect((yield* read([{ ...fixture.context, authorityRevision: 'revoked:2' }])).outcome).toBe('DENIED');
      expect(
        (yield* read([fixture.context], {
          ...fixture.proof,
          profileCorrelationEvidenceRef: 'changed:actual-role-revision',
        })).outcome,
      ).toBe('DENIED');
      yield* native
        .prepareOwner((transaction) =>
          Effect.gen(function* exactProfileHold() {
            const hold = {
              actorPrincipalRef: principalId,
              authorityKind: 'LEGAL_HOLD_AUTHORITY',
              authorityRef: 'internal:profile-hold-authority',
              contentScopeRefs: [fixture.context.processingScopeRef.scopeId],
              controllerRef: legalEntityId,
              effectiveFrom: '2026-11-01T00:00:00.000Z',
              effectiveTo: '2026-12-01T00:00:00.000Z',
              evidenceRefs: ['internal:profile-hold-evidence'],
              holdRef: `internal:profile-hold:${tenantId}`,
              policyRef: 'internal:profile-hold-policy',
              policyVersion: 1,
              provenanceRef: 'internal:profile-hold-provenance',
              reasonTypeRef: 'internal:profile-hold-reason',
              reasonTypeVersion: 1,
              releaseConditionRef: null,
              releasedAt: null,
              releasedByPrincipalRef: null,
              releaseEvidenceRefs: [],
              releaseReasonRef: null,
              releaseRef: null,
              reviewDueAt: '2026-11-20T00:00:00.000Z',
              reviewedAt: null,
              reviewEvidenceRefs: [],
              reviewRef: 'internal:profile-hold-review',
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
      expect((yield* read()).outcome).toBe('DENIED');
    }).pipe(Effect.provide(NodeServices.layer), Effect.provide(NodeCrypto.layer), Effect.provide(TestClock.layer())),
);
