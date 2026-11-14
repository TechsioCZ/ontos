import { NodeCrypto } from '@effect/platform-node';
import { ReadHandlerUnavailable, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { ConfigProvider, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  OrganizationBusinessNameExportFields,
  OrganizationBusinessNameExportProjectionVersion,
} from '@app/party-registry/apis/organization-business-name-export';
import { CurrentOrganizationCustomerRecordFactsSchema } from '@app/party-registry/apis/organization-record-facts';
import {
  OrganizationBusinessApplicabilityLiveProofSchema,
  OrganizationBusinessApplicabilityContextSchema,
  OrganizationBusinessApplicabilityRequestSchema,
  OrganizationBusinessSourceOnboardLiveProofSchema,
  OrganizationBusinessSourceProfileCreateLiveProofSchema,
} from '../../shared/apis/organization-business-applicability.ts';
import { resolvePrivacyApplicability } from '../../shared/domain/privacy-applicability.ts';
import {
  PrivacyApplicabilityBusinessFactAuthority,
  PrivacyApplicabilityBusinessFactAuthorityLive,
} from '../../src/actions/privacy-applicability-business-fact-authority-service.ts';
import {
  evaluateOrganizationBusinessApplicability,
  organizationBusinessFacts,
} from '../../src/services/organization-business-applicability.service.ts';
import {
  makeOrganizationBusinessApplicabilityFixture,
  makeOrganizationBusinessSourceDagFixture,
} from '../support/organization-business-applicability.fixture.ts';

const decodeProof = Schema.decodeUnknownSync(OrganizationBusinessApplicabilityLiveProofSchema);
const businessContextsKey = 'ONTOS_PRIVACY_ORGANIZATION_BUSINESS_CONTEXTS';

it.layer(NodeCrypto.layer)('organization business applicability decision logic', (suite) => {
  suite.effect('requires explicit source organization classification for CREATE and MATCH without a dummy person', () =>
    Effect.gen(function* sourceClassification() {
      for (const mode of ['SOURCE_CREATE', 'SOURCE_MATCH'] as const) {
        const fixture = yield* makeOrganizationBusinessApplicabilityFixture(mode);
        expect(yield* fixture.run()).toMatchObject({
          classification: 'SOURCE_ASSERTED_ORGANIZATION',
          inputDigest: fixture.intent.inputDigest,
          liveProof: { kind: 'SOURCE_ASSERTED', sourceSubjectRevision: fixture.sourceSnapshot.revision },
          outcome: 'NOT_APPLICABLE',
        });
        expect(fixture.business.scope.facts.some((fact) => fact.dimension === 'PRIVACY_SUBJECT')).toBe(false);
        expect(fixture.business.scope.facts.some((fact) => fact.dimension === 'OWNER_PARTY_KIND')).toBe(false);
        expect(fixture.business.scope.facts).toContainEqual({
          dimension: 'SOURCE_CLASSIFICATION',
          value: 'SOURCE_ASSERTED_ORGANIZATION',
        });
      }
    }),
  );

  suite.effect('binds canonical membership and price intent to the complete current customer tuple', () =>
    Effect.gen(function* canonicalClassification() {
      for (const mode of ['MEMBERSHIP', 'PRICE'] as const) {
        const fixture = yield* makeOrganizationBusinessApplicabilityFixture(mode);
        expect(yield* fixture.run()).toMatchObject({
          classification: 'CANONICAL_ORGANIZATION',
          liveProof: { kind: 'COUNTERPARTY_PROFILE', profile: { profileRevision: 5 } },
          operation: fixture.request.operation,
          outcome: 'NOT_APPLICABLE',
        });
        expect(fixture.business.scope.facts.some((fact) => fact.dimension === 'PRIVACY_SUBJECT')).toBe(false);
      }
    }),
  );

  suite.effect('rechecks current configuration, policy, Controller, Purpose and holds on every attempt', () =>
    Effect.gen(function* currentGovernance() {
      const fixture = yield* makeOrganizationBusinessApplicabilityFixture('MEMBERSHIP');
      const { services } = fixture;
      for (const ports of [
        { ...services, contexts: [] },
        { ...services, contexts: [{ ...fixture.context, authorityRevision: 'internal:revoked-context' }] },
        { ...services, contexts: [{ ...fixture.context, validUntil: fixture.evaluatedAt }] },
        { ...services, repository: { ...services.repository, listApplicabilityPolicies: () => Effect.succeed([]) } },
        { ...services, repository: { ...services.repository, listResponsibilities: () => Effect.succeed([]) } },
        { ...services, purposes: { get: () => Effect.succeed(Option.none()) } },
        {
          ...services,
          purposes: { get: () => Effect.succeed(Option.some({ ...fixture.purpose, lifecycle: 'RETIRED' as const })) },
        },
        {
          ...services,
          purposes: {
            get: () =>
              Effect.succeed(
                Option.some({
                  ...fixture.purpose,
                  versions: fixture.purpose.versions.map((version) => ({
                    ...version,
                    effectiveTo: fixture.evaluatedAt,
                  })),
                }),
              ),
          },
        },
        { ...services, holds: () => Effect.succeed('BLOCKED' as const) },
      ]) {
        expect((yield* fixture.run(ports)).outcome).toBe('DENIED');
      }
      expect((yield* fixture.run({ ...services, holds: () => Effect.succeed('INDETERMINATE') })).outcome).toBe(
        'INDETERMINATE',
      );
    }),
  );

  suite.effect('does not accept absent or superseded native classification history', () =>
    Effect.gen(function* currentDecision() {
      const fixture = yield* makeOrganizationBusinessApplicabilityFixture('SOURCE_CREATE');
      const unresolved = resolvePrivacyApplicability({
        authority: fixture.business.authority,
        authorityEvidenceRefs: fixture.business.evidenceRefs,
        authorityReceiptRef: fixture.business.receiptRef,
        evaluatedAt: fixture.evaluatedAt,
        policies: [],
        proposedActivity: false,
        responsibilityAssignmentRefs: [fixture.responsibility.assignmentRef],
        scope: fixture.business.scope,
      });
      expect((yield* fixture.run({ ...fixture.services, decision: () => Effect.succeed(Option.none()) })).outcome).toBe(
        'DENIED',
      );
      expect(
        (yield* fixture.run({
          ...fixture.services,
          repository: { ...fixture.services.repository, listApplicabilityDecisions: () => Effect.succeed([]) },
        })).outcome,
      ).toBe('DENIED');
      expect(
        (yield* fixture.run({
          ...fixture.services,
          repository: {
            ...fixture.services.repository,
            listApplicabilityDecisions: () => Effect.succeed([unresolved]),
          },
        })).outcome,
      ).toBe('DENIED');
    }),
  );

  suite.effect('reports only the exact requested fields when the native policy permits a larger projection', () =>
    Effect.gen(function* exactPositiveProjection() {
      const fixture = yield* makeOrganizationBusinessApplicabilityFixture('MEMBERSHIP');
      const request = Schema.decodeUnknownSync(OrganizationBusinessApplicabilityRequestSchema)({
        ...fixture.request,
        fields: ['processingKind'],
      });
      const context = Schema.decodeUnknownSync(OrganizationBusinessApplicabilityContextSchema)({
        ...fixture.context,
        request,
      });
      const business = yield* organizationBusinessFacts(context, fixture.profileProof, fixture.evaluatedAt);
      const decision = resolvePrivacyApplicability({
        authority: business.authority,
        authorityEvidenceRefs: business.evidenceRefs,
        authorityReceiptRef: business.receiptRef,
        evaluatedAt: fixture.evaluatedAt,
        policies: [fixture.policy],
        proposedActivity: false,
        responsibilityAssignmentRefs: [fixture.responsibility.assignmentRef],
        scope: business.scope,
      });
      expect(
        yield* evaluateOrganizationBusinessApplicability(
          request,
          fixture.scope,
          {
            ...fixture.services,
            contexts: [context],
            decision: () => Effect.succeed(Option.some(decision)),
            repository: {
              ...fixture.services.repository,
              listApplicabilityDecisions: () => Effect.succeed([decision]),
            },
          },
          fixture.evaluatedAt,
        ),
      ).toMatchObject({ allowedFields: ['processingKind'], outcome: 'NOT_APPLICABLE' });
    }),
  );

  suite.effect('rejects changed source occurrence, accepted input, effect, caller witness and anchor version', () =>
    Effect.gen(function* sourcePins() {
      const fixture = yield* makeOrganizationBusinessApplicabilityFixture('SOURCE_CREATE');
      const proof = fixture.sourceProof;
      for (const changed of [
        {
          ...proof,
          source: {
            ...proof.source,
            sourceReference: { ...proof.source.sourceReference, occurrenceId: 'different-occurrence' },
          },
        },
        { ...proof, source: { ...proof.source, inputDigest: '9'.repeat(64) } },
        { ...proof, source: { ...proof.source, effectId: '81000000-0000-4000-8000-000000000099' } },
        {
          ...proof,
          source: { ...proof.source, originalAdmissionInvocationId: '81000000-0000-4000-8000-000000000099' },
        },
        {
          ...proof,
          source: { ...proof.source, acceptedAdmissionInvocationId: '81000000-0000-4000-8000-000000000099' },
        },
        { ...proof, source: { ...proof.source, routeRevision: 'changed-source-route' } },
        { ...proof, sourceSubjectRevision: '9'.repeat(64) },
      ]) {
        expect(
          (yield* fixture.run({ ...fixture.services, proof: () => Effect.succeed(decodeProof(changed)) })).outcome,
        ).toBe('DENIED');
      }
    }),
  );

  suite.effect('keeps the canonical receipt stable across a separately validated transport alias', () =>
    Effect.gen(function* sourceAliasProjection() {
      const fixture = yield* makeOrganizationBusinessApplicabilityFixture('SOURCE_CREATE');
      const aliasId = '81000000-0000-4000-8000-000000000098';
      const aliased = {
        ...fixture.sourceProof,
        source: { ...fixture.sourceProof.source, originalAdmissionInvocationId: aliasId },
      };
      const aliasBusiness = yield* organizationBusinessFacts(fixture.context, aliased, fixture.evaluatedAt);
      expect(aliasBusiness.receiptRef).toBe(fixture.business.receiptRef);
      const request = Schema.decodeUnknownSync(OrganizationBusinessApplicabilityRequestSchema)({
        ...fixture.request,
        processingWitness: {
          effectId: fixture.sourceProof.source.effectId,
          originalAdmissionInvocationId: aliasId,
          purpose: 'PROCESSING',
        },
      });
      // The trusted unit proof seam establishes no actual Core alias relationship.
      expect(
        (yield* evaluateOrganizationBusinessApplicability(
          request,
          fixture.scope,
          {
            ...fixture.services,
            proof: () => Effect.succeed(aliased),
          },
          fixture.evaluatedAt,
        )).outcome,
      ).toBe('NOT_APPLICABLE');
    }),
  );

  suite.effect('blocks reconciled and erased source material despite a new projection label', () =>
    Effect.gen(function* retainedSourceProtections() {
      const fixture = yield* makeOrganizationBusinessApplicabilityFixture('SOURCE_CREATE');
      for (const snapshot of [
        { ...fixture.sourceSnapshot, reconciled: true },
        { ...fixture.sourceSnapshot, protections: [fixture.protection] },
      ]) {
        expect(
          yield* fixture.run({
            ...fixture.services,
            sourceAuthority: { read: () => Effect.succeed(snapshot) },
          }),
        ).toMatchObject({ outcome: 'DENIED', reason: 'SOURCE_PROTECTED' });
      }
    }),
  );

  suite.effect('rejects mixed profile, Party, Counterparty, role and legal-entity proofs', () =>
    Effect.gen(function* currentCustomerTuple() {
      const fixture = yield* makeOrganizationBusinessApplicabilityFixture('MEMBERSHIP');
      const proof = fixture.profileProof;
      for (const changed of [
        { ...proof, organization: { ...proof.organization, partyRevision: 8 } },
        { ...proof, organization: { ...proof.organization, counterpartyRevision: '9'.repeat(64) } },
        { ...proof, organization: { ...proof.organization, currentCustomerRoleRevision: '9'.repeat(64) } },
        { ...proof, organization: { ...proof.organization, typeAssertionRevision: '9'.repeat(64) } },
        { ...proof, organization: { ...proof.organization, typeValidFrom: '2027-01-01T00:00:00.000Z' } },
        { ...proof, profile: { ...proof.profile, profileRevision: 6 } },
        {
          ...proof,
          profile: {
            ...proof.profile,
            profileRef: { ...proof.profile.profileRef, resourceId: '81000000-0000-4000-8000-000000000099' },
          },
        },
        {
          ...proof,
          organization: {
            ...proof.organization,
            legalEntityRef: {
              ...proof.organization.legalEntityRef,
              resourceId: '81000000-0000-4000-8000-000000000099',
            },
          },
        },
      ]) {
        expect(
          (yield* fixture.run({ ...fixture.services, proof: () => Effect.succeed(decodeProof(changed)) })).outcome,
        ).toBe('DENIED');
      }
    }),
  );

  suite.effect('requires the exact verified scope and requested operation field set', () =>
    Effect.gen(function* exactScope() {
      const fixture = yield* makeOrganizationBusinessApplicabilityFixture('MEMBERSHIP');
      for (const changed of [
        { legalEntityId: '81000000-0000-4000-8000-000000000099' },
        { tenantId: '81000000-0000-4000-8000-000000000099' },
        { principalId: '81000000-0000-4000-8000-000000000099' },
      ]) {
        const foreign = {
          ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({ ...fixture.scope, ...changed }),
          correlationId: fixture.scope.correlationId,
        };
        expect(
          (yield* evaluateOrganizationBusinessApplicability(
            fixture.request,
            foreign,
            fixture.services,
            fixture.evaluatedAt,
          )).outcome,
        ).toBe('DENIED');
      }
      const otherFields = Schema.decodeUnknownSync(OrganizationBusinessApplicabilityRequestSchema)({
        ...fixture.request,
        fields: ['processingKind'],
      });
      expect(
        (yield* evaluateOrganizationBusinessApplicability(
          otherFields,
          fixture.scope,
          fixture.services,
          fixture.evaluatedAt,
        )).outcome,
      ).toBe('DENIED');
      for (const invalid of [
        { ...fixture.request, fields: ['assignmentReason'] },
        { ...fixture.request, fields: ['firstName'] },
        { ...fixture.request, fields: ['actorPrincipalId'] },
        { ...fixture.request, consumerModuleId: 'party.registry' },
        { ...fixture.request, projectionVersion: 'party.registry.organization-business-source-fields.v1' },
        {
          ...fixture.request,
          profileRef: {
            ...fixture.profileProof.profile.profileRef,
            resourceType: 'commerce.customer-context.retail-customer-profile',
          },
        },
      ]) {
        expect(Schema.is(OrganizationBusinessApplicabilityRequestSchema)(invalid)).toBe(false);
      }
    }),
  );

  suite.effect(
    'keeps semantic governance evidence independent of later owner facts and accepts current processing DTOs',
    () =>
      Effect.gen(function* semanticDagGovernance() {
        for (const mode of ['ONBOARD', 'PROFILE_CREATE'] as const) {
          const fixture = yield* makeOrganizationBusinessSourceDagFixture(mode);
          expect('resolvedOwner' in fixture.governanceProof).toBe(false);
          expect('materialization' in fixture.governanceProof.source).toBe(false);
          const processing = yield* organizationBusinessFacts(fixture.context, fixture.proof, fixture.evaluatedAt);
          expect(processing.receiptRef).toBe(fixture.business.receiptRef);
          expect(processing.evidenceRefs).toEqual(fixture.business.evidenceRefs);
          // These DTO seams do not prove real Core parent receipts or receiving transport authority.
          expect(yield* fixture.run()).toMatchObject({
            classification: 'SOURCE_ASSERTED_ORGANIZATION',
            operation: fixture.request.operation,
            outcome: 'NOT_APPLICABLE',
          });
        }
      }),
  );

  suite.effect('requires materialization for deferred source processing but not semantic governance evidence', () =>
    Effect.gen(function* requiredMaterialization() {
      for (const mode of ['ONBOARD', 'PROFILE_CREATE'] as const) {
        const fixture = yield* makeOrganizationBusinessSourceDagFixture(mode);
        expect(
          (yield* fixture.run({ ...fixture.services, proof: () => Effect.succeed(fixture.governanceProof) })).outcome,
        ).toBe('DENIED');
        expect(
          Schema.is(OrganizationBusinessApplicabilityRequestSchema)({
            ...fixture.request,
            processingWitness: {
              effectId: fixture.request.processingWitness.effectId,
              originalAdmissionInvocationId: fixture.request.processingWitness.originalAdmissionInvocationId,
              purpose: 'PROCESSING',
            },
          }),
        ).toBe(false);
      }
    }),
  );

  suite.effect('denies deferred source requests with a wrong native digest, native version or resolved target', () =>
    Effect.gen(function* materializationIdentity() {
      const fixture = yield* makeOrganizationBusinessSourceDagFixture('ONBOARD');
      for (const changed of [
        {
          ...fixture.request,
          processingWitness: {
            ...fixture.request.processingWitness,
            materializationWitness: {
              ...fixture.request.processingWitness.materializationWitness,
              inputDigest: '9'.repeat(64),
            },
          },
        },
        {
          ...fixture.request,
          processingWitness: {
            ...fixture.request.processingWitness,
            materializationWitness: {
              ...fixture.request.processingWitness.materializationWitness,
              projectionVersion: 'wrong-native-version',
            },
          },
        },
        {
          ...fixture.request,
          resolvedTarget: {
            kind: 'PARTY',
            partyRef: {
              ...fixture.onboardProof.resolvedOwner.organization.partyRef,
              resourceId: '81000000-0000-4000-8000-000000000099',
            },
          },
        },
      ]) {
        const request = Schema.decodeUnknownSync(OrganizationBusinessApplicabilityRequestSchema)(changed);
        expect(
          (yield* evaluateOrganizationBusinessApplicability(
            request,
            fixture.scope,
            fixture.services,
            fixture.evaluatedAt,
          )).outcome,
        ).toBe('DENIED');
      }
    }),
  );

  suite.effect('denies stale or uncorrelated current organization evidence for a deferred onboard', () =>
    Effect.gen(function* currentOnboardTarget() {
      const fixture = yield* makeOrganizationBusinessSourceDagFixture('ONBOARD');
      const proof = fixture.onboardProof;
      for (const changed of [
        {
          ...proof,
          resolvedOwner: {
            ...proof.resolvedOwner,
            organization: { ...proof.resolvedOwner.organization, typeValidTo: fixture.evaluatedAt },
          },
        },
        {
          ...proof,
          resolvedOwner: {
            ...proof.resolvedOwner,
            organization: { ...proof.resolvedOwner.organization, sourceCitation: null },
          },
        },
        {
          ...proof,
          resolvedOwner: {
            ...proof.resolvedOwner,
            organization: {
              ...proof.resolvedOwner.organization,
              partyRef: {
                ...proof.resolvedOwner.organization.partyRef,
                resourceId: '81000000-0000-4000-8000-000000000099',
              },
            },
          },
        },
        {
          ...proof,
          source: {
            ...proof.source,
            materialization: { ...proof.source.materialization, projectionVersion: 'wrong-native-version' },
          },
        },
      ]) {
        const changedProof = Schema.decodeUnknownSync(OrganizationBusinessSourceOnboardLiveProofSchema)(changed);
        expect((yield* fixture.run({ ...fixture.services, proof: () => Effect.succeed(changedProof) })).outcome).toBe(
          'DENIED',
        );
      }
    }),
  );

  suite.effect(
    'denies mixed current Party, Counterparty, role and legal-entity parent tuples for deferred profile creation',
    () =>
      Effect.gen(function* currentCounterpartyParent() {
        const fixture = yield* makeOrganizationBusinessSourceDagFixture('PROFILE_CREATE');
        const proof = fixture.profileCreateProof;
        const { organization } = proof.resolvedOwner;
        for (const changed of [
          { ...organization, typeValidFrom: '2027-01-01T00:00:00.000Z' },
          {
            ...organization,
            partyRef: { ...organization.partyRef, resourceId: '81000000-0000-4000-8000-000000000099' },
          },
          {
            ...organization,
            counterpartyRef: { ...organization.counterpartyRef, resourceId: '81000000-0000-4000-8000-000000000099' },
          },
          {
            ...organization,
            legalEntityRef: { ...organization.legalEntityRef, resourceId: '81000000-0000-4000-8000-000000000099' },
          },
          {
            ...organization,
            currentCustomerRoleRef: {
              ...organization.currentCustomerRoleRef,
              resourceId: '81000000-0000-4000-8000-000000000099',
            },
          },
        ]) {
          const changedProof = Schema.decodeUnknownSync(OrganizationBusinessSourceProfileCreateLiveProofSchema)({
            ...proof,
            resolvedOwner: { ...proof.resolvedOwner, organization: changed },
          });
          expect((yield* fixture.run({ ...fixture.services, proof: () => Effect.succeed(changedProof) })).outcome).toBe(
            'DENIED',
          );
        }
      }),
  );
  suite.effect('preserves missing business authority separately from an owned-source availability failure', () =>
    Effect.gen(function* businessAuthorityFailures() {
      const fixture = yield* makeOrganizationBusinessApplicabilityFixture('SOURCE_CREATE');
      const authority = yield* PrivacyApplicabilityBusinessFactAuthority;
      const request = {
        asOf: fixture.evaluatedAt,
        legalEntityId: fixture.context.legalEntityId,
        scope: { operation: fixture.intent.operation, processingScopeRef: fixture.context.processingScopeRef },
        tenantId: fixture.context.tenantId,
      };
      const absent = yield* authority
        .resolve(request, fixture.scope, fixture.services.sourceAuthority)
        .pipe(Effect.flip, Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})));
      expect(absent.code).toBe('MISSING_AUTHORITY');
      const encoded = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Array(OrganizationBusinessApplicabilityContextSchema)),
      )([fixture.context]);
      const configured = ConfigProvider.fromUnknown({ [businessContextsKey]: encoded });
      const mismatch = yield* authority
        .resolve(
          {
            ...request,
            scope: {
              ...request.scope,
              processingScopeRef: { ...request.scope.processingScopeRef, scopeId: 'internal:other-business-intent' },
            },
          },
          fixture.scope,
          fixture.services.sourceAuthority,
        )
        .pipe(Effect.flip, Effect.provideService(ConfigProvider.ConfigProvider, configured));
      expect(mismatch.code).toBe('MISSING_AUTHORITY');
      // This is an owned-source port failure, not a missing Core lease or a claimed HTTP failure.
      const unavailable = yield* authority
        .resolve(request, fixture.scope, {
          read: () =>
            Effect.fail(
              new ReadHandlerUnavailable({
                code: 'read_handler_unavailable',
                reason: 'Unit owned-source authority is unavailable',
              }),
            ),
        })
        .pipe(Effect.flip, Effect.provideService(ConfigProvider.ConfigProvider, configured));
      expect(unavailable.code).toBe('AUTHORITY_UNAVAILABLE');
    }).pipe(Effect.provide(PrivacyApplicabilityBusinessFactAuthorityLive)),
  );

  suite.effect('keeps legacy ICO routing independent of malformed unrelated business-context configuration', () =>
    Effect.gen(function* unrelatedBusinessConfiguration() {
      const fixture = yield* makeOrganizationBusinessApplicabilityFixture('SOURCE_CREATE');
      const authority = yield* PrivacyApplicabilityBusinessFactAuthority;
      for (const operation of [
        'party-ico-legacy-inventory.read',
        'customer-profile-ico.read',
        'customer-profile-ico.write',
        'customer-profile-ico.migrate',
      ]) {
        const request = {
          asOf: fixture.evaluatedAt,
          legalEntityId: fixture.context.legalEntityId,
          scope: { operation, processingScopeRef: fixture.context.processingScopeRef },
          tenantId: fixture.context.tenantId,
        };
        const [clean, malformed] = yield* Effect.all(
          [
            authority
              .resolve(request, fixture.scope)
              .pipe(Effect.flip, Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({}))),
            authority
              .resolve(request, fixture.scope)
              .pipe(
                Effect.flip,
                Effect.provideService(
                  ConfigProvider.ConfigProvider,
                  ConfigProvider.fromUnknown({ [businessContextsKey]: 'not valid JSON' }),
                ),
              ),
          ],
          { concurrency: 2 },
        );
        expect({ code: malformed.code, reason: malformed.reason }).toEqual({ code: clean.code, reason: clean.reason });
      }
    }).pipe(Effect.provide(PrivacyApplicabilityBusinessFactAuthorityLive)),
  );
  suite.effect(
    'classifies only the exact eleven organization name-export fields using current source-cited metadata',
    () =>
      Effect.gen(function* nameExportProjection() {
        const fixture = yield* makeOrganizationBusinessApplicabilityFixture('NAME_EXPORT');
        expect(OrganizationBusinessNameExportFields).toHaveLength(11);
        expect(fixture.intent.inputDigest).toBe(fixture.nameExportProjection.inputDigest);
        expect('businessName' in fixture.partyProof.organization).toBe(false);
        expect(yield* fixture.run()).toMatchObject({
          allowedFields: OrganizationBusinessNameExportFields,
          classification: 'CANONICAL_ORGANIZATION',
          inputDigest: fixture.nameExportProjection.inputDigest,
          liveProof: { kind: 'PARTY', organization: { partyRevision: 7 } },
          operation: 'ORGANIZATION_BUSINESS_NAME_EXPORT',
          outcome: 'NOT_APPLICABLE',
          projectionVersion: OrganizationBusinessNameExportProjectionVersion,
        });
      }),
  );

  suite.effect(
    'rechecks exact name-export source occurrence, current Party, policy, purpose, Controller and holds',
    () =>
      Effect.gen(function* currentNameExportAuthority() {
        const fixture = yield* makeOrganizationBusinessApplicabilityFixture('NAME_EXPORT');
        const { partyProof, services } = fixture;
        const citation = Schema.decodeUnknownSync(CurrentOrganizationCustomerRecordFactsSchema.fields.sourceCitation)(
          partyProof.organization.sourceCitation,
        );
        for (const changed of [
          { ...partyProof, organization: { ...partyProof.organization, partyRevision: 8 } },
          { ...partyProof, organization: { ...partyProof.organization, typeValidTo: fixture.evaluatedAt } },
          { ...partyProof, organization: { ...partyProof.organization, sourceCitation: null } },
          {
            ...partyProof,
            organization: {
              ...partyProof.organization,
              sourceCitation: { ...citation, originalOccurrenceId: 'wrong-original-occurrence' },
            },
          },
        ]) {
          expect((yield* fixture.run({ ...services, proof: () => Effect.succeed(decodeProof(changed)) })).outcome).toBe(
            'DENIED',
          );
        }
        for (const ports of [
          { ...services, contexts: [] },
          { ...services, contexts: [{ ...fixture.context, authorityRevision: 'internal:name-export-revoked' }] },
          { ...services, repository: { ...services.repository, listApplicabilityPolicies: () => Effect.succeed([]) } },
          { ...services, repository: { ...services.repository, listResponsibilities: () => Effect.succeed([]) } },
          { ...services, purposes: { get: () => Effect.succeed(Option.none()) } },
          { ...services, holds: () => Effect.succeed('BLOCKED' as const) },
        ]) {
          expect((yield* fixture.run(ports)).outcome).toBe('DENIED');
        }
        expect((yield* fixture.run({ ...services, holds: () => Effect.succeed('INDETERMINATE') })).outcome).toBe(
          'INDETERMINATE',
        );
      }),
  );

  suite.effect('rejects other versions, operations, personal fields and a missing name-export source reference', () =>
    Effect.gen(function* exactNameExportContract() {
      const fixture = yield* makeOrganizationBusinessApplicabilityFixture('NAME_EXPORT');
      for (const invalid of [
        { ...fixture.request, projectionVersion: 'party.registry.organization-business-record-fields.v1' },
        { ...fixture.request, operation: 'EVIDENCE_READ' },
        { ...fixture.request, fields: ['result.firstName'] },
        { ...fixture.request, fields: ['result.contacts'] },
        { ...fixture.request, fields: ['actorPrincipalId'] },
        { ...fixture.request, fields: ['result.businessName.reason'] },
        {
          consumerModuleId: 'party.registry',
          fields: OrganizationBusinessNameExportFields,
          inputDigest: fixture.nameExportProjection.inputDigest,
          kind: 'PARTY',
          operation: 'ORGANIZATION_BUSINESS_NAME_EXPORT',
          partyRef: fixture.partyProof.organization.partyRef,
          projectionVersion: OrganizationBusinessNameExportProjectionVersion,
        },
      ]) {
        expect(Schema.is(OrganizationBusinessApplicabilityRequestSchema)(invalid)).toBe(false);
      }
    }),
  );
});
