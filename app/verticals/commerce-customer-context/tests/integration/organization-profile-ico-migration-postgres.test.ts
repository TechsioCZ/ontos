import { randomUUID } from 'node:crypto';
import { ContextAccessLive, ReadRuntime, runAction } from '@app/core-runtime';
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
            actionKeys: [migrateOrganizationCustomerProfileIcoAction.descriptor.actionKey],
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
        let currentCorrelationRevision = 'a'.repeat(64);
        let fenced = false;
        let mixed = false;
        let privacyDenied = false;
        const observedProjections: unknown[] = [];
        const inventory = yield* Schema.decodeUnknownEffect(LegacyIcoInventoryResponseSchema)({
          assertions: [
            {
              assertionRef,
              isCurrent: true,
              normalizedValue: '00000019',
              originalInput: { digits: '19', kind: 'KNOWN' },
              partyRef,
              provenance: { ownerReceiptRef: assertionRef },
              recordedAt: effectiveAt,
              revision: 'c'.repeat(64),
              state: 'ACTIVE',
              validFrom: effectiveAt,
              validTo: null,
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
            correlate: (_scope, ref, options) =>
              Effect.succeed(
                options?.organizationOnly === true && ref.resourceId === counterpartyId
                  ? Option.some({
                      archived: false,
                      counterpartyRef,
                      organizationProof: {
                        counterpartyRef,
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
                        partyRef,
                        partyRevision: 1,
                      },
                      partyRef,
                      revision: currentCorrelationRevision,
                    })
                  : Option.none(),
              ),
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
                    partyRef,
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
        const apply = (input: MigrateOrganizationCustomerProfileIcoPayload) =>
          runAction({
            payload: input,
            principal,
            registration: migrateOrganizationCustomerProfileIcoAction,
            transport: transport(),
          }).pipe(Effect.provideContext(context));
        yield* admin`insert into commerce_customer_context.customer_profiles(tenant_id,legal_entity_id,customer_profile_id,profile_kind,lifecycle,revision) values(${fixture.tenantId}::uuid,${fixture.legalEntityId}::uuid,${profileId}::uuid,'COUNTERPARTY','ACTIVE',1)`;
        yield* admin`insert into commerce_customer_context.counterparty_purchasing_profiles(tenant_id,legal_entity_id,counterparty_purchasing_profile_id,counterparty_resource_id) values(${fixture.tenantId}::uuid,${fixture.legalEntityId}::uuid,${profileId}::uuid,${counterpartyId})`;
        const report = yield* read();
        expect(report.records.map((record) => record.classification)).toEqual(['MATCHED']);
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
        privacyDenied = true;
        expect(yield* Effect.flip(apply({ ...command, operation: 'CUTOVER' }))).toMatchObject({
          code: 'PRIVACY_DENIED',
        });
        expect(observedProjections.every((projection) => projection === 'ORGANIZATION_ICO_FIELDS_V1')).toBe(true);
      }),
    ).pipe(Effect.provide(platform)),
  { timeout: 180_000 },
);
