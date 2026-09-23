import { describe, expect, it } from 'effect-rstest';
import { Effect, Predicate, Schema } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import {
  RegisterStorefrontApplicationPayloadSchema,
  registerStorefrontApplicationAction,
} from '../../src/actions/register-storefront-application.action.ts';
import {
  ReviseStorefrontApplicationPayloadSchema,
  reviseStorefrontApplicationAction,
} from '../../src/actions/revise-storefront-application.action.ts';
import type { StorefrontAdministrationService } from '../../src/services/storefront-administration.service.ts';
import { StorefrontApplicationRefSchema } from '../../shared/resources/storefront-application.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const applicationId = '33333333-3333-4333-8333-333333333333';
const actionInvocationId = '44444444-4444-4444-8444-444444444444';
const scope = {
  authMethod: 'system' as const,
  correlationId: 'storefront-administration-actions',
  principalId,
  tenantId,
};
const applicationRef = Schema.decodeSync(StorefrontApplicationRefSchema)({
  moduleId: 'commerce.storefront-registry',
  resourceId: applicationId,
  resourceType: 'commerce.storefront-registry.storefront-application',
  tenantId,
});
const registerPayload = Schema.decodeSync(RegisterStorefrontApplicationPayloadSchema)({
  allowedChannels: ['B2C', 'B2B'],
  effectiveInterval: { effectiveFrom: '2026-09-22T10:00:00.000Z' },
  lifecycle: 'ACTIVE',
  reason: 'Approve the Czech Storefront application.',
  storefrontAppId: 'shop-cz',
});
const revisePayload = Schema.decodeSync(ReviseStorefrontApplicationPayloadSchema)({
  allowedChannels: ['B2B'],
  effectiveInterval: { effectiveFrom: '2026-10-01T00:00:00.000Z' },
  expectedRevision: 1,
  lifecycle: 'SUSPENDED',
  reason: 'Suspend while the B2C channel is reconfigured.',
  storefrontApplicationRef: applicationRef,
});
const unexpected = () => Effect.die('unexpected Storefront administration service call');
const unavailableServices: StorefrontAdministrationService = { register: unexpected, revise: unexpected };

const collectRegister = (changed: boolean) =>
  Effect.gen(function* collectRegisterEvidence() {
    const collector = createActionCollector(
      registerStorefrontApplicationAction.descriptor.domainEvents,
      'commerce.storefront-registry',
      registerStorefrontApplicationAction.descriptor.accessEvidencePolicy,
      registerStorefrontApplicationAction.descriptor.auditEvidenceSchema,
    );
    const result = yield* getActionHandler(registerStorefrontApplicationAction)(registerPayload, {
      actionInvocationId,
      addDomainEvent: collector.addDomainEvent,
      addOutboxMessage: collector.addOutboxMessage,
      recordAuditEvidence: collector.recordAuditEvidence,
      recordDataAccess: collector.recordDataAccess,
      scope,
      services: {
        ...unavailableServices,
        register: () =>
          changed
            ? Effect.succeed({
                _tag: 'created' as const,
                changed: true as const,
                generation: 1,
                revision: 1 as const,
                storefrontApplicationId: applicationRef.resourceId,
              })
            : Effect.succeed({
                _tag: 'reused' as const,
                changed: false as const,
                generation: 1,
                revision: 1 as const,
                storefrontApplicationId: applicationRef.resourceId,
              }),
      },
    });
    return { evidence: collector.snapshot(), result };
  });

describe('Storefront Registry administration Actions', () => {
  it('keeps both mutations on idempotent governed write boundaries', () => {
    for (const action of [registerStorefrontApplicationAction, reviseStorefrontApplicationAction]) {
      expect(action.descriptor.entrypoint).toMatchObject({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'explicit' },
        moduleKey: 'commerce.storefront-registry',
        role: 'action',
        scope: 'tenant',
      });
      expect(action.descriptor.idempotency).toBe('required');
      expect(action.descriptor.legalEntityScope).toBe('optional');
    }
  });

  it('rejects duplicate channels, invalid intervals, and direct terminal registration', () => {
    expect(() =>
      Schema.decodeSync(RegisterStorefrontApplicationPayloadSchema)({
        ...registerPayload,
        allowedChannels: ['B2C', 'B2C'],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(RegisterStorefrontApplicationPayloadSchema)({
        ...registerPayload,
        effectiveInterval: {
          effectiveFrom: '2026-10-01T00:00:00.000Z',
          effectiveTo: '2026-09-01T00:00:00.000Z',
        },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(RegisterStorefrontApplicationPayloadSchema)({
        ...registerPayload,
        lifecycle: 'RETIRED',
      }),
    ).toThrow();
  });

  it.effect('records audit, access, domain, and outbox evidence once while idempotent replay stays quiet', () =>
    Effect.gen(function* recordAdministrationEvidence() {
      const created = yield* collectRegister(true);
      expect(created.result).toMatchObject({ created: true, generation: 1, revision: 1 });
      expect(created.evidence.auditEvidence).toMatchObject({ changed: true, operation: 'REGISTER', revision: 1 });
      expect(created.evidence.dataAccessEvents).toHaveLength(1);
      expect(created.evidence.domainEvents).toHaveLength(1);
      expect(created.evidence.outboxMessages).toHaveLength(1);

      const replay = yield* collectRegister(false);
      expect(replay.result).toMatchObject({ created: false });
      expect(replay.evidence.auditEvidence).toMatchObject({ changed: false });
      expect(replay.evidence.domainEvents).toHaveLength(0);
      expect(replay.evidence.outboxMessages).toHaveLength(0);
    }),
  );

  it.effect('requires the observed revision and publishes a lifecycle revision only after optimistic success', () =>
    Effect.gen(function* reviseWithOptimisticConcurrency() {
      const conflictCollector = createActionCollector(
        reviseStorefrontApplicationAction.descriptor.domainEvents,
        'commerce.storefront-registry',
        reviseStorefrontApplicationAction.descriptor.accessEvidencePolicy,
        reviseStorefrontApplicationAction.descriptor.auditEvidenceSchema,
      );
      const conflict = yield* getActionHandler(reviseStorefrontApplicationAction)(revisePayload, {
        actionInvocationId,
        addDomainEvent: conflictCollector.addDomainEvent,
        addOutboxMessage: conflictCollector.addOutboxMessage,
        recordAuditEvidence: conflictCollector.recordAuditEvidence,
        recordDataAccess: conflictCollector.recordDataAccess,
        scope,
        services: {
          ...unavailableServices,
          revise: () => Effect.succeed({ _tag: 'revision_conflict', actualRevision: 2 }),
        },
      }).pipe(Effect.flip);
      expect(Predicate.isTagged(conflict, 'StorefrontApplicationCommandRejected')).toBe(true);
      expect(conflict).toMatchObject({ code: 'revision_conflict' });
      expect(conflictCollector.snapshot().domainEvents).toHaveLength(0);

      const successCollector = createActionCollector(
        reviseStorefrontApplicationAction.descriptor.domainEvents,
        'commerce.storefront-registry',
        reviseStorefrontApplicationAction.descriptor.accessEvidencePolicy,
        reviseStorefrontApplicationAction.descriptor.auditEvidenceSchema,
      );
      const revised = yield* getActionHandler(reviseStorefrontApplicationAction)(revisePayload, {
        actionInvocationId,
        addDomainEvent: successCollector.addDomainEvent,
        addOutboxMessage: successCollector.addOutboxMessage,
        recordAuditEvidence: successCollector.recordAuditEvidence,
        recordDataAccess: successCollector.recordDataAccess,
        scope,
        services: {
          ...unavailableServices,
          revise: () =>
            Effect.succeed({
              _tag: 'revised',
              changed: true,
              generation: 2,
              previousRevision: 1,
              revision: 2,
              storefrontApplicationId: applicationRef.resourceId,
            }),
        },
      });
      expect(revised).toMatchObject({ changed: true, previousRevision: 1, revision: 2 });
      expect(successCollector.snapshot().auditEvidence).toMatchObject({ operation: 'REVISE', revision: 2 });
      expect(successCollector.snapshot().domainEvents).toHaveLength(1);
      expect(successCollector.snapshot().outboxMessages).toHaveLength(1);
    }),
  );
});
