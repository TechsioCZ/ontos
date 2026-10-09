import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  ChangeExternalIdentityStatusInput,
  ExternalIdentityAdmissionContext,
  ExternalIdentityRepositoryService,
} from '../../src/auth/external-identity/repository.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { trustResolvedSystemPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import {
  ActivatePrincipalBindingResultSchema,
  ChangePrincipalBindingStatusResultSchema,
  ReadPrincipalBindingResultSchema,
  ReservePrincipalBindingResultSchema,
} from '../../src/auth/external-identity-contracts.ts';
import { activatePrincipalBindingAction } from '../../src/modules/actions/activate-principal-binding.action.ts';
import { changePrincipalBindingStatusAction } from '../../src/modules/actions/change-principal-binding-status.action.ts';
import { reservePrincipalBindingAction } from '../../src/modules/actions/reserve-principal-binding.action.ts';
import { bindActionTestServices, makeActionTestHarness } from '../../src/testing/actions.ts';

const tenantId = '30000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const authBindingId = '10000000-0000-4000-8000-000000000001';
const activationTransitionRef = '60000000-0000-4000-8000-000000000001';
const namespaceId = 'test.third-provider.realm';
const subject = {
  authenticationNamespaceId: namespaceId,
  providerSubjectId: 'provider-user-1',
  subjectType: 'user' as const,
};
const principal = trustResolvedSystemPrincipalContext(
  Schema.decodeSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:external-identity:run:lifecycle',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
);

const noAdmission = Option.none<ExternalIdentityAdmissionContext>();

it.effect('runs the neutral reservation Action and emits only a generated lifecycle event', () =>
  Effect.gen(function* reserveActionProgram() {
    const prepare: ExternalIdentityRepositoryService['prepare'] = (input) =>
      Effect.sync(() => {
        expect(input.subject).toEqual(subject);
        expect(input.displayName).toBe('Reserved display name');
        return {
          authBindingId,
          bindingRevision: 1,
          bindingStatus: 'pending' as const,
          outcome: 'RESERVED' as const,
          principalId,
        };
      });
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      services: [bindActionTestServices(reservePrincipalBindingAction, { admission: noAdmission, prepare })],
    });

    const result = yield* harness.runtime.runAction({
      payload: { ...subject, displayName: 'Reserved display name' },
      principal,
      registration: reservePrincipalBindingAction,
      transport: { correlationId: 'external-identity-reserve', idempotencyKey: 'reserve-1' },
    });

    expect(yield* Schema.decodeEffect(ReservePrincipalBindingResultSchema)(result)).toEqual({
      authBindingId,
      bindingRevision: 1,
      bindingStatus: 'pending',
      outcome: 'RESERVED',
      principalId,
    });
    const [committed] = harness.snapshot().committed;
    expect(committed?.evidence.domainEvents).toHaveLength(1);
    expect(committed?.evidence.outboxMessages).toHaveLength(1);
    expect(committed?.evidence.auditEvidence['operation']).toBe('reserve');
  }),
);

it.effect('returns an existing reservation without fabricating another lifecycle transition', () =>
  Effect.gen(function* existingReservationProgram() {
    const prepare: ExternalIdentityRepositoryService['prepare'] = () =>
      Effect.succeed({
        authBindingId,
        bindingRevision: 3,
        bindingStatus: 'disabled',
        outcome: 'EXISTING',
        principalId,
      });
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      services: [bindActionTestServices(reservePrincipalBindingAction, { admission: noAdmission, prepare })],
    });

    const result = yield* harness.runtime.runAction({
      payload: subject,
      principal,
      registration: reservePrincipalBindingAction,
      transport: { correlationId: 'external-identity-existing', idempotencyKey: 'reserve-existing' },
    });

    expect(yield* Schema.decodeEffect(ReservePrincipalBindingResultSchema)(result)).toEqual({
      authBindingId,
      bindingRevision: 3,
      bindingStatus: 'disabled',
      outcome: 'EXISTING',
      principalId,
    });
    const [committed] = harness.snapshot().committed;
    expect(committed?.evidence.domainEvents).toHaveLength(0);
    expect(committed?.evidence.outboxMessages).toHaveLength(0);
  }),
);

it.effect('activates a pending binding through the neutral Action and publishes revision two', () =>
  Effect.gen(function* activateActionProgram() {
    const activate: ExternalIdentityRepositoryService['activate'] = () =>
      Effect.succeed({
        authBindingId,
        authenticationNamespaceId: namespaceId,
        bindingRevision: 2,
        bindingStatus: 'active',
        changed: true,
        outcome: 'ACTIVATED',
        principalId,
        tenantId,
        transitionRef: activationTransitionRef,
      });
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      services: [bindActionTestServices(activatePrincipalBindingAction, { activate, admission: noAdmission })],
    });

    const result = yield* harness.runtime.runAction({
      payload: { authBindingId, expectedRevision: 1 },
      principal,
      registration: activatePrincipalBindingAction,
      transport: { correlationId: 'external-identity-activate', idempotencyKey: 'activate-1' },
    });

    expect(yield* Schema.decodeEffect(ActivatePrincipalBindingResultSchema)(result)).toEqual({
      authBindingId,
      bindingRevision: 2,
      bindingStatus: 'active',
      outcome: 'ACTIVATED',
      principalId,
    });
    const [committed] = harness.snapshot().committed;
    expect(committed?.evidence.domainEvents).toHaveLength(1);
    expect(committed?.evidence.outboxMessages).toHaveLength(1);
  }),
);

it.effect('treats repeat activation of the current binding as an event-free no-op', () =>
  Effect.gen(function* repeatActivationProgram() {
    const activate: ExternalIdentityRepositoryService['activate'] = () =>
      Effect.succeed({
        authBindingId,
        authenticationNamespaceId: namespaceId,
        bindingRevision: 2,
        bindingStatus: 'active',
        changed: false,
        outcome: 'ACTIVATED',
        principalId,
        tenantId,
        transitionRef: activationTransitionRef,
      });
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      services: [bindActionTestServices(activatePrincipalBindingAction, { activate, admission: noAdmission })],
    });

    const result = yield* harness.runtime.runAction({
      payload: { authBindingId, expectedRevision: 2 },
      principal,
      registration: activatePrincipalBindingAction,
      transport: { correlationId: 'external-identity-activate-repeat', idempotencyKey: 'activate-repeat-1' },
    });

    expect(yield* Schema.decodeEffect(ActivatePrincipalBindingResultSchema)(result)).toEqual({
      authBindingId,
      bindingRevision: 2,
      bindingStatus: 'active',
      outcome: 'ACTIVATED',
      principalId,
    });
    const [committed] = harness.snapshot().committed;
    expect(committed?.evidence.domainEvents).toHaveLength(0);
    expect(committed?.evidence.outboxMessages).toHaveLength(0);
    expect(committed?.evidence.auditEvidence['previousStatus']).toBe('active');
    expect(committed?.evidence.auditEvidence['transitionRef']).toBe(activationTransitionRef);
  }),
);

it('round-trips populated and legacy-absent read provenance through the strict public schema', () => {
  const found = {
    authBindingId,
    authenticationNamespaceId: namespaceId,
    bindingRevision: 2,
    bindingStatus: 'active' as const,
    originalInvocationId: activationTransitionRef,
    outcome: 'FOUND' as const,
    principalId,
    principalStatus: 'active' as const,
    tenantStatus: 'active' as const,
  };
  expect(Schema.decodeSync(ReadPrincipalBindingResultSchema)(found)).toEqual({
    ...found,
    originalInvocationId: Option.some(activationTransitionRef),
  });
  expect(Schema.decodeSync(ReadPrincipalBindingResultSchema)({ ...found, originalInvocationId: null })).toEqual({
    ...found,
    originalInvocationId: Option.none(),
  });
});

it.effect('keeps an administrative same-state status no-op stable and event-free', () =>
  Effect.gen(function* statusActionProgram() {
    const statusResults: ChangeExternalIdentityStatusInput[] = [];
    const changeStatus: ExternalIdentityRepositoryService['changeStatus'] = (input) =>
      Effect.sync(() => {
        statusResults.push(input);
        return statusResults.length === 1
          ? {
              authBindingId,
              authenticationNamespaceId: namespaceId,
              bindingRevision: 2,
              bindingStatus: 'disabled' as const,
              previousStatus: 'active' as const,
              principalId,
              tenantId,
              transitionRef: activationTransitionRef,
            }
          : {
              authBindingId,
              authenticationNamespaceId: namespaceId,
              bindingRevision: 2,
              bindingStatus: 'disabled' as const,
              previousStatus: 'disabled' as const,
              principalId,
              tenantId,
              transitionRef: activationTransitionRef,
            };
      });
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      services: [bindActionTestServices(changePrincipalBindingStatusAction, { admission: noAdmission, changeStatus })],
      tenantPermission: 'allowed',
    });

    const first = yield* harness.runtime.runAction({
      payload: { authBindingId, expectedRevision: 1, reason: 'administrative disable', requestedStatus: 'disabled' },
      principal,
      registration: changePrincipalBindingStatusAction,
      transport: { correlationId: 'external-identity-status-1', idempotencyKey: 'status-1' },
    });
    const second = yield* harness.runtime.runAction({
      payload: { authBindingId, expectedRevision: 2, reason: 'repeat current state', requestedStatus: 'disabled' },
      principal,
      registration: changePrincipalBindingStatusAction,
      transport: { correlationId: 'external-identity-status-2', idempotencyKey: 'status-2' },
    });

    expect((yield* Schema.decodeEffect(ChangePrincipalBindingStatusResultSchema)(first)).transitionRef).toBe(
      activationTransitionRef,
    );
    expect((yield* Schema.decodeEffect(ChangePrincipalBindingStatusResultSchema)(second)).transitionRef).toBe(
      activationTransitionRef,
    );
    const { committed } = harness.snapshot();
    expect(committed).toHaveLength(2);
    expect(committed[0]?.evidence.domainEvents).toHaveLength(1);
    expect(committed[0]?.evidence.outboxMessages).toHaveLength(1);
    expect(committed[1]?.evidence.domainEvents).toHaveLength(0);
    expect(committed[1]?.evidence.outboxMessages).toHaveLength(0);
    expect(statusResults).toHaveLength(2);
  }),
);
