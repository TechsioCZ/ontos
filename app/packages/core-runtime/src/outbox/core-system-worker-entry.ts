import { withOptional } from '../access/decision/optional.ts';
import { Effect, Schema } from 'effect';

import { isFenceBusy } from '../access/intent/projection-writer.ts';
import { AccessProjectionWriteError } from '../access/intent/projection-write-error.ts';

import { projectPeopleLifecycleSearch, rebuildPeopleSearch } from '../people/people-search-workers.ts';
import { ActionAuthorizationLifecycle } from '../permissions/action-authorization-lifecycle.ts';
import { ActionAuthorizationLifecycleError } from '../permissions/action-authorization-lifecycle-error.ts';
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
  const lifecycle = yield* ActionAuthorizationLifecycle;
  return yield* lifecycle.reconcileTenant(scope).pipe(
    Effect.asVoid,
    // Another operation holds the tenant's fence, or projected the tenant since this reconcile pinned it: somebody
    // is projecting this tenant right now, so the wake-up is already being served (the same rule as the fence sweep
    // and the release activation, `isFenceBusy`). This is sound because of how intent and the fence interlock: the
    // change that emitted this message committed its intent while the fence was `Ready`, holding the fence's lock,
    // so no fence take could complete across that commit. Any hold present now was therefore taken after it, and a
    // holder reads the intent again once it holds the fence, so it projects this change; if it fails part-way, the
    // fence stays closed and its take-over projects fresh intent. Counting this as a failure only burned retries:
    // a switch-over, where the new host's release steps project every tenant while its Outbox host starts, saw a
    // carried-over delivery declare three failures before it ran.
    Effect.catchIf(
      (error) => Schema.is(AccessProjectionWriteError)(error.cause) && isFenceBusy(error.cause),
      () =>
        Effect.logInfo('Core lifecycle wake-up left to the writer already projecting the tenant').pipe(
          Effect.annotateLogs({ tenantId: scope.tenantId }),
        ),
    ),
  );
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
