import { ContextAccess } from '@app/core-runtime';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { profileCounterpartyRoleEligibilityResolverFactoryLive } from '../../src/profile-counterparty-role-eligibility.ts';
import {
  profileReactivationEligibilityEvaluatorFactoryLive,
  profileReconfirmationPolicyUnavailableLive,
} from '../../src/integrations/profile-reactivation-eligibility.ts';
import { profileRetailPermissionReaderFactoryLive } from '../../src/integrations/retail-permission-reader.ts';
import { partyRegistryGuestResolverFactoryLive } from '../../src/integrations/party-registry-guest-resolver.ts';
import { partyRegistryRetailPartyResolverFactoryLive } from '../../src/integrations/party-registry-retail-party-resolver.ts';
import { readFile } from 'node:fs/promises';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { makeEnrollmentFailureTracer } from '../support/enrollment-current-access-receiver.fixture.ts';
import { mapCreateCounterpartyPurchasingProfileActionProblem } from '../../api/create-counterparty-purchasing-profile-action-problems.ts';
import { CreateCounterpartyPurchasingProfileActionUnavailableProblemSchema } from '../../shared/apis/create-counterparty-purchasing-profile-action.ts';
import { describe, expect, it } from 'effect-rstest';
import { Effect, Layer, Redacted, Schema, Tracer } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { archiveCustomerProfileAction } from '../../src/actions/archive-customer-profile.action.ts';
import { attributeGuestRetailCustomerAction } from '../../src/actions/attribute-guest-retail-customer.action.ts';
import { bindRetailPortalProfileAction } from '../../src/actions/bind-retail-portal-profile.action.ts';
import { createCounterpartyPurchasingProfileAction } from '../../src/actions/create-counterparty-purchasing-profile.action.ts';
import { ensureRetailCustomerProfileAction } from '../../src/actions/ensure-retail-customer-profile.action.ts';
import {
  EnsureRetailCustomerProfilePayloadSchema,
  EnsureRetailCustomerProfileRejected,
} from '../../shared/actions/ensure-retail-customer-profile.ts';
import {
  OpenProfileReconciliationPayloadSchema,
  openProfileReconciliationAction,
} from '../../src/actions/open-profile-reconciliation.action.ts';
import { reactivateCustomerProfileAction } from '../../src/actions/reactivate-customer-profile.action.ts';
import { recoverRetailPortalProfileBindingAction } from '../../src/actions/recover-retail-portal-profile-binding.action.ts';
import { resolveProfileReconciliationAction } from '../../src/actions/resolve-profile-reconciliation.action.ts';
import { revokeRetailPortalProfileBindingAction } from '../../src/actions/revoke-retail-portal-profile-binding.action.ts';
import { ProfileLifecycleActionRejected } from '../../shared/actions/suspend-customer-profile.ts';
import { suspendCustomerProfileAction } from '../../src/actions/suspend-customer-profile.action.ts';
import {
  ProfilePersistenceDependencyFailure,
  profilePersistenceServicesForTransaction,
} from '../../src/persistence/profile-persistence.ts';

const originalCompositionRevision = 'a'.repeat(64);
const tenantId = '10000000-0000-4000-8000-000000000001';
const actionRegistrations = [
  ensureRetailCustomerProfileAction,
  createCounterpartyPurchasingProfileAction,
  suspendCustomerProfileAction,
  reactivateCustomerProfileAction,
  archiveCustomerProfileAction,
  bindRetailPortalProfileAction,
  recoverRetailPortalProfileBindingAction,
  revokeRetailPortalProfileBindingAction,
  openProfileReconciliationAction,
  resolveProfileReconciliationAction,
  attributeGuestRetailCustomerAction,
] as const;

describe('customer profile Actions', () => {
  it('retains generated registration identity and fail-closed execution metadata', () => {
    expect(actionRegistrations.map(({ descriptor }) => descriptor.actionKey)).toHaveLength(11);
    for (const { descriptor } of actionRegistrations) {
      expect(descriptor.actionKey.startsWith('commerce.customer-context.')).toBe(true);
      expect(descriptor.idempotency).toBe('required');
      expect(descriptor.legalEntityScope).toBe('required');
      expect(descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
    }
  });

  it.effect('projects native Counterparty scope metadata before the strict Domain Event collector', () =>
    Effect.gen(function* projectsCounterpartyPublicResult() {
      const legalEntityId = '20000000-0000-4000-8000-000000000002';
      const principalId = '30000000-0000-4000-8000-000000000003';
      const nativeResult = {
        outcome: 'PROFILE_CREATED' as const,
        profileRef: {
          moduleId: 'commerce.customer-context' as const,
          resourceId: '40000000-0000-4000-8000-000000000004',
          resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
          tenantId,
        },
        revision: 1,
        scopeLegalEntityId: legalEntityId,
        state: 'ACTIVE' as const,
      };
      const registration = createCounterpartyPurchasingProfileAction.descriptor;
      const collector = createActionCollector(
        registration.domainEvents,
        'commerce.customer-context',
        registration.accessEvidencePolicy,
        registration.auditEvidenceSchema,
      );
      const services = profilePersistenceServicesForTransaction(
        { invoke: () => Effect.succeed([{ outcome: nativeResult.outcome, payload: nativeResult }]) },
        { legalEntityId, principalId, tenantId },
        {
          resolveCounterpartyRole: () =>
            Effect.succeed({
              managedLegalEntityId: legalEntityId,
              outcome: 'ELIGIBLE' as const,
              roleResourceId: '60000000-0000-4000-8000-000000000006',
              roleResourceRevision: '7',
            }),
        },
      ).createCounterpartyPurchasingProfile;
      const payload = Schema.decodeUnknownSync(registration.payloadSchema)({
        effectiveAt: '2026-09-09T10:00:00.000Z',
        subject: {
          counterpartyRef: {
            moduleId: 'party.registry',
            resourceId: '50000000-0000-4000-8000-000000000005',
            resourceType: 'party.registry.counterparty',
            tenantId,
          },
          kind: 'COUNTERPARTY',
        },
        trigger: 'AUTHORIZED_ONBOARDING',
      });
      const result = yield* services.create(payload, {
        actionInvocationId: '70000000-0000-4000-8000-000000000007',
        scope: { legalEntityId, tenantId },
      });
      const event = {
        eventType: 'commerce.customer-context.counterparty-purchasing-profile-created.v1' as const,
        producerModuleKey: 'commerce.customer-context',
        subjectModuleKey: 'commerce.customer-context',
        subjectResourceId: nativeResult.profileRef.resourceId,
        subjectResourceType: nativeResult.profileRef.resourceType,
      };
      // The native-only scope remains present internally, while the actual collector stays strict.
      const rawFailure = yield* collector.addDomainEvent({ ...event, payloadJson: nativeResult }).pipe(Effect.flip);
      expect(rawFailure.code).toBe('action_collector_invalid');
      expect(result).toEqual({
        outcome: nativeResult.outcome,
        profileRef: nativeResult.profileRef,
        revision: nativeResult.revision,
        state: nativeResult.state,
      });
      yield* collector.addDomainEvent({ ...event, payloadJson: result });
      expect(nativeResult.scopeLegalEntityId).toBe(legalEntityId);
      expect(collector.snapshot().domainEvents).toHaveLength(1);
    }),
  );

  it('accepts only an explicit tenant-consistent retail subject and create trigger', () => {
    const payload = Schema.decodeUnknownSync(EnsureRetailCustomerProfilePayloadSchema)({
      effectiveAt: '2026-09-09T10:00:00.000Z',
      subject: {
        kind: 'RETAIL',
        partyRef: {
          moduleId: 'party.registry',
          resourceId: 'party-1',
          resourceType: 'party.registry.party',
          tenantId,
        },
        sellingLegalEntityRef: {
          moduleId: 'core.identity',
          resourceId: 'seller-1',
          resourceType: 'core.identity.legal-entity',
          tenantId,
        },
      },
      trigger: 'ENSURE_BEFORE_ORDER_ACCEPTANCE',
    });
    expect(payload.subject.kind).toBe('RETAIL');
    expect(payload.trigger).toBe('ENSURE_BEFORE_ORDER_ACCEPTANCE');
  });

  it('exposes retryability explicitly on unavailable and indeterminate failures', () => {
    const failure = new EnsureRetailCustomerProfileRejected({
      code: 'PERSISTENCE_UNAVAILABLE',
      reason: 'owner store unavailable',
      retryable: true,
    });
    expect(Schema.is(EnsureRetailCustomerProfileRejected)(failure)).toBe(true);
    expect(failure.retryable).toBe(true);
  });

  it('requires explicit canonicalization authority and never derives a target from member order', () => {
    const profileRef = (resourceId: string) => ({
      kind: 'COUNTERPARTY' as const,
      moduleId: 'commerce.customer-context' as const,
      resourceId,
      resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
      tenantId,
    });
    const base = {
      canonicalizationEvidence: {
        decisionRef: 'operator-decision-1',
        evidenceKind: 'AUTHORIZED_OPERATOR_DECISION' as const,
        observedAt: '2026-09-09T09:59:00.000Z',
        policyVersion: 'profile-reconciliation-operator-v1',
      },
      detectedAt: '2026-09-09T10:00:00.000Z',
      evidenceRef: 'collision-evidence-1',
      profileRefs: [profileRef('profile-1'), profileRef('profile-2')],
      reason: 'Authorized import collision decision',
      targetSubject: {
        counterpartyRef: {
          moduleId: 'party.registry' as const,
          resourceId: 'counterparty-canonical',
          resourceType: 'party.registry.counterparty' as const,
          tenantId,
        },
        kind: 'COUNTERPARTY' as const,
      },
      trigger: 'IMPORT_CORRELATION' as const,
    };

    expect(Schema.is(OpenProfileReconciliationPayloadSchema)(base)).toBe(true);
    expect(Schema.is(OpenProfileReconciliationPayloadSchema)({ ...base, trigger: 'COUNTERPARTY_ALIAS' })).toBe(false);
  });

  it.effect('rejects a payload legal entity that differs from the trusted operational scope', () =>
    // @ts-expect-error -- This test supplies the exact action-local service double and exercises the pre-dependency rejection branch, so ambient production factories are intentionally absent.
    Effect.gen(function* rejectsMismatchedLegalEntity() {
      const payload = Schema.decodeUnknownSync(attributeGuestRetailCustomerAction.descriptor.payloadSchema)({
        correlationRoot: 'checkout-1',
        guestEvidenceRef: 'guest-evidence-1',
        requestedAt: '2026-09-09T10:00:00.000Z',
        sellingLegalEntityRef: {
          moduleId: 'core.identity',
          resourceId: '20000000-0000-4000-8000-000000000002',
          resourceType: 'core.identity.legal-entity',
          tenantId,
        },
      });
      const collector = createActionCollector(
        attributeGuestRetailCustomerAction.descriptor.domainEvents,
        'commerce.customer-context',
        attributeGuestRetailCustomerAction.descriptor.accessEvidencePolicy,
        attributeGuestRetailCustomerAction.descriptor.auditEvidenceSchema,
      );
      let dependencyCalled = false;
      const failure = yield* getActionHandler(attributeGuestRetailCustomerAction)(payload, {
        actionInvocationId: '30000000-0000-4000-8000-000000000003',
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        compositionRevision: originalCompositionRevision,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope: {
          authMethod: 'system',
          correlationId: 'profile-action-scope-test',
          legalEntityId: '20000000-0000-4000-8000-000000000001',
          principalId: '30000000-0000-4000-8000-000000000003',
          tenantId,
        },
        services: {
          attribute: () => {
            dependencyCalled = true;
            return Effect.succeed({ outcome: 'PARTY_UNRESOLVED' as const });
          },
        },
      }).pipe(Effect.flip);

      expect(failure.code).toBe('CURRENT_STATE_CONFLICT');
      expect(dependencyCalled).toBe(false);
      expect(collector.snapshot().domainEvents).toHaveLength(0);
      expect(collector.snapshot().outboxMessages).toHaveLength(0);
    }),
  );

  it.effect('records exact Party and profile access before publishing guest attribution', () =>
    // @ts-expect-error -- This action-contract test supplies its complete local service double directly; production factory requirements are intentionally outside this fixture.
    Effect.gen(function* recordsGuestAttributionEvidence() {
      const legalEntityId = '20000000-0000-4000-8000-000000000001';
      const payload = Schema.decodeUnknownSync(attributeGuestRetailCustomerAction.descriptor.payloadSchema)({
        correlationRoot: 'checkout-2',
        guestEvidenceRef: 'guest-evidence-2',
        requestedAt: '2026-09-09T10:00:00.000Z',
        sellingLegalEntityRef: {
          moduleId: 'core.identity',
          resourceId: legalEntityId,
          resourceType: 'core.identity.legal-entity',
          tenantId,
        },
      });
      const collector = createActionCollector(
        attributeGuestRetailCustomerAction.descriptor.domainEvents,
        'commerce.customer-context',
        attributeGuestRetailCustomerAction.descriptor.accessEvidencePolicy,
        attributeGuestRetailCustomerAction.descriptor.auditEvidenceSchema,
      );
      yield* getActionHandler(attributeGuestRetailCustomerAction)(payload, {
        actionInvocationId: '30000000-0000-4000-8000-000000000004',
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        compositionRevision: originalCompositionRevision,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope: {
          authMethod: 'system',
          correlationId: 'profile-action-evidence-test',
          legalEntityId,
          principalId: '30000000-0000-4000-8000-000000000004',
          tenantId,
        },
        services: {
          attribute: () =>
            Effect.succeed({
              outcome: 'ATTRIBUTED' as const,
              partyRef: {
                moduleId: 'party.registry' as const,
                resourceId: 'party-2',
                resourceType: 'party.registry.party' as const,
                tenantId,
              },
              profileRef: {
                moduleId: 'commerce.customer-context' as const,
                resourceId: 'retail-profile-2',
                resourceType: 'commerce.customer-context.retail-customer-profile' as const,
                tenantId,
              },
            }),
        },
      });

      const snapshot = collector.snapshot();
      expect(snapshot.dataAccessEvents).toHaveLength(2);
      expect(snapshot.dataAccessEvents.map(({ targetResourceType }) => targetResourceType)).toEqual([
        'party.registry.party',
        'commerce.customer-context.retail-customer-profile',
      ]);
      expect(snapshot.domainEvents).toHaveLength(1);
      expect(snapshot.outboxMessages).toHaveLength(1);
    }),
  );

  it.effect('retains native lifecycle discriminators and rejects untagged or inconsistent profile kinds', () =>
    Effect.gen(function* verifiesLifecycleWireContracts() {
      const legalEntityId = '20000000-0000-4000-8000-000000000002';
      const principalId = '30000000-0000-4000-8000-000000000003';
      const effectiveAt = '2026-09-09T10:00:00.000Z';
      const scope = { legalEntityId, principalId, tenantId };
      const context = {
        actionInvocationId: '70000000-0000-4000-8000-000000000007',
        scope: { legalEntityId, tenantId },
      };
      const transitions = [
        {
          outcome: 'PROFILE_SUSPENDED',
          previousState: 'ACTIVE',
          service: 'suspendCustomerProfile',
          state: 'SUSPENDED',
        },
        {
          outcome: 'PROFILE_ARCHIVED',
          previousState: 'SUSPENDED',
          service: 'archiveCustomerProfile',
          state: 'ARCHIVED',
        },
        {
          outcome: 'PROFILE_REACTIVATED',
          previousState: 'ARCHIVED',
          service: 'reactivateCustomerProfile',
          state: 'ACTIVE',
        },
      ] as const;
      const profiles = [
        { kind: 'RETAIL', resourceType: 'commerce.customer-context.retail-customer-profile' },
        { kind: 'COUNTERPARTY', resourceType: 'commerce.customer-context.counterparty-purchasing-profile' },
      ] as const;
      for (const profile of profiles) {
        const profileRef = {
          ...profile,
          moduleId: 'commerce.customer-context',
          resourceId: '40000000-0000-4000-8000-000000000004',
          tenantId,
        };
        for (const transition of transitions) {
          const nativeResult = {
            effectiveAt,
            outcome: transition.outcome,
            previousState: transition.previousState,
            profileRef,
            revision: 2,
            state: transition.state,
          };
          const { kind, ...untaggedRef } = profileRef;
          const wrongKind = kind === 'RETAIL' ? 'COUNTERPARTY' : 'RETAIL';
          const wireResults = [
            { accepted: true, payload: nativeResult },
            { accepted: false, payload: { ...nativeResult, profileRef: untaggedRef } },
            { accepted: false, payload: { ...nativeResult, profileRef: { ...profileRef, kind: wrongKind } } },
          ];
          for (const wire of wireResults) {
            const services = profilePersistenceServicesForTransaction(
              { invoke: () => Effect.succeed([{ outcome: nativeResult.outcome, payload: wire.payload }]) },
              scope,
              {
                evaluateReactivation: () =>
                  Effect.succeed({ dependenciesSatisfied: true, reconfirmationSatisfied: true }),
              },
            );
            const payload = Schema.decodeUnknownSync(suspendCustomerProfileAction.descriptor.payloadSchema)({
              effectiveAt,
              expectedRevision: 1,
              expectedState: transition.previousState,
              profileRef,
              reason: 'Lifecycle wire result contract',
            });
            const result = services[transition.service].transition(payload, context);
            if (wire.accepted) {
              expect(yield* result).toEqual(nativeResult);
            } else {
              const failure = yield* result.pipe(Effect.flip);
              expect(yield* Schema.decodeUnknownEffect(ProfileLifecycleActionRejected)(failure)).toMatchObject({
                code: 'OUTCOME_INDETERMINATE',
                retryable: false,
              });
            }
          }
        }
      }
    }),
  );
});

// Execute the exact existing API-root observation layer without initializing its DB/service graph.
const actualObservationLayer = Effect.gen(function* readActualObservationLayer() {
  const source = yield* Effect.tryPromise(() => readFile(new URL('../../api/index.ts', import.meta.url), 'utf-8'));
  const start = source.indexOf('const runtimeObservabilityLive =');
  const end = source.indexOf('const tenantModuleStateServiceLive', start);
  const moduleSource = `import { Layer, Logger, References, Tracer } from ${JSON.stringify(pathToFileURL(createRequire(new URL('../../package.json', import.meta.url)).resolve('effect')).href)};\n${source.slice(start, end)}\nexport default runtimeObservabilityLive;`;
  const loaded: { readonly default: Layer.Layer<Tracer.Tracer> } = yield* Effect.promise(
    async () => await import(`data:text/javascript,${encodeURIComponent(moduleSource)}`),
  );
  return loaded.default;
});

it.effect('the actual API observation layer retains a supplied tracer and has a native default', () =>
  Effect.gen(function* observationLayerInheritance() {
    const layer = yield* actualObservationLayer;
    const supplied = makeEnrollmentFailureTracer([], () => {});
    expect(yield* Tracer.Tracer.pipe(Effect.provide(layer), Effect.provideService(Tracer.Tracer, supplied))).toBe(
      supplied,
    );
    const fallback = yield* Tracer.Tracer.pipe(Effect.provide(layer));
    expect(fallback).toBe(Tracer.nativeTracer);
  }),
);

const unusedPermission = () => Effect.die(new Error('Unused Retail permission dependency'));

it.live('observes the original profile handler cause before mapping while public HTTP stays safe', () =>
  Effect.gen(function* observeRealProfileFailure() {
    const legalEntityId = '20000000-0000-4000-8000-000000000002';
    const principalId = '30000000-0000-4000-8000-000000000003';
    const secret = 'unit-private-profile-api-key';
    const jwt = `eyJ${'a'.repeat(20_000)}.unit-payload.unit-signature`;
    const original = new Error(`actual unknown owner failure ${secret} ${jwt}`);
    const dependency = Object.defineProperty(
      new ProfilePersistenceDependencyFailure({ reason: 'Original typed dependency stage' }),
      'cause',
      { value: original },
    );
    const registration = createCounterpartyPurchasingProfileAction.descriptor;
    const payload = Schema.decodeUnknownSync(registration.payloadSchema)({
      effectiveAt: '2026-09-09T10:00:00.000Z',
      subject: {
        counterpartyRef: {
          moduleId: 'party.registry',
          resourceId: '50000000-0000-4000-8000-000000000005',
          resourceType: 'party.registry.counterparty',
          tenantId,
        },
        kind: 'COUNTERPARTY',
      },
      trigger: 'AUTHORIZED_ONBOARDING',
    });
    const services = profilePersistenceServicesForTransaction(
      { invoke: () => Effect.die('No persistence allowed after dependency failure') },
      { legalEntityId, principalId, tenantId },
      { resolveCounterpartyRole: () => Effect.fail(dependency) },
    ).createCounterpartyPurchasingProfile;
    const collector = createActionCollector(
      registration.domainEvents,
      'commerce.customer-context',
      registration.accessEvidencePolicy,
      registration.auditEvidenceSchema,
    );
    const handler = getActionHandler(createCounterpartyPurchasingProfileAction)(payload, {
      actionInvocationId: '70000000-0000-4000-8000-000000000007',
      addDomainEvent: collector.addDomainEvent,
      addOutboxMessage: collector.addOutboxMessage,
      compositionRevision: originalCompositionRevision,
      recordAuditEvidence: collector.recordAuditEvidence,
      recordDataAccess: collector.recordDataAccess,
      scope: { authMethod: 'system', correlationId: 'unit-profile-failure', legalEntityId, principalId, tenantId },
      services,
    }).pipe(
      Effect.flatMap((value) =>
        Schema.is(registration.resultSchema)(value)
          ? Effect.succeed(value)
          : Effect.die(new Error('Unexpected profile success outcome')),
      ),
      Effect.mapError(mapCreateCounterpartyPurchasingProfileActionProblem),
      Effect.mapError(Schema.decodeUnknownSync(CreateCounterpartyPurchasingProfileActionUnavailableProblemSchema)),
      Effect.provide(
        Layer.mergeAll(
          profileCounterpartyRoleEligibilityResolverFactoryLive,
          profileReactivationEligibilityEvaluatorFactoryLive.pipe(
            Layer.provide(profileReconfirmationPolicyUnavailableLive),
          ),
          profileRetailPermissionReaderFactoryLive.pipe(
            Layer.provide(
              Layer.succeed(ContextAccess, {
                assortmentPermissions: unusedPermission,
                businessPermissions: unusedPermission,
                contextPermissions: unusedPermission,
                identityNamespaces: unusedPermission,
                legalEntities: unusedPermission,
                modules: unusedPermission,
                resources: unusedPermission,
                tenantResources: unusedPermission,
                tenants: unusedPermission,
              }),
            ),
          ),
          partyRegistryGuestResolverFactoryLive,
          partyRegistryRetailPartyResolverFactoryLive,
        ),
      ),
    );
    const api = HttpApi.make('ProfileFailureObservation').add(
      HttpApiGroup.make('profile').add(
        HttpApiEndpoint.get('create', '/profile', {
          error: CreateCounterpartyPurchasingProfileActionUnavailableProblemSchema,
          success: registration.resultSchema,
        }),
      ),
    );
    const layer = yield* actualObservationLayer;
    const diagnostics: string[] = [];
    const tracer = makeEnrollmentFailureTracer([Redacted.make(secret)], (text) => {
      diagnostics.push(text);
    });
    const handlers = HttpApiBuilder.group(api, 'profile', (group) => group.handle('create', () => handler)).pipe(
      Layer.provide(layer),
    );
    const runtime = assembleEffectBffRuntime({
      api,
      handlers: handlers.pipe(Layer.provide(Layer.succeed(Tracer.Tracer, tracer))),
    });
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => runtime.createHandler()),
      (value) => Effect.promise(() => value.dispose()),
    );
    const response = yield* Effect.promise(() => server.handler(new Request('https://unit.invalid/profile')));
    const problem: unknown = yield* Effect.promise(() => response.json());
    expect(response.status).toBe(503);
    expect(problem).toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      detail: 'The Action capability is temporarily unavailable.',
    });
    expect(JSON.stringify(problem)).not.toContain('cause');
    expect(JSON.stringify(problem)).not.toContain('Original typed');
    const diagnostic = diagnostics.join('');
    expect(diagnostic).toContain('Original typed dependency stage');
    expect(diagnostic).toContain('actual unknown owner failure');
    expect(diagnostic).toContain('Error:');
    expect(diagnostic).toContain('at ');
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain(jwt);
    expect(diagnostic).not.toContain('unit-signature');
    expect(diagnostic.length).toBeLessThanOrEqual(16_385);
    expect(collector.snapshot().domainEvents).toHaveLength(0);
  }).pipe(Effect.scoped),
);
