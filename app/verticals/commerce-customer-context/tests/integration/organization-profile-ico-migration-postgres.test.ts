import { randomUUID } from 'node:crypto';
import { ContextAccessLive, findPostgresFailure, ReadRuntime, runAction } from '@app/core-runtime';
import { ActionInvocationIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Context, DateTime, Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
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
  OrganizationCustomerProfileIcoResponseSchema,
  ORGANIZATION_PROFILE_ICO_FIELDS,
} from '../../shared/domain/organization-profile-ico.ts';
import { CustomerProfileIcoMigrationRejected } from '../../shared/domain/customer-profile-ico-migration.ts';
import {
  OrganizationProfileIcoApplicabilityResponseSchema,
  OrganizationProfileIcoFieldContractVersion,
} from '@app/privacy/api/organization-profile-ico-applicability';
import { LegacyIcoInventoryResponseSchema } from '@app/party-registry/apis/legacy-ico-inventory';
import type { IcoCorrelationWitness } from '@app/party-registry/apis/legacy-ico-inventory';
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
            additionalLegalEntity: 'same-tenant',
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
        const otherHome = yield* Effect.fromNullishOr(fixture.secondaryLegalEntity).pipe(Effect.orDie);
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
        let correlationEpoch = 'e'.repeat(64);
        let samePartyAcrossHomes = false;
        let fenced = false;
        let mixed = false;
        let privacyDenied = false;
        let contendPartyMutation = false;
        const verifyPartyMutationWaits = Effect.fn('OrganizationIcoTest.verifyPartyMutationWaits')(
          function* verifyPartyMutationWaits() {
            const result = yield* admin
              .withTransaction(
                Effect.gen(function* attemptForeignMutation() {
                  yield* admin`set local lock_timeout='150ms'`;
                  yield* admin`update party.counterparties
                set archived_at=clock_timestamp() where counterparty_id=${lateCounterparty.resourceId}::uuid`;
                }),
              )
              .pipe(Effect.result);
            expect(
              Result.isFailure(result) &&
                Option.isSome(findPostgresFailure(result.failure, ({ code }) => code === '55P03')),
            ).toBe(true);
            const [unmodified] = yield* admin<{ unchanged: boolean }>`
              select archived_at is null as unchanged
              from party.counterparties where counterparty_id=${lateCounterparty.resourceId}::uuid
            `;
            expect(unmodified?.unchanged).toBe(true);
          },
        );
        const observedProjections: unknown[] = [];
        const homeWitness = (late: boolean): IcoCorrelationWitness => {
          const lateSignature = samePartyAcrossHomes ? '5' : '4';
          return {
            counterpartyId: late ? lateCounterparty.resourceId : counterpartyId,
            epoch: correlationEpoch,
            legalEntityId: late ? otherHome.legalEntityId : fixture.legalEntityId,
            signature: (late ? lateSignature : '3').repeat(64),
          };
        };
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
            correlate: (scope, ref, options) => {
              const late = ref.resourceId === lateCounterparty.resourceId;
              const exactCounterparty = late ? lateCounterparty : counterpartyRef;
              const exactParty = late ? lateParty : partyRef;
              if (
                options?.organizationOnly !== true ||
                ref.resourceId !== exactCounterparty.resourceId ||
                scope.legalEntityId !== homeWitness(late).legalEntityId
              ) {
                return Effect.succeed(Option.none());
              }
              const correlation = {
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
                    resourceId: homeWitness(late).legalEntityId,
                    resourceType: 'core.identity.legal-entity' as const,
                    tenantId: fixture.tenantId,
                  },
                  outcome: 'CURRENT_ORGANIZATION_CUSTOMER' as const,
                  partyRef: exactParty,
                  partyRevision: 1,
                },
                partyRef: exactParty,
                revision: currentCorrelationRevision,
              };
              if (options.includeCorrelationWitness === true) {
                Object.assign(correlation, { correlationWitness: homeWitness(late) });
              }
              return Effect.succeed(Option.some(correlation));
            },
            read: Effect.fn('OrganizationIcoTest.partyInventory')(function* partyInventory(scope, options) {
              observedProjections.push(options?.projection);
              if (mixed) {
                return yield* new CustomerProfileIcoMigrationRejected({
                  code: 'INVENTORY_UNAVAILABLE',
                  reason: 'Explicit internal mixed PERSON fixture is not a complete organization projection',
                });
              }
              const result = {
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
              };
              if (options?.includeCorrelationWitness === true) {
                const supplied: readonly IcoCorrelationWitness[] = options.verifyCorrelationWitnesses ?? [];
                const matched = supplied.every((witness) =>
                  [homeWitness(false), homeWitness(true)].some(
                    (expected) =>
                      expected.counterpartyId === witness.counterpartyId &&
                      expected.legalEntityId === witness.legalEntityId &&
                      expected.epoch === witness.epoch &&
                      expected.signature === witness.signature,
                  ),
                );
                const correlationCoverage = { epoch: correlationEpoch };
                if (matched) {
                  const foreignMatchCounts = inventory.assertions.map(
                    (record) =>
                      supplied.filter((witness) => {
                        const late = witness.counterpartyId === lateCounterparty.resourceId;
                        const correlatedParty = late && !samePartyAcrossHomes ? lateParty : partyRef;
                        return record.partyRef.resourceId === correlatedParty.resourceId;
                      }).length,
                  );
                  Object.assign(correlationCoverage, { foreignMatchCounts });
                }
                Object.assign(result, { correlationCoverage });
              }
              if (options?.commitFenceChallenge !== undefined && scope.legalEntityId !== undefined) {
                const nonce = `ontos.owner-fact.party-ico.challenge:${scope.tenantId}:${scope.legalEntityId}:${options.commitFenceChallenge}`;
                const tenant = `ontos.owner-fact.party-ico.correlation:${scope.tenantId}`;
                const [locks] = yield* admin<{ challenge: boolean; tenant: boolean }>`
                  select not pg_try_advisory_xact_lock(hashtextextended(${nonce},0)) as challenge,
                         not pg_try_advisory_xact_lock(hashtextextended(${tenant},0)) as tenant
                `.pipe(Effect.orDie);
                Object.assign(result, { commitFenceHeld: locks !== undefined && locks.challenge && locks.tenant });
                if (contendPartyMutation) {
                  yield* verifyPartyMutationWaits().pipe(Effect.orDie);
                }
              }
              return result;
            }),
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
        const read = (actor = principal, correlationWitnesses: readonly IcoCorrelationWitness[] = []) =>
          Context.get(context, ReadRuntime)
            .runRead({
              input: {
                asOf: now,
                correlationWitnesses,
                planId,
                sourceContext: null,
              },
              principal: actor,
              registration: organizationCustomerProfileIcoMigrationRead,
              transport: transport(),
            })
            .pipe(Effect.provideContext(context));
        const apply = (input: MigrateOrganizationCustomerProfileIcoPayload, request = transport(), actor = principal) =>
          runAction({
            payload: input,
            principal: actor,
            registration: migrateOrganizationCustomerProfileIcoAction,
            transport: request,
          }).pipe(Effect.provideContext(context));
        yield* admin`insert into commerce_customer_context.customer_profiles(tenant_id,legal_entity_id,customer_profile_id,profile_kind,lifecycle,revision) values(${fixture.tenantId}::uuid,${fixture.legalEntityId}::uuid,${profileId}::uuid,'COUNTERPARTY','ACTIVE',1)`;
        yield* admin`insert into commerce_customer_context.counterparty_purchasing_profiles(tenant_id,legal_entity_id,counterparty_purchasing_profile_id,counterparty_resource_id) values(${fixture.tenantId}::uuid,${fixture.legalEntityId}::uuid,${profileId}::uuid,${counterpartyId})`;
        yield* admin`insert into commerce_customer_context.customer_profiles(tenant_id,legal_entity_id,customer_profile_id,profile_kind,lifecycle,revision) values(${fixture.tenantId}::uuid,${otherHome.legalEntityId}::uuid,${lateProfile.resourceId}::uuid,'COUNTERPARTY','ACTIVE',1)`;
        yield* admin`insert into commerce_customer_context.counterparty_purchasing_profiles(tenant_id,legal_entity_id,counterparty_purchasing_profile_id,counterparty_resource_id) values(${fixture.tenantId}::uuid,${otherHome.legalEntityId}::uuid,${lateProfile.resourceId}::uuid,${lateCounterparty.resourceId})`;
        yield* admin`insert into party.parties(tenant_id,party_id,current_type)
          values(${fixture.tenantId}::uuid,${lateParty.resourceId}::uuid,'ORGANIZATION')`;
        yield* admin`insert into party.counterparties(
          tenant_id,legal_entity_id,party_id,counterparty_id,creation_reason,evidence_refs,
          source_record_refs,provenance_source,provenance_method,accepted_by_action_invocation_id,
          accepted_by_principal_id,policy_version
        ) values(
          ${fixture.tenantId}::uuid,${otherHome.legalEntityId}::uuid,${lateParty.resourceId}::uuid,
          ${lateCounterparty.resourceId}::uuid,'C14 native owner concurrency fixture','["fixture"]'::jsonb,
          '[]'::jsonb,'fixture','MANUAL',${planId}::uuid,${principal.principalId}::uuid,'fixture'
        )`;
        const incomplete = yield* read();
        expect(incomplete.homeCorrelationWitnesses).toEqual([homeWitness(false)]);
        expect(incomplete.records.map((record) => record.classification)).toEqual([
          'COUNTERPARTY_CORRELATION_UNAVAILABLE',
          'COUNTERPARTY_CORRELATION_UNAVAILABLE',
        ]);
        const localOther = yield* read(otherHome.manager);
        expect(localOther.homeCorrelationWitnesses).toEqual([homeWitness(true)]);
        const report = yield* read(principal, [homeWitness(true)]);
        expect(report.records.map((record) => record.classification)).toEqual(['MATCHED', 'TARGET_SCOPE_UNAUTHORIZED']);
        expect(JSON.stringify(report)).not.toContain(lateCounterparty.resourceId);
        expect(JSON.stringify(report)).not.toContain('actorPrincipalId');
        expect(JSON.stringify(report)).not.toContain('reason');
        expect(JSON.stringify(report)).not.toContain('organizationIcoAuthority');
        const command = {
          asOf: now,
          correlationWitnesses: [homeWitness(true)],
          expectedPartySnapshotVersion: report.partySnapshotVersion,
          expectedTargetInventoryVersion: report.targetInventoryVersion,
          operation: 'STAGE' as const,
          planId,
          sourceContext: null,
        };
        expect(yield* Effect.flip(apply({ ...command, correlationWitnesses: [] }))).toMatchObject({
          code: 'PROFILE_NOT_ADMISSIBLE',
        });
        expect(
          yield* Effect.flip(
            apply({
              ...command,
              correlationWitnesses: [{ ...homeWitness(true), signature: '0'.repeat(64) }],
            }),
          ),
        ).toMatchObject({ code: 'PROFILE_NOT_ADMISSIBLE' });
        correlationEpoch = 'f'.repeat(64);
        expect(yield* Effect.flip(apply(command))).toMatchObject({ code: 'PROFILE_NOT_ADMISSIBLE' });
        correlationEpoch = 'e'.repeat(64);
        samePartyAcrossHomes = true;
        const ambiguous = yield* read(principal, [homeWitness(true)]);
        expect(ambiguous.records.map((record) => record.classification)).toEqual(['MULTIPLE_TARGETS', 'NO_TARGET']);
        samePartyAcrossHomes = false;
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
        contendPartyMutation = true;
        const staged = yield* apply(command);
        contendPartyMutation = false;
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
        const pendingOther = yield* Context.get(context, ReadRuntime)
          .runRead({
            input: { profileRef: lateProfile },
            principal: otherHome.manager,
            registration: organizationCustomerProfileIcoRead,
            transport: transport(),
          })
          .pipe(Effect.provideContext(context));
        expect(Schema.is(OrganizationCustomerProfileIcoResponseSchema.members[0])(pendingOther)).toBe(true);
        // Model an existing profile with independent Commerce authority, without changing the
        // production guard that otherwise fences newly enrolled profiles after cutover.
        yield* admin`
          update commerce_customer_context.customer_profile_ico_authority
          set plan=jsonb_set(plan,'{migrationRequiredProfileIds}',(plan->'migrationRequiredProfileIds')-${lateProfile.resourceId}::text)
          where tenant_id=${fixture.tenantId}::uuid and phase='COMMERCE'
        `;
        const reconcile = Effect.fn('OrganizationIcoTest.reconcile')(function* reconcile() {
          const current = yield* read(otherHome.manager, [homeWitness(false)]);
          return {
            ...command,
            correlationWitnesses: [homeWitness(false)],
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
            principal: otherHome.manager,
            registration: changeOrganizationCustomerProfileIcoAction,
            transport: transport(),
          }).pipe(Effect.provideContext(context));
        });
        const beforeSet = yield* reconcile();
        const independentSet = randomUUID();
        const independentCorrection = randomUUID();
        yield* change({ effectId: independentSet, expectedRevision: 0, operation: 'SET', value: '19' });
        expect(yield* Effect.flip(apply(beforeSet, transport(), otherHome.manager))).toMatchObject({
          code: 'STALE_PLAN',
        });
        expect(yield* Effect.flip(apply(yield* reconcile(), transport(), otherHome.manager))).toMatchObject({
          code: 'PLAN_CONFLICT',
        });
        yield* change({
          effectId: independentCorrection,
          expectedRevision: 1,
          operation: 'CORRECT',
          value: '27074358',
        });
        const acceptedCommand = yield* reconcile();
        const exactRequest = transport();
        privacyDenied = true;
        expect(yield* Effect.flip(apply(acceptedCommand, transport(), otherHome.manager))).toMatchObject({
          code: 'PRIVACY_DENIED',
        });
        privacyDenied = false;
        const accepted = yield* apply(acceptedCommand, exactRequest, otherHome.manager);
        expect(accepted.phase).toBe('COMMERCE');
        const committed = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ code: Schema.Literal('action_already_committed'), invocationId: ActionInvocationIdSchema }),
        )(yield* Effect.flip(apply(acceptedCommand, exactRequest, otherHome.manager)));
        expect((yield* apply(yield* reconcile(), transport(), otherHome.manager)).phase).toBe('COMMERCE');
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
            principal: otherHome.manager,
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
