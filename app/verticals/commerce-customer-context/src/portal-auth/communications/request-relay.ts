import {
  ActiveApplicationCompositionService,
  loadActiveApplicationComposition,
} from '@app/core-runtime/modules/active-application-composition';
import { Config, Crypto, DateTime, Duration, Effect, Layer, Option, Ref, Result, Schedule, Schema } from 'effect';

import { portalAuthRealmConfigured } from '../../../api/portal-auth/provider/config.ts';
import { ultramodernApiMarker } from '../../../shared/ultramodern-build.ts';
import { CommercePortalAuthCommunicationRequestSubmitter } from './communication-request-submitter.ts';
import type { PortalAuthTransportAnswer } from './communication-request-submitter.ts';
import type { PortalAuthCommunicationUnavailable } from './communication-unavailable.ts';
import { CommercePortalAuthCommunicationStore } from './communication-store.ts';
import type { ClaimedCommunicationRequest } from './communication-store.ts';
import { requestOfStored } from './request.ts';
import { CommercePortalAuthTrustedScope } from './trusted-scope.ts';
import type { PortalAuthTrustedScopeUnavailable } from './trusted-scope-unavailable.ts';

/**
 * The relay of the Auth-local outbox (D1). Auth's user-triggered flows only COMMIT an issuance together with its Communication
 * Request (`protected-handoff.ts#hold`); this relay is what later submits each committed request to Communications, so a request
 * exists only for a committed issuance and the flow itself never needs a principal.
 *
 * It is at least once. A due row is leased to one relay (`FOR UPDATE SKIP LOCKED`, so two relays never take the same row) and
 * stays PENDING until the decision Communications returned is recorded under that lease. A crash, a lost answer or an expired
 * lease leaves the row due again, and the repeated submission of the same request returns Communications' stored decision
 * (its owner-local idempotency); a decision recorded by another relay first makes this relay's late record a no-op.
 *
 * Nothing here decides a message. A request whose issuance expired before it could be submitted is closed as EXPIRED without
 * being submitted; a decision that leaves no message (NO_MESSAGE, a conflict, only stopped intents) clears the issuance's
 * protected value, because nothing will ever ask for it; an issuance is never reissued to repair a stop.
 */

export interface RelayOptions {
  /** How long a claimed row belongs to this relay before another one may take it over. */
  readonly leaseMillis: number;
  readonly leaseOwner: string;
  /** Rows one tick claims. */
  readonly limit: number;
  readonly maxRetryMillis: number;
  /** The first retry delay after an unavailable intake; it doubles per attempt up to `maxRetryMillis`. */
  readonly retryMillis: number;
  /** The Tenant of the realm this relay serves; it never takes another Tenant's row. */
  readonly tenantId: string;
}

export interface RelayTickResult {
  readonly claimed: number;
  readonly conflicts: number;
  readonly decided: number;
  readonly expired: number;
  /** Rows whose lease was taken over before this relay could record their outcome. */
  readonly lost: number;
  /** Rows the production transport queued for the module's source worker (decided later by Communications). */
  readonly relayed: number;
  readonly released: number;
  /** Rows whose outcome the store could not record now: they stay leased until the lease expires, then are relayed again. */
  readonly unrecorded: number;
}

const RowResultSchema = Schema.Literals([
  'CONFLICT',
  'DECIDED',
  'EXPIRED',
  'LOST',
  'RELAYED',
  'RELEASED',
  'UNRECORDED',
]);
type RowResult = typeof RowResultSchema.Type;

/** Identities Communications owns; Auth only keeps them to tell which stored decision a row ended with. */
const CommunicationsRefSchema = Schema.String.pipe(Schema.brand('PortalAuthCommunicationsRef'));
const IntentRefSchema = Schema.String.pipe(Schema.brand('PortalAuthCommunicationsIntentRef'));
const StoredOutcomeSchema = Schema.Union([
  Schema.Struct({
    decision: Schema.Union([
      Schema.Struct({
        intents: Schema.Array(
          Schema.Struct({
            intentId: IntentRefSchema,
            reason: Schema.optionalKey(Schema.String),
            status: Schema.Literals(['NOT_SENT', 'PENDING_HANDOFF', 'SUPPRESSED']),
          }),
        ),
        kind: Schema.Literal('MESSAGE_INTENTS'),
      }),
      Schema.Struct({ kind: Schema.Literal('NO_MESSAGE'), reason: Schema.String }),
    ]),
    decisionId: CommunicationsRefSchema,
    outcome: Schema.Literal('DECIDED'),
    replayed: Schema.Boolean,
    requestId: CommunicationsRefSchema,
  }),
  Schema.Struct({
    originalDecisionId: CommunicationsRefSchema,
    outcome: Schema.Literal('CONFLICT'),
    requestId: CommunicationsRefSchema,
  }),
  Schema.Struct({ outcome: Schema.Literal('RELAYED') }),
]);
/** The safe summary a relayed row keeps: identities and closed codes, exactly as Communications answered them. */
const encodeOutcome = (submission: PortalAuthTransportAnswer) =>
  Schema.decodeUnknownEffect(StoredOutcomeSchema)(submission).pipe(
    Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(StoredOutcomeSchema))),
  );

/** Whether any message can still leave for this decision: a stop is final and is never repaired by reissuing. */
const leavesNoMessage = (submission: PortalAuthTransportAnswer): boolean => {
  if (submission.outcome === 'RELAYED') {
    // not decided yet: the issuance keeps its protected value until it is settled, superseded or expires
    return false;
  }
  if (submission.outcome === 'CONFLICT' || submission.decision.kind === 'NO_MESSAGE') {
    return true;
  }
  return !submission.decision.intents.some(({ status }) => status === 'PENDING_HANDOFF');
};

const stateOf = (submission: PortalAuthTransportAnswer) => {
  if (submission.outcome === 'DECIDED') {
    return 'DECIDED' as const;
  }
  return submission.outcome;
};

const retryDelayMillis = (options: RelayOptions, attempts: number) =>
  Math.min(options.maxRetryMillis, options.retryMillis * 2 ** Math.max(0, Math.min(attempts - 1, 20)));

const relayRow = Effect.fn('PortalAuthCommunicationRelay.relayRow')(function* relayRow(
  options: RelayOptions,
  row: ClaimedCommunicationRequest,
): Effect.fn.Return<
  RowResult,
  PortalAuthCommunicationUnavailable,
  CommercePortalAuthCommunicationRequestSubmitter | CommercePortalAuthCommunicationStore
> {
  const store = yield* CommercePortalAuthCommunicationStore;
  const submitter = yield* CommercePortalAuthCommunicationRequestSubmitter;
  const now = yield* DateTime.now;
  const { issuanceRef } = row;
  const { leaseOwner } = options;
  const ended = (completed: boolean, result: RowResult): RowResult => (completed ? result : 'LOST');
  const release = (failure: string) =>
    store
      .release({
        availableAt: DateTime.add(now, { milliseconds: retryDelayMillis(options, row.attempts) }),
        failure,
        issuanceRef,
        leaseOwner,
        now,
      })
      .pipe(Effect.map((released) => ended(released, 'RELEASED')));

  if (!DateTime.isGreaterThan(row.expiresAt, now)) {
    return yield* store
      .complete({ forget: true, issuanceRef, leaseOwner, now, outcome: Option.none(), state: 'EXPIRED' })
      .pipe(Effect.map((completed) => ended(completed, 'EXPIRED')));
  }
  const request = yield* requestOfStored(row.request).pipe(Effect.option);
  if (Option.isNone(request)) {
    // a row written through the contract always decodes; one that does not waits for its issuance to expire, never half-sent
    return yield* release('REQUEST_UNREADABLE');
  }
  const submitted = yield* submitter.submit(request.value).pipe(Effect.result);
  if (Result.isFailure(submitted)) {
    return yield* release('INTAKE_UNAVAILABLE');
  }
  const submission = submitted.success;
  const outcome = yield* encodeOutcome(submission).pipe(Effect.option);
  const state = stateOf(submission);
  return yield* store
    .complete({ forget: leavesNoMessage(submission), issuanceRef, leaseOwner, now, outcome, state })
    .pipe(Effect.map((completed) => ended(completed, state)));
});

const count = (results: readonly RowResult[], result: RowResult) => results.filter((value) => value === result).length;

/**
 * One relay tick: claim the due rows and relay each. It has no failure channel: an unreadable store or an unavailable intake
 * leaves the rows due for a later tick.
 */
export const relayCommunicationRequests = Effect.fn('PortalAuthCommunicationRelay.tick')(function* relayTick(
  options: RelayOptions,
): Effect.fn.Return<
  RelayTickResult,
  never,
  CommercePortalAuthCommunicationRequestSubmitter | CommercePortalAuthCommunicationStore
> {
  const store = yield* CommercePortalAuthCommunicationStore;
  const now = yield* DateTime.now;
  const claimed = yield* store
    .claimDue({
      leaseMillis: options.leaseMillis,
      leaseOwner: options.leaseOwner,
      limit: options.limit,
      now,
      tenantId: options.tenantId,
    })
    .pipe(Effect.orElseSucceed((): readonly ClaimedCommunicationRequest[] => []));
  const results = yield* Effect.forEach(
    claimed,
    // a store failure while ending a row leaves it leased; the lease expires and the row is relayed again
    (row) => relayRow(options, row).pipe(Effect.orElseSucceed((): RowResult => 'UNRECORDED')),
    { concurrency: 1 },
  );
  return {
    claimed: claimed.length,
    conflicts: count(results, 'CONFLICT'),
    decided: count(results, 'DECIDED'),
    expired: count(results, 'EXPIRED'),
    lost: count(results, 'LOST'),
    relayed: count(results, 'RELAYED'),
    released: count(results, 'RELEASED'),
    unrecorded: count(results, 'UNRECORDED'),
  };
});

/**
 * Clears the protected value of every expired issuance, whatever the relay may do: it needs neither the realm's trusted scope
 * nor an approved release, because clearing a value nothing may use any more is never a send. An unreadable store leaves the
 * values for the next tick; a sweep that cleared something is logged with its count only.
 */
export const sweepExpiredProtectedValues = Effect.gen(function* sweepExpiredProtectedValuesEffect() {
  const store = yield* CommercePortalAuthCommunicationStore;
  const cleared = yield* store.forgetExpired(yield* DateTime.now).pipe(Effect.orElseSucceed(() => 0));
  if (cleared > 0) {
    yield* Effect.annotateLogs(Effect.logInfo('The Portal Auth protected values of expired issuances were cleared'), {
      cleared,
    });
  }
});

const RELAY_INTERVAL = Duration.seconds(1);
const RELAY_DEFAULTS = {
  leaseMillis: 30_000,
  limit: 32,
  maxRetryMillis: 300_000,
  retryMillis: 1000,
} as const;

const RELAY_MODULE_ID = 'commerce.customer-context';

/** The approved modules of a composition, as far as the relay reads them. */
interface ApprovedModules {
  readonly composition: {
    readonly modules: readonly {
      readonly deployment: { readonly appId: string; readonly buildMarker: string };
      readonly moduleId: string;
    }[];
  };
}

/** Whether the approved release of `commerce.customer-context` in the composition is exactly this build. */
export const relayReleaseApproved = (
  deployment: { readonly appId: string; readonly buildMarker: string },
  snapshot: ApprovedModules,
): boolean =>
  snapshot.composition.modules.some(
    (module) =>
      module.moduleId === RELAY_MODULE_ID &&
      module.deployment.appId === deployment.appId &&
      module.deployment.buildMarker === deployment.buildMarker,
  );

/**
 * The relay loop for the lifetime of the layer's scope, under a lease owner unique to this process, for the Tenant of the
 * realm's trusted scope. It is the scoped maintenance loop of this module's Outbox Worker entry (the sweep of the Auth-local
 * outbox belongs to the worker host, never to a request-serving API process). Every tick first clears the protected values of
 * expired issuances (`sweepExpiredProtectedValues`), admitted or not. A tick relays only while `admitted` says the approved
 * release is this build, logging one refusal per change; a realm without a usable trusted scope relays nothing (fail closed)
 * and reports its typed, value-free configuration error once per change. A tick that moved something is logged with counts
 * only, never a request.
 */
export const makePortalAuthCommunicationRelayLive = (admitted: Effect.Effect<boolean>) =>
  Layer.effectDiscard(
    Effect.gen(function* startPortalAuthCommunicationRelay() {
      const trustedScope = yield* CommercePortalAuthTrustedScope;
      const process = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
      const leaseOwner = `portal-auth-relay:${process}`;
      /** Whether the previous tick was admitted, so a refused release is logged once per change. */
      const wasAdmitted = yield* Ref.make(true);
      /** The reason the previous tick had no trusted scope, so a configuration error is reported once per change. */
      const scopeRefusal = yield* Ref.make(Option.none<PortalAuthTrustedScopeUnavailable['reason']>());
      const unscoped = (failure: PortalAuthTrustedScopeUnavailable) =>
        Ref.getAndSet(scopeRefusal, Option.some(failure.reason)).pipe(
          Effect.flatMap((previously) =>
            Option.contains(previously, failure.reason)
              ? Effect.void
              : Effect.annotateLogs(
                  Effect.logError('The Portal Auth realm has no usable trusted Tenant; nothing is relayed'),
                  { failure: failure._tag, reason: failure.reason },
                ),
          ),
        );
      const relay = trustedScope.current.pipe(
        Effect.matchEffect({
          onFailure: unscoped,
          onSuccess: ({ tenantId }) =>
            Ref.set(scopeRefusal, Option.none()).pipe(
              Effect.andThen(relayCommunicationRequests({ ...RELAY_DEFAULTS, leaseOwner, tenantId })),
              Effect.tap((result) =>
                result.claimed === 0
                  ? Effect.void
                  : Effect.annotateLogs(Effect.logInfo('The Portal Auth communication relay tick completed'), {
                      ...result,
                    }),
              ),
            ),
        }),
        Effect.ignore,
      );
      const refused = Effect.logWarning(
        'The Portal Auth communication relay awaits an approved commerce.customer-context release',
      );
      const tick = sweepExpiredProtectedValues.pipe(
        Effect.andThen(admitted),
        Effect.flatMap((admission) =>
          Ref.getAndSet(wasAdmitted, admission).pipe(
            Effect.flatMap((previously) => {
              if (admission) {
                return relay;
              }
              return previously ? refused : Effect.void;
            }),
          ),
        ),
      );
      yield* Effect.forkScoped(tick.pipe(Effect.repeat(Schedule.spaced(RELAY_INTERVAL))));
    }),
  );

/** The relay loop admitted by the worker entry's active Application Composition: it relays only for this approved build. */
export const PortalAuthCommunicationRelayLive = Layer.unwrap(
  Effect.gen(function* portalAuthCommunicationRelay() {
    const authority = yield* ActiveApplicationCompositionService;
    const admitted = loadActiveApplicationComposition(authority).pipe(
      Effect.map((snapshot) => relayReleaseApproved(ultramodernApiMarker, snapshot)),
      Effect.orElseSucceed(() => false),
    );
    return makePortalAuthCommunicationRelayLive(admitted);
  }),
);

/** What a worker host's deployment says about adopting the relay. */
export interface PortalAuthCommunicationRelayAdoption {
  readonly realmConfigured: boolean;
  readonly relayCredentialNamed: boolean;
}

/**
 * The relay is opt-in: a worker host relays only when its deployment opted in to the Portal Auth realm AND named the relay
 * credential. Read once, when the worker entry's layer is built.
 */
export const portalAuthCommunicationRelayAdoption: Effect.Effect<PortalAuthCommunicationRelayAdoption> = Effect.all(
  {
    realmConfigured: portalAuthRealmConfigured,
    relayCredentialNamed: Config.Redacted('COMMERCE_PORTAL_AUTH_COMMUNICATION_RELAY_API_KEY').pipe(
      Config.option,
      Effect.map(Option.isSome),
      Effect.orElseSucceed(() => false),
    ),
  },
  { concurrency: 1 },
);

/**
 * Whether a worker host composes the relay loop. Any other host composes nothing: no loop, no Auth pool, and no other hosted
 * loop changed. The realm's API composition is never touched, so a deployment without Communications keeps the direct
 * e-mail delivery.
 */
export const portalAuthCommunicationRelayAdopted = (adoption: PortalAuthCommunicationRelayAdoption): boolean =>
  adoption.realmConfigured && adoption.relayCredentialNamed;
