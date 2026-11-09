import { randomUUID } from 'node:crypto';
import { computeActionRequestHash } from '@app/core-runtime/access/enforcement';
import { ReadRuntime, runAction, ContextAccessLive } from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { LegacyIcoInventoryResponseSchema } from '@app/party-registry/apis/legacy-ico-inventory';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { eq, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, DateTime, Effect, Layer, Match, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { changeCustomerProfileIcoRequestIdentity } from '../../shared/domain/native-action-request-identity.ts';
import type { CustomerProfileIcoRequest } from '../../shared/apis/customer-profile-ico.ts';
import { ChangeCustomerProfileIcoPayloadSchema } from '../../shared/domain/customer-profile-ico.ts';
import type { MigrateCustomerProfileIcoPayloadSchema } from '../../shared/domain/customer-profile-ico-migration.ts';
import { changeCustomerProfileIcoAction } from '../../src/actions/change-customer-profile-ico.action.ts';
import { migrateCustomerProfileIcoAction } from '../../src/actions/migrate-customer-profile-ico.action.ts';
import { customerProfileIcoRead } from '../../src/api/customer-profile-ico.read.ts';
import { customerProfileIcoMigrationRead } from '../../src/api/customer-profile-ico-migration.read.ts';
import { CommerceLegacyIcoInventory } from '../../src/integrations/party-legacy-ico-inventory.ts';
import {
  OrganizationProfileIcoApplicabilityResponseSchema,
  OrganizationProfileIcoFieldContractVersion,
} from '@app/privacy/api/organization-profile-ico-applicability';
import {
  ORGANIZATION_PROFILE_ICO_FIELDS,
  OrganizationProfileIcoRejected,
} from '../../shared/domain/organization-profile-ico.ts';
import { CommerceOrganizationProfileIcoEligibility } from '../../src/integrations/organization-profile-ico-eligibility.ts';
import {
  CommerceSourceProcessingEligibility,
  CommerceSourceProcessingRejected,
} from '../../src/integrations/source-processing-eligibility.ts';
import {
  commerceCustomerContextRelations,
  customerProfiles,
  customerProfileIcoAssertions,
  customerProfileIcoAuthority,
  customerProfileIcoMigrationHistory,
  profileReconciliationCases,
  counterpartyPurchasingProfiles,
} from '../../src/database/schema.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';
import { makeEnrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';
import { profileCounterpartyRoleEligibilityResolverFactoryLive } from '../../src/profile-counterparty-role-eligibility.ts';
import {
  profileReactivationEligibilityEvaluatorFactoryLive,
  profileReconfirmationPolicyUnavailableLive,
} from '../../src/integrations/profile-reactivation-eligibility.ts';
import { partyRegistryGuestResolverFactoryLive } from '../../src/integrations/party-registry-guest-resolver.ts';
import { partyRegistryRetailPartyResolverFactoryLive } from '../../src/integrations/party-registry-retail-party-resolver.ts';

const platform = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const transport = () => ({
  correlationId: randomUUID(),
  idempotencyKey: randomUUID(),
  targetModuleKey: 'commerce.customer-context',
});
const sourceContext = {
  issuer: 'internal-fixture-ebs',
  namespace: 'profile-ico',
  occurrenceId: 'original-1',
  recordId: 'customer-1',
  recordType: 'profile',
  routeRef: 'internal-ico-route',
};
const nativeFixture = Effect.fn('ProfileIcoTests.nativeFixture')(function* nativeFixture() {
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
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      access: 'allowed',
      actionExecutor: 'manager-only',
      actionKeys: [
        changeCustomerProfileIcoAction.descriptor.actionKey,
        migrateCustomerProfileIcoAction.descriptor.actionKey,
      ],
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      allowedAudiences: ['commerce-customer-context'],
      applicationComposition: { load: Effect.succeed(snapshot) },
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: snapshot.composition.revision,
      expectedDeployment: ultramodernApiMarker,
      moduleKeys: ['commerce.customer-context', 'privacy.core', 'party.registry'],
      ownerRegistration: commerceCustomerContextRegistration,
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    }),
    (resource) => resource.close().pipe(Effect.orDie),
  );
  const now = DateTime.formatIso(yield* DateTime.now);
  let inventory = yield* Schema.decodeUnknownEffect(LegacyIcoInventoryResponseSchema)({
    assertions: [],
    authority: { kind: 'LEGACY_PARTY' },
    completeness: 'ALL_LEGACY_ICO_ASSERTIONS',
    snapshotVersion: 'a'.repeat(64),
    tenantId: fixture.tenantId,
  });
  let privacyDenied = false;
  let personalProfileDenied = false;
  let fullScopeDenied = false;
  let organizationDenied = false;
  let organizationCase:
    | { correlationRevision: string; counterpartyId: string; partyId: string; profileId: string; roleId: string }
    | undefined;
  const ordinary = Layer.mergeAll(
    Layer.succeed(CommerceOrganizationProfileIcoEligibility, {
      check: (scope, input) => {
        const current = organizationCase;
        return current === undefined ||
          organizationDenied ||
          input.profileRef.resourceId !== current.profileId ||
          scope.tenantId !== fixture.tenantId
          ? Effect.fail(
              new OrganizationProfileIcoRejected({
                code: 'PRIVACY_DENIED',
                reason: 'This owner fixture does not grant organization field authority',
              }),
            )
          : Schema.decodeUnknownEffect(OrganizationProfileIcoApplicabilityResponseSchema.members[0])({
              allowedFields: ORGANIZATION_PROFILE_ICO_FIELDS,
              applicabilityDecisionRef: 'internal-mixed-organization-field-decision',
              authorityIncarnation: 'internal-mixed-field-authority',
              authorityRevision: '1',
              evaluatedAt: now,
              evidenceRefs: ['internal-mixed-current-org-proof'],
              fieldContractVersion: OrganizationProfileIcoFieldContractVersion,
              outcome: 'NOT_APPLICABLE',
              partyRef: {
                moduleId: 'party.registry',
                resourceId: current.partyId,
                resourceType: 'party.registry.party',
                tenantId: fixture.tenantId,
              },
              partyRevision: 1,
              policyRevisions: [{ policyRef: 'internal-mixed-org-fields', revision: '1' }],
              profileRef: input.profileRef,
              profileRevision: 1,
            }).pipe(Effect.orDie);
      },
    }),
    Layer.succeed(CommerceLegacyIcoInventory, {
      correlate: (_scope, ref, options) => {
        const current = organizationCase;
        return Effect.succeed(
          current === undefined || options?.organizationOnly !== true || ref.resourceId !== current.counterpartyId
            ? Option.none()
            : Option.some({
                archived: false,
                counterpartyRef: ref,
                organizationProof: {
                  counterpartyRef: ref,
                  counterpartyRevision: current.correlationRevision,
                  currentCustomerRoleRef: {
                    moduleId: 'party.registry' as const,
                    resourceId: current.roleId,
                    resourceType: 'party.registry.counterparty-role-period' as const,
                    tenantId: fixture.tenantId,
                  },
                  currentCustomerRoleRevision: 'e'.repeat(64),
                  legalEntityRef: {
                    moduleId: 'core.identity' as const,
                    resourceId: fixture.legalEntityId,
                    resourceType: 'core.identity.legal-entity' as const,
                    tenantId: fixture.tenantId,
                  },
                  outcome: 'CURRENT_ORGANIZATION_CUSTOMER' as const,
                  partyRef: {
                    moduleId: 'party.registry' as const,
                    resourceId: current.partyId,
                    resourceType: 'party.registry.party' as const,
                    tenantId: fixture.tenantId,
                  },
                  partyRevision: 1,
                },
                partyRef: {
                  moduleId: 'party.registry' as const,
                  resourceId: current.partyId,
                  resourceType: 'party.registry.party' as const,
                  tenantId: fixture.tenantId,
                },
                revision: current.correlationRevision,
              }),
        );
      },
      read: () => Effect.succeed(inventory),
    }),
    Layer.succeed(CommerceSourceProcessingEligibility, {
      check: (scope, input) =>
        scope.tenantId !== fixture.tenantId ||
        privacyDenied ||
        (fullScopeDenied && input.target === null) ||
        (personalProfileDenied && input.target?.kind === 'RETAIL_CUSTOMER_PROFILE') ||
        (organizationCase !== undefined && input.target?.resourceId === organizationCase.profileId)
          ? Effect.fail(
              new CommerceSourceProcessingRejected({
                code: 'DENIED',
                reason: 'Internal current protected-material fixture',
              }),
            )
          : Effect.void,
    }),
    profileCounterpartyRoleEligibilityResolverFactoryLive,
    profileReactivationEligibilityEvaluatorFactoryLive,
    partyRegistryGuestResolverFactoryLive,
    partyRegistryRetailPartyResolverFactoryLive,
  ).pipe(Layer.provideMerge(ContextAccessLive), Layer.provide(profileReconfirmationPolicyUnavailableLive));
  const context = yield* Layer.build(ordinary.pipe(Layer.provideMerge(fixture.layer)));
  const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
  const profile = Effect.fn('ProfileIcoTests.seedProfile')(function* seedProfile(
    partyId = randomUUID(),
    legalEntityId = fixture.legalEntityId,
  ) {
    const id = randomUUID();
    yield* admin
      .insert(customerProfiles)
      .values({ customerProfileId: id, legalEntityId, profileKind: 'RETAIL', tenantId: fixture.tenantId });
    yield* admin.execute(
      sql`insert into commerce_customer_context.retail_customer_profiles(retail_customer_profile_id,tenant_id,legal_entity_id,party_resource_id) values(${id}::uuid,${fixture.tenantId}::uuid,${legalEntityId}::uuid,${partyId})`,
    );
    return {
      authorizationSubject: {
        kind: 'RETAIL' as const,
        partyRef: {
          moduleId: 'party.registry' as const,
          resourceId: partyId,
          resourceType: 'party.registry.party' as const,
          tenantId: fixture.tenantId,
        },
        sellingLegalEntityRef: {
          moduleId: 'core.identity' as const,
          resourceId: legalEntityId,
          resourceType: 'core.identity.legal-entity' as const,
          tenantId: fixture.tenantId,
        },
      },
      profileRef: {
        kind: 'RETAIL' as const,
        moduleId: 'commerce.customer-context' as const,
        resourceId: id,
        resourceType: 'commerce.customer-context.retail-customer-profile' as const,
        tenantId: fixture.tenantId,
      },
    };
  });
  const counterparty = Effect.fn('ProfileIcoTests.seedCounterparty')(function* seedCounterparty() {
    const id = randomUUID();
    const counterpartyId = randomUUID();
    yield* admin.insert(customerProfiles).values({
      customerProfileId: id,
      legalEntityId: fixture.legalEntityId,
      profileKind: 'COUNTERPARTY',
      tenantId: fixture.tenantId,
    });
    yield* admin.insert(counterpartyPurchasingProfiles).values({
      counterpartyPurchasingProfileId: id,
      counterpartyResourceId: counterpartyId,
      legalEntityId: fixture.legalEntityId,
      tenantId: fixture.tenantId,
    });
    return {
      authorizationSubject: {
        counterpartyRef: {
          moduleId: 'party.registry' as const,
          resourceId: counterpartyId,
          resourceType: 'party.registry.counterparty' as const,
          tenantId: fixture.tenantId,
        },
        kind: 'COUNTERPARTY' as const,
      },
      profileRef: {
        kind: 'COUNTERPARTY' as const,
        moduleId: 'commerce.customer-context' as const,
        resourceId: id,
        resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
        tenantId: fixture.tenantId,
      },
    };
  });
  const report = (planId: string, asOf = now) =>
    Context.get(context, ReadRuntime)
      .runRead({
        input: { asOf, planId, reason: 'Migrate approved internal fixture assertions', sourceContext },
        principal,
        registration: customerProfileIcoMigrationRead,
        transport: transport(),
      })
      .pipe(Effect.provideContext(context));
  const migrate = (input: typeof MigrateCustomerProfileIcoPayloadSchema.Type) =>
    runAction({
      payload: input,
      principal,
      registration: migrateCustomerProfileIcoAction,
      transport: transport(),
    }).pipe(Effect.provideContext(context));
  return {
    admin,
    context,
    counterparty,
    fence: (planId: string) => {
      inventory = {
        ...inventory,
        authority: {
          kind: 'COMMERCE_FENCED',
          proof: {
            fencedAt: now,
            fenceId: randomUUID(),
            migrationPlanRef: planId,
            snapshotVersion: inventory.snapshotVersion,
            tenantId: fixture.tenantId,
          },
        },
      };
    },
    fixture,
    migrate,
    now,
    principal,
    profile,
    read: (input: CustomerProfileIcoRequest) =>
      Context.get(context, ReadRuntime)
        .runRead({ input, principal, registration: customerProfileIcoRead, transport: transport() })
        .pipe(Effect.provideContext(context)),
    report,
    setFullScopeDenied: (next: boolean) => {
      fullScopeDenied = next;
    },
    setInventory: (next: typeof LegacyIcoInventoryResponseSchema.Type) => {
      inventory = next;
    },
    setOrganizationCase: (next: {
      correlationRevision: string;
      counterpartyId: string;
      partyId: string;
      profileId: string;
      roleId: string;
    }) => {
      organizationCase = next;
    },
    setOrganizationDenied: (next: boolean) => {
      organizationDenied = next;
    },
    setPersonalProfileDenied: (next: boolean) => {
      personalProfileDenied = next;
    },
    setPrivacyDenied: (denied: boolean) => {
      privacyDenied = denied;
    },
  };
});

it.live(
  'enforces one Current independent profile IČO with atomic history, CAS, effect recovery and current Privacy',
  () =>
    Effect.scoped(
      Effect.gen(function* profileIcoNative() {
        const test = yield* nativeFixture();
        const p1 = yield* test.profile();
        const p2 = yield* test.profile();
        const p3 = yield* test.counterparty();
        const plan = yield* test.report('empty-internal-plan');
        const migration = {
          asOf: plan.asOf,
          expectedPartySnapshotVersion: plan.partySnapshotVersion,
          expectedTargetInventoryVersion: plan.targetInventoryVersion,
          operation: 'STAGE' as const,
          planId: plan.planId,
          reason: plan.reason,
          sourceContext: plan.sourceContext,
        };
        yield* test.migrate(migration);
        test.fence(plan.planId);
        yield* test.migrate({ ...migration, operation: 'CUTOVER' });
        const { read } = test;
        expect(yield* read(p1)).toMatchObject({ current: null, revision: 0 });
        const payload = yield* Schema.decodeUnknownEffect(ChangeCustomerProfileIcoPayloadSchema)({
          ...p1,
          effectId: 'p1-original',
          effectiveAt: test.now,
          expectedRevision: 0,
          identifier: { identifierType: 'ICO', value: '19' },
          operation: 'SET',
          originalInput: '19',
          provenance: {
            assertionId: 'assertion-1',
            countryCode: 'CZ',
            evidenceRef: 'evidence-1',
            source: 'internal-fixture',
            sourceContext,
            sourceRevision: '1',
          },
          reason: 'Declare independently sourced Czech registration',
        });
        const change = (input: typeof ChangeCustomerProfileIcoPayloadSchema.Type = payload) =>
          runAction({
            payload: input,
            principal: test.principal,
            registration: changeCustomerProfileIcoAction,
            transport: transport(),
          }).pipe(Effect.provideContext(test.context));
        const [first, replay] = yield* Effect.all([change(), change()], { concurrency: 2 });
        expect(first.assertion).toEqual(replay.assertion);
        const publicIdentity = yield* changeCustomerProfileIcoRequestIdentity(
          yield* Schema.decodeUnknownEffect(Schema.Json)(
            yield* Schema.encodeEffect(ChangeCustomerProfileIcoPayloadSchema)(payload),
          ),
        );
        const expectedHash = computeActionRequestHash({ ...publicIdentity, principal: test.principal });
        const recordedHashes = yield* test.admin.execute<{ request_hash: string }>(
          sql`select request_hash from core.action_invocations where tenant_id=${test.fixture.tenantId}::uuid and action_key='commerce.customer-context.change-customer-profile-ico' and status='succeeded'`,
        );
        const hashRows = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ rows: Schema.Array(Schema.Struct({ request_hash: Schema.String })) }),
        )(recordedHashes);
        expect(hashRows.rows.some((row) => row.request_hash === expectedHash)).toBe(true);
        const accessEvidence = yield* test.admin.execute(
          sql`select count(distinct a.action_invocation_id)::integer invocations,count(e.data_access_event_id)::integer reads,bool_and(e.evidence_payload_json is null) metadata_only from core.action_invocations a left join core.data_access_events e on e.tenant_id=a.tenant_id and e.action_invocation_id=a.action_invocation_id and e.query_hash like 'profile-ico-%' where a.tenant_id=${test.fixture.tenantId}::uuid and a.request_hash=${expectedHash} and a.status='succeeded'`,
        );
        const evidence = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            rows: Schema.Array(
              Schema.Struct({ invocations: Schema.Int, metadata_only: Schema.Boolean, reads: Schema.Int }),
            ),
          }),
        )(accessEvidence);
        expect(evidence.rows[0]?.invocations).toBeGreaterThan(0);
        expect(evidence.rows[0]?.reads).toBe((evidence.rows[0]?.invocations ?? 0) * 2);
        expect(evidence.rows[0]?.metadata_only).toBe(true);
        expect(yield* read({ ...p1, effectId: payload.effectId })).toMatchObject({ assertion: first.assertion });
        yield* change({ ...payload, ...p2, effectId: 'p2-original' });
        yield* change({ ...payload, ...p3, effectId: 'p3-original' });
        expect(
          yield* Effect.flip(
            change({
              ...payload,
              effectId: 'foreign-tenant',
              profileRef: { ...payload.profileRef, tenantId: randomUUID() },
            }),
          ),
        ).toMatchObject({ code: 'PROFILE_NOT_FOUND' });
        const corrected = yield* change({
          ...payload,
          effectId: 'p1-correction',
          expectedRevision: 1,
          identifier: { identifierType: 'ICO', value: '27074358' },
          operation: 'CORRECT',
          originalInput: '27074358',
          reason: 'Correct explicit source assertion',
        });
        expect(corrected.assertion.revision).toBe(2);
        expect(yield* read(p1)).toMatchObject({
          current: { normalizedValue: '27074358' },
          history: [{ normalizedValue: '00000019' }, { normalizedValue: '27074358' }],
        });
        expect(yield* read(p2)).toMatchObject({
          current: { normalizedValue: '00000019' },
          revision: 1,
        });
        expect(yield* Effect.flip(change({ ...payload, effectId: 'stale-set' }))).toMatchObject({
          code: 'REVISION_CONFLICT',
        });
        expect(yield* Effect.flip(change({ ...payload, reason: 'Conflicting original effect' }))).toMatchObject({
          code: 'EFFECT_CONFLICT',
        });
        yield* change({
          authorizationSubject: p1.authorizationSubject,
          effectId: 'p1-end',
          effectiveAt: test.now,
          expectedRevision: 2,
          operation: 'END',
          profileRef: p1.profileRef,
          provenance: payload.provenance,
          reason: 'End explicit independent source assertion',
        });
        expect(yield* read(p1)).toMatchObject({ revision: 3 });
        yield* test.migrate({ ...migration, operation: 'CUTOVER' });
        expect(yield* read(p1)).toMatchObject({ revision: 3 });
        test.setPrivacyDenied(true);
        expect(yield* Effect.flip(read(p2))).toMatchObject({ code: 'read_handler_unavailable' });
        expect(yield* Effect.flip(change({ ...payload, ...p2, effectId: 'p2-original' }))).toMatchObject({
          code: 'PRIVACY_DENIED',
        });
        const rows = yield* test.admin
          .select()
          .from(customerProfileIcoAssertions)
          .where(eq(customerProfileIcoAssertions.tenantId, test.fixture.tenantId));
        expect(rows).toHaveLength(5);
        expect(rows.filter((row) => row.isCurrent)).toHaveLength(2);
        test.setPrivacyDenied(false);
        const caseId = randomUUID();
        yield* test.admin.insert(profileReconciliationCases).values({
          actionInvocationId: randomUUID(),
          actorPrincipalId: test.principal.principalId,
          canonicalizationEvidence: { kind: 'INTERNAL_OWNER_FIXTURE' },
          canonicalPartyResourceId: p2.authorizationSubject.partyRef.resourceId,
          collidingProfileId: p1.profileRef.resourceId,
          legalEntityId: test.fixture.legalEntityId,
          mergeResourceId: 'internal-profile-review',
          profileKind: 'RETAIL',
          profileReconciliationCaseId: caseId,
          sourceCorrelationRef: 'internal-profile-review',
          sourceProfileId: p2.profileRef.resourceId,
          targetSubject: p2.authorizationSubject,
          tenantId: test.fixture.tenantId,
          trigger: 'IMPORT_CORRELATION',
        });
        yield* test.admin.execute(
          sql`insert into commerce_customer_context.profile_reconciliation_case_members(tenant_id,legal_entity_id,profile_reconciliation_case_id,customer_profile_id,member_position,observed_lifecycle) values(${test.fixture.tenantId}::uuid,${test.fixture.legalEntityId}::uuid,${caseId}::uuid,${p2.profileRef.resourceId}::uuid,0,'ACTIVE')`,
        );
        expect(
          Match.value(yield* read(p2)).pipe(
            Match.tag('MIGRATION_REQUIRED', () => true),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        expect(
          yield* Effect.flip(
            change({
              ...payload,
              ...p2,
              effectId: 'blocked-reconciliation',
              expectedRevision: 1,
              identifier: { identifierType: 'ICO', value: '19' },
              operation: 'CORRECT',
              originalInput: '19',
            }),
          ),
        ).toMatchObject({ code: 'MIGRATION_REQUIRED' });
        const grantRows = yield* test.admin.execute<{ helper: boolean; raw: boolean }>(
          sql`select has_table_privilege('ontos_runtime','commerce_customer_context.customer_profile_ico_assertions','SELECT') raw, has_function_privilege('ontos_runtime','commerce_customer_context.refresh_profile_ico_inventory()','EXECUTE') helper`,
        );
        const grants = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ rows: Schema.Array(Schema.Struct({ helper: Schema.Boolean, raw: Schema.Boolean })) }),
        )(grantRows);
        expect(grants.rows[0]).toEqual({ helper: false, raw: false });
      }),
    ).pipe(Effect.provide(platform)),
  { timeout: 180_000 },
);

it.live(
  'stages only exact unambiguous legacy evidence, fences cutover, and never fans out across Selling Legal Entities',
  () =>
    Effect.scoped(
      Effect.gen(function* icoMigrationNative() {
        const test = yield* nativeFixture();
        const p1 = yield* test.profile();
        const legacy = {
          assertionRef: {
            moduleId: 'party.registry' as const,
            resourceId: randomUUID(),
            resourceType: 'party.registry.party-official-identifier' as const,
            tenantId: test.fixture.tenantId,
          },
          isCurrent: true,
          normalizedValue: '00000019',
          originalInput: { kind: 'UNKNOWN' as const },
          partyRef: p1.authorizationSubject.partyRef,
          provenance: {
            acceptedByActionInvocationId: randomUUID(),
            acceptedByPrincipalId: randomUUID(),
            method: 'ACTOR_DECLARATION',
            policyVersion: '1',
            retractsAssertionId: null,
            source: 'retained-original-source',
            supersedesAssertionId: null,
          },
          recordedAt: '2026-01-01T00:00:00.000Z',
          revision: 'c'.repeat(64),
          state: 'ACTIVE' as const,
          validFrom: '2026-01-01T00:00:00.000Z',
          validTo: null,
        };
        const secondPartyId = randomUUID();
        yield* test.profile(secondPartyId);
        yield* test.profile(secondPartyId, randomUUID());
        const foreignUnique = yield* test.profile(randomUUID(), randomUUID());
        const outsidePlanTime = yield* test.profile();
        const noTargetPartyId = randomUUID();
        const noTargetAssertionRef = { ...legacy.assertionRef, resourceId: randomUUID() };
        test.setInventory({
          assertions: [
            legacy,
            {
              ...legacy,
              assertionRef: { ...legacy.assertionRef, resourceId: randomUUID() },
              partyRef: { ...legacy.partyRef, resourceId: secondPartyId },
            },
            {
              ...legacy,
              assertionRef: { ...legacy.assertionRef, resourceId: randomUUID() },
              partyRef: foreignUnique.authorizationSubject.partyRef,
            },
            {
              ...legacy,
              assertionRef: { ...legacy.assertionRef, resourceId: randomUUID() },
              partyRef: outsidePlanTime.authorizationSubject.partyRef,
              validFrom: '2026-11-06T00:00:00.000Z',
            },
            {
              ...legacy,
              assertionRef: noTargetAssertionRef,
              partyRef: { ...legacy.partyRef, resourceId: noTargetPartyId },
              provenance: { ownerReceiptRef: noTargetAssertionRef },
            },
          ],
          authority: { kind: 'LEGACY_PARTY' },
          completeness: 'ALL_LEGACY_ICO_ASSERTIONS',
          snapshotVersion: 'b'.repeat(64),
          tenantId: test.fixture.tenantId,
        });
        const plan = yield* test.report('legacy-internal-plan', '2026-01-01T00:00:00.000Z');
        expect(plan.records.map((record) => record.classification)).toEqual([
          'MATCHED',
          'MULTIPLE_TARGETS',
          'TARGET_SCOPE_UNAUTHORIZED',
          'CURRENT_OUTSIDE_PLAN_TIME',
          'NO_TARGET',
        ]);
        expect(yield* test.admin.select().from(customerProfiles)).toHaveLength(5);
        expect(yield* test.admin.select().from(customerProfileIcoAssertions)).toHaveLength(0);
        const input = {
          asOf: plan.asOf,
          expectedPartySnapshotVersion: plan.partySnapshotVersion,
          expectedTargetInventoryVersion: plan.targetInventoryVersion,
          operation: 'STAGE' as const,
          planId: plan.planId,
          reason: plan.reason,
          sourceContext,
        };
        yield* test.migrate(input);
        yield* test.migrate(input);
        const staged = yield* test.admin.select().from(customerProfileIcoAssertions);
        expect(staged).toHaveLength(1);
        expect(staged[0]?.isCurrent).toBe(false);
        expect(staged[0]?.assertion).toMatchObject({
          normalizerVersion: null,
          originalInput: null,
          provenance: { legacy: { originalInput: { kind: 'UNKNOWN' } } },
        });
        expect(yield* Effect.flip(test.migrate({ ...input, operation: 'CUTOVER' }))).toMatchObject({
          code: 'AUTHORITY_NOT_FENCED',
        });
        yield* test.admin
          .update(customerProfiles)
          .set({ revision: 2 })
          .where(eq(customerProfiles.customerProfileId, p1.profileRef.resourceId));
        expect(yield* Effect.flip(test.migrate({ ...input, operation: 'CUTOVER' }))).toMatchObject({
          code: 'STALE_PLAN',
        });
        test.fence(plan.planId);
        const fresh = yield* test.report(plan.planId, plan.asOf);
        const revision = yield* Schema.decodeUnknownEffect(Schema.Int)(fresh.authorityRevision);
        const restage = {
          ...input,
          expectedAuthorityRevision: revision,
          expectedTargetInventoryVersion: fresh.targetInventoryVersion,
          operation: 'RESTAGE' as const,
        };
        expect(yield* Effect.flip(test.migrate({ ...restage, expectedAuthorityRevision: revision + 1 }))).toMatchObject(
          { code: 'STALE_PLAN' },
        );
        expect(
          yield* Effect.flip(test.migrate({ ...restage, planId: 'cannot-abandon-permanent-fence' })),
        ).toMatchObject({ code: 'AUTHORITY_NOT_FENCED' });
        yield* test.migrate(restage);
        expect(yield* Effect.flip(test.migrate(restage))).toMatchObject({ code: 'STALE_PLAN' });
        const archives = yield* test.admin.select().from(customerProfileIcoMigrationHistory);
        expect(archives).toHaveLength(1);
        expect(archives[0]?.plan).toMatchObject({
          planId: plan.planId,
          records: expect.arrayContaining([
            expect.objectContaining({ targets: expect.arrayContaining([expect.objectContaining({ revision: 1 })]) }),
          ]),
        });
        expect(yield* test.admin.select().from(customerProfileIcoAssertions)).toHaveLength(1);
        const cutover = { ...restage, operation: 'CUTOVER' as const };
        yield* test.migrate(cutover);
        yield* test.migrate(cutover);
        const active = yield* test.admin.select().from(customerProfileIcoAssertions);
        expect(active).toHaveLength(1);
        expect(active[0]?.isCurrent).toBe(true);
        const [authority] = yield* test.admin.select().from(customerProfileIcoAuthority);
        expect(authority?.phase).toBe('COMMERCE');
        const unresolved = yield* Context.get(test.context, ReadRuntime)
          .runRead({
            input: outsidePlanTime,
            principal: test.principal,
            registration: customerProfileIcoRead,
            transport: transport(),
          })
          .pipe(Effect.provideContext(test.context));
        expect('history' in unresolved).toBe(false);
        expect(authority?.plan.migrationRequiredProfileIds).toEqual(
          expect.arrayContaining([outsidePlanTime.profileRef.resourceId, foreignUnique.profileRef.resourceId]),
        );
        const correctedPayload = yield* Schema.decodeUnknownEffect(ChangeCustomerProfileIcoPayloadSchema)({
          ...p1,
          effectId: 'legacy-import-correction',
          effectiveAt: test.now,
          expectedRevision: 1,
          identifier: { identifierType: 'ICO', value: '27074358' },
          operation: 'CORRECT',
          originalInput: '27074358',
          provenance: {
            assertionId: 'corrected-owner-evidence',
            countryCode: 'CZ',
            evidenceRef: 'corrected-owner-evidence',
            source: 'internal-fixture',
            sourceContext,
            sourceRevision: '2',
          },
          reason: 'Correct retained legacy assertion with explicit current source',
        });
        yield* runAction({
          payload: correctedPayload,
          principal: test.principal,
          registration: changeCustomerProfileIcoAction,
          transport: transport(),
        }).pipe(Effect.provideContext(test.context));
        const newlyAmbiguous = yield* test.profile(p1.authorizationSubject.partyRef.resourceId, randomUUID());
        const newlyResolved = yield* test.profile(noTargetPartyId);
        const followup = yield* test.report(plan.planId, plan.asOf);
        const followupRevision = yield* Schema.decodeUnknownEffect(Schema.Int)(followup.authorityRevision);
        const reconcile = {
          ...input,
          expectedAuthorityRevision: followupRevision,
          expectedTargetInventoryVersion: followup.targetInventoryVersion,
          operation: 'RECONCILE' as const,
        };
        yield* test.migrate(reconcile);
        expect(yield* Effect.flip(test.migrate(reconcile))).toMatchObject({ code: 'STALE_PLAN' });
        const { read } = test;
        expect(yield* read(p1)).toMatchObject({
          current: { normalizedValue: '27074358' },
          history: [{ normalizedValue: '00000019' }, { normalizedValue: '27074358' }],
          revision: 2,
        });
        const [reconciledAuthority] = yield* test.admin.select().from(customerProfileIcoAuthority);
        expect(reconciledAuthority?.plan.migrationRequiredProfileIds).toEqual(
          expect.arrayContaining([newlyAmbiguous.profileRef.resourceId]),
        );
        expect(reconciledAuthority?.plan.migrationRequiredProfileIds).not.toEqual(
          expect.arrayContaining([p1.profileRef.resourceId]),
        );
        expect(yield* read(newlyResolved)).toMatchObject({
          current: {
            normalizedValue: '00000019',
            provenance: { legacy: { provenance: { ownerReceiptRef: noTargetAssertionRef } }, source: null },
          },
          revision: 1,
        });
        const reconciledRows = yield* test.admin.select().from(customerProfileIcoAssertions);
        expect(reconciledRows).toHaveLength(3);
        expect(reconciledRows.filter((row) => row.isCurrent)).toHaveLength(2);
        expect((yield* test.admin.select().from(customerProfileIcoMigrationHistory)).length).toBeGreaterThan(2);
        const authorityQueryHash = `profile-ico-authority:${plan.planId}`;
        const rawMigrationEvidence = yield* test.admin.execute(
          sql`select count(distinct a.action_invocation_id)::integer invocations,count(e.data_access_event_id)::integer authority_reads,bool_and(e.evidence_payload_json is null) metadata_only from core.action_invocations a left join core.data_access_events e on e.tenant_id=a.tenant_id and e.action_invocation_id=a.action_invocation_id and e.query_hash=${authorityQueryHash} where a.tenant_id=${test.fixture.tenantId}::uuid and a.action_key='commerce.customer-context.migrate-customer-profile-ico' and a.status='succeeded'`,
        );
        const migrationEvidence = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            rows: Schema.Array(
              Schema.Struct({ authority_reads: Schema.Int, invocations: Schema.Int, metadata_only: Schema.Boolean }),
            ),
          }),
        )(rawMigrationEvidence);
        expect(migrationEvidence.rows[0]?.invocations).toBeGreaterThan(4);
        expect(migrationEvidence.rows[0]?.authority_reads).toBe(migrationEvidence.rows[0]?.invocations);
        expect(migrationEvidence.rows[0]?.metadata_only).toBe(true);
      }),
    ).pipe(Effect.provide(platform)),
  { timeout: 180_000 },
);

/** INTERNAL_OWNER_CONTRACT: genuine Commerce/Core migration, explicit full-person and safe-ORG ports. */
it.live(
  'keeps full personal migration authority while importing a bounded organization record in the same complete fenced plan',
  () =>
    Effect.scoped(
      Effect.gen(function* mixedAuthorityMigration() {
        const test = yield* nativeFixture();
        const personal = yield* test.profile();
        const company = yield* test.counterparty();
        const companyPartyId = randomUUID();
        const roleId = randomUUID();
        const config = {
          correlationRevision: 'd'.repeat(64),
          counterpartyId: company.authorizationSubject.counterpartyRef.resourceId,
          partyId: companyPartyId,
          profileId: company.profileRef.resourceId,
          roleId,
        };
        test.setOrganizationCase(config);
        const personAssertionId = randomUUID();
        const organizationAssertionId = randomUUID();
        const personRef = {
          moduleId: 'party.registry',
          resourceId: personAssertionId,
          resourceType: 'party.registry.party-official-identifier',
          tenantId: test.fixture.tenantId,
        };
        const organizationRef = { ...personRef, resourceId: organizationAssertionId };
        const inventory = yield* Schema.decodeUnknownEffect(LegacyIcoInventoryResponseSchema)({
          assertions: [
            {
              assertionRef: personRef,
              isCurrent: true,
              normalizedValue: '00000019',
              originalInput: { digits: '19', kind: 'KNOWN' },
              partyRef: personal.authorizationSubject.partyRef,
              provenance: {
                acceptedByActionInvocationId: randomUUID(),
                acceptedByPrincipalId: test.principal.principalId,
                method: 'MIGRATION_REVIEW',
                policyVersion: '1',
                retractsAssertionId: null,
                source: 'INTERNAL_PERSON_OWNER_CONTRACT',
                supersedesAssertionId: null,
              },
              recordedAt: '2020-01-01T00:00:00.000Z',
              revision: 'a'.repeat(64),
              state: 'ACTIVE',
              validFrom: '2020-01-01T00:00:00.000Z',
              validTo: null,
            },
            {
              assertionRef: organizationRef,
              isCurrent: true,
              normalizedValue: '00000027',
              originalInput: { digits: '27', kind: 'KNOWN' },
              partyRef: {
                moduleId: 'party.registry',
                resourceId: companyPartyId,
                resourceType: 'party.registry.party',
                tenantId: test.fixture.tenantId,
              },
              provenance: { ownerReceiptRef: organizationRef },
              recordedAt: '2020-01-01T00:00:00.000Z',
              revision: 'b'.repeat(64),
              state: 'ACTIVE',
              validFrom: '2020-01-01T00:00:00.000Z',
              validTo: null,
            },
          ],
          authority: { kind: 'LEGACY_PARTY' },
          completeness: 'ALL_LEGACY_ICO_ASSERTIONS',
          snapshotVersion: 'c'.repeat(64),
          tenantId: test.fixture.tenantId,
        });
        test.setInventory(inventory);
        const planId = randomUUID();
        test.setFullScopeDenied(true);
        expect(yield* Effect.flip(test.report(planId))).toMatchObject({ code: 'read_handler_unavailable' });
        test.setFullScopeDenied(false);
        test.setPersonalProfileDenied(true);
        expect(yield* Effect.flip(test.report(planId))).toMatchObject({ code: 'read_handler_unavailable' });
        test.setPersonalProfileDenied(false);
        test.setOrganizationDenied(true);
        expect(yield* Effect.flip(test.report(planId))).toMatchObject({ code: 'read_handler_unavailable' });
        test.setOrganizationDenied(false);
        const firstPlan = yield* test.report(planId);
        expect(firstPlan.records.map((record) => record.classification)).toEqual(['MATCHED', 'MATCHED']);
        const command = {
          asOf: firstPlan.asOf,
          expectedPartySnapshotVersion: firstPlan.partySnapshotVersion,
          expectedTargetInventoryVersion: firstPlan.targetInventoryVersion,
          operation: 'STAGE' as const,
          planId,
          reason: firstPlan.reason,
          sourceContext: firstPlan.sourceContext,
        };
        test.setOrganizationCase({ ...config, correlationRevision: 'f'.repeat(64) });
        expect(yield* Effect.flip(test.migrate(command))).toMatchObject({ code: 'STALE_PLAN' });
        const freshPlan = yield* test.report(planId);
        const freshCommand = { ...command, expectedTargetInventoryVersion: freshPlan.targetInventoryVersion };
        yield* test.migrate(freshCommand);
        test.fence(planId);
        const cutover = yield* test.migrate({ ...freshCommand, operation: 'CUTOVER' });
        expect(cutover.phase).toBe('COMMERCE');
        const rows = yield* test.admin
          .select()
          .from(customerProfileIcoAssertions)
          .where(eq(customerProfileIcoAssertions.tenantId, test.fixture.tenantId));
        expect(rows).toHaveLength(2);
        const companyRow = rows.find((row) => row.customerProfileId === company.profileRef.resourceId);
        const personalRow = rows.find((row) => row.customerProfileId === personal.profileRef.resourceId);
        expect(companyRow?.assertion).toMatchObject({ normalizedValue: '00000027' });
        expect(JSON.stringify(companyRow?.assertion)).not.toContain('actorPrincipalId');
        expect(JSON.stringify(companyRow?.assertion)).not.toContain('"reason":');
        expect(JSON.stringify(companyRow?.assertion)).not.toContain('"source":');
        expect(personalRow?.assertion).toMatchObject({
          actorPrincipalId: test.principal.principalId,
          reason: freshPlan.reason,
        });
        test.setPersonalProfileDenied(true);
        expect(yield* Effect.flip(test.report(planId))).toMatchObject({ code: 'read_handler_unavailable' });
      }),
    ).pipe(Effect.provide(platform)),
  { timeout: 180_000 },
);
