import { Effect, Layer, Option, Schema } from 'effect';

import {
  CommerceEnrollmentContinuation,
  CommerceEnrollmentContinuationLive,
} from '../../src/enrollment/continuation/enrollment-continuation.ts';
import type { CommerceEnrollmentContinuationService } from '../../src/enrollment/continuation/enrollment-continuation.ts';
import type { CommerceEnrollmentAttemptError } from '../../src/enrollment/attempts/errors.ts';
import { journeyTransitionIdentity } from '../../src/enrollment/journeys/journey-contracts.ts';
import type { JourneyTransitionSpec } from '../../src/enrollment/journeys/journey-contracts.ts';
import { CommerceEnrollmentOwnerEffectRegistry } from '../../src/enrollment/orchestration/owner-effect-registry.ts';
import type {
  CommerceEnrollmentOwnerEffectContext,
  CommerceEnrollmentRegisteredOwnerEffect,
} from '../../src/enrollment/orchestration/owner-effect-registry.ts';
import { CommerceEnrollmentOwnerTransactionRunner } from '../../src/enrollment/orchestration/owner-transition-production.ts';
import type {
  CommerceEnrollmentOwnerTransactionRun,
  CommerceEnrollmentWorkerTransactionRun,
} from '../../src/enrollment/orchestration/owner-transition-production.ts';
import { CommerceEnrollmentPreparationSubjectResolver } from '../../src/enrollment/orchestration/preparation-subject.ts';
import type { RetailSelfEnrollmentPreparationSubject } from '../../src/enrollment/journeys/retail-self-enrollment-preparation.ts';
import { EnrollmentDigestSchema, enrollmentDigest } from '../../shared/enrollment-contracts.ts';
import { PORTAL_ACCOUNT_CREATION_TRANSITION_KEY } from '../../src/enrollment/orchestration/prepared-owner-authority.ts';
import { enrollmentAcceptanceScriptedOwner } from './enrollment-acceptance-owner-script.ts';
import type {
  EnrollmentAcceptanceOwnerAnswer,
  EnrollmentAcceptanceOwnerResolution,
  EnrollmentAcceptanceScriptedOwner,
} from './enrollment-acceptance-owner-script.ts';

/**
 * The continuation, assembled exactly as `api/index.ts` assembles it, with the owner-effect
 * registry replaced by a scripted one.
 *
 * Only the far side of the owner dispatch seam is scripted. The continuation, the generic
 * owner-transition driver, the owner store, the Attempt service, the SECURITY DEFINER routines and
 * the tenant policies all run for real against PostgreSQL, one committed transaction per phase.
 * Party Registry and Core identity are not reachable from the sandbox, so their clients are the
 * exact seam the script replaces — nothing below them is stubbed.
 */

interface EnrollmentContinuationHarness {
  readonly continuation: CommerceEnrollmentContinuationService;
  readonly owner: EnrollmentAcceptanceScriptedOwner;
}

export interface EnrollmentContinuationScript {
  readonly actorPrincipalId: Parameters<typeof enrollmentAcceptanceScriptedOwner>[0]['actorPrincipalId'];
  /** Answer for one dispatch, by transition key. */
  readonly answers: Readonly<Record<string, EnrollmentAcceptanceOwnerAnswer>>;
  /** Authoritative resolution for one reconciliation, by transition key. */
  readonly resolutions?: Readonly<Record<string, EnrollmentAcceptanceOwnerResolution>>;
  readonly subject: RetailSelfEnrollmentPreparationSubject;
  /** Transition keys this deployment registers no owner effect for. */
  readonly unregistered?: readonly string[];
}

const digestFor = (
  transition: JourneyTransitionSpec,
  context: CommerceEnrollmentOwnerEffectContext,
): typeof EnrollmentDigestSchema.Type =>
  Schema.decodeSync(EnrollmentDigestSchema)(
    enrollmentDigest(`${journeyTransitionIdentity(transition)}\u0000${context.attempt.portalEnrollmentAttemptId}`),
  );

/**
 * The portal account-creation transition is reconcile-only in production too, so the harness keeps
 * that shape: a scenario can never advance it by dispatching from the continuation.
 */
const isReconcileOnly = (transition: JourneyTransitionSpec): boolean =>
  transition.transitionKey === PORTAL_ACCOUNT_CREATION_TRANSITION_KEY;

export const makeEnrollmentContinuationHarness = Effect.fnUntraced(function* makeEnrollmentContinuationHarness(
  run: CommerceEnrollmentOwnerTransactionRun,
  runWorker: CommerceEnrollmentWorkerTransactionRun,
  script: EnrollmentContinuationScript,
) {
  const owner = enrollmentAcceptanceScriptedOwner(
    script.resolutions === undefined
      ? { actorPrincipalId: script.actorPrincipalId, answers: script.answers }
      : { actorPrincipalId: script.actorPrincipalId, answers: script.answers, resolutions: script.resolutions },
  );
  const unregistered = new Set(script.unregistered);
  const registryLive = Layer.succeed(CommerceEnrollmentOwnerEffectRegistry, {
    resolve: (
      transition: JourneyTransitionSpec,
      context: CommerceEnrollmentOwnerEffectContext,
    ): Effect.Effect<Option.Option<CommerceEnrollmentRegisteredOwnerEffect>, CommerceEnrollmentAttemptError> =>
      Effect.sync(() => {
        if (unregistered.has(transition.transitionKey)) {
          return Option.none();
        }
        return Option.some({
          dispatch: isReconcileOnly(transition)
            ? Option.none()
            : Option.some({ effect: owner.effect.dispatch, requestDigest: digestFor(transition, context) }),
          reconcile: owner.effect.reconcile,
        });
      }),
  });
  const subjectLive = Layer.succeed(CommerceEnrollmentPreparationSubjectResolver, {
    resolve: (input) =>
      Effect.succeed({ ...script.subject, portalEnrollmentAttemptId: input.portalEnrollmentAttemptId }),
  });
  const continuation = yield* CommerceEnrollmentContinuation.pipe(
    Effect.provide(
      CommerceEnrollmentContinuationLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CommerceEnrollmentOwnerTransactionRunner, { run, runWorker }),
            registryLive,
            subjectLive,
          ),
        ),
      ),
    ),
  );
  const harness: EnrollmentContinuationHarness = { continuation, owner };
  return harness;
});

/**
 * The very same continuation, with the cross-Tenant due-work listing narrowed to the Tenants one
 * scenario created. The listing is global by design and the integration files run in parallel
 * against one database, so without this a sweeper under test would advance another file's
 * Attempts. It only ever removes rows the routine returned: a scenario whose Attempt the routine
 * does not report still sees an empty listing and a sweep that moves nothing.
 */
export const enrollmentContinuationForTenants = (
  continuation: CommerceEnrollmentContinuationService,
  tenantIds: readonly string[],
): CommerceEnrollmentContinuationService => {
  const scenarioTenants = new Set<string>(tenantIds);
  return {
    advance: continuation.advance,
    claimSweep: continuation.claimSweep,
    listDue: (input) =>
      continuation.listDue(input).pipe(Effect.map((rows) => rows.filter((row) => scenarioTenants.has(row.tenantId)))),
  };
};

/** The `(transitionKey, status, outcomeCode)` triple of every durable owner operation, in order. */
export const enrollmentOperationSummary = (
  rows: readonly { readonly outcome_code: string | null; readonly status: string; readonly transition_key: string }[],
): readonly (readonly [string, string, string | null])[] =>
  rows.map((row) => [row.transition_key, row.status, row.outcome_code] as const);
