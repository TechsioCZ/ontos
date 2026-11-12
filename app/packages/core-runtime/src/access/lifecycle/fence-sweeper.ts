import { sql } from 'drizzle-orm';
import { Clock, Duration, Effect, Option, Ref, Result, Schema } from 'effect';

import { AccessReleaseStore } from '../changes/persistence/release-store.ts';
import { AccessProjectionWriter, isFenceBusy } from '../intent/projection-writer.ts';
import { RELEASE_ACTOR_DISPLAY_NAME, releaseActorId } from '../release/activation.ts';
import { makeSystemPrincipalContextResolver, registerSystemWorkload } from '../../auth/system-principal-context.ts';
import { preserveSystemPrincipalContextTrust } from '../../auth/system-principal-context-provenance.ts';
import { CoreDatabase } from '../../db/client.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { ACCESS_FENCE_CLOCK_SKEW_MARGIN, ACCESS_FENCE_PRE_LEASE_IDLE } from './fence.ts';

/*
 * The access fence sweeper. A tenant's fence stays closed when its holder died (OOM kill, SIGKILL, host loss) or when
 * a projection failed after it wrote to the engine. A closed fence refuses the tenant's Actions; reads never check it
 * and keep answering from the graph as it is. Only the next reconcile of that tenant takes the fence over (once the
 * holder's lease lapsed, or at once when its operation failed before it sent the engine anything) and opens it on a
 * completed projection. Without the sweeper that reconcile waits for an intent write
 * or the next deploy. Once a minute the sweeper asks, in one indexed statement, which tenants have a lapsed hold, and
 * reconciles a few of them through the one writer under the tenant's platform release actor. A tenant that fails is
 * tried again later, its wait doubling up to a ceiling. With nothing lapsed a tick is that one statement.
 *
 * The host owns the loop and the backoff record (`makeAccessFenceSweepBackoffs`), and provides the writer, the
 * release store and the database at its root.
 */

/** The platform workload the sweeper reconciles as: the tenant's release actor, revalidated for every tenant. */
export const ACCESS_FENCE_SWEEP_JOB = registerSystemWorkload({ jobKey: 'access-fence-sweep' });
export const ACCESS_FENCE_SWEEP_INTERVAL = Duration.minutes(1);
/** At most this many tenants are reconciled in one tick; the rest wait for the next. */
export const ACCESS_FENCE_SWEEP_TENANTS_PER_TICK = 5;
/** How many lapsed tenants one statement reads at most (the function caps it at 100). */
const LAPSED_PAGE = 50;
export const ACCESS_FENCE_SWEEP_FIRST_BACKOFF = Duration.minutes(1);
/** Short enough that a tenant failing while the engine was down is tried again soon after the engine is back. */
export const ACCESS_FENCE_SWEEP_MAX_BACKOFF = Duration.minutes(5);

const PRE_LEASE_LAPSE_SECONDS =
  Duration.toSeconds(ACCESS_FENCE_PRE_LEASE_IDLE) + Duration.toSeconds(ACCESS_FENCE_CLOCK_SKEW_MARGIN);

export class AccessFenceSweepError extends Schema.TaggedError<AccessFenceSweepError>()('AccessFenceSweepError', {
  cause: Schema.optionalKey(Schema.Unknown),
  reason: Schema.String,
}) {}

const sweepFailure =
  (step: string) =>
  (cause: { readonly reason: string }): AccessFenceSweepError =>
    new AccessFenceSweepError({ cause, reason: `${step}: ${cause.reason}` });

/** One tenant the sweeper could not heal, and when it tries again. */
export interface AccessFenceSweepFailure {
  readonly reason: string;
  readonly retryInMillis: number;
  readonly tenantId: string;
}

/**
 * What one tick did. Tenants still waiting out their backoff, or beyond this tick's bound, are `deferred`; `busy`
 * ones were being projected by another writer (another sweep, a deploy's activation, an Action's reconcile) when
 * this one tried, and are left to it, with no failure and no backoff.
 */
export interface AccessFenceSweepReport {
  readonly busy: readonly string[];
  readonly deferred: number;
  readonly failed: readonly AccessFenceSweepFailure[];
  readonly healed: readonly string[];
}

const NOTHING_LAPSED: AccessFenceSweepReport = Object.freeze({ busy: [], deferred: 0, failed: [], healed: [] });

/** A tenant's failed attempts so far and when it is due again, on the host's clock. */
export interface Backoff {
  readonly failures: number;
  readonly retryAt: number;
}

export type AccessFenceSweepBackoffs = Ref.Ref<ReadonlyMap<string, Backoff>>;

/** The host's backoff record: one per sweeping process, empty at start. */
export const makeAccessFenceSweepBackoffs: Effect.Effect<AccessFenceSweepBackoffs> = Ref.make<
  ReadonlyMap<string, Backoff>
>(new Map());

const LapsedTenantRowsSchema = Schema.Array(Schema.Struct({ tenant_id: Schema.String }));

/** The doubling wait after `failures` failed attempts, never longer than the ceiling. */
export const accessFenceSweepBackoff = (failures: number): Duration.Duration =>
  Duration.min(
    Duration.times(ACCESS_FENCE_SWEEP_FIRST_BACKOFF, 2 ** Math.min(Math.max(failures - 1, 0), 10)),
    ACCESS_FENCE_SWEEP_MAX_BACKOFF,
  );

/**
 * The backoff record after one attempt. A heal clears every tenant's wait, not only its own: most failures are an
 * engine or database that was away, and one heal shows it is back, so every waiting tenant is due again at once. A
 * failure doubles this tenant's wait.
 */
export const accessFenceSweepBackoffsAfter = (
  current: ReadonlyMap<string, Backoff>,
  attempt: { readonly healed: boolean; readonly now: number; readonly tenantId: string },
): ReadonlyMap<string, Backoff> => {
  if (attempt.healed) {
    return current.size === 0 ? current : new Map();
  }
  const failures = (current.get(attempt.tenantId)?.failures ?? 0) + 1;
  const retryAt = attempt.now + Duration.toMillis(accessFenceSweepBackoff(failures));
  return new Map(current).set(attempt.tenantId, { failures, retryAt });
};

/**
 * The ids of tenants whose fence has a lapsed hold, oldest lapse first, without those the sweep is still waiting
 * out: one statement over the held-fence index, ids only.
 */
const readLapsedTenants = Effect.fn('AccessFenceSweeper.readLapsedTenants')(function* readLapsedTenantsEffect(
  waiting: readonly string[],
) {
  const { executor } = yield* CoreDatabase;
  const rows = yield* executor
    .execute(
      sql`select tenant_id::text as tenant_id from core.lapsed_access_fence_tenants(${LAPSED_PAGE}, pg_catalog.make_interval(secs => ${PRE_LEASE_LAPSE_SECONDS}), pg_catalog.string_to_array(${waiting.join(',')}, ',')::uuid[])`,
      'objects',
    )
    .pipe(
      Effect.mapError(
        (cause) => new AccessFenceSweepError({ cause, reason: 'the lapsed access fences could not be read' }),
      ),
    );
  return yield* Schema.decodeUnknownEffect(LapsedTenantRowsSchema)(rows).pipe(
    Effect.mapError(
      (cause) => new AccessFenceSweepError({ cause, reason: 'the lapsed access fences were not tenant ids' }),
    ),
  );
});

/** The tenant's platform release actor, ensured and resolved as a trusted system scope (never minted). */
const sweepScopeOf = Effect.fn('AccessFenceSweeper.scope')(function* sweepScopeEffect(
  tenantId: string,
  runReference: string,
) {
  const releases = yield* AccessReleaseStore;
  const { executor } = yield* CoreDatabase;
  yield* releases
    .ensureReleaseActor({ displayName: RELEASE_ACTOR_DISPLAY_NAME, principalId: releaseActorId(tenantId), tenantId })
    .pipe(Effect.mapError(sweepFailure('the release actor could not be ensured')));
  const resolved = yield* makeSystemPrincipalContextResolver({ executor })
    .resolve({ principalId: releaseActorId(tenantId), registration: ACCESS_FENCE_SWEEP_JOB, runReference, tenantId })
    .pipe(Effect.mapError(sweepFailure('the release actor could not act')));
  return preserveSystemPrincipalContextTrust(resolved, {
    ...resolved,
    correlationId: `access-fence-sweep:${runReference}`,
  }) satisfies OperationalScope;
});

/**
 * Reconcile one tenant through the one writer; the writer takes the lapsed fence over and opens it on success. It
 * answers `false` when another writer took the fence first (it holds it under a live lease, or moved it since): that
 * writer is healing the tenant.
 */
const healTenant = Effect.fn('AccessFenceSweeper.healTenant')(function* healTenantEffect(
  tenantId: string,
  runReference: string,
) {
  const writer = yield* AccessProjectionWriter;
  const scope = yield* sweepScopeOf(tenantId, runReference);
  return yield* writer.reconcileTenant({ scope }).pipe(
    Effect.as(true),
    Effect.catchIf(isFenceBusy, () => Effect.succeed(false)),
    Effect.mapError(sweepFailure('the projection was not reconciled')),
  );
});

/**
 * One tenant: healed (`Some`, every backoff forgotten), busy with another writer (`None`, nothing recorded), or
 * failed (its wait doubled).
 */
const attemptTenant = Effect.fn('AccessFenceSweeper.attempt')(function* attemptTenantEffect(
  backoffs: AccessFenceSweepBackoffs,
  tenantId: string,
  runReference: string,
): Effect.fn.Return<
  Result.Result<Option.Option<string>, AccessFenceSweepFailure>,
  never,
  AccessProjectionWriter | AccessReleaseStore | CoreDatabase
> {
  const healed = yield* Effect.result(healTenant(tenantId, runReference));
  if (Result.isSuccess(healed) && !healed.success) {
    return Result.succeed(Option.none());
  }
  const now = yield* Clock.currentTimeMillis;
  const after = yield* Ref.updateAndGet(backoffs, (current) =>
    accessFenceSweepBackoffsAfter(current, { healed: Result.isSuccess(healed), now, tenantId }),
  );
  if (Result.isSuccess(healed)) {
    return Result.succeed(Option.some(tenantId));
  }
  const retryInMillis = (after.get(tenantId)?.retryAt ?? now) - now;
  return Result.fail({ reason: healed.failure.reason, retryInMillis, tenantId });
});

/**
 * One tick. It fails only when the lapsed tenants cannot be read at all; a tenant that could not be healed is
 * reported with its next try.
 */
export const sweepLapsedAccessFences = Effect.fn('AccessFenceSweeper.sweep')(function* sweepLapsedAccessFencesEffect(
  backoffs: AccessFenceSweepBackoffs,
  runReference: string,
) {
  const now = yield* Clock.currentTimeMillis;
  const backedOff = yield* Ref.get(backoffs);
  const waiting = [...backedOff].flatMap(([tenantId, { retryAt }]) => (retryAt > now ? [tenantId] : []));
  const lapsed = yield* readLapsedTenants(waiting);
  if (lapsed.length === 0 && waiting.length === 0) {
    // Nothing is held past its lease: forget every backoff, so a tenant that lapses again starts afresh.
    if (backedOff.size > 0) {
      yield* Ref.set(backoffs, new Map());
    }
    return NOTHING_LAPSED;
  }
  const chosen = lapsed.slice(0, ACCESS_FENCE_SWEEP_TENANTS_PER_TICK).map(({ tenant_id: tenantId }) => tenantId);
  const outcomes = yield* Effect.forEach(chosen, (tenantId) => attemptTenant(backoffs, tenantId, runReference), {
    concurrency: 1,
  });
  const settled = outcomes.flatMap((outcome) => (Result.isSuccess(outcome) ? [outcome.success] : []));
  const healed = settled.flatMap((tenant) => Option.toArray(tenant));
  return {
    busy: chosen.filter((_tenantId, index) => {
      const outcome = outcomes[index];
      return outcome !== undefined && Result.isSuccess(outcome) && Option.isNone(outcome.success);
    }),
    deferred: waiting.length + lapsed.length - chosen.length,
    failed: outcomes.flatMap((outcome) => (Result.isFailure(outcome) ? [outcome.failure] : [])),
    healed,
  } satisfies AccessFenceSweepReport;
});
