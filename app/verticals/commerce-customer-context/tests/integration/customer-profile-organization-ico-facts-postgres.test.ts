import { randomUUID } from 'node:crypto';
import { ContextAccessLive, ReadRuntime, defineScopedRoutine } from '@app/core-runtime';
import { installOperationalScope, makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Layer, Match, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { expect, it } from 'effect-rstest';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { customerProfileOrganizationIcoFactsRead } from '../../src/api/customer-profile-organization-ico-facts.read.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';
import { makeEnrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';

const historicalIdentityRoutine = defineScopedRoutine({
  name: 'read_customer_profile_organization_business_facts',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({ outcome: Schema.String, payload: Schema.Unknown }),
  routineKey: 'customer-profile-organization-business-facts.read',
  schema: 'commerce_customer_context',
});

const platform = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

/** Own-owner scope/lifecycle proof. The combined organization fixture proves the real Party receiver. */
it.live(
  'rejects organization IČO facts outside the exact active unreconciled home profile',
  () =>
    Effect.scoped(
      Effect.gen(function* organizationProfileGuards() {
        const snapshot = yield* makeEnrollmentApplicationCompositionSnapshot(ultramodernApiMarker.buildMarker, [
          'party-registry',
          'privacy',
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
        const admin = Context.get(adminContext, PgClient.PgClient);
        const coreDatabase = yield* testCoreDatabase.pipe(Effect.provide(adminContext));
        const fixture = yield* Effect.acquireRelease(
          makeLiveOperationFixture({
            access: 'allowed',
            actionExecutor: 'manager-only',
            actionKeys: [],
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
        const context = yield* Layer.build(Layer.mergeAll(fixture.layer, ContextAccessLive, NodeCrypto.layer));
        const profileId = randomUUID();
        const counterpartyId = randomUUID();
        const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
        const profileRef = {
          moduleId: 'commerce.customer-context' as const,
          resourceId: profileId,
          resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
          tenantId: fixture.tenantId,
        };
        // This positive probe proves only Commerce SQL identity/RLS, not a Party or Privacy decision.
        const historicalSql = () =>
          coreDatabase.transaction(
            Effect.fn('OrganizationHistoricalIdentity.sql')(function* query(transaction) {
              const scoped = yield* installOperationalScope(transaction, {
                ...principal,
                correlationId: 'internal-historical-identity-sql',
              });
              return yield* scoped.invoke(historicalIdentityRoutine, [profileId]);
            }),
          );
        const read = (requestedProfile = profileRef) =>
          Context.get(context, ReadRuntime)
            .runRead({
              input: { profileRef: requestedProfile },
              principal,
              registration: customerProfileOrganizationIcoFactsRead,
              transport: {
                correlationId: randomUUID(),
                idempotencyKey: randomUUID(),
                targetModuleKey: 'commerce.customer-context',
              },
            })
            .pipe(Effect.provideContext(context));
        expect(
          Match.value(yield* read()).pipe(
            Match.tag('NOT_ADMISSIBLE', () => true),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        yield* admin`insert into commerce_customer_context.customer_profiles(tenant_id,legal_entity_id,customer_profile_id,profile_kind,lifecycle,revision) values(${fixture.tenantId}::uuid,${fixture.legalEntityId}::uuid,${profileId}::uuid,'COUNTERPARTY','ARCHIVED',7)`;
        yield* admin`insert into commerce_customer_context.counterparty_purchasing_profiles(tenant_id,legal_entity_id,counterparty_purchasing_profile_id,counterparty_resource_id) values(${fixture.tenantId}::uuid,${fixture.legalEntityId}::uuid,${profileId}::uuid,${counterpartyId})`;
        expect(
          Match.value(yield* read()).pipe(
            Match.tag('NOT_ADMISSIBLE', () => true),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        for (const profileState of ['ARCHIVED', 'SUSPENDED', 'ACTIVE']) {
          yield* admin`update commerce_customer_context.customer_profiles set lifecycle=${profileState} where tenant_id=${fixture.tenantId}::uuid and customer_profile_id=${profileId}::uuid`;
          const [identity] = yield* historicalSql();
          expect(identity).toMatchObject({
            outcome: 'CURRENT_HISTORICAL_IDENTITY',
            payload: { counterpartyResourceId: counterpartyId, profileRevision: 7, profileState },
          });
        }
        yield* admin`update commerce_customer_context.customer_profiles set lifecycle='ARCHIVED' where tenant_id=${fixture.tenantId}::uuid and customer_profile_id=${profileId}::uuid`;
        expect(
          Match.value(yield* read({ ...profileRef, tenantId: randomUUID() })).pipe(
            Match.tag('NOT_ADMISSIBLE', () => true),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        yield* admin`update commerce_customer_context.customer_profiles set lifecycle='ACTIVE' where tenant_id=${fixture.tenantId}::uuid and customer_profile_id=${profileId}::uuid`;
        const differentHome = randomUUID();
        yield* admin`update commerce_customer_context.customer_profiles set legal_entity_id=${differentHome}::uuid where tenant_id=${fixture.tenantId}::uuid and customer_profile_id=${profileId}::uuid`;
        expect(
          Match.value(yield* read()).pipe(
            Match.tag('NOT_ADMISSIBLE', () => true),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        expect((yield* historicalSql())[0]).toMatchObject({ outcome: 'NOT_ADMISSIBLE' });
        yield* admin`update commerce_customer_context.customer_profiles set legal_entity_id=${fixture.legalEntityId}::uuid where tenant_id=${fixture.tenantId}::uuid and customer_profile_id=${profileId}::uuid`;
        const caseId = randomUUID();
        const collisionId = randomUUID();
        yield* admin`insert into commerce_customer_context.customer_profiles(tenant_id,legal_entity_id,customer_profile_id,profile_kind,lifecycle,revision) values(${fixture.tenantId}::uuid,${fixture.legalEntityId}::uuid,${collisionId}::uuid,'COUNTERPARTY','ACTIVE',1)`;
        yield* admin`insert into commerce_customer_context.profile_reconciliation_cases(tenant_id,legal_entity_id,profile_reconciliation_case_id,action_invocation_id,actor_principal_id,canonicalization_evidence,canonical_party_resource_id,colliding_profile_id,merge_resource_id,profile_kind,source_correlation_ref,source_profile_id,target_subject,trigger) values(${fixture.tenantId}::uuid,${fixture.legalEntityId}::uuid,${caseId}::uuid,${randomUUID()}::uuid,${fixture.manager.principalId}::uuid,'{"kind":"INTERNAL_OWNER_FIXTURE"}'::jsonb,${randomUUID()},${collisionId}::uuid,'internal-organization-ico-review','COUNTERPARTY','internal-organization-ico-review',${profileId}::uuid,'{}'::jsonb,'IMPORT_CORRELATION')`;
        yield* admin`insert into commerce_customer_context.profile_reconciliation_case_members(tenant_id,legal_entity_id,profile_reconciliation_case_id,customer_profile_id,member_position,observed_lifecycle) values(${fixture.tenantId}::uuid,${fixture.legalEntityId}::uuid,${caseId}::uuid,${profileId}::uuid,0,'ACTIVE')`;
        expect(
          Match.value(yield* read()).pipe(
            Match.tag('NOT_ADMISSIBLE', () => true),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        expect((yield* historicalSql())[0]).toMatchObject({ outcome: 'NOT_ADMISSIBLE' });
        const [permissions] = yield* admin<{
          raw: boolean;
        }>`select has_table_privilege('ontos_runtime','commerce_customer_context.counterparty_purchasing_profiles','SELECT') raw`;
        expect(permissions).toEqual({ raw: false });
      }),
    ).pipe(Effect.provide(platform)),
  { timeout: 180_000 },
);
