import { ApplicationCompositionModuleSchema } from '@app/core-runtime';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/outbox/worker';
import { Array as EffectArray, Clock, Duration, Effect, Layer, Match, Option, Ref, Schedule, Schema } from 'effect';

import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { GatewayReconciliationInvoker } from '../integrations/psp/gateway-reconciliation-invoker.ts';
import type {
  GatewayReconciliationOutcome,
  GatewayReconciliationSkipReason,
} from '../integrations/psp/gateway-reconciliation-invoker.ts';
import { ReconciliationCredentials } from '../integrations/psp/reconciliation-credentials.ts';
import type { ReconciliationApiKey } from '../integrations/psp/reconciliation-credentials.ts';
import { GatewayReconciliationDueSource } from '../persistence/gateway-reconciliation-due.ts';
import type { GatewayReconciliationDueRow } from '../persistence/gateway-reconciliation-due.ts';

/**
 * Gateway reconciliation driver (#1158, #1153, phase 2 D-P5): the one thing that comes back for gateway
 * operations whose outcome nobody will report on their own (a lost create, a GoPay or Comgate payment with no
 * notification, evidence that could not be submitted). It runs as one scoped fiber of the Payment Outbox Worker
 * entry and only asks A10 for a recovery of a listed debt row. It never calls a provider, never picks a recovery
 * mode and never marks anything resolved; unresolved debt stays in the public debt Read whatever happens here.
 *
 * Every decision about time is made by the cross-Tenant listing routine with its own transaction's `now()`
 * (#1234): round budget, backoff and the acknowledged wait budget. The tick passes no time to it, and selection
 * is finished before the first request, so a slow request cannot change what this tick decided for later rows.
 *
 * Two drivers (replicas, or a dedicated worker next to a host-mode one) read the same row with the same round,
 * so they send the same idempotency key and payload, and Core commits one A10 invocation. Nothing is retried
 * within a tick: a lost answer is retried with the identical request in a later tick, or not at all once the
 * committed round makes the operation wait for its backoff.
 *
 * The tick has no failure channel and logs only when it did something or could not do it.
 */

export const GATEWAY_RECONCILIATION_INTERVAL = Duration.seconds(60);
export const GATEWAY_RECONCILIATION_LIMITS = Object.freeze({
  /** A10 takes the Payment row lock; two requests at a time keep the database pressure low. */
  callConcurrency: 2,
  callsPerFamily: 15,
  callsPerLegalEntity: 20,
  callsPerTick: 50,
  cooldownMs: 3_600_000,
  /** With the 24 h backoff cap this covers about 19 days of rounds; after that a person owns the debt. */
  maxRounds: 24,
  pageLimit: 50,
  pages: 4,
  payerContactMaxAgeHours: 48,
});
const LIMITS = GATEWAY_RECONCILIATION_LIMITS;
const PAYMENT_MODULE_ID = 'payment.core';

export interface GatewayReconciliationSweepResult {
  /** Rows not requested this tick: a cooled-down or stopped Tenant, no key, or a spent budget. */
  readonly deferred: number;
  readonly failures: readonly string[];
  readonly listed: number;
  readonly purged: number;
  readonly requested: number;
  readonly skipped: number;
  readonly unavailable: number;
}

const EMPTY_RESULT: GatewayReconciliationSweepResult = Object.freeze({
  deferred: 0,
  failures: [],
  listed: 0,
  purged: 0,
  requested: 0,
  skipped: 0,
  unavailable: 0,
});

type Deployment = Readonly<{ appId: string; buildMarker: string }>;
type Cooldowns = ReadonlyMap<string, number>;
type Selected = readonly [GatewayReconciliationDueRow, ReconciliationApiKey];

const ModuleAbiSchema = Schema.Struct({
  publicContract: ApplicationCompositionModuleSchema.fields.publicContract,
  requiredCoreCapabilities: ApplicationCompositionModuleSchema.fields.requiredCoreCapabilities,
  requiredShellAbi: ApplicationCompositionModuleSchema.fields.requiredShellAbi,
  sharedSingletons: ApplicationCompositionModuleSchema.fields.sharedSingletons,
});
type ModuleAbi = typeof ModuleAbiSchema.Type;
const sameModuleAbi = Schema.toEquivalence(ModuleAbiSchema);

const rowKey = (row: GatewayReconciliationDueRow) => `${row.operationId}:r${row.round}`;
const scopeKey = (row: GatewayReconciliationDueRow) => `${row.tenantId}/${row.legalEntityId}`;
const familyStopKey = (row: GatewayReconciliationDueRow) => `${row.tenantId}/${row.providerFamily}`;

const stillActive = (cooldowns: Cooldowns, now: number): Cooldowns =>
  new Map([...cooldowns].filter(([, until]) => until > now));

const coolDown = (cooldowns: Ref.Ref<Cooldowns>, key: string) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => Ref.update(cooldowns, (current) => new Map([...current, [key, now + LIMITS.cooldownMs]]))),
  );

/** Budgets, cooldowns and keys, decided for the whole tick before the first request. */
export const selectGatewayReconciliationRows = (
  rows: readonly GatewayReconciliationDueRow[],
  keys: ReadonlyMap<string, Option.Option<ReconciliationApiKey>>,
  rowCooldowns: Cooldowns,
) => {
  const perScope = new Map<string, number>();
  const perFamily = new Map<string, number>();
  const selected: Selected[] = [];
  for (const row of rows) {
    const key = Option.flatten(Option.fromUndefinedOr(keys.get(row.tenantId)));
    if (
      Option.isSome(key) &&
      !rowCooldowns.has(rowKey(row)) &&
      selected.length < LIMITS.callsPerTick &&
      (perScope.get(scopeKey(row)) ?? 0) < LIMITS.callsPerLegalEntity &&
      (perFamily.get(row.providerFamily) ?? 0) < LIMITS.callsPerFamily
    ) {
      perScope.set(scopeKey(row), (perScope.get(scopeKey(row)) ?? 0) + 1);
      perFamily.set(row.providerFamily, (perFamily.get(row.providerFamily) ?? 0) + 1);
      selected.push([row, key.value]);
    }
  }
  return { deferred: rows.length - selected.length, selected };
};

/** What one answer does to the rest of this tick and to later ticks. */
interface Settlement {
  readonly coolRow: boolean;
  readonly coolTenant: boolean;
  /** A Tenant or a Tenant provider family that gets no further request in this tick. */
  readonly stop: Option.Option<string>;
}

const NO_SETTLEMENT: Settlement = { coolRow: false, coolTenant: false, stop: Option.none() };

const skipSettlement = (row: GatewayReconciliationDueRow, reason: GatewayReconciliationSkipReason): Settlement =>
  Match.value(reason).pipe(
    Match.whenOr('forbidden', 'module_state', () => ({
      ...NO_SETTLEMENT,
      coolTenant: true,
      stop: Option.some(row.tenantId),
    })),
    Match.when('drain', () => ({ ...NO_SETTLEMENT, stop: Option.some(row.tenantId) })),
    Match.orElse(() => ({ ...NO_SETTLEMENT, coolRow: true })),
  );

/**
 * A refused key, workload or module state cools the Tenant down for an hour; a drain stops the Tenant for this
 * tick; an unavailable answer stops only that Tenant's provider family for this tick (H1094-01=A), so an outage
 * behind one binding never blocks another family; a refusal a person owns cools only that row's round.
 */
export const settlementOf = (row: GatewayReconciliationDueRow, outcome: GatewayReconciliationOutcome): Settlement =>
  Match.valueTags(outcome, {
    REQUESTED: () => NO_SETTLEMENT,
    SKIPPED: ({ reason }) => skipSettlement(row, reason),
    UNAVAILABLE: () => ({ ...NO_SETTLEMENT, stop: Option.some(familyStopKey(row)) }),
  });

interface Tally {
  requested: number;
  skipped: number;
  unavailable: number;
}

const tally = (outcomes: readonly GatewayReconciliationOutcome[]): Tally => {
  const counts: Tally = { requested: 0, skipped: 0, unavailable: 0 };
  for (const outcome of outcomes) {
    Match.valueTags(outcome, {
      REQUESTED: () => {
        counts.requested += 1;
      },
      SKIPPED: () => {
        counts.skipped += 1;
      },
      UNAVAILABLE: () => {
        counts.unavailable += 1;
      },
    });
  }
  return counts;
};

interface Listing {
  readonly failure: Option.Option<string>;
  readonly rows: readonly GatewayReconciliationDueRow[];
}

export interface GatewayReconciliationSweep {
  /** One tick. It has no failure channel. */
  readonly sweep: Effect.Effect<GatewayReconciliationSweepResult>;
}

/** Builds the driver tick for the compiled artifact `deployment`. */
export const makeGatewayReconciliationSweep = Effect.fn('GatewayReconciliationDriver.make')(
  function* makeGatewayReconciliationSweep(deployment: Deployment) {
    const authority = yield* ActiveApplicationCompositionService;
    const source = yield* GatewayReconciliationDueSource;
    const credentials = yield* ReconciliationCredentials;
    const invoker = yield* GatewayReconciliationInvoker;
    const pinnedAbi = yield* Ref.make(Option.none<ModuleAbi>());
    /** Whether the previous tick was admitted, so a refused release is logged once per change. */
    const wasAdmitted = yield* Ref.make(true);
    /** Tenants whose key, workload or module state was refused, until the given instant. */
    const tenantCooldowns = yield* Ref.make<Cooldowns>(new Map());
    /** `operationId:r<round>` refused by A10 for a reason a person owns, until the given instant. */
    const rowCooldowns = yield* Ref.make<Cooldowns>(new Map());

    /** This compiled Payment artifact must be the approved `payment.core`, with the ABI it first saw. */
    const admitRelease = authority.load.pipe(
      Effect.flatMap(validateActiveApplicationCompositionSnapshot),
      Effect.flatMap(({ composition }) => {
        const approved = composition.modules.find(({ moduleId }) => moduleId === PAYMENT_MODULE_ID);
        if (
          approved === undefined ||
          approved.deployment.appId !== deployment.appId ||
          approved.deployment.buildMarker !== deployment.buildMarker
        ) {
          return Effect.succeed(false);
        }
        const abi: ModuleAbi = {
          publicContract: approved.publicContract,
          requiredCoreCapabilities: approved.requiredCoreCapabilities,
          requiredShellAbi: approved.requiredShellAbi,
          sharedSingletons: approved.sharedSingletons,
        };
        return Ref.modify(pinnedAbi, (pinned) =>
          Option.match(pinned, {
            onNone: () => [true, Option.some(abi)] as const,
            onSome: (previous) => [sameModuleAbi(previous, abi), pinned] as const,
          }),
        );
      }),
      Effect.orElseSucceed(() => false),
    );

    const listFrom = (
      after: Option.Option<GatewayReconciliationDueRow>,
      page: number,
      read: readonly GatewayReconciliationDueRow[],
    ): Effect.Effect<Listing> =>
      source.listDue({ after, maxRounds: LIMITS.maxRounds, pageLimit: LIMITS.pageLimit }).pipe(
        Effect.matchEffect({
          // A page that cannot be read ends the listing with what was read so far.
          onFailure: ({ reason }) => Effect.succeed<Listing>({ failure: Option.some(reason), rows: read }),
          onSuccess: (rows) => {
            const next = [...read, ...rows];
            const last = rows.at(-1);
            return last === undefined || rows.length < LIMITS.pageLimit || page + 1 >= LIMITS.pages
              ? Effect.succeed<Listing>({ failure: Option.none(), rows: next })
              : listFrom(Option.some(last), page + 1, next);
          },
        }),
      );

    const purge = source.purgeExpiredPayerContacts(LIMITS.payerContactMaxAgeHours).pipe(
      Effect.map((purged) => ({ failure: Option.none<string>(), purged })),
      Effect.catchTag('GatewayReconciliationDueUnavailable', ({ reason }) =>
        Effect.succeed({ failure: Option.some(reason), purged: 0 }),
      ),
    );

    const runTick = Effect.fn('GatewayReconciliationDriver.tick')(function* runTick() {
      const [{ failure: purgeFailure, purged }, listing] = yield* Effect.all([purge, listFrom(Option.none(), 0, [])], {
        concurrency: 2,
      });
      const now = yield* Clock.currentTimeMillis;
      const [cooledTenants, cooledRows, tick] = yield* Effect.all(
        [
          Ref.updateAndGet(tenantCooldowns, (current) => stillActive(current, now)),
          Ref.updateAndGet(rowCooldowns, (current) => stillActive(current, now)),
          credentials.load,
        ],
        { concurrency: 1 },
      );
      const tenants = EffectArray.dedupe(listing.rows.map(({ tenantId }) => tenantId)).filter(
        (tenantId) => !cooledTenants.has(tenantId),
      );
      const keys = new Map(
        yield* Effect.forEach(
          tenants,
          (tenantId) => tick.forTenant(tenantId).pipe(Effect.map((key) => [tenantId, key] as const)),
          { concurrency: 1 },
        ),
      );
      const { deferred, selected } = selectGatewayReconciliationRows(listing.rows, keys, cooledRows);

      // Stops within this tick: a drained or refusing Tenant, and an unavailable provider family of a Tenant.
      const stopped = yield* Ref.make<ReadonlySet<string>>(new Set());
      const stop = (key: string) => Ref.update(stopped, (current) => new Set([...current, key]));
      const settle = Effect.fn('GatewayReconciliationDriver.settle')(function* settle(
        row: GatewayReconciliationDueRow,
        outcome: GatewayReconciliationOutcome,
      ) {
        const { coolRow, coolTenant, stop: stopKey } = settlementOf(row, outcome);
        if (coolTenant) {
          yield* coolDown(tenantCooldowns, row.tenantId);
        }
        if (coolRow) {
          yield* coolDown(rowCooldowns, rowKey(row));
        }
        if (Option.isSome(stopKey)) {
          yield* stop(stopKey.value);
        }
      });
      const requestRow = Effect.fn('GatewayReconciliationDriver.request')(function* requestRow([row, key]: Selected) {
        const halted = yield* Ref.get(stopped);
        if (halted.has(row.tenantId) || halted.has(familyStopKey(row))) {
          return Option.none<GatewayReconciliationOutcome>();
        }
        const outcome = yield* invoker.request(row, key);
        yield* settle(row, outcome);
        return Option.some(outcome);
      });
      const outcomes = yield* Effect.forEach(selected, requestRow, { concurrency: LIMITS.callConcurrency });
      const answered = outcomes.flatMap(Option.toArray);
      return {
        ...tally(answered),
        deferred: deferred + outcomes.length - answered.length,
        failures: [...Option.toArray(purgeFailure), ...Option.toArray(listing.failure)],
        listed: listing.rows.length,
        purged,
      } satisfies GatewayReconciliationSweepResult;
    });

    const sweep = admitRelease.pipe(
      Effect.flatMap((admitted) =>
        Ref.getAndSet(wasAdmitted, admitted).pipe(
          Effect.flatMap((previously) => {
            if (admitted) {
              return runTick();
            }
            return previously
              ? Effect.logWarning('The Payment reconciliation driver awaits an approved payment.core release').pipe(
                  Effect.as(EMPTY_RESULT),
                )
              : Effect.succeed(EMPTY_RESULT);
          }),
        ),
      ),
    );
    return { sweep } satisfies GatewayReconciliationSweep;
  },
);

const actedOn = (result: GatewayReconciliationSweepResult) =>
  result.purged > 0 ||
  result.requested > 0 ||
  result.skipped > 0 ||
  result.unavailable > 0 ||
  result.failures.length > 0;

/** First tick after one interval, then one tick per interval for the lifetime of the scope. */
export const runGatewayReconciliationLoop = (sweep: Effect.Effect<GatewayReconciliationSweepResult>) =>
  sweep.pipe(
    Effect.tap((result) =>
      actedOn(result)
        ? Effect.annotateLogs(Effect.logInfo('The Payment reconciliation driver tick completed'), {
            deferred: result.deferred,
            failures: result.failures.join('; '),
            listed: result.listed,
            purged: result.purged,
            requested: result.requested,
            skipped: result.skipped,
            unavailable: result.unavailable,
          })
        : Effect.void,
    ),
    Effect.repeat(Schedule.spaced(GATEWAY_RECONCILIATION_INTERVAL)),
    Effect.delay(GATEWAY_RECONCILIATION_INTERVAL),
    Effect.asVoid,
  );

/** The driver fiber, started and interrupted with the Payment Outbox Worker entry's layer scope. */
export const GatewayReconciliationDriverLive = Layer.effectDiscard(
  makeGatewayReconciliationSweep(ultramodernApiMarker).pipe(
    Effect.flatMap(({ sweep }) => Effect.forkScoped(runGatewayReconciliationLoop(sweep))),
  ),
);
