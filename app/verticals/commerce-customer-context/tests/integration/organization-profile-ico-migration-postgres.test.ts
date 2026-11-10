import { randomUUID } from 'node:crypto';
import { ContextAccessLive, ReadRuntime, runAction } from '@app/core-runtime';
import { ActionInvocationIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Context, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';
import { makeEnrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';
import { CommerceLegacyIcoInventory } from '../../src/integrations/party-legacy-ico-inventory.ts';
import { CommerceOrganizationProfileIcoEligibility } from '../../src/integrations/organization-profile-ico-eligibility.ts';
import {
  ChangeOrganizationCustomerProfileIcoPayloadSchema,
  OrganizationProfileIcoRejected,
  ORGANIZATION_PROFILE_ICO_FIELDS,
} from '../../shared/domain/organization-profile-ico.ts';
import { CustomerProfileIcoMigrationRejected } from '../../shared/domain/customer-profile-ico-migration.ts';
import {
  OrganizationProfileIcoApplicabilityResponseSchema,
  OrganizationProfileIcoFieldContractVersion,
} from '@app/privacy/api/organization-profile-ico-applicability';
import { LegacyIcoInventoryResponseSchema } from '@app/party-registry/apis/legacy-ico-inventory';
import { migrateOrganizationCustomerProfileIcoAction } from '../../src/actions/migrate-organization-customer-profile-ico.action.ts';
import { changeOrganizationCustomerProfileIcoAction } from '../../src/actions/change-organization-customer-profile-ico.action.ts';
import { organizationCustomerProfileIcoMigrationRead } from '../../src/api/organization-customer-profile-ico-migration.read.ts';
import { organizationCustomerProfileIcoRead } from '../../src/api/organization-customer-profile-ico.read.ts';
import type { MigrateOrganizationCustomerProfileIcoPayload } from '../../shared/domain/organization-profile-ico-migration.ts';

const platform = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const transport = () => ({
  correlationId: randomUUID(),
  idempotencyKey: randomUUID(),
  targetModuleKey: 'commerce.customer-context',
});

/** INTERNAL_OWNER_ONLY: real Commerce/Core PG/SpiceDB; Party inventory and Privacy ports are explicit.
 * The combined registered fixture separately proves real Party inventory, fence and current policies. */
it.live(
  'stages and cuts over a bounded complete organization inventory while rejecting stale correlations and mixed authority',
  () =>
    Effect.scoped(
      Effect.gen(function* organizationMigrationNative() {
        const snapshot = yield* makeEnrollmentApplicationCompositionSnapshot(ultramodernApiMarker.buildMarker, [
          'party-registry',
          'privacy',
        ]);
        const owned = yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot: snapshot,
          mode: 'schema-only',
          purpose: 'implementation-1197-profile-ico',
        });
        const adminContext = yield* Layer.build(
          PgClient.layer({ url: Redacted.make(owned.connections.admin.connectionString) }).pipe(
            Layer.provideMerge(Reactivity.layer),
          ),
        );
        const admin = Context.get(adminContext, PgClient.PgClient);
        const fixture = yield* Effect.acquireRelease(
          makeLiveOperationFixture({
            access: 'allowed',
            actionExecutor: 'manager-only',
            actionKeys: [
              migrateOrganizationCustomerProfileIcoAction.descriptor.actionKey,
              changeOrganizationCustomerProfileIcoAction.descriptor.actionKey,
            ],
            adminConnectionString: Redacted.make(owned.connections.admin.connectionString),
            allowedAudiences: ['commerce-customer-context'],
            applicationComposition: { load: Effect.succeed(snapshot) },
            authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
            compositionRevision: snapshot.composition.revision,
            expectedDeployment: ultramodernApiMarker,
            moduleKeys: ['commerce.customer-context', 'party.registry', 'privacy.core'],
            ownerRegistration: commerceCustomerContextRegistration,
            runtimeConnectionString: Redacted.make(owned.connections.runtime.connectionString),
          }),
          (resource) => resource.close().pipe(Effect.orDie),
        );
        const partyId = randomUUID();
        const counterpartyId = randomUUID();
        const roleId = randomUUID();
        const profileId = randomUUID();
        const assertionId = randomUUID();
        const planId = randomUUID();
        const fenceId = randomUUID();
        const now = DateTime.formatIso(yield* DateTime.now);
        const effectiveAt = '2020-01-01T00:00:00.000Z';
        const profileRef = {
          moduleId: 'commerce.customer-context' as const,
          resourceId: profileId,
          resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
          tenantId: fixture.tenantId,
        };
        const partyRef = {
          moduleId: 'party.registry' as const,
          resourceId: partyId,
          resourceType: 'party.registry.party' as const,
          tenantId: fixture.tenantId,
        };
        const counterpartyRef = {
          moduleId: 'party.registry' as const,
          resourceId: counterpartyId,
          resourceType: 'party.registry.counterparty' as const,
          tenantId: fixture.tenantId,
        };
        const assertionRef = {
          moduleId: 'party.registry' as const,
          resourceId: assertionId,
          resourceType: 'party.registry.party-official-identifier' as const,
          tenantId: fixture.tenantId,
        };
        const lateParty = { ...partyRef, resourceId: randomUUID() };
        const lateCounterparty = { ...counterpartyRef, resourceId: randomUUID() };
        const lateProfile = { ...profileRef, resourceId: randomUUID() };
        const lateAssertion = { ...assertionRef, resourceId: randomUUID() };
        const legacy = {
          isCurrent: true,
          normalizedValue: '00000019',
          originalInput: { digits: '19', kind: 'KNOWN' },
          recordedAt: effectiveAt,
          revision: 'c'.repeat(64),
          state: 'ACTIVE',
          validFrom: effectiveAt,
          validTo: null,
        };
        let currentCorrelationRevision = 'a'.repeat(64);
        let fenced = false;
        let mixed = false;
        let privacyDenied = false;
        const observedProjections: unknown[] = [];
        const inventory = yield* Schema.decodeUnknownEffect(LegacyIcoInventoryResponseSchema)({
          assertions: [
            {
              ...legacy,
              assertionRef,
              partyRef,
              provenance: { ownerReceiptRef: assertionRef },
            },
            {
              ...legacy,
              assertionRef: lateAssertion,
              normalizedValue: '27074358',
              originalInput: { digits: '27074358', kind: 'KNOWN' },
              partyRef: lateParty,
              provenance: { ownerReceiptRef: lateAssertion },
            },
          ],
          authority: { kind: 'LEGACY_PARTY' },
          completeness: 'ALL_LEGACY_ICO_ASSERTIONS',
          snapshotVersion: 'b'.repeat(64),
          tenantId: fixture.tenantId,
        });
        const ordinary = Layer.mergeAll(
          ContextAccessLive,
          NodeCrypto.layer,
          Layer.succeed(CommerceLegacyIcoInventory, {
            correlate: (_scope, ref, options) => {
              const late = ref.resourceId === lateCounterparty.resourceId;
              const exactCounterparty = late ? lateCounterparty : counterpartyRef;
              const exactParty = late ? lateParty : partyRef;
              return Effect.succeed(
                options?.organizationOnly === true && ref.resourceId === exactCounterparty.resourceId
                  ? Option.some({
                      archived: false,
                      counterpartyRef: exactCounterparty,
                      organizationProof: {
                        counterpartyRef: exactCounterparty,
                        counterpartyRevision: currentCorrelationRevision,
                        currentCustomerRoleRef: {
                          moduleId: 'party.registry' as const,
                          resourceId: roleId,
                          resourceType: 'party.registry.counterparty-role-period' as const,
                          tenantId: fixture.tenantId,
                        },
                        currentCustomerRoleRevision: 'd'.repeat(64),
                        legalEntityRef: {
                          moduleId: 'core.identity' as const,
                          resourceId: fixture.legalEntityId,
                          resourceType: 'core.identity.legal-entity' as const,
                          tenantId: fixture.tenantId,
                        },
                        outcome: 'CURRENT_ORGANIZATION_CUSTOMER' as const,
                        partyRef: exactParty,
                        partyRevision: 1,
                      },
                      partyRef: exactParty,
                      revision: currentCorrelationRevision,
                    })
                  : Option.none(),
              );
            },
            read: (_scope, options) => {
              observedProjections.push(options?.projection);
              return mixed
                ? Effect.fail(
                    new CustomerProfileIcoMigrationRejected({
                      code: 'INVENTORY_UNAVAILABLE',
                      reason: 'Explicit internal mixed PERSON fixture is not a complete organization projection',
                    }),
                  )
                : Effect.succeed({
                    ...inventory,
                    authority: fenced
                      ? {
                          kind: 'COMMERCE_FENCED' as const,
                          proof: {
                            fencedAt: now,
                            fenceId,
                            migrationPlanRef: planId,
                            snapshotVersion: inventory.snapshotVersion,
                            tenantId: fixture.tenantId,
                          },
                        }
                      : { kind: 'LEGACY_PARTY' as const },
                  });
            },
          }),
          Layer.succeed(CommerceOrganizationProfileIcoEligibility, {
            check: (_scope, input) =>
              privacyDenied
                ? Effect.fail(
                    new OrganizationProfileIcoRejected({
                      code: 'PRIVACY_DENIED',
                      reason: 'Explicit internal current organization policy denied',
                    }),
                  )
                : Schema.decodeUnknownEffect(OrganizationProfileIcoApplicabilityResponseSchema.members[0])({
                    allowedFields: ORGANIZATION_PROFILE_ICO_FIELDS,
                    applicabilityDecisionRef: 'internal-native-organization-migration-decision',
                    authorityIncarnation: 'internal-native-organization-authority',
                    authorityRevision: '1',
                    evaluatedAt: now,
                    evidenceRefs: ['internal-native-current-org-proof'],
                    fieldContractVersion: OrganizationProfileIcoFieldContractVersion,
                    outcome: 'NOT_APPLICABLE',
                    partyRef: input.profileRef.resourceId === lateProfile.resourceId ? lateParty : partyRef,
                    partyRevision: 1,
                    policyRevisions: [{ policyRef: 'internal-native-org-fields', revision: '1' }],
                    profileRef: input.profileRef,
                    profileRevision: 1,
                  }).pipe(Effect.orDie),
          }),
        );
        const context = yield* Layer.build(ordinary.pipe(Layer.provideMerge(fixture.layer)));
        const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
        const read = () =>
          Context.get(context, ReadRuntime)
            .runRead({
              input: { asOf: now, planId, sourceContext: null },
              principal,
              registration: organizationCustomerProfileIcoMigrationRead,
              transport: transport(),
            })
            .pipe(Effect.provideContext(context));
        const apply = (input: MigrateOrganizationCustomerProfileIcoPayload, request = transport()) =>
          runAction({
            payload: input,
            principal,
            registration: migrateOrganizationCustomerProfileIcoAction,
            transport: request,
          }).pipe(Effect.provideContext(context));
        yield* admin`insert into commerce_customer_context.customer_profiles(tenant_id,legal_entity_id,customer_profile_id,profile_kind,lifecycle,revision) values(${fixture.tenantId}::uuid,${fixture.legalEntityId}::uuid,${profileId}::uuid,'COUNTERPARTY','ACTIVE',1)`;
        yield* admin`insert into commerce_customer_context.counterparty_purchasing_profiles(tenant_id,legal_entity_id,counterparty_purchasing_profile_id,counterparty_resource_id) values(${fixture.tenantId}::uuid,${fixture.legalEntityId}::uuid,${profileId}::uuid,${counterpartyId})`;
        const report = yield* read();
        expect(report.records.map((record) => record.classification)).toEqual(['MATCHED', 'NO_TARGET']);
        expect(JSON.stringify(report)).not.toContain('actorPrincipalId');
        expect(JSON.stringify(report)).not.toContain('reason');
        expect(JSON.stringify(report)).not.toContain('organizationIcoAuthority');
        const command = {
          asOf: now,
          expectedPartySnapshotVersion: report.partySnapshotVersion,
          expectedTargetInventoryVersion: report.targetInventoryVersion,
          operation: 'STAGE' as const,
          planId,
          sourceContext: null,
        };
        currentCorrelationRevision = 'e'.repeat(64);
        expect(yield* Effect.flip(apply(command))).toMatchObject({ code: 'STALE_PLAN' });
        currentCorrelationRevision = 'a'.repeat(64);
        mixed = true;
        expect(yield* Effect.flip(apply(command))).toMatchObject({
          code: 'PERSISTENCE_UNAVAILABLE',
        });
        const [before] = yield* admin<{
          count: number;
        }>`select count(*)::integer count from commerce_customer_context.customer_profile_ico_authority where tenant_id=${fixture.tenantId}::uuid`;
        expect(before?.count).toBe(0);
        mixed = false;
        const staged = yield* apply(command);
        expect(staged.phase).toBe('STAGING');
        expect(yield* Effect.flip(apply({ ...command, operation: 'CUTOVER' }))).toMatchObject({
          code: 'AUTHORITY_NOT_FENCED',
        });
        fenced = true;
        const cutover = yield* apply({ ...command, operation: 'CUTOVER' });
        expect(cutover.phase).toBe('COMMERCE');
        const [row] = yield* admin<{
          actor_principal_id: string;
          assertion: unknown;
          count: number;
        }>`select assertion,actor_principal_id,(count(*) over())::integer count from commerce_customer_context.customer_profile_ico_assertions where tenant_id=${fixture.tenantId}::uuid`;
        expect(row?.count).toBe(1);
        expect(row?.actor_principal_id).toBe(fixture.manager.principalId);
        expect(JSON.stringify(row?.assertion)).not.toContain('actorPrincipalId');
        expect(JSON.stringify(row?.assertion)).not.toContain('reason');
        expect(JSON.stringify(row?.assertion)).not.toContain('"source":');
        const state = yield* Context.get(context, ReadRuntime)
          .runRead({
            input: { profileRef },
            principal,
            registration: organizationCustomerProfileIcoRead,
            transport: transport(),
          })
          .pipe(Effect.provideContext(context));
        expect(state).toMatchObject({
          current: {
            normalizedValue: '00000019',
            originalInput: { digits: '19', kind: 'KNOWN' },
            provenance: { ownerReceiptRef: assertionRef },
          },
        });
        yield* admin`insert into commerce_customer_context.customer_profiles(tenant_id,legal_entity_id,customer_profile_id,profile_kind,lifecycle,revision) values(${fixture.tenantId}::uuid,${fixture.legalEntityId}::uuid,${lateProfile.resourceId}::uuid,'COUNTERPARTY','ACTIVE',1)`;
        yield* admin`insert into commerce_customer_context.counterparty_purchasing_profiles(tenant_id,legal_entity_id,counterparty_purchasing_profile_id,counterparty_resource_id) values(${fixture.tenantId}::uuid,${fixture.legalEntityId}::uuid,${lateProfile.resourceId}::uuid,${lateCounterparty.resourceId})`;
        // Model an existing profile with independent Commerce authority, without changing the
        // production guard that otherwise fences newly enrolled profiles after cutover.
        yield* admin`
          update commerce_customer_context.customer_profile_ico_authority
          set plan=jsonb_set(plan,'{migrationRequiredProfileIds}',(plan->'migrationRequiredProfileIds')-${lateProfile.resourceId}::text)
          where tenant_id=${fixture.tenantId}::uuid and phase='COMMERCE'
        `;
        const reconcile = Effect.fn('OrganizationIcoTest.reconcile')(function* reconcile() {
          const current = yield* read();
          return {
            ...command,
            expectedAuthorityRevision: current.authorityRevision,
            expectedTargetInventoryVersion: current.targetInventoryVersion,
            operation: 'RECONCILE' as const,
          };
        });
        const change = Effect.fn('OrganizationIcoTest.change')(function* change(input: {
          readonly effectId: string;
          readonly expectedRevision: number;
          readonly operation: 'SET' | 'CORRECT';
          readonly value: string;
        }) {
          const payload = yield* Schema.decodeUnknownEffect(ChangeOrganizationCustomerProfileIcoPayloadSchema)({
            countryCode: 'CZ',
            effectId: input.effectId,
            effectiveAt,
            expectedRevision: input.expectedRevision,
            identifier: { identifierType: 'ICO', value: input.value },
            operation: input.operation,
            originalInput: input.value,
            profileRef: lateProfile,
          });
          return yield* runAction({
            payload,
            principal,
            registration: changeOrganizationCustomerProfileIcoAction,
            transport: transport(),
          }).pipe(Effect.provideContext(context));
        });
        const beforeSet = yield* reconcile();
        const independentSet = randomUUID();
        const independentCorrection = randomUUID();
        yield* change({ effectId: independentSet, expectedRevision: 0, operation: 'SET', value: '19' });
        expect(yield* Effect.flip(apply(beforeSet))).toMatchObject({ code: 'STALE_PLAN' });
        expect(yield* Effect.flip(apply(yield* reconcile()))).toMatchObject({ code: 'PLAN_CONFLICT' });
        yield* change({
          effectId: independentCorrection,
          expectedRevision: 1,
          operation: 'CORRECT',
          value: '27074358',
        });
        const acceptedCommand = yield* reconcile();
        const exactRequest = transport();
        const accepted = yield* apply(acceptedCommand, exactRequest);
        expect(accepted.phase).toBe('COMMERCE');
        const committed = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ code: Schema.Literal('action_already_committed'), invocationId: ActionInvocationIdSchema }),
        )(yield* Effect.flip(apply(acceptedCommand, exactRequest)));
        expect((yield* apply(yield* reconcile())).phase).toBe('COMMERCE');
        const [ledger] = yield* admin<{ count: number; current_effect: string; current_invocation: string }>`
          select count(*)::integer count,max(effect_id) filter (where is_current) current_effect,
            max(action_invocation_id::text) filter (where is_current) current_invocation
          from commerce_customer_context.customer_profile_ico_assertions
          where tenant_id=${fixture.tenantId}::uuid and customer_profile_id=${lateProfile.resourceId}::uuid
        `;
        expect(ledger).toMatchObject({ count: 2, current_effect: independentCorrection });
        const lateState = yield* Context.get(context, ReadRuntime)
          .runRead({
            input: { profileRef: lateProfile },
            principal,
            registration: organizationCustomerProfileIcoRead,
            transport: transport(),
          })
          .pipe(Effect.provideContext(context));
        expect(lateState).toMatchObject({
          current: {
            normalizedValue: '27074358',
            provenance: {
              ownerReceiptRef: { _tag: 'CORE_ACTION_INVOCATION', actionInvocationId: ledger?.current_invocation },
            },
          },
          history: [{ normalizedValue: '00000019' }, { normalizedValue: '27074358' }],
          revision: 2,
        });
        const [provenance] = yield* admin<{ count: number; reuse: unknown }>`
          select count(*)::integer count,jsonb_agg(r.value) reuse
          from commerce_customer_context.customer_profile_ico_authority a
          cross join lateral jsonb_each(a.plan->'reusedCurrentAssertions') r
          where a.tenant_id=${fixture.tenantId}::uuid
        `;
        expect(provenance).toMatchObject({
          count: 1,
          reuse: [
            {
              assertionRef: lateAssertion,
              currentActionInvocationId: ledger?.current_invocation,
              currentEffectId: independentCorrection,
              currentRevision: 2,
              legacyRevision: legacy.revision,
              migrationActionInvocationId: committed.invocationId,
              profileRef: lateProfile,
            },
          ],
        });
        privacyDenied = true;
        expect(yield* Effect.flip(apply({ ...command, operation: 'CUTOVER' }))).toMatchObject({
          code: 'PRIVACY_DENIED',
        });
        expect(observedProjections.every((projection) => projection === 'ORGANIZATION_ICO_FIELDS_V1')).toBe(true);
      }),
    ).pipe(Effect.provide(platform)),
  { timeout: 180_000 },
);
