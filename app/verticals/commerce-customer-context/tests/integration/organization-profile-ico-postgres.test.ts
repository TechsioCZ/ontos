import { randomUUID } from 'node:crypto';
import { computeActionRequestHash } from '@app/core-runtime/access/enforcement';
import { changeOrganizationCustomerProfileIcoRequestIdentity } from '../../shared/domain/native-action-request-identity.ts';
import { ContextAccessLive, ReadRuntime, runAction } from '@app/core-runtime';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import {
  OrganizationProfileIcoApplicabilityResponseSchema,
  OrganizationProfileIcoFieldContractVersion,
} from '@app/privacy/api/organization-profile-ico-applicability';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Layer, Match, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { CreateCounterpartyPurchasingProfilePayloadSchema } from '../../shared/actions/create-counterparty-purchasing-profile.ts';
import {
  ChangeOrganizationCustomerProfileIcoPayloadSchema,
  ChangeOrganizationCustomerProfileIcoResultSchema,
  ORGANIZATION_PROFILE_ICO_FIELDS,
  OrganizationCustomerProfileIcoResponseSchema,
  OrganizationProfileIcoRejected,
} from '../../shared/domain/organization-profile-ico.ts';
import type {
  ChangeOrganizationCustomerProfileIcoPayload,
  OrganizationCustomerProfileIcoRequest,
} from '../../shared/domain/organization-profile-ico.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { changeOrganizationCustomerProfileIcoAction } from '../../src/actions/change-organization-customer-profile-ico.action.ts';
import { createCounterpartyPurchasingProfileAction } from '../../src/actions/create-counterparty-purchasing-profile.action.ts';
import { organizationCustomerProfileIcoRead } from '../../src/api/organization-customer-profile-ico.read.ts';
import { CommerceOrganizationProfileIcoEligibility } from '../../src/integrations/organization-profile-ico-eligibility.ts';
import { ProfileCounterpartyRoleEligibilityResolverFactory } from '../../src/profile-counterparty-role-eligibility.ts';
import {
  profileReactivationEligibilityEvaluatorFactoryLive,
  profileReconfirmationPolicyUnavailableLive,
} from '../../src/integrations/profile-reactivation-eligibility.ts';
import { partyRegistryGuestResolverFactoryLive } from '../../src/integrations/party-registry-guest-resolver.ts';
import { partyRegistryRetailPartyResolverFactoryLive } from '../../src/integrations/party-registry-retail-party-resolver.ts';
import {
  commerceCustomerContextRelations,
  customerProfileIcoAuthority,
  customerProfileIcoAssertions,
  customerProfiles,
} from '../../src/database/schema.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';
import { makeEnrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';

const platform = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const transport = () => ({
  correlationId: randomUUID(),
  idempotencyKey: randomUUID(),
  targetModuleKey: 'commerce.customer-context',
});
const [allowedAuthority] = OrganizationProfileIcoApplicabilityResponseSchema.members;

it.live(
  'writes company ICO in the existing ledger with safe thirteen-field history and immutable original recovery',
  () =>
    Effect.scoped(
      Effect.gen(function* organizationProfileIcoOwnerOnly() {
        const snapshot = yield* makeEnrollmentApplicationCompositionSnapshot(ultramodernApiMarker.buildMarker, [
          'privacy',
          'party-registry',
        ]);
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot: snapshot,
          mode: 'schema-only',
          purpose: 'implementation-1197-profile-ico',
        });
        const adminContext = yield* Layer.build(
          PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
            Layer.provideMerge(Reactivity.layer),
          ),
        );
        const admin = yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
          Effect.provide(adminContext),
        );
        const coreEvidence = yield* testCoreDatabase.pipe(Effect.provide(adminContext));
        const fixture = yield* Effect.acquireRelease(
          makeLiveOperationFixture({
            access: 'allowed',
            actionExecutor: 'manager-only',
            actionKeys: [
              createCounterpartyPurchasingProfileAction.descriptor.actionKey,
              changeOrganizationCustomerProfileIcoAction.descriptor.actionKey,
            ],
            additionalLegalEntity: 'same-tenant',
            adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
            allowedAudiences: ['commerce-customer-context'],
            applicationComposition: { load: Effect.succeed(snapshot) },
            authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
            compositionRevision: snapshot.composition.revision,
            expectedDeployment: ultramodernApiMarker,
            moduleKeys: ['commerce.customer-context', 'party.registry', 'privacy.core'],
            ownerRegistration: commerceCustomerContextRegistration,
            runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
          }),
          (resource) => resource.close().pipe(Effect.orDie),
        );
        const companyPartyId = randomUUID();
        const counterpartyId = randomUUID();
        const customerRoleId = randomUUID();
        let privacyDenied = false;
        let eligibilityChecks = 0;
        const seenOperations: string[] = [];
        // INTERNAL_OWNER_ONLY: exact Party organization and Privacy decisions are explicit service seams.
        // The combined Party/Privacy HTTP proof is separate; this fixture does not claim a live organization decision.
        const ordinary = Layer.mergeAll(
          Layer.succeed(ProfileCounterpartyRoleEligibilityResolverFactory, {
            make:
              () =>
              ({ counterpartyResourceId, tenantId }) =>
                Effect.succeed(
                  counterpartyResourceId === counterpartyId && tenantId === fixture.tenantId
                    ? {
                        managedLegalEntityId: fixture.legalEntityId,
                        outcome: 'ELIGIBLE' as const,
                        partyResourceId: companyPartyId,
                        roleResourceId: customerRoleId,
                        roleResourceRevision: '2026-11-07T00:00:00.000Z',
                      }
                    : { outcome: 'INDETERMINATE' as const },
                ),
          }),
          Layer.succeed(CommerceOrganizationProfileIcoEligibility, {
            check: (scope, input, requirementKey) => {
              eligibilityChecks += 1;
              seenOperations.push(input.operation);
              expect(requirementKey).toBe(
                input.operation === 'customer-profile-ico.write'
                  ? 'commerce.customer-context.requirement.organization-profile-ico-write-privacy'
                  : 'commerce.customer-context.requirement.organization-profile-ico-read-privacy',
              );
              if (privacyDenied || scope.tenantId !== fixture.tenantId) {
                return Effect.fail(
                  new OrganizationProfileIcoRejected({
                    code: 'PRIVACY_DENIED',
                    reason: 'Current owner-only field decision denied',
                  }),
                );
              }
              return Schema.decodeUnknownEffect(allowedAuthority)({
                allowedFields: ORGANIZATION_PROFILE_ICO_FIELDS,
                applicabilityDecisionRef: 'internal-owner-only-company-field-decision',
                authorityIncarnation: 'internal-owner-only-company-authority',
                authorityRevision: '1',
                evaluatedAt: '2026-11-07T00:00:00.000Z',
                evidenceRefs: ['internal-owner-only-org-kind-evidence'],
                fieldContractVersion: OrganizationProfileIcoFieldContractVersion,
                outcome: 'NOT_APPLICABLE',
                partyRef: {
                  moduleId: 'party.registry',
                  resourceId: companyPartyId,
                  resourceType: 'party.registry.party',
                  tenantId: fixture.tenantId,
                },
                partyRevision: 1,
                policyRevisions: [{ policyRef: 'internal-owner-only-company-field-policy', revision: '1' }],
                profileRef: input.profileRef,
                profileRevision: 1,
              }).pipe(Effect.orDie);
            },
          }),
          profileReactivationEligibilityEvaluatorFactoryLive,
          partyRegistryGuestResolverFactoryLive,
          partyRegistryRetailPartyResolverFactoryLive,
        ).pipe(Layer.provideMerge(ContextAccessLive), Layer.provide(profileReconfirmationPolicyUnavailableLive));
        const context = yield* Layer.build(ordinary.pipe(Layer.provideMerge(fixture.layer)));
        const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
        const createProfile = yield* Schema.decodeUnknownEffect(CreateCounterpartyPurchasingProfilePayloadSchema)({
          effectiveAt: '2025-01-01T00:00:00.000Z',
          subject: {
            counterpartyRef: {
              moduleId: 'party.registry',
              resourceId: counterpartyId,
              resourceType: 'party.registry.counterparty',
              tenantId: fixture.tenantId,
            },
            kind: 'COUNTERPARTY',
            sellingLegalEntityRef: {
              moduleId: 'core.identity',
              resourceId: fixture.legalEntityId,
              resourceType: 'core.identity.legal-entity',
              tenantId: fixture.tenantId,
            },
          },
          trigger: 'AUTHORIZED_ONBOARDING',
        });
        const profileAck = yield* runAction({
          payload: createProfile,
          principal,
          registration: createCounterpartyPurchasingProfileAction,
          transport: transport(),
        }).pipe(Effect.provideContext(context));
        expect(profileAck.outcome).toBe('PROFILE_CREATED');
        const read = (input: OrganizationCustomerProfileIcoRequest, actor = principal) =>
          Context.get(context, ReadRuntime)
            .runRead({
              input,
              principal: actor,
              registration: organizationCustomerProfileIcoRead,
              transport: { correlationId: randomUUID(), targetModuleKey: 'commerce.customer-context' },
            })
            .pipe(Effect.provideContext(context));
        const change = (payload: ChangeOrganizationCustomerProfileIcoPayload, actor = principal) =>
          runAction({
            payload,
            principal: actor,
            registration: changeOrganizationCustomerProfileIcoAction,
            transport: transport(),
          }).pipe(Effect.provideContext(context));
        const request = { profileRef: profileAck.profileRef };
        expect(
          Match.value(yield* read(request)).pipe(
            Match.tag('MIGRATION_REQUIRED', () => true),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        const set = yield* Schema.decodeUnknownEffect(ChangeOrganizationCustomerProfileIcoPayloadSchema)({
          countryCode: 'CZ',
          effectId: randomUUID(),
          effectiveAt: '2025-01-01T00:00:00.000Z',
          expectedRevision: 0,
          identifier: { identifierType: 'ICO', value: '19' },
          operation: 'SET',
          originalInput: '19',
          profileRef: profileAck.profileRef,
        });
        expect(yield* Effect.flip(change(set))).toMatchObject({ code: 'MIGRATION_REQUIRED' });
        // Explicit Commerce control-plane fixture state, not a claimed Party cutover or migration Action receipt.
        yield* admin.insert(customerProfileIcoAuthority).values({
          actionInvocationId: randomUUID(),
          actorPrincipalId: fixture.manager.principalId,
          inventoryVersion: 'internal-owner-only-empty-inventory',
          partyFenceId: 'internal-owner-only-not-a-party-fence',
          phase: 'COMMERCE',
          plan: { migrationRequiredProfileIds: [] },
          planId: 'internal-owner-only-authority-fixture',
          tenantId: fixture.tenantId,
        });
        expect(
          Match.value(yield* read(request)).pipe(
            Match.tag('ABSENT', (value) => value.revision === 0 && value.history.length === 0),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        const original = yield* change(set);
        expect(Schema.is(ChangeOrganizationCustomerProfileIcoResultSchema)(original)).toBe(true);
        expect(original).toMatchObject({
          assertion: {
            effectiveTo: null,
            isCurrent: true,
            normalizedValue: '00000019',
            normalizerVersion: 'CZ:ICO:party-v1',
            operation: 'SET',
            originalInput: { digits: '19', kind: 'KNOWN' },
            profileRef: profileAck.profileRef,
            revision: 1,
          },
          outcome: 'APPLIED',
        });
        const [firstRow] = yield* admin.select().from(customerProfileIcoAssertions);
        if (firstRow === undefined) {
          return yield* Effect.die('Missing actual company ICO ledger effect');
        }
        expect(firstRow.actorPrincipalId).toBe(fixture.manager.principalId);
        const evidence = yield* fixture.evidence(coreEvidence);
        const requestIdentity = yield* changeOrganizationCustomerProfileIcoRequestIdentity(
          yield* Schema.encodeEffect(ChangeOrganizationCustomerProfileIcoPayloadSchema)(set),
        );
        const expectedRequestHash = computeActionRequestHash({ ...requestIdentity, principal });

        expect(
          evidence.invocations.find((invocation) => invocation.actionInvocationId === firstRow.actionInvocationId),
        ).toMatchObject({
          actionKey: changeOrganizationCustomerProfileIcoAction.descriptor.actionKey,
          principalId: fixture.manager.principalId,
          requestHash: expectedRequestHash,
          status: 'succeeded',
        });
        const originalRead = { ...request, actionInvocationId: firstRow.actionInvocationId };
        const receipt = yield* read(originalRead);
        expect(
          Match.value(receipt).pipe(
            Match.tag('RECEIPT', ({ assertion }) => {
              expect(assertion).toEqual(original.assertion);
              return true;
            }),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        const secondSet = yield* Schema.decodeUnknownEffect(ChangeOrganizationCustomerProfileIcoPayloadSchema)({
          ...set,
          effectId: randomUUID(),
          expectedRevision: 1,
        });
        expect(yield* Effect.flip(change(secondSet))).toMatchObject({ code: 'INVALID_TRANSITION' });
        const correction = yield* Schema.decodeUnknownEffect(ChangeOrganizationCustomerProfileIcoPayloadSchema)({
          ...set,
          effectId: randomUUID(),
          effectiveAt: '2025-01-01T00:00:01.000Z',
          expectedRevision: 1,
          identifier: { identifierType: 'ICO', value: '27074358' },
          operation: 'CORRECT',
          originalInput: '27074358',
        });
        const corrected = yield* change(correction);
        expect(corrected).toMatchObject({
          assertion: { isCurrent: true, normalizedValue: '27074358', revision: 2 },
          outcome: 'APPLIED',
        });
        expect(yield* read(originalRead)).toEqual(receipt);
        const staleCorrection = yield* Schema.decodeUnknownEffect(ChangeOrganizationCustomerProfileIcoPayloadSchema)({
          ...correction,
          effectId: randomUUID(),
          expectedRevision: 0,
        });
        expect(yield* Effect.flip(change(staleCorrection))).toMatchObject({ code: 'REVISION_CONFLICT' });
        expect(yield* Effect.flip(read({ ...request, actionInvocationId: randomUUID() }))).toMatchObject({
          code: 'read_handler_unavailable',
        });
        expect(
          Match.value(yield* read({ ...request, asOf: '2025-01-01T00:00:00.000Z' })).pipe(
            Match.tag('PRESENT', (value) => value.current.normalizedValue === '00000019' && value.current.isCurrent),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        const replay = yield* change(set);
        expect(replay.outcome).toBe('REPLAY');
        expect(replay.assertion).toEqual(original.assertion);
        const changedIntent = yield* Schema.decodeUnknownEffect(ChangeOrganizationCustomerProfileIcoPayloadSchema)({
          ...set,
          identifier: { identifierType: 'ICO', value: '27074358' },
          originalInput: '27074358',
        });
        expect(yield* Effect.flip(change(changedIntent))).toMatchObject({ code: 'EFFECT_CONFLICT' });
        const current = yield* read(request);
        expect(
          Match.value(current).pipe(
            Match.tag('PRESENT', (value) => {
              expect(value.revision).toBe(2);
              expect(value.history).toHaveLength(2);
              expect(value.history[0]).toMatchObject({
                effectiveTo: '2025-01-01T00:00:01.000Z',
                isCurrent: false,
                normalizedValue: '00000019',
              });
              expect(value.current.normalizedValue).toBe('27074358');
              return true;
            }),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        const end = yield* Schema.decodeUnknownEffect(ChangeOrganizationCustomerProfileIcoPayloadSchema)({
          countryCode: 'CZ',
          effectId: randomUUID(),
          effectiveAt: '2025-01-01T00:00:02.000Z',
          expectedRevision: 2,
          operation: 'END',
          profileRef: profileAck.profileRef,
        });
        const ended = yield* change(end);
        expect(ended).toMatchObject({
          assertion: {
            isCurrent: false,
            normalizedValue: null,
            normalizerVersion: null,
            operation: 'END',
            originalInput: { kind: 'UNKNOWN' },
            revision: 3,
          },
          outcome: 'APPLIED',
        });
        const afterEnd = yield* read(request);
        expect(Schema.is(OrganizationCustomerProfileIcoResponseSchema)(afterEnd)).toBe(true);
        expect(
          Match.value(afterEnd).pipe(
            Match.tag('ABSENT', (value) => value.revision === 3 && value.history.length === 3),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        expect(yield* read(originalRead)).toEqual(receipt);
        privacyDenied = true;
        expect(yield* Effect.flip(read(originalRead))).toMatchObject({ code: 'read_handler_unavailable' });
        expect(yield* Effect.flip(change({ ...end, effectId: randomUUID() }))).toMatchObject({
          code: 'PRIVACY_DENIED',
        });
        privacyDenied = false;
        const foreign = fixture.secondaryLegalEntity;
        if (foreign === undefined) {
          return yield* Effect.die('Missing actual granted second Legal Entity fixture');
        }
        expect(yield* Effect.flip(read(request, foreign.manager))).toMatchObject({ code: 'read_handler_unavailable' });
        const rows = yield* admin.select().from(customerProfileIcoAssertions);
        expect(rows).toHaveLength(3);
        expect(rows.filter((row) => row.isCurrent)).toHaveLength(0);
        expect(rows.every((row) => row.customerProfileId === profileAck.profileRef.resourceId)).toBe(true);
        const profiles = yield* admin.select().from(customerProfiles);
        expect(profiles).toHaveLength(1);
        expect(profiles[0]?.profileKind).toBe('COUNTERPARTY');
        for (const response of [original, corrected, ended, receipt, current, afterEnd]) {
          const output = JSON.stringify(response);
          expect(output).not.toContain('actorPrincipalId');
          expect(output).not.toContain('internal-owner-only-company-field-policy');
          expect(output).not.toContain('internal-owner-only-org-kind-evidence');
          expect(output).not.toContain('reason');
          expect(output).not.toContain('sourceContext');
        }
        expect(eligibilityChecks).toBeGreaterThan(10);
        expect(seenOperations).toContain('customer-profile-ico.read');
        expect(seenOperations).toContain('customer-profile-ico.write');
        return yield* Effect.void;
      }),
    ).pipe(Effect.provide(platform)),
  180_000,
);
