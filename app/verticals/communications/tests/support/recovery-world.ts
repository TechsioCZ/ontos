import { NodeCrypto } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { Effect, Layer } from 'effect';

import type { MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import {
  attemptRetryLinks,
  deliveryAttempts,
  intentHandoffStops,
  intentRecoveryEvaluations,
  intentResendLinks,
  messageIntents,
  providerObservationConflictResolutions,
  providerObservationConflicts,
  providerObservations,
} from '../../src/database/schema.ts';
import { HandoffStoreUnavailable, processIntentHandoff } from '../../src/handoff/process-intent-handoff.ts';
import type { ScopedRunner } from '../../src/handoff/process-intent-handoff.ts';
import { reconcileAndEvaluate, reconcileProviderEvidence } from '../../src/recovery/reconcile-provider-evidence.ts';
import { fixtureRecovery, fixtureType } from '../unit/support/catalog-fixtures.ts';
import { scopedIn } from './history-world.ts';
import type { World } from './history-world.ts';
import type { handoffDouble } from './intake-fixtures.ts';

/**
 * TEST-ONLY wiring of the recovery lane (#1403) on native PostgreSQL, as the runtime role and through the REAL scoped routines.
 * The Messaging Adapter (`handoffDouble`) and the step 22 evidence (`step22Double`) are labelled doubles. The limits below are
 * test data of a fictional approved type: no code, default or production type supplies one.
 */

/** A type whose owner approved automatic recovery of a proven non-acceptance, with the owner's own limit as test data. */
export const recoverableType = (maxAttempts = 3) => fixtureType({ recovery: fixtureRecovery(maxAttempts) });
/** A type whose source owner approved an Explicit Resend. */
export const resendableType = (overrides: Parameters<typeof fixtureType>[0] = {}) =>
  fixtureType({ resend: 'SOURCE_APPROVED', ...overrides });

/** One delivery of the pre-handoff step with the approved types of the given list (default: the world's own). */
export const stepWith = (
  world: World,
  handoff: ReturnType<typeof handoffDouble>,
  intentId: typeof MessageIntentIdSchema.Type,
  types = world.types,
  callLeaseMs?: number,
) =>
  processIntentHandoff({ callLeaseMs, intentId, tenantId: world.tenantId }, scopedIn(world)).pipe(
    Effect.provide(Layer.mergeAll(world.portsFor(types), handoff.layer, NodeCrypto.layer)),
  );

/** The answers a provider (the labelled double) can give. */
export const answers = {
  accepted: () => Effect.succeed({ kind: 'ACCEPTED', providerKey: 'fixture-provider', providerRef: 'ref-1' } as const),
  rateLimited: () => Effect.succeed({ kind: 'REJECTED', reason: 'rate_limited' } as const),
  refused: () => Effect.succeed({ kind: 'REJECTED', reason: 'provider_rejected' } as const),
  timeout: () => Effect.succeed({ kind: 'INDETERMINATE', reason: 'timeout' } as const),
  unavailable: () => Effect.succeed({ kind: 'UNAVAILABLE', reason: 'provider_unavailable' } as const),
};

export const attemptsOf = (world: World, intentId: string) =>
  world
    .read((tx) => tx.select().from(deliveryAttempts).where(eq(deliveryAttempts.intentId, intentId)))
    .pipe(Effect.map((rows) => rows.toSorted((left, right) => left.attemptNumber - right.attemptNumber)));

export const retryLinksOf = (world: World, intentId: string) =>
  world
    .read((tx) => tx.select().from(attemptRetryLinks).where(eq(attemptRetryLinks.intentId, intentId)))
    .pipe(Effect.map((rows) => rows.toSorted((left, right) => left.linkedAt.getTime() - right.linkedAt.getTime())));

export const recoveriesOf = (world: World, intentId: string) =>
  world
    .read((tx) => tx.select().from(intentRecoveryEvaluations).where(eq(intentRecoveryEvaluations.intentId, intentId)))
    .pipe(Effect.map((rows) => rows.toSorted((left, right) => left.evaluationSeq - right.evaluationSeq)));

export const stopsOf = (world: World, intentId: string) =>
  world
    .read((tx) => tx.select().from(intentHandoffStops).where(eq(intentHandoffStops.intentId, intentId)))
    .pipe(Effect.map((rows) => rows.toSorted((left, right) => left.evaluationSeq - right.evaluationSeq)));

export const observationsOf = (world: World, intentId: string) =>
  world.read((tx) => tx.select().from(providerObservations).where(eq(providerObservations.intentId, intentId)));

export const conflictsOf = (world: World, intentId: string) =>
  world.read((tx) =>
    tx.select().from(providerObservationConflicts).where(eq(providerObservationConflicts.intentId, intentId)),
  );

export const resolutionsOf = (world: World, intentId: string) =>
  world.read((tx) =>
    tx
      .select()
      .from(providerObservationConflictResolutions)
      .where(eq(providerObservationConflictResolutions.intentId, intentId)),
  );

export const intentRows = (world: World) => world.read((tx) => tx.select().from(messageIntents));

export const resendLinksOf = (world: World) => world.read((tx) => tx.select().from(intentResendLinks));

export const intentRowOf = (world: World, intentId: string) =>
  world.read((tx) =>
    tx
      .select()
      .from(messageIntents)
      .where(and(eq(messageIntents.tenantId, world.tenantId), eq(messageIntents.intentId, intentId))),
  );

export const kindOf = (processing: Effect.Success<ReturnType<typeof stepWith>>) => {
  if (processing.kind === 'SKIPPED') {
    return `${processing.kind}:${processing.reason}`;
  }
  if (processing.kind === 'LATE_ANSWER') {
    return `${processing.kind}:${processing.recorded}`;
  }
  return processing.kind === 'HALTED' ? `${processing.kind}:${processing.code}` : processing.kind;
};

/**
 * A scoped runner whose `failingProgram`-th program dies, as a worker crash would: program 1 reads and gates, 2 commits the
 * attempt, the provider is called, 3 would commit its evidence. The provider call has then happened and nothing records it.
 */
export const runnerFailingAt = (world: World, failingProgram: number): ScopedRunner => {
  let count = 0;
  const real = scopedIn(world);
  return (program) =>
    Effect.suspend(() => {
      count += 1;
      return count === failingProgram
        ? Effect.fail(new HandoffStoreUnavailable({ reason: 'injected crash before the evidence was recorded' }))
        : real(program);
    });
};

/** One delivery of the step under a crashing runner: the provider is called, the evidence is never recorded. */
export const crashAfterProviderCall = (
  world: World,
  handoff: ReturnType<typeof handoffDouble>,
  intentId: typeof MessageIntentIdSchema.Type,
) =>
  Effect.exit(
    processIntentHandoff({ intentId, tenantId: world.tenantId }, runnerFailingAt(world, 3)).pipe(
      Effect.provide(Layer.mergeAll(world.portsFor(world.types), handoff.layer, NodeCrypto.layer)),
    ),
  );

/**
 * "The lease of the delivery has elapsed since the attempt was prepared" as test data: the tests cannot wait the Core worker
 * lease, so a test that stands for a crashed worker long ago passes none; a test of an in-flight call passes the real lease.
 */
export const ELAPSED_CALL_LEASE_MS = 0;

/** Reconciliation evidence of one intent (the labelled step 22 double), then one evaluation of the SAME pre-handoff step. */
export const reconcileThenStep = (
  world: World,
  handoff: ReturnType<typeof handoffDouble>,
  intentId: typeof MessageIntentIdSchema.Type,
  evidence: Parameters<typeof reconcileAndEvaluate>[0]['evidence'],
  callLeaseMs = ELAPSED_CALL_LEASE_MS,
) =>
  reconcileAndEvaluate({ callLeaseMs, evidence, intentId, tenantId: world.tenantId }, scopedIn(world)).pipe(
    Effect.provide(Layer.mergeAll(world.portsFor(world.types), handoff.layer, NodeCrypto.layer)),
  );

/** Reconciliation evidence only: appended, settled where it settles anything, and nothing evaluated or sent. */
export const reconcileOnly = (
  world: World,
  intentId: typeof MessageIntentIdSchema.Type,
  evidence: Parameters<typeof reconcileProviderEvidence>[0]['evidence'],
  callLeaseMs = ELAPSED_CALL_LEASE_MS,
) =>
  reconcileProviderEvidence({ callLeaseMs, evidence, intentId }, scopedIn(world)).pipe(
    Effect.provide(NodeCrypto.layer),
  );
