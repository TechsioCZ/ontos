import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  Cause,
  Clock,
  Context,
  Crypto,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Ref,
  Result,
} from 'effect';
import { Hex } from 'effect/encoding';

import type { OperationalScope } from '../../operations/context.ts';
import type { TenantProjectionIntent } from '../compiler/intent.ts';
import { planAccessProjection } from '../compiler/plan.ts';
import type { ProjectionFenceScope, ProjectionPlan } from '../compiler/plan.ts';
import { AccessProjectionError } from '../compiler/projection-error.ts';
import type {
  AccessProjectionCompiler as AccessProjectionCompilerEngine,
  ProjectionFenceAssertion,
  ReconcileReport,
} from '../compiler/spice-db-compiler.ts';
import { AccessOperationIdSchema, AccessScopeIdSchema, CommandDigestSchema, TenantIdSchema } from '../ids.ts';
import type { AccessOperationId, AccessScopeId, CommandDigest, TenantId } from '../ids.ts';
import type { AccessLifecycleError } from '../lifecycle/errors.ts';
import { lifecycleRefusal } from '../lifecycle/errors.ts';
import {
  ACCESS_FENCE_LEASE,
  ACCESS_FENCE_LEASE_RENEWAL,
  AccessWriteJournalPort,
  acquireScopeFence,
  advanceOperationJournal,
  openOperationJournal,
  releaseScopeFence,
  runAccessWrite,
  validateAccessChange,
} from '../lifecycle/fence.ts';
import type { AccessFailureBeforeEngineWrite, AccessWriteJournalPortService } from '../lifecycle/fence.ts';
import { AccessWriteJournalStore } from '../lifecycle/persistence/journal-store.ts';
import type { AccessIntentError } from './errors.ts';
import { AccessProjectionCompiler } from './projection-compiler.ts';
import { ProjectionIntentMoved } from './projection-intent-moved.ts';
import { projectionWriteRefusal, projectionWriteViolation } from './projection-write-error.ts';
import type { AccessProjectionWriteError, AccessProjectionWriteErrorCode } from './projection-write-error.ts';
import { TenantIntentLoader } from './tenant-intent-loader.ts';
import type { TenantIntentLoaderService } from './tenant-intent-loader.ts';
import type { ScopeFence } from '../model.ts';

/*
 * The single Core writer (D9, D24). Intent lives in PostgreSQL and SpiceDB is only its projection, so
 * exactly one path turns intent into tuples: take the tenant's scope fence, load one complete tenant
 * intent under it, plan it, write the minimal difference, verify that the graph equals intent, and
 * journal the projection token. Every intent write (bootstrap, role edit, membership, installation,
 * departure, adoption) ends by calling this writer for its tenant; nothing else writes a relationship.
 *
 * The snapshot is pinned to the tenant fence's revision *before* it is read, and the fence is taken by a
 * compare-and-set against that exact revision (R5a-1). The fence serializes graph writes, but a reconcile
 * that read its snapshot against no fence at all could project an intent a revocation had already
 * overtaken — restoring a membership nobody holds, whose still-active role makes the restored tuple
 * grant. The fence cannot be *held* while the intent is read, because the schema requires the fence to
 * name an operation that already has a journal (`access_scope_fences_operation_fk`) and the journal's
 * command digest is the plan's, which only the intent produces. Pinning the revision instead gives the
 * same guarantee without holding the lock across the read: the compare-and-set succeeds only if the
 * fence has not moved since before the snapshot was read, so a reconcile whose snapshot was overtaken is
 * refused instead of written, and the fence's revision is proved again immediately before the graph is
 * touched. D9 keeps its own order too: the change is validated before the scope is locked.
 *
 * Every reconcile is one operation of its own, and its command digest is the SHA-256 of the plan lines the
 * intent produces. An unchanged tenant therefore projects no relationship at all — the plan and the graph
 * are equal, so the write path records the intent it verified instead of an engine write — while a changed
 * intent projects exactly the difference. That is what makes "reconcile twice" observably a no-op instead
 * of a rewrite. The operation is named by its caller (bootstrap, role edit, installation) or minted here,
 * and never by its content: a tenant can return to an intent it carried before (uninstall and reinstall),
 * and a journal committed under that content would otherwise answer for a graph that has moved on.
 *
 * L46 fences per scope, and a tenant is projected whole (its tenant unit carries every member, owner and
 * legal entity, D13). Every scope unit of the tenant is therefore written under the tenant context
 * scope's fence: one lock per tenant, proved before the plan reads a single tuple, so two reconciles of
 * one tenant can never interleave.
 */

export interface TenantProjectionRequest {
  /**
   * Optional: a caller that resumed a journal of its own continues that operation (D24). Without one, the
   * reconcile is an operation of its own, because a tenant can return to an intent it carried before
   * (uninstall and reinstall) and the graph must then be rewritten, not read back from an old journal.
   */
  readonly operationId?: AccessOperationId;
  /** The trusted request scope: its tenant is the tenant reconciled (O66). */
  readonly scope: OperationalScope;
}

/**
 * What one reconcile did. `resumed` names the case where the tenant already carried exactly this intent:
 * the operation's journal was found committed, `projectionToken` is the token it wrote then, and nothing
 * was sent to the engine now.
 */
export interface TenantProjectionWrite {
  readonly deletions: number;
  readonly digest: CommandDigest;
  readonly operationId: AccessOperationId;
  readonly projectionToken: string;
  readonly resumed: boolean;
  /** The fence the write took: the tenant's own context scope, which serializes the whole tenant. */
  readonly scopeId: AccessScopeId;
  readonly touches: number;
  readonly units: readonly string[];
  readonly verified: boolean;
}

/** The writer as its callers see it: no requirement of its own, every call carrying its scope (O66). */
export interface AccessProjectionWriterService {
  /** Brings every scope of one tenant's projection in line with its intent (the single writer). */
  readonly reconcileTenant: (
    request: TenantProjectionRequest,
  ) => Effect.Effect<TenantProjectionWrite, AccessProjectionWriteError>;
}

/**
 * The reconcile before the request scope's fence and journal port is bound. The port belongs to one
 * request scope (O66), so it is a requirement here and is bound once per scope where the writer is used,
 * never read from the command body.
 */
export interface UnboundAccessProjectionWriter {
  readonly reconcileTenant: (
    request: TenantProjectionRequest,
  ) => Effect.Effect<TenantProjectionWrite, AccessProjectionWriteError, AccessWriteJournalPort | Crypto.Crypto>;
}

/** The compile-checked shape of the intent reads this writer makes: one complete tenant picture (D13). */
export type ProjectionIntentReads = Pick<TenantIntentLoaderService, 'loadProjection' | 'loadTenantContextScopeId'>;

/**
 * The tenant context scope of an intent: the one scope that speaks for the whole tenant, and therefore
 * the one fence under which the whole tenant is projected.
 */
const tenantScopeOf = (intent: TenantProjectionIntent): Option.Option<AccessScopeId> =>
  Option.fromUndefinedOr(
    intent.scopes.flatMap((scopeIntent): readonly AccessScopeId[] =>
      Match.value(scopeIntent.scope.scope).pipe(
        Match.tag('TenantContext', () => [scopeIntent.scope.id]),
        Match.orElse((): readonly AccessScopeId[] => []),
      ),
    )[0],
  );

/** The identity of a reconcile: its plan, and nothing else about the caller. */
const planDigest = (plan: ProjectionPlan): CommandDigest =>
  CommandDigestSchema.make(Hex.encode(sha256(utf8ToBytes(plan.lines.join('\n')))));

/**
 * The token a reconcile commits when the graph already equals intent: which intent was verified, so the
 * journal distinguishes "projected these tuples" from "found them already there" without pretending an
 * engine write happened that did not.
 */
const unchangedProjectionToken = (digest: CommandDigest): string => `intent:${digest}`;

/**
 * L46 types a write's projection step in the lifecycle's own vocabulary, which has no code for a refused
 * projection: `commitProjection` records the accurate `projection_failed` journal reason itself, so the
 * code below only carries the failure out of L46's API. The caller never sees it — this writer replaces it
 * with the projection's own code and violations before the effect returns.
 */
const projectionFailedInWritePath = (reason: string): AccessLifecycleError =>
  lifecycleRefusal('fence_unavailable', reason);

/** One projection violation as text: the unit it refused, its code and its reason. */
const violationText = (failure: AccessProjectionError): string =>
  failure.unit === undefined
    ? `${failure.code}: ${failure.reason}`
    : `${failure.unit} ${failure.code}: ${failure.reason}`;

const fenceFailure = (reason: string): readonly AccessProjectionError[] => [
  new AccessProjectionError({ code: 'access_projection_unavailable', reason }),
];

/** The fence a reconcile must hold, and the scope that names it. */
interface HeldFenceRequest {
  readonly operationId: AccessOperationId;
  readonly tenantId: TenantId;
  readonly tenantScopeId: AccessScopeId;
}

/**
 * Why this operation may not write, if it may not: the tenant context scope has no fence, or another
 * operation holds it (D15). No issue means this operation holds the tenant's fence.
 */
const heldFenceIssue = (fence: Option.Option<ScopeFence>, request: HeldFenceRequest): Option.Option<string> =>
  Option.match(fence, {
    onNone: () => Option.some('The tenant context scope has no scope fence, so nothing may write'),
    onSome: (current) =>
      current.state === 'Changing' && current.owningOperationId === request.operationId
        ? Option.none()
        : Option.some(
            `The tenant's scope fence is held by operation ${current.owningOperationId ?? 'nobody'}, not by ${request.operationId}`,
          ),
  });

/** Why one scope of the plan cannot be projected, if it cannot: it has no fence, or is unavailable. */
const scopeFenceIssue = (fence: Option.Option<ScopeFence>, scopeId: string): Option.Option<string> =>
  Option.match(fence, {
    onNone: () => Option.some(`Scope ${scopeId} has no scope fence, so it cannot be projected`),
    onSome: (current) =>
      current.state === 'Unavailable'
        ? Option.some(`Scope ${scopeId} is unavailable, so nothing may write`)
        : Option.none(),
  });

/**
 * Why the snapshot this reconcile planned is no longer the one its fence covers, if it is not: the fence
 * moved to another revision or another operation, or it became unavailable (R5a-1).
 *
 * The fence's revision is the tenant's own intent revision: every intent write ends by projecting under
 * this one fence, so a fence still at the revision this operation took it at cannot have been overtaken
 * by another writer's completed projection. Checking it here — immediately before the graph is written —
 * is what stops a reconcile from committing a snapshot the fence has already moved past.
 */
const fenceMovedIssue = (fence: Option.Option<ScopeFence>, held: ScopeFence): Option.Option<string> =>
  Option.match(fence, {
    onNone: () => Option.some(`Scope ${held.scopeId} has no scope fence, so nothing may write`),
    onSome: (current) =>
      current.state === 'Changing' &&
      current.owningOperationId === held.owningOperationId &&
      current.revision === held.revision
        ? Option.none()
        : Option.some(
            `Scope ${current.scopeId} moved from revision ${held.revision} held by ${held.owningOperationId ?? 'nobody'} to revision ${current.revision} held by ${current.owningOperationId ?? 'nobody'}, so the intent this reconcile planned is not the intent its fence covers`,
          ),
  });

const intentFailure = (error: AccessIntentError): AccessProjectionWriteError =>
  projectionWriteRefusal(
    'access_projection_write_intent_unavailable',
    `The tenant's access intent could not be read (${error.code}): ${error.reason}`,
  );

const fenceRefusalError = (error: AccessLifecycleError): AccessProjectionWriteError =>
  projectionWriteRefusal('access_projection_write_fence_refused', `${error.code}: ${error.reason}`);

/**
 * Whether a refusal only means another writer holds the tenant's fence under a live hold, or moved it since this
 * reconcile pinned it: somebody else is projecting the tenant right now. Waiting for it, or leaving the tenant to it,
 * is correct; it is not a failure of this caller.
 */
export const isFenceBusy = (error: AccessProjectionWriteError): boolean =>
  error.code === 'access_projection_write_fence_refused' &&
  (error.reason.startsWith('fence_held_by_other_operation:') || error.reason.startsWith('fence_revision_conflict:'));

/** How many times one reconcile reads a tenant whose intent keeps moving before it gives up. */
export const ACCESS_PROJECTION_INTENT_ATTEMPTS = 3;

/** One read of the tenant's intent, planned: the snapshot, its plan, and the digest that names the plan. */
interface PlannedIntent {
  readonly digest: CommandDigest;
  readonly intent: TenantProjectionIntent;
  readonly plan: ProjectionPlan;
}

/**
 * Read the tenant's whole intent and plan it. The snapshot must name the tenant whose fence this operation holds,
 * or the plan it produces would describe another tenant than the lock it writes under.
 */
const planTenantIntent = Effect.fn('AccessProjectionWriter.planTenantIntent')(function* planTenantIntentEffect(
  loader: ProjectionIntentReads,
  scope: OperationalScope,
  tenantScopeId: AccessScopeId,
) {
  const intent = yield* loader.loadProjection(scope).pipe(Effect.mapError(intentFailure));
  const snapshotScope = tenantScopeOf(intent);
  if (!Option.exists(snapshotScope, (snapshot) => snapshot === tenantScopeId)) {
    return yield* projectionWriteRefusal(
      'access_projection_write_scope_missing',
      `The intent pinned to scope ${tenantScopeId}'s fence names tenant-context scope ${Option.getOrUndefined(snapshotScope) ?? 'none'}, which is not the scope this reconcile writes`,
    );
  }
  const planned = planAccessProjection({ tenants: [intent] });
  if (Result.isFailure(planned)) {
    return yield* projectionWriteViolation('access_projection_write_plan_refused', planned.failure.map(violationText));
  }
  return { digest: planDigest(planned.success), intent, plan: planned.success } satisfies PlannedIntent;
});

/**
 * D15's proof that this operation holds the tenant's own fence. The read is handed in, so the module stays a
 * description of the rule: the tenant context scope's fence must exist, be `Changing`, and name us.
 */
const heldFenceProof = (
  readFence: Effect.Effect<Option.Option<ScopeFence>, AccessLifecycleError>,
  request: HeldFenceRequest,
): Effect.Effect<void, readonly AccessProjectionError[]> =>
  readFence.pipe(
    Effect.mapError((cause) => fenceFailure(`The tenant's scope fence could not be read: ${cause.reason}`)),
    Effect.flatMap((fence) =>
      Option.match(heldFenceIssue(fence, request), {
        onNone: () => Effect.void,
        onSome: (reason) => Effect.fail(fenceFailure(reason)),
      }),
    ),
  );

/** D9: a scope of the plan is projected only when it has a fence that admits a write at all. */
const scopeFenceGuard = (
  readFence: Effect.Effect<Option.Option<ScopeFence>, AccessLifecycleError>,
  scopeId: string,
): Effect.Effect<void, AccessLifecycleError> =>
  readFence.pipe(
    Effect.mapError((cause) =>
      lifecycleRefusal('fence_store_unavailable', `The scope fence store could not be read: ${cause.reason}`),
    ),
    Effect.flatMap((fence) =>
      Option.match(scopeFenceIssue(fence, scopeId), {
        onNone: () => Effect.void,
        onSome: (reason) => Effect.fail(lifecycleRefusal('fence_unavailable', reason)),
      }),
    ),
  );

/** The fence one reconcile holds: its operation, its scope and the revision it took the scope at. */
interface TakenFence {
  readonly fence: ScopeFence;
  readonly operationId: AccessOperationId;
  readonly scopeId: AccessScopeId;
  readonly tenantId: TenantId;
}

const fenceCommand = (request: TakenFence) =>
  ({ operationId: request.operationId, scopeId: request.scopeId, tenantId: request.tenantId }) as const;

/**
 * Take over a fence whose holder died with it held: the store's compare-and-set succeeds only while the observed
 * holder still owns the fence at the pinned revision and its lease has lapsed, and it ends that holder's journal.
 * A live holder is never preempted: its fence comes back as a conflict and this reconcile is refused.
 */
const takeOverLapsedFence = Effect.fn('AccessProjectionWriter.takeOverLapsedFence')(function* takeOverLapsedFenceEffect(
  takeOver: NonNullable<AccessWriteJournalPortService['takeOverExpiredFence']>,
  request: {
    readonly expectedRevision: number;
    readonly operationId: AccessOperationId;
    readonly previousOperationId: AccessOperationId;
    readonly scopeId: AccessScopeId;
    readonly tenantId: TenantId;
  },
) {
  const outcome = yield* takeOver(request);
  return yield* Match.value(outcome).pipe(
    Match.tag('Acquired', ({ fence }) =>
      Effect.logWarning(
        `Tenant ${request.tenantId}: took over the access fence of operation ${request.previousOperationId}, whose hold lapsed; reconciling the whole tenant before it opens`,
      ).pipe(Effect.as(fence)),
    ),
    Match.tag('Conflict', ({ fence }) =>
      Effect.fail(
        lifecycleRefusal(
          'fence_held_by_other_operation',
          `Scope ${fence.scopeId} is held by operation ${fence.owningOperationId ?? 'nobody'} (${fence.state}, revision ${fence.revision}) whose hold has not lapsed, so nothing may write`,
        ),
      ),
    ),
    Match.exhaustive,
  );
});

/**
 * How long a holder may go without a successful lease renewal before it stops writing: well inside the lease, so a
 * holder cut off from the database stops before anybody may judge its hold lapsed and take the fence over.
 */
export const ACCESS_FENCE_HOLD_UNPROVED_LIMIT = Duration.seconds(90);

/** What this operation knows about its own hold while it writes. */
interface HoldWatch {
  /** Why this operation no longer holds its fence, once it knows. */
  readonly lost: Ref.Ref<Option.Option<string>>;
  /** When the hold was last proved live (taken or renewed), on this process's clock. */
  readonly provedAt: Ref.Ref<number>;
}

const holdLostReason = (taken: TakenFence, why: string) =>
  `Operation ${taken.operationId} no longer holds tenant ${taken.tenantId}'s access fence: ${why}, so it writes nothing more`;

/** One renewal; answers whether to keep renewing. A refused renewal means another operation holds the fence. */
const renewOnce = Effect.fn('AccessProjectionWriter.renewOnce')(function* renewOnceEffect(
  renew: NonNullable<AccessWriteJournalPortService['renewFenceLease']>,
  taken: TakenFence,
  watch: HoldWatch,
) {
  // The hold is proved from the moment the renewal was sent, never from its answer: the lease it sets is younger.
  const sentAt = yield* Clock.currentTimeMillis;
  const renewed = yield* renew(fenceCommand(taken)).pipe(
    Effect.map(Option.some),
    Effect.catchTag('AccessLifecycleError', ({ code, reason }) =>
      Effect.logWarning(`The tenant scope fence lease could not be renewed (${code}: ${reason})`).pipe(
        Effect.as(Option.none<boolean>()),
      ),
    ),
  );
  if (Option.isNone(renewed)) {
    return true;
  }
  if (renewed.value) {
    yield* Ref.set(watch.provedAt, sentAt);
    return true;
  }
  yield* Ref.set(
    watch.lost,
    Option.some(holdLostReason(taken, 'its lease renewal found the fence held by another operation')),
  );
  return false;
});

/**
 * Keep this operation's hold live while it works. A renewal that fails is logged and the next one tries again; one
 * the store refuses means the fence has another holder, and is recorded so the writer stops before its next write.
 */
const renewHeldLease = Effect.fn('AccessProjectionWriter.renewHeldLease')(function* renewHeldLeaseEffect(
  taken: TakenFence,
  watch: HoldWatch,
) {
  const port = yield* AccessWriteJournalPort;
  const { renewFenceLease } = port;
  if (renewFenceLease === undefined) {
    return yield* Effect.void;
  }
  return yield* Effect.sleep(ACCESS_FENCE_LEASE_RENEWAL).pipe(
    Effect.andThen(renewOnce(renewFenceLease, taken, watch)),
    Effect.repeat({ while: (keepRenewing) => keepRenewing }),
    Effect.asVoid,
  );
});

/**
 * A renewal fiber that died of anything but its own interruption leaves the hold unrenewed: say so loudly, and
 * count the hold as lost so the writer stops instead of writing on under a lease nobody renews.
 */
const renewalEnded = (taken: TakenFence, watch: HoldWatch) => (exit: Exit.Exit<void, AccessLifecycleError>) =>
  Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
    ? Effect.logError(
        `ACCESS FENCE LEASE RENEWAL DIED for tenant ${taken.tenantId}, operation ${taken.operationId}: ${Cause.pretty(exit.cause)}`,
      ).pipe(Effect.andThen(Ref.set(watch.lost, Option.some(holdLostReason(taken, 'its lease renewal stopped')))))
    : Effect.void;

/**
 * Run before every engine write: refuse once the hold is known lost, or when no renewal has proved it for longer
 * than `ACCESS_FENCE_HOLD_UNPROVED_LIMIT` (a holder that cannot reach its database may already have been taken
 * over). A store without leases has no renewals to prove the hold with, and only the first rule applies.
 */
const holdStillProved = Effect.fn('AccessProjectionWriter.holdStillProved')(function* holdStillProvedEffect(
  taken: TakenFence,
  watch: HoldWatch,
  leased: boolean,
) {
  const lost = yield* Ref.get(watch.lost);
  if (Option.isSome(lost)) {
    return yield* Effect.fail(fenceFailure(lost.value));
  }
  const unproved = (yield* Clock.currentTimeMillis) - (yield* Ref.get(watch.provedAt));
  if (leased && unproved > Duration.toMillis(ACCESS_FENCE_HOLD_UNPROVED_LIMIT)) {
    const reason = holdLostReason(
      taken,
      `no lease renewal succeeded for ${Duration.format(Duration.millis(unproved))}, so another operation may hold it`,
    );
    yield* Ref.set(watch.lost, Option.some(reason));
    return yield* Effect.fail(fenceFailure(reason));
  }
  return yield* Effect.void;
});

/**
 * D15's compare-and-set against the revision this reconcile pinned *before* it read its snapshot (R5a-1).
 *
 * `runAccessWrite` takes the same fence for the projection it commits; this operation already holds it, so
 * that call resumes it instead of taking it a second time (`acquireScopeFence` answers an operation's own
 * `Changing` fence with the fence itself). The rule and the compare-and-set are the lifecycle's own — only
 * their place in this writer's order is this module's, and that place is the point: a fence that moved
 * since the snapshot was read means the snapshot is not the intent this reconcile may project.
 */
const takeTenantFence = Effect.fn('AccessProjectionWriter.takeTenantFence')(function* takeTenantFenceEffect(request: {
  readonly expectedRevision: number;
  readonly operationId: AccessOperationId;
  readonly previousHolder: Option.Option<AccessOperationId>;
  readonly scopeId: AccessScopeId;
  readonly tenantId: TenantId;
}) {
  const port = yield* AccessWriteJournalPort;
  const { takeOverExpiredFence } = port;
  if (Option.isSome(request.previousHolder) && takeOverExpiredFence !== undefined) {
    return yield* takeOverLapsedFence(takeOverExpiredFence, {
      ...request,
      previousOperationId: request.previousHolder.value,
    });
  }
  {
    const current = yield* port.readFence({ scopeId: request.scopeId, tenantId: request.tenantId });
    const desired = yield* acquireScopeFence({ ...request, current });
    if (Option.exists(current, (observed) => observed.state === 'Changing')) {
      // The operation already owns the fence (a resumed reconcile): its own fence is the proof.
      return desired;
    }
    const outcome = yield* port.acquireFence({
      expectedRevision: request.expectedRevision,
      operationId: request.operationId,
      scopeId: request.scopeId,
      tenantId: request.tenantId,
    });
    return yield* Match.value(outcome).pipe(
      Match.tag('Acquired', ({ fence }) => Effect.succeed(fence)),
      // A store that answered with a released fence took and released it while this snapshot was read: the
      // intent this reconcile planned is older than the graph, so it may not project it.
      Match.tag('Conflict', ({ fence }) =>
        fence.state === 'Changing' && fence.owningOperationId === request.operationId
          ? Effect.succeed(fence)
          : Effect.fail(
              lifecycleRefusal(
                'fence_revision_conflict',
                `Scope ${fence.scopeId} moved from revision ${request.expectedRevision} to revision ${fence.revision} (${fence.state}) while this reconcile read tenant ${request.tenantId}, so the intent it planned is not the intent its fence covers`,
              ),
            ),
      ),
      Match.exhaustive,
    );
  }
});

/**
 * The journal row the tenant fence names. The schema's foreign key requires the operation to have one
 * before the fence may point at it, and the command digest it carries is the plan's, so the row is opened
 * once the plan exists and before the fence is taken (D24). `runAccessWrite` resumes this same journal
 * through its own checks, which is why an existing row is left exactly as it is.
 *
 * It answers whether this reconcile opened the row: the write path cannot tell an operation it opened
 * itself from one its caller resumed, and only the second is a `resumed` reconcile.
 */
const openProjectionJournal = Effect.fn('AccessProjectionWriter.openProjectionJournal')(
  function* openProjectionJournalEffect(request: {
    readonly commandDigest: CommandDigest;
    readonly operationId: AccessOperationId;
    readonly scopeId: AccessScopeId;
    readonly tenantId: TenantId;
  }) {
    const port = yield* AccessWriteJournalPort;
    const existing = yield* port.readJournal({ operationId: request.operationId, tenantId: request.tenantId });
    if (Option.isSome(existing)) {
      // A resumed operation keeps the journal it opened; `runAccessWrite` refuses one that is not ours.
      return false;
    }
    const millis = yield* Clock.currentTimeMillis;
    const journal = yield* openOperationJournal({
      commandDigest: request.commandDigest,
      operationId: request.operationId,
      scopeId: request.scopeId,
      startedAt: DateTime.toDateUtc(DateTime.makeUnsafe(millis)),
      tenantId: request.tenantId,
    });
    yield* port.writeJournal(journal);
    return true;
  },
);

/**
 * D15: give the tenant's fence back when the write path did not commit this reconcile — a refused plan, an
 * unreadable intent, a journal that belongs to another command. Releasing is idempotent for the owner and
 * impossible for anybody else, and a fence the write path already released is `Ready`, so this is the
 * one cleanup both paths can share.
 */
const releaseHeldFence = Effect.fn('AccessProjectionWriter.releaseHeldFence')(function* releaseHeldFenceEffect(
  taken: TakenFence,
) {
  const port = yield* AccessWriteJournalPort;
  const current = yield* port.readFence({ scopeId: taken.scopeId, tenantId: taken.tenantId });
  const held = Option.getOrUndefined(current);
  if (held === undefined || held.state !== 'Changing' || held.owningOperationId !== taken.operationId) {
    return yield* Effect.void;
  }
  yield* releaseScopeFence({ current: held, operationId: taken.operationId });
  // The compare-and-set names the revision the fence is at now; the store moves it on as it releases.
  const outcome = yield* port.releaseFence({ ...fenceCommand(taken), expectedRevision: held.revision });
  return yield* Match.value(outcome).pipe(
    Match.tag('Released', () => Effect.void),
    Match.tag('Conflict', ({ fence }) =>
      Effect.fail(
        lifecycleRefusal(
          'fence_revision_conflict',
          `Scope ${fence.scopeId} moved to revision ${fence.revision} (${fence.state}) while operation ${taken.operationId} was releasing it`,
        ),
      ),
    ),
    Match.exhaustive,
  );
});

/** How often a projection that failed after it began writing the engine is tried again under the same fence. */
export const ACCESS_PROJECTION_ENGINE_RETRIES = 2;
export const ACCESS_PROJECTION_ENGINE_RETRY_SPACING = Duration.seconds(1);

/**
 * Project, and once the engine was touched, try again a few times under the same fence before giving up: the
 * compiler diffs against the engine, so a second run writes exactly what the first did not, and the tenant opens
 * now instead of after its lease lapsed. A refusal the engine will repeat (an invalid plan) is not tried again.
 */
const projectWithRetries = Effect.fn('AccessProjectionWriter.projectWithRetries')(function* projectWithRetriesEffect(
  project: Effect.Effect<ReconcileReport, readonly AccessProjectionError[]>,
  engineTouched: Ref.Ref<boolean>,
  lost: Ref.Ref<Option.Option<string>>,
  retriesLeft: number,
): Effect.fn.Return<Result.Result<ReconcileReport, readonly AccessProjectionError[]>> {
  const projected = yield* Effect.result(project);
  if (Result.isSuccess(projected) || retriesLeft === 0 || !(yield* Ref.get(engineTouched))) {
    return projected;
  }
  // A hold that is lost is never written under again.
  if (Option.isSome(yield* Ref.get(lost))) {
    return projected;
  }
  if (projected.failure.some(({ code }) => code === 'access_projection_engine_rejected')) {
    return projected;
  }
  yield* Effect.logWarning(
    `The access projection failed after it began writing the engine (${projected.failure.map(violationText).join('; ')}); trying again under the same fence`,
  );
  yield* Effect.sleep(ACCESS_PROJECTION_ENGINE_RETRY_SPACING);
  return yield* projectWithRetries(project, engineTouched, lost, retriesLeft - 1);
});

/**
 * The projection step of one reconcile, stated once so the write path stays readable: prove the fence is
 * still the one this reconcile took at its pinned revision (R5a-1), project the plan, and remember what the
 * engine reported. A compiler refusal is recorded for the caller and travels up the lifecycle's own
 * channel, which the write path turns into a failed journal entry.
 */
const projectionStep = Effect.fn('AccessProjectionWriter.projectionStep')(function* projectionStepEffect(input: {
  readonly compiler: AccessProjectionCompilerEngine;
  readonly digest: CommandDigest;
  /** Set once the compiler sent its first relationship write: from then on the graph may be half-written. */
  readonly engineTouched: Ref.Ref<boolean>;
  readonly fence: ProjectionFenceAssertion;
  /** Refuses an engine write this operation may no longer make: its hold is lost or unproved. */
  readonly holdStillProved: Effect.Effect<void, readonly AccessProjectionError[]>;
  readonly intent: TenantProjectionIntent;
  readonly lost: Ref.Ref<Option.Option<string>>;
  /** The tenant fence as this operation reads it, so the step states no collaborator of its own (A6/B4). */
  readonly readFence: Effect.Effect<Option.Option<ScopeFence>, AccessLifecycleError>;
  readonly refused: Ref.Ref<Option.Option<readonly AccessProjectionError[]>>;
  readonly report: Ref.Ref<Option.Option<ReconcileReport>>;
  readonly taken: TakenFence;
}) {
  const violated = (failures: readonly AccessProjectionError[]) =>
    Ref.set(input.refused, Option.some(failures)).pipe(
      Effect.andThen(Effect.fail(projectionFailedInWritePath(failures.map(violationText).join('; ')))),
    );
  const read = yield* Effect.result(input.readFence);
  if (Result.isFailure(read)) {
    return yield* violated(fenceFailure(`The tenant's scope fence could not be read: ${read.failure.reason}`));
  }
  const moved = fenceMovedIssue(read.success, input.taken.fence);
  if (Option.isSome(moved)) {
    return yield* violated(fenceFailure(moved.value));
  }
  const projected = yield* projectWithRetries(
    input.compiler.reconcile(
      { tenants: [input.intent] },
      {
        beforeWrite: input.holdStillProved.pipe(Effect.andThen(Ref.set(input.engineTouched, true))),
        fence: input.fence,
      },
    ),
    input.engineTouched,
    input.lost,
    ACCESS_PROJECTION_ENGINE_RETRIES,
  );
  if (Result.isFailure(projected)) {
    return yield* violated(projected.failure);
  }
  yield* Ref.set(input.report, Option.some(projected.success));
  return projected.success.projectionToken ?? unchangedProjectionToken(input.digest);
});

/** Everything the fenced part of one reconcile needs, decided before the fence is taken. */
interface FencedReconcileInput {
  readonly change: Parameters<typeof runAccessWrite>[0]['change'];
  readonly compiler: AccessProjectionCompilerEngine;
  readonly digest: CommandDigest;
  readonly intent: TenantProjectionIntent;
  readonly openedJournal: boolean;
  readonly operationId: AccessOperationId;
  readonly pinnedRevision: number;
  /** The holder whose lapsed hold this reconcile takes over, when the fence was not `Ready`. */
  readonly previousHolder: Option.Option<AccessOperationId>;
  /** The tenant's intent read and planned again, once the fence is held. */
  readonly replan: Effect.Effect<PlannedIntent, AccessProjectionWriteError>;
  readonly tenantId: TenantId;
  readonly tenantScopeId: AccessScopeId;
}

/**
 * End the journal this reconcile opened when it stops before the write path ran, so no row is left `validated`
 * with nobody to finish it. A journal the caller resumed is the caller's, and is left as it is.
 */
const abandonOpenedJournal = Effect.fn('AccessProjectionWriter.abandonOpenedJournal')(
  function* abandonOpenedJournalEffect(input: FencedReconcileInput, failureCode: AccessFailureBeforeEngineWrite) {
    if (!input.openedJournal) {
      return yield* Effect.void;
    }
    const port = yield* AccessWriteJournalPort;
    const current = yield* port.readJournal({ operationId: input.operationId, tenantId: input.tenantId });
    if (Option.isNone(current) || current.value.phase !== 'validated') {
      return yield* Effect.void;
    }
    const millis = yield* Clock.currentTimeMillis;
    const failed = yield* advanceOperationJournal({
      current: current.value,
      failureCode,
      operationId: input.operationId,
      phase: 'failed',
      updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe(millis)),
    });
    yield* port.writeJournal(failed);
    return yield* Effect.void;
  },
  (effect) =>
    effect.pipe(
      Effect.catchTag('AccessLifecycleError', ({ code, reason }) =>
        Effect.logWarning(`The journal of a reconcile that stopped early could not be ended (${code}: ${reason})`),
      ),
    ),
);

/**
 * Read the intent again now that the fence is held. Every Action that writes intent holds the fence's lock (shared,
 * `Ready` only) until it commits, so taking the fence waited for all of them, and this read sees every intent they
 * committed. Intent writes do not move the fence's revision, so an Action that committed between the first read and
 * the take is invisible to the compare-and-set; only this second read sees it. A moved intent is refused before the
 * engine is touched.
 */
const intentStillPlanned = Effect.fn('AccessProjectionWriter.intentStillPlanned')(function* intentStillPlannedEffect(
  input: FencedReconcileInput,
) {
  const fresh = yield* input.replan.pipe(Effect.tapError(() => abandonOpenedJournal(input, 'intent_unavailable')));
  if (fresh.digest === input.digest) {
    return yield* Effect.void;
  }
  yield* abandonOpenedJournal(input, 'intent_moved');
  // The reconcile starts again under a new operation. A fence taken over from a dead holder stays closed meanwhile:
  // this operation failed before it sent the engine anything (`intent_moved`), so the next attempt takes the fence
  // over from it at once and projects the fresh intent before the fence opens.
  return yield* new ProjectionIntentMoved({
    reason: `Tenant ${input.tenantId}'s access intent changed between this reconcile's read and its fence (plan ${input.digest.slice(0, 12)} became ${fresh.digest.slice(0, 12)}), so the plan it read was not projected`,
  });
});

/** The write path under the tenant's fence: project, commit, and report what the engine did. */
const reconcileUnderFence = Effect.fn('AccessProjectionWriter.reconcileUnderFence')(function* reconcileUnderFenceEffect(
  input: FencedReconcileInput,
  taken: TakenFence,
  engineTouched: Ref.Ref<boolean>,
  watch: HoldWatch,
) {
  const port = yield* AccessWriteJournalPort;
  const { digest, operationId, tenantId, tenantScopeId } = input;
  const held: HeldFenceRequest = { operationId, tenantId, tenantScopeId };
  // The tenant's fence is read once and remembered: every scope the plan writes rides the same lock.
  const proveHeld = yield* Effect.cached(heldFenceProof(port.readFence({ scopeId: tenantScopeId, tenantId }), held));
  const fence: ProjectionFenceAssertion = (plannedScope: ProjectionFenceScope) =>
    plannedScope.tenantId === tenantId
      ? proveHeld
      : Effect.fail(
          fenceFailure(
            `The plan writes scope ${plannedScope.scopeId} of tenant ${plannedScope.tenantId}, which is not this scope's tenant`,
          ),
        );
  const report = yield* Ref.make(Option.none<ReconcileReport>());
  const refused = yield* Ref.make(Option.none<readonly AccessProjectionError[]>());
  const write = yield* Effect.result(
    runAccessWrite({
      change: input.change,
      commandDigest: digest,
      // The fence is this writer's to give back: only while the engine is untouched (see `fencedReconcile`).
      keepFenceOnFailure: true,
      operationId,
      project: () =>
        projectionStep({
          compiler: input.compiler,
          digest,
          engineTouched,
          fence,
          holdStillProved: holdStillProved(taken, watch, port.renewFenceLease !== undefined),
          intent: input.intent,
          lost: watch.lost,
          readFence: port.readFence({ scopeId: tenantScopeId, tenantId }),
          refused,
          report,
          taken,
        }),
      scopeId: tenantScopeId,
      tenantId,
    }),
  );
  if (Result.isFailure(write)) {
    const violations = yield* Ref.get(refused);
    return yield* Option.match(violations, {
      onNone: () => fenceRefusalError(write.failure),
      onSome: (failures) =>
        projectionWriteViolation('access_projection_write_unavailable', failures.map(violationText)),
    });
  }
  const written = Option.match(yield* Ref.get(report), {
    onNone: (): Pick<TenantProjectionWrite, 'deletions' | 'touches' | 'units' | 'verified'> => ({
      deletions: 0,
      touches: 0,
      units: [],
      verified: true,
    }),
    onSome: (value) => ({
      deletions: value.deletions,
      touches: value.touches,
      units: value.units,
      verified: value.verified,
    }),
  });
  return {
    ...written,
    digest,
    operationId,
    projectionToken: write.success.projectionToken,
    // Only a journal this reconcile found already written is a resume: the row it opened itself to
    // name its own fence is the operation starting, not continuing.
    resumed: !input.openedJournal && write.success.resumed,
    scopeId: tenantScopeId,
  } satisfies TenantProjectionWrite;
});

/**
 * After a reconcile that did not commit, the fence opens only if the engine was never written. What a closed fence
 * protects: writes. Every protected Action locks the fence and runs only on a `Ready` one, so no Action commits a
 * change, and no other projection writes, against a graph that may be half-written. What it does not protect: reads.
 * Read and inspection gates do not check the fence (`bindLiveActionAccessGate` adds currentness for Actions only), so
 * reads keep answering from the graph as it is until a reconcile completes; the compiler sends revocations before
 * grants, so a half-written graph can only lack a grant being added, never keep a revoked one beside it. The fence
 * stays closed until the next reconcile (the fence sweeper, a deploy's activation, any intent write) takes it over
 * once this operation's lease lapsed (an engine write it sent may still be under way until its deadline passes), and
 * opens it only on a completed projection. A committed
 * reconcile already released the fence, and releasing an operation's released fence is a no-op.
 */
const releaseAfterReconcile = Effect.fn('AccessProjectionWriter.releaseAfterReconcile')(
  function* releaseAfterReconcileEffect(taken: TakenFence, engineTouched: Ref.Ref<boolean>) {
    if (!(yield* Ref.get(engineTouched))) {
      return yield* releaseHeldFence(taken);
    }
    const port = yield* AccessWriteJournalPort;
    const current = yield* port.readFence({ scopeId: taken.scopeId, tenantId: taken.tenantId });
    if (
      Option.exists(current, (fence) => fence.state === 'Changing' && fence.owningOperationId === taken.operationId)
    ) {
      yield* Effect.logError(
        `ACCESS FENCE KEPT CLOSED: tenant ${taken.tenantId}'s projection failed after operation ${taken.operationId} began writing the engine. Actions of the tenant are refused until a reconcile completes, while reads answer from the graph as it is; the fence sweeper takes it over once its lease lapsed (within ${Duration.format(ACCESS_FENCE_LEASE)})`,
      );
    }
    return yield* Effect.void;
  },
  (effect) =>
    effect.pipe(
      // A release that fails leaves the fence to its owner; the refusal already being reported is the one that counts.
      Effect.catchTag('AccessLifecycleError', ({ code, reason }) =>
        Effect.logWarning(
          `The tenant scope fence could not be released after a refused reconcile (${code}: ${reason})`,
        ),
      ),
    ),
);

/**
 * Take the tenant's fence at the pinned revision, reconcile under it, and give it back. A reconcile that stops before
 * the write path committed releases the fence itself, but only while it has not written to the engine; a committed
 * one already did, and releasing an operation's released fence is a `Ready` no-op (D15).
 */
const fencedReconcile = Effect.fn('AccessProjectionWriter.fencedReconcile')(function* fencedReconcileEffect(
  input: FencedReconcileInput,
) {
  const { operationId, tenantId, tenantScopeId } = input;
  // The hold counts as proved from before the take was sent: the take may wait behind Actions' locks, and the lease
  // the database sets is measured from when it was written, so this side's limit never outlasts the lease.
  const takeSentAt = yield* Clock.currentTimeMillis;
  const taken: TakenFence = {
    fence: yield* takeTenantFence({
      expectedRevision: input.pinnedRevision,
      operationId,
      previousHolder: input.previousHolder,
      scopeId: tenantScopeId,
      tenantId,
    }).pipe(
      Effect.mapError(fenceRefusalError),
      // A refused take leaves no `validated` journal behind: every refused attempt would otherwise add one.
      Effect.tapError(() => abandonOpenedJournal(input, 'fence_refused')),
    ),
    operationId,
    scopeId: tenantScopeId,
    tenantId,
  };
  const watch: HoldWatch = {
    lost: yield* Ref.make(Option.none<string>()),
    provedAt: yield* Ref.make(takeSentAt),
  };
  // The renewal runs beside the write and stops with it; it is interruptible although the write is not.
  yield* renewHeldLease(taken, watch).pipe(
    Effect.onExit(renewalEnded(taken, watch)),
    Effect.interruptible,
    Effect.forkScoped,
  );
  const engineTouched = yield* Ref.make(false);
  const reconciled = intentStillPlanned(input).pipe(
    Effect.andThen(reconcileUnderFence(input, taken, engineTouched, watch)),
  );
  // A fence taken over from a dead holder opens only on a committed reconcile (the write path releases it then);
  // anything short of that leaves it held, its lease lapsing to the next taker.
  return yield* Option.isSome(input.previousHolder)
    ? reconciled
    : reconciled.pipe(Effect.ensuring(releaseAfterReconcile(taken, engineTouched)));
}, Effect.scoped);

/** One attempt of a reconcile, under one operation: pin, read, plan, journal, then the fenced write. */
const reconcileAttempt = (compiler: AccessProjectionCompilerEngine, loader: ProjectionIntentReads) =>
  Effect.fn('AccessProjectionWriter.reconcileAttempt')(function* reconcileAttemptEffect(
    request: TenantProjectionRequest,
  ) {
    const { scope } = request;
    const tenantId = TenantIdSchema.make(scope.tenantId);
    const crypto = yield* Crypto.Crypto;
    const operationId = yield* Option.match(Option.fromUndefinedOr(request.operationId), {
      onNone: () =>
        crypto.randomUUIDv4().pipe(
          Effect.map((minted) => AccessOperationIdSchema.make(minted)),
          Effect.mapError((cause) =>
            projectionWriteRefusal(
              'access_projection_write_unavailable',
              `An identifier for this operation could not be generated, so nothing was projected: ${cause.message}`,
            ),
          ),
        ),
      // A caller that resumed a journal of its own continues that operation (D24).
      onSome: (resumed: AccessOperationId) => Effect.succeed(resumed),
    });
    const port = yield* AccessWriteJournalPort;
    // Which fence: the tenant context scope's own, because a tenant is projected whole (D13). It is resolved
    // on its own so this reconcile can pin the fence's revision before it reads a single intent row.
    const fenceScope = yield* loader.loadTenantContextScopeId(scope).pipe(Effect.mapError(intentFailure));
    if (Option.isNone(fenceScope)) {
      return yield* projectionWriteRefusal(
        'access_projection_write_scope_missing',
        `Tenant ${scope.tenantId} has no tenant-context access scope, so no fence covers its projection`,
      );
    }
    const tenantScopeId = fenceScope.value;
    // R5a-1: the fence's revision is pinned before the snapshot is read, and the compare-and-set below spends
    // it, so a snapshot another operation's write has already overtaken is refused instead of projected.
    const pinned = yield* port
      .readFence({ scopeId: tenantScopeId, tenantId })
      .pipe(
        Effect.mapError((cause) =>
          fenceRefusalError(
            lifecycleRefusal('fence_store_unavailable', `The tenant's scope fence could not be read: ${cause.reason}`),
          ),
        ),
      );
    // A fence another operation holds may be taken over once that holder's lease has lapsed; whether it has is the
    // store's decision (database clock), made atomically when this reconcile tries to take the fence.
    const previousHolder = pinned.pipe(
      Option.flatMap((current) =>
        current.state === 'Changing' &&
        current.owningOperationId !== undefined &&
        current.owningOperationId !== operationId &&
        port.takeOverExpiredFence !== undefined
          ? Option.some(current.owningOperationId)
          : Option.none(),
      ),
    );
    const pinnedIssue = Option.match(pinned, {
      onNone: () => Option.some(`The tenant context scope ${tenantScopeId} has no scope fence, so nothing may write`),
      onSome: (current) =>
        current.state === 'Ready' || Option.isSome(previousHolder)
          ? Option.none()
          : Option.some(
              `The tenant's scope fence is ${current.state} and held by operation ${current.owningOperationId ?? 'nobody'}, so nothing may write`,
            ),
    });
    if (Option.isSome(pinnedIssue)) {
      return yield* projectionWriteRefusal('access_projection_write_fence_refused', pinnedIssue.value);
    }
    const pinnedRevision = Option.match(pinned, { onNone: () => 0, onSome: ({ revision }) => revision });
    const replan = planTenantIntent(loader, scope, tenantScopeId);
    const { digest, intent, plan } = yield* replan;
    // D9: the change is validated before the scope is locked.
    const change = yield* validateAccessChange([
      {
        check: 'projection_scope_fences_present',
        run: Effect.forEach(
          plan.fences,
          (plannedScope) =>
            scopeFenceGuard(
              port.readFence({ scopeId: AccessScopeIdSchema.make(plannedScope.scopeId), tenantId }),
              plannedScope.scopeId,
            ),
          { concurrency: 1, discard: true },
        ),
      },
    ]).pipe(Effect.mapError(fenceRefusalError));
    // The fence may only name a journaled operation, and that journal carries the plan's digest (D24).
    const openedJournal = yield* openProjectionJournal({
      commandDigest: digest,
      operationId,
      scopeId: tenantScopeId,
      tenantId,
    }).pipe(Effect.mapError(fenceRefusalError));
    // From the moment the fence is taken until it is released, the reconcile runs to its end even when its fiber
    // is interrupted (a process stopping on SIGTERM, a caller's time budget): an interrupt that cut the engine write
    // short and then released the fence would open the tenant on a half-written graph. The interrupt is honoured as
    // soon as the fence is given back.
    return yield* Effect.uninterruptible(
      fencedReconcile({
        change,
        compiler,
        digest,
        intent,
        openedJournal,
        operationId,
        pinnedRevision,
        previousHolder,
        replan,
        tenantId,
        tenantScopeId,
      }),
    );
  });

/**
 * The reconcile program: it states the request scope's fence and journal port in `R` and binds none of
 * them. One `runAccessWrite` is the whole write path — journal (D24), fence (D15), projection,
 * verification — and `projectionToken` is the engine's token of the write, or the identity of the intent
 * a no-op reconcile found already projected. A reconcile whose intent moved before it took the fence starts
 * again under a new operation, a bounded number of times; one its caller named cannot, and is refused.
 */
export const reconcileTenantIntent = (
  compiler: AccessProjectionCompilerEngine,
  loader: ProjectionIntentReads,
): UnboundAccessProjectionWriter['reconcileTenant'] => {
  const attempt = reconcileAttempt(compiler, loader);
  const settle = (
    request: TenantProjectionRequest,
    attempted: number,
  ): ReturnType<UnboundAccessProjectionWriter['reconcileTenant']> =>
    attempt(request).pipe(
      Effect.catchTag('ProjectionIntentMoved', ({ reason }) =>
        request.operationId === undefined && attempted < ACCESS_PROJECTION_INTENT_ATTEMPTS
          ? Effect.logInfo(`${reason}; reading it again`).pipe(Effect.andThen(settle(request, attempted + 1)))
          : Effect.fail(projectionWriteRefusal('access_projection_write_fence_refused', reason)),
      ),
    );
  return Effect.fn('AccessProjectionWriter.reconcileTenant')(function* reconcileTenantEffect(
    request: TenantProjectionRequest,
  ) {
    return yield* settle(request, 1);
  });
};

export class AccessProjectionWriter extends Context.Service<AccessProjectionWriter, AccessProjectionWriterService>()(
  '@app/core-runtime/access/intent/projection-writer/AccessProjectionWriter',
) {}

/**
 * The writer of the process. The compiler comes from the composition root (it owns the engine transport),
 * and L51's store is bound to each call's request scope, so the program keeps no tenant of its own.
 */
export const AccessProjectionWriterLive: Layer.Layer<
  AccessProjectionWriter,
  never,
  AccessProjectionCompiler | AccessWriteJournalStore | Crypto.Crypto | TenantIntentLoader
> = Layer.effect(
  AccessProjectionWriter,
  Effect.gen(function* accessProjectionWriterLayer() {
    const compiler = yield* AccessProjectionCompiler;
    const crypto = yield* Crypto.Crypto;
    const journal = yield* AccessWriteJournalStore;
    const loader = yield* TenantIntentLoader;
    const reconcile = reconcileTenantIntent(compiler, loader);
    const { renewFenceLease: renew, takeOverExpiredFence: takeOver } = journal;
    // The port of one request scope; the lease operations exist exactly when the store has them.
    const portOver = (scope: OperationalScope): AccessWriteJournalPortService => {
      const base: AccessWriteJournalPortService = {
        acquireFence: (command) => journal.acquireFence(scope, command),
        readFence: (command) => journal.readFence(scope, command),
        readJournal: (command) => journal.readJournal(scope, command),
        releaseFence: (command) => journal.releaseFence(scope, command),
        writeJournal: (entry) => journal.writeJournal(scope, entry),
      };
      return renew === undefined || takeOver === undefined
        ? base
        : {
            ...base,
            renewFenceLease: (command) => renew(scope, command),
            takeOverExpiredFence: (command) => takeOver(scope, command),
          };
    };
    return Object.freeze({
      reconcileTenant: (request: TenantProjectionRequest) =>
        reconcile(request).pipe(
          Effect.provideContext(
            Context.make(AccessWriteJournalPort, portOver(request.scope)).pipe(Context.add(Crypto.Crypto, crypto)),
          ),
        ),
    });
  }),
);

/** A writer whose engine is not configured refuses every reconcile instead of projecting nothing. */
export const unconfiguredAccessProjectionWriter = (
  code: AccessProjectionWriteErrorCode,
  reason: string,
): AccessProjectionWriterService =>
  Object.freeze({
    reconcileTenant: () => Effect.fail<AccessProjectionWriteError>(projectionWriteRefusal(code, reason)),
  });
