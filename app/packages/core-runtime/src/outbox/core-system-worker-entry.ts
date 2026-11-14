import { withOptional } from '../access/decision/optional.ts';
import { Clock, Context, Duration, Effect, Result, Schema } from 'effect';

import type { TenantProjectionWrite } from '../access/intent/projection-writer.ts';
import type { OperationalScope } from '../operations/context.ts';

import { projectPeopleLifecycleSearch, rebuildPeopleSearch } from '../people/people-search-workers.ts';
import { ActionAuthorizationLifecycle } from '../permissions/action-authorization-lifecycle.ts';
import { ActionAuthorizationLifecycleError } from '../permissions/action-authorization-lifecycle-error.ts';
import { TenantProjectionBusyError } from '../permissions/tenant-projection-busy-error.ts';
import { outboxWorkerTenantScope } from './core-authorization-projection.ts';
import { OutboxPayloadSchema as PrincipalBindingPayloadSchema } from './core-identity-principal-binding-activated-v1.ts';
import { OutboxPayloadSchema as PrincipalLifecyclePayloadSchema } from './core-identity-principal-lifecycle-changed-v1.ts';
import { OutboxPayloadSchema } from './core-modules-tenant-module-state-changed-v1.ts';
import {
  coreModuleInstallationSubscription,
  corePrincipalBindingSubscription,
  corePrincipalLifecycleSubscription,
} from './core-system-subscriptions.ts';
import { defineOutboxWorker } from './definition.ts';
import type { OutboxWorkerHandlerContext } from './definition.ts';
import { isVerifiedOutboxWorkerHandlerContext } from './verified-handler-context.ts';

export {
  ActionAuthorizationLifecycle,
  ActionAuthorizationLifecycleLive,
} from '../permissions/action-authorization-lifecycle.ts';
export {
  CoreAuthorizationProjectionCompilerLive,
  CoreAuthorizationProjectionError,
  AccessProjectionWriterLive,
  AccessWriteJournalStoreLive,
  outboxWorkerTenantScope,
  TenantIntentLoaderLive,
} from './core-authorization-projection.ts';
export { SpiceDbConfigError } from '../permissions/config-error.ts';
export { SpiceDbConfigLive } from '../permissions/config.ts';
export { CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS } from './core-system-subscriptions.ts';
export { OutboxRuntimeLive } from './runtime.ts';

const coreWorkerRetryPolicy = { initialBackoffMs: 1000, maxAttempts: 20, maxBackoffMs: 60_000, multiplier: 2 } as const;

const unattestedClaim = (reason: string) => new ActionAuthorizationLifecycleError({ reason });

/**
 * How one attempt waits while another writer holds the tenant's fence: at most `budget` in total, trying again
 * every `spacing`. The budget stays well inside the worker's 60-second claim lease, so a waiting attempt does not
 * lose its claim to a second host. Tests running under `TestClock` provide a zero spacing.
 */
export const CoreWorkerFenceWait = Context.Reference<{
  readonly budget: Duration.Duration;
  readonly spacing: Duration.Duration;
}>('@app/core-runtime/outbox/core-system-worker-entry/CoreWorkerFenceWait', {
  defaultValue: () => ({ budget: Duration.seconds(30), spacing: Duration.seconds(2) }),
});

/**
 * Reconcile the tenant, and while another writer holds its fence (`isFenceBusy`), run the reconcile again every two
 * seconds within the attempt's budget — the rule the release activation follows. Nothing here ever settles a
 * wake-up it did not reconcile itself: every retry re-reads the tenant's current intent, so it projects the change
 * behind this message however that change committed. (Not every producer of this topic serialises its intent write
 * with the fence — person invitation acceptance commits memberships without it — so "another writer is projecting"
 * is not proof that this change will be projected.) A fence still held when the budget runs out fails the attempt
 * as before, and the Outbox retries it. At a switch-over, where the new host's release steps project every tenant
 * while its Outbox host starts, short contention no longer spends attempts.
 */
const reconcileWhenFenceFree = Effect.fn('CoreSystemWorker.reconcileWhenFenceFree')(
  function* reconcileWhenFenceFreeEffect(
    scope: OperationalScope,
    waitUntil: number,
  ): Effect.fn.Return<TenantProjectionWrite, ActionAuthorizationLifecycleError, ActionAuthorizationLifecycle> {
    const lifecycle = yield* ActionAuthorizationLifecycle;
    const written = yield* Effect.result(lifecycle.reconcileTenant(scope));
    if (Result.isSuccess(written)) {
      return written.success;
    }
    const { failure } = written;
    if (!Schema.is(TenantProjectionBusyError)(failure)) {
      return yield* failure;
    }
    const { spacing } = yield* CoreWorkerFenceWait;
    if ((yield* Clock.currentTimeMillis) + Duration.toMillis(spacing) > waitUntil) {
      // The fence stayed held for the attempt's whole budget: this attempt fails and the Outbox retries it.
      return yield* new ActionAuthorizationLifecycleError({
        reason: `Another writer held the tenant's fence for the whole waiting budget: ${failure.reason}`,
      });
    }
    yield* Effect.logInfo('Another writer is projecting this tenant; reconciling again once its fence is free');
    yield* Effect.sleep(spacing);
    return yield* reconcileWhenFenceFree(scope, waitUntil);
  },
);

/** One lifecycle wake-up's reconcile of its tenant, waiting for a busy fence within the attempt's budget. */
export const reconcileLifecycleTenant = Effect.fn('CoreSystemWorker.reconcileLifecycleTenant')(
  function* reconcileLifecycleTenantEffect(scope: OperationalScope) {
    const { budget } = yield* CoreWorkerFenceWait;
    return yield* reconcileWhenFenceFree(scope, (yield* Clock.currentTimeMillis) + Duration.toMillis(budget));
  },
);

/**
 * The one reconcile of a Core lifecycle wake-up (D9, D24). Every wake-up — an installation, a principal
 * change, a binding activation — reconciles the whole tenant: authorization v2 projects the graph from
 * PostgreSQL intent, so there is no per-principal, per-role or per-Action writer left to drive, and a
 * tenant that already carries this intent projects nothing. The scope is minted from the attested claim,
 * never from the message body (O66).
 *
 * A role or membership change does not wake this worker at all: the canonical access commands
 * (`AccessPeopleCommands`, `writeRoleRevision`) reconcile and verify the tenant in their own transaction,
 * so there is no trailing role event for this worker to consume.
 */
const reconcileTenantFromClaim = Effect.fn('CoreSystemWorker.reconcileTenant')(function* reconcileTenantFromClaimEffect(
  context: OutboxWorkerHandlerContext,
) {
  if (!isVerifiedOutboxWorkerHandlerContext(context)) {
    return yield* unattestedClaim('Core lifecycle work requires an attested Outbox claim');
  }
  const scope = yield* outboxWorkerTenantScope(
    withOptional(
      { claimId: context.claimId, tenantId: context.tenantId },
      'actorPrincipalId',
      context.actorPrincipalId,
    ),
  ).pipe(Effect.mapError((cause) => new ActionAuthorizationLifecycleError({ cause, reason: cause.reason })));
  return yield* reconcileLifecycleTenant(scope).pipe(Effect.asVoid);
});

const installationWorker = defineOutboxWorker(
  {
    ...coreModuleInstallationSubscription,
    leaseDurationMs: 60_000,
    legalEntityScope: 'forbidden',
    payloadSchema: OutboxPayloadSchema,
    retryPolicy: coreWorkerRetryPolicy,
  },
  Effect.fn('CoreSystemWorker.reconcileCommittedInstallation')(
    function* reconcileCommittedInstallation(_payload, context) {
      return yield* reconcileTenantFromClaim(context).pipe(Effect.asVoid);
    },
  ),
);

const principalLifecycleWorker = defineOutboxWorker(
  {
    ...corePrincipalLifecycleSubscription,
    leaseDurationMs: 60_000,
    legalEntityScope: 'forbidden',
    payloadSchema: PrincipalLifecyclePayloadSchema,
    retryPolicy: coreWorkerRetryPolicy,
  },
  Effect.fn('CoreSystemWorker.reconcileCommittedPrincipal')(function* reconcileCommittedPrincipal(_payload, context) {
    return yield* reconcileTenantFromClaim(context).pipe(Effect.asVoid);
  }),
);

const principalBindingWorker = defineOutboxWorker(
  {
    ...corePrincipalBindingSubscription,
    leaseDurationMs: 60_000,
    legalEntityScope: 'forbidden',
    payloadSchema: PrincipalBindingPayloadSchema,
    retryPolicy: coreWorkerRetryPolicy,
  },
  Effect.fn('CoreSystemWorker.reconcileActivatedPrincipalBinding')(
    function* reconcileActivatedPrincipalBinding(payload, context) {
      // The binding's own tenant must be the attested one: a wake-up never widens its tenant (O66).
      if (!isVerifiedOutboxWorkerHandlerContext(context) || payload.data.tenantId !== context.tenantId) {
        return yield* unattestedClaim('Binding lifecycle work requires exact attested tenant scope');
      }
      return yield* reconcileTenantFromClaim(context).pipe(Effect.asVoid);
    },
  ),
);

export {
  PeopleSearchProjectorLive,
  PeopleSearchSourceLive,
  peopleSearchIngestionRegistrations,
} from '../people/people-search-worker-layer.ts';

/** The application root supplies persistence, composition authority and process-local resources. */
export const corePeopleSearchOutboxWorkers = Object.freeze([
  projectPeopleLifecycleSearch,
  rebuildPeopleSearch,
] as const);

export const coreSystemOutboxWorkers = Object.freeze([
  installationWorker,
  principalBindingWorker,
  principalLifecycleWorker,
] as const);
