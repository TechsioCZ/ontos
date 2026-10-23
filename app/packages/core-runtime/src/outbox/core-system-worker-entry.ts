import { Effect } from 'effect';

import { ActionAuthorizationLifecycleError } from '../permissions/action-authorization-lifecycle-error.ts';
import { ActionAuthorizationLifecycle } from '../permissions/action-authorization-lifecycle.ts';
import { OutboxPayloadSchema } from './core-modules-tenant-module-state-changed-v1.ts';
import { OutboxPayloadSchema as PrincipalLifecyclePayloadSchema } from './core-identity-principal-lifecycle-changed-v1.ts';
import { OutboxPayloadSchema as PrincipalBindingPayloadSchema } from './core-identity-principal-binding-activated-v1.ts';
import {
  OutboxPayloadSchema as ScopedRolePayloadSchema,
  scopedRoleIdentity,
} from './core-identity-scoped-role-membership-changed-v1.ts';
import {
  coreModuleInstallationSubscription,
  corePrincipalLifecycleSubscription,
  corePrincipalBindingSubscription,
  coreScopedRoleMembershipSubscription,
} from './core-system-subscriptions.ts';
import { defineOutboxWorker } from './definition.ts';
import { isVerifiedOutboxWorkerHandlerContext } from './verified-handler-context.ts';

export { ActionAuthorizationLifecycleLive } from '../permissions/action-authorization-lifecycle.ts';
export { ScopedRoleMembershipLifecycleLive } from '../permissions/scoped-role-membership-lifecycle.ts';
export { SpiceDbConfigError } from '../permissions/config-error.ts';
export { SpiceDbConfigLive } from '../permissions/config.ts';
export { CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS } from './core-system-subscriptions.ts';
export { OutboxRuntimeLive } from './runtime.ts';

const installationWorker = defineOutboxWorker(
  {
    ...coreModuleInstallationSubscription,
    leaseDurationMs: 60_000,
    legalEntityScope: 'forbidden',
    payloadSchema: OutboxPayloadSchema,
    retryPolicy: { initialBackoffMs: 1000, maxAttempts: 20, maxBackoffMs: 60_000, multiplier: 2 },
  },
  Effect.fn('CoreSystemWorker.reconcileCommittedInstallation')(
    function* reconcileCommittedInstallation(_payload, context) {
      if (!isVerifiedOutboxWorkerHandlerContext(context)) {
        return yield* new ActionAuthorizationLifecycleError({
          reason: 'Core lifecycle work requires an attested Outbox claim',
        });
      }
      const lifecycle = yield* ActionAuthorizationLifecycle;
      return yield* lifecycle.reconcileTenant(context.tenantId, context.compositionRevision);
    },
  ),
);

const principalLifecycleWorker = defineOutboxWorker(
  {
    ...corePrincipalLifecycleSubscription,
    leaseDurationMs: 60_000,
    legalEntityScope: 'forbidden',
    payloadSchema: PrincipalLifecyclePayloadSchema,
    retryPolicy: { initialBackoffMs: 1000, maxAttempts: 20, maxBackoffMs: 60_000, multiplier: 2 },
  },
  Effect.fn('CoreSystemWorker.reconcileCommittedPrincipal')(function* reconcileCommittedPrincipal(payload, context) {
    if (!isVerifiedOutboxWorkerHandlerContext(context)) {
      return yield* new ActionAuthorizationLifecycleError({
        reason: 'Principal lifecycle work requires an attested Outbox claim',
      });
    }
    const lifecycle = yield* ActionAuthorizationLifecycle;
    return yield* lifecycle.reconcilePrincipal(context.tenantId, payload.data.principalId, context.compositionRevision);
  }),
);

const principalBindingWorker = defineOutboxWorker(
  {
    ...corePrincipalBindingSubscription,
    leaseDurationMs: 60_000,
    legalEntityScope: 'forbidden',
    payloadSchema: PrincipalBindingPayloadSchema,
    retryPolicy: { initialBackoffMs: 1000, maxAttempts: 20, maxBackoffMs: 60_000, multiplier: 2 },
  },
  Effect.fn('CoreSystemWorker.reconcileActivatedPrincipalBinding')(
    function* reconcileActivatedPrincipalBinding(payload, context) {
      if (!isVerifiedOutboxWorkerHandlerContext(context) || payload.data.tenantId !== context.tenantId) {
        return yield* new ActionAuthorizationLifecycleError({
          reason: 'Binding lifecycle work requires exact attested tenant scope',
        });
      }
      const lifecycle = yield* ActionAuthorizationLifecycle;
      return yield* lifecycle.reconcilePrincipal(
        context.tenantId,
        payload.data.principalId,
        context.compositionRevision,
      );
    },
  ),
);

const scopedRoleMembershipWorker = defineOutboxWorker(
  {
    ...coreScopedRoleMembershipSubscription,
    leaseDurationMs: 60_000,
    legalEntityScope: 'forbidden',
    payloadSchema: ScopedRolePayloadSchema,
    retryPolicy: { initialBackoffMs: 1000, maxAttempts: 20, maxBackoffMs: 60_000, multiplier: 2 },
  },
  Effect.fn('CoreSystemWorker.reconcileScopedRoleMembership')(
    function* reconcileScopedRoleMembership(payload, context) {
      if (!isVerifiedOutboxWorkerHandlerContext(context)) {
        return yield* new ActionAuthorizationLifecycleError({
          reason: 'Scoped role membership work requires an attested Outbox claim',
        });
      }
      const lifecycle = yield* ActionAuthorizationLifecycle;
      return yield* lifecycle.reconcileScopedRoleMembership(
        scopedRoleIdentity({ ...payload.data, tenantId: context.tenantId }),
        payload.data.principalId,
        context.compositionRevision,
      );
    },
  ),
);

/** The application root supplies persistence, composition authority and process-local resources. */
export const coreSystemOutboxWorkers = Object.freeze([
  installationWorker,
  principalBindingWorker,
  principalLifecycleWorker,
  scopedRoleMembershipWorker,
] as const);
