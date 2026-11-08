import { NodeCrypto } from '@effect/platform-node';
import {
  OperationContextUnavailable,
  TrustedPrincipalContextSchema,
  defineDatabaseIdentityEnrollment,
} from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { Array as EffectArray, Effect, Layer, Order, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import {
  createActionCollector,
  getActionHandler,
  getActionServiceFactory,
  installOperationalScope,
} from '@app/core-runtime/testing/actions';
import { AccessPortalProjection } from '@app/core-runtime/access/portal';
import { getReadServiceFactory } from '@app/core-runtime/testing/reads';

import { archiveCustomerProfileAction } from '../../src/actions/archive-customer-profile.action.ts';
import { attributeGuestRetailCustomerAction } from '../../src/actions/attribute-guest-retail-customer.action.ts';
import { bindRetailPortalProfileAction } from '../../src/actions/bind-retail-portal-profile.action.ts';
import { createCounterpartyPurchasingProfileAction } from '../../src/actions/create-counterparty-purchasing-profile.action.ts';
import { ensureRetailCustomerProfileAction } from '../../src/actions/ensure-retail-customer-profile.action.ts';
import { openProfileReconciliationAction } from '../../src/actions/open-profile-reconciliation.action.ts';
import { reactivateCustomerProfileAction } from '../../src/actions/reactivate-customer-profile.action.ts';
import { recoverRetailPortalProfileBindingAction } from '../../src/actions/recover-retail-portal-profile-binding.action.ts';
import { resolveProfileReconciliationAction } from '../../src/actions/resolve-profile-reconciliation.action.ts';
import { revokeRetailPortalProfileBindingAction } from '../../src/actions/revoke-retail-portal-profile-binding.action.ts';
import { suspendCustomerProfileAction } from '../../src/actions/suspend-customer-profile.action.ts';
import { customerProfileReadRead } from '../../src/api/customer-profile-read.read.ts';
import { customerProfileTradingGateRead } from '../../src/api/customer-profile-trading-gate.read.ts';
import { guestAttributionStatusRead } from '../../src/api/guest-attribution-status.read.ts';
import { profileReconciliationReadRead } from '../../src/api/profile-reconciliation-read.read.ts';
import { retailAccessDecisionRead } from '../../src/api/retail-access-decision.read.ts';
import { retailPortalProfileBindingReadRead } from '../../src/api/retail-portal-profile-binding-read.read.ts';
import { retailPrincipalResolutionRead } from '../../src/api/retail-principal-resolution.read.ts';
import { ReactivateCustomerProfilePayloadSchema } from '../../shared/actions/reactivate-customer-profile.ts';
import { ProfileLifecycleActionRejected } from '../../shared/actions/suspend-customer-profile.ts';

import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { PartyRegistryGuestResolverFactory } from '../../src/integrations/party-registry-guest-resolver.ts';
import { PartyRegistryRetailPartyResolverFactory } from '../../src/integrations/party-registry-retail-party-resolver.ts';
import { ProfileReactivationEligibilityEvaluatorFactory } from '../../src/integrations/profile-reactivation-eligibility.ts';
import { ProfileCounterpartyRoleEligibilityResolverFactory } from '../../src/profile-counterparty-role-eligibility.ts';
import { ProfileReconciliationOwnerVerifier } from '../../src/profile-reconciliation-owner-verifier.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '30000000-0000-4000-8000-000000000003',
  authContextRef: 'better-auth-session:profile-wiring-unit',
  authMethod: 'session',
  principalId: '40000000-0000-4000-8000-000000000004',
  tenantId,
});
const revision = 'a'.repeat(64);
const unused = () => Effect.die('Factory construction must not contact an owner or evaluate eligibility');
const dependencies = Layer.mergeAll(
  NodeCrypto.layer,
  Layer.succeed(AccessPortalProjection, { project: unused }),
  Layer.succeed(PartyRegistryGuestResolverFactory, { make: () => unused }),
  Layer.succeed(PartyRegistryRetailPartyResolverFactory, { make: () => unused }),
  Layer.succeed(ProfileReactivationEligibilityEvaluatorFactory, { make: () => unused, observe: unused }),
  Layer.succeed(ProfileCounterpartyRoleEligibilityResolverFactory, { make: () => unused }),
  Layer.succeed(ProfileReconciliationOwnerVerifier, { verify: unused }),
);

const serviceKeys =
  <Services extends object, R>(
    factory: (
      transaction: ScopedTransactionExecutor,
      scope: OperationalScope,
      compositionRevision: string,
    ) => Effect.Effect<Services, OperationContextUnavailable, R>,
  ) =>
  (transaction: ScopedTransactionExecutor, scope: OperationalScope, compositionRevision: string) =>
    factory(transaction, scope, compositionRevision).pipe(Effect.map(Object.keys));

const factories = [
  ['archive', serviceKeys(getActionServiceFactory(archiveCustomerProfileAction)), ['transition']],
  ['attribute', serviceKeys(getActionServiceFactory(attributeGuestRetailCustomerAction)), ['attribute']],
  ['bind', serviceKeys(getActionServiceFactory(bindRetailPortalProfileAction)), ['bind']],
  ['create', serviceKeys(getActionServiceFactory(createCounterpartyPurchasingProfileAction)), ['create']],
  ['ensure', serviceKeys(getActionServiceFactory(ensureRetailCustomerProfileAction)), ['ensure']],
  ['open', serviceKeys(getActionServiceFactory(openProfileReconciliationAction)), ['open']],
  ['reactivate', serviceKeys(getActionServiceFactory(reactivateCustomerProfileAction)), ['transition']],
  ['recover', serviceKeys(getActionServiceFactory(recoverRetailPortalProfileBindingAction)), ['recover']],
  [
    'resolve',
    serviceKeys(getActionServiceFactory(resolveProfileReconciliationAction)),
    ['ownerReconciler', 'ownerVerifier'],
  ],
  ['revoke', serviceKeys(getActionServiceFactory(revokeRetailPortalProfileBindingAction)), ['revoke']],
  ['suspend', serviceKeys(getActionServiceFactory(suspendCustomerProfileAction)), ['transition']],
  ['profile', serviceKeys(getReadServiceFactory(customerProfileReadRead)), ['readProfile']],
  ['trading', serviceKeys(getReadServiceFactory(customerProfileTradingGateRead)), ['evaluateGate']],
  ['guest', serviceKeys(getReadServiceFactory(guestAttributionStatusRead)), ['readStatus']],
  ['reconciliation', serviceKeys(getReadServiceFactory(profileReconciliationReadRead)), ['readCase']],
  ['access', serviceKeys(getReadServiceFactory(retailAccessDecisionRead)), ['decideAccess']],
  ['binding', serviceKeys(getReadServiceFactory(retailPortalProfileBindingReadRead)), ['readBinding']],
  ['principal', serviceKeys(getReadServiceFactory(retailPrincipalResolutionRead)), ['resolvePrincipal']],
] as const;

/** One scripted native connection, real Core scoped transaction, and original registration factories. */
const withTransaction = <A, E, R>(
  scope: OperationalScope,
  use: (transaction: ScopedTransactionExecutor, trustedScope: OperationalScope) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* scopedFactory() {
      const statements: string[] = [];
      const connection = testSqlConnection((sql, params) =>
        Effect.sync(() => {
          statements.push(sql);
          if (sql.includes('select set_config')) {
            expect(params).toEqual([tenantId, scope.legalEntityId ?? '']);
            return [];
          }
          if (sql.includes('current_user::text as role')) {
            return [{ legal_entity_id: scope.legalEntityId ?? '', role: 'ontos_runtime', tenant_id: tenantId }];
          }
          expect(sql).toMatch(/^(?:BEGIN|COMMIT|ROLLBACK)/u);
          return [];
        }),
      );
      const database = yield* testCoreDatabase.pipe(
        Effect.provide(scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer))),
      );
      const value = yield* database.transaction((transaction) =>
        installOperationalScope(transaction, scope, defineDatabaseIdentityEnrollment([])).pipe(
          Effect.flatMap((scoped) => use(scoped, scope)),
        ),
      );
      expect(statements).toContain('COMMIT');
      return value;
    }),
  );

it.layer(dependencies)('Original Profile production service factories', (suite) => {
  for (const [name, factory, keys] of factories) {
    suite.effect(`${name} exposes its exact services on the supplied scoped transaction`, () =>
      withTransaction({ ...principal, correlationId: 'profile-wiring', legalEntityId }, (transaction, trustedScope) =>
        Effect.gen(function* originalFactory() {
          const actualKeys = yield* factory(transaction, trustedScope, revision);
          expect(EffectArray.sort(actualKeys, Order.String)).toEqual(EffectArray.sort(keys, Order.String));
        }),
      ),
    );
    suite.effect(`${name} refuses missing Selling Legal Entity before owner SQL`, () =>
      withTransaction({ ...principal, correlationId: 'profile-wiring' }, (transaction, trustedScope) =>
        Effect.gen(function* noCompany() {
          const acquisition: Effect.Effect<
            string[],
            OperationContextUnavailable,
            Layer.Success<typeof dependencies>
          > = factory(transaction, trustedScope, revision);
          const failure = yield* Effect.flip(acquisition);
          expect(Schema.is(OperationContextUnavailable)(failure)).toBe(true);
        }),
      ),
    );
  }
  suite.effect('keeps unprepared reactivation unavailable instead of invoking an owner transition', () =>
    withTransaction({ ...principal, correlationId: 'profile-wiring', legalEntityId }, (transaction, trustedScope) =>
      Effect.gen(function* unpreparedReactivation() {
        const { descriptor } = reactivateCustomerProfileAction;
        const services = yield* getActionServiceFactory(reactivateCustomerProfileAction)(
          transaction,
          trustedScope,
          revision,
        );
        const collector = createActionCollector(
          descriptor.domainEvents,
          descriptor.owningModuleKey,
          descriptor.accessEvidencePolicy,
          descriptor.auditEvidenceSchema,
          revision,
        );
        const payload = yield* Schema.decodeUnknownEffect(ReactivateCustomerProfilePayloadSchema)({
          effectiveAt: '2026-11-07T10:00:00.000Z',
          expectedRevision: 1,
          expectedState: 'SUSPENDED',
          profileRef: {
            kind: 'RETAIL',
            moduleId: 'commerce.customer-context',
            resourceId: '50000000-0000-4000-8000-000000000005',
            resourceType: 'commerce.customer-context.retail-customer-profile',
            tenantId,
          },
          reason: 'Unprepared fallback must never claim current eligibility',
        });
        const failure = yield* getActionHandler(reactivateCustomerProfileAction)(payload, {
          ...collector,
          actionInvocationId: '60000000-0000-4000-8000-000000000006',
          compositionRevision: revision,
          scope: trustedScope,
          services,
        }).pipe(Effect.flip);
        expect(Schema.is(ProfileLifecycleActionRejected)(failure)).toBe(true);
        expect(failure).toMatchObject({ code: 'OUTCOME_INDETERMINATE', retryable: true });
        expect(collector.snapshot().domainEvents).toEqual([]);
      }),
    ),
  );
});
