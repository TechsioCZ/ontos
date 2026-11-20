import { Context, DateTime, Effect, HashMap, Layer, Option, Ref } from 'effect';
import type { Redacted } from 'effect';

import { portalAuthOwnerRenderedSlotOf } from '../../../shared/portal-auth-communications.ts';
import type { PortalAuthEmailFlow, PortalAuthIssuanceRef } from '../../../shared/portal-auth-communications.ts';
import type { PortalAuthIssuanceStateUnavailable } from './issuance-state-unavailable.ts';
import type { HeldIssuance, IssuanceCurrentness, PortalAuthIssuance } from './issuance.ts';
import { OwnerSlotStop } from './owner-slot-stop.ts';

/**
 * The PROTECTED Auth handoff (ADR-0022): the one place that holds the secret of an issuance between the moment the
 * provider issues it and the moment Auth completes the owner-rendered slot of an approved message.
 *
 * It is NOT a token store and NOT a ledger: it keeps no copy beyond this process, writes nothing, and loses every entry
 * on restart. It holds a value only until the issuance expires or is spent, and it never offers the value to the generic
 * path: the single way out is `revealSecret`, which answers only for the exact issuance, only for its own owner-rendered
 * slot and only while Auth's Current lifecycle says the issuance is usable. Nothing is ever reproduced or reissued here;
 * a restart, an expiry or a spent issuance is a truthful stop and only Auth itself can issue a new one.
 *
 * Per-flow restart recognition (AC-06): after a restart the issuance is recognised only as NOT_RESUMABLE. The verification
 * link is a stateless signed token, a reset link is not reproducible from Auth's digest-only ledger, and a one-time code is
 * never stored by Auth outside the provider, so none of the three can be rebuilt safely; Auth's answer is the stop.
 */

/** What Auth's own ledger says about a held issuance now. A flow without a ledger answers CURRENT and relies on expiry and settlement. */
export type IssuanceLedgerProbe = (
  held: HeldIssuance,
) => Effect.Effect<'CURRENT' | 'NO_LONGER_CURRENT', PortalAuthIssuanceStateUnavailable>;

/** The provider-issuance context the enrollment gateway reserves BEFORE it asks the provider to issue, so the callback can name the issuance. */
export interface IssuanceReservation {
  readonly enrollmentOwnerInvocationId?: string;
  readonly issuanceRef: PortalAuthIssuanceRef;
}

export interface ProtectedHandoffService {
  readonly currentness: (
    issuanceRef: PortalAuthIssuanceRef,
  ) => Effect.Effect<IssuanceCurrentness, PortalAuthIssuanceStateUnavailable>;
  /** Where the completed slot of this issuance's message goes: the ORIGINAL address, only while the issuance is Current. */
  readonly endpointOf: (
    issuanceRef: PortalAuthIssuanceRef,
  ) => Effect.Effect<Option.Option<Redacted.Redacted>, PortalAuthIssuanceStateUnavailable>;
  readonly forget: (issuanceRef: PortalAuthIssuanceRef) => Effect.Effect<void>;
  /** Holds one issuance; `supersede` revokes the earlier issuance of the same flow and subject (a new link or code replaces it). */
  readonly hold: (held: HeldIssuance, options: { readonly supersede: boolean }) => Effect.Effect<void>;
  /** The safe facts Auth tells Communications about the issuance; never the protected side. */
  readonly issuanceOf: (issuanceRef: PortalAuthIssuanceRef) => Effect.Effect<Option.Option<PortalAuthIssuance>>;
  readonly reserve: (input: {
    readonly flow: PortalAuthEmailFlow;
    readonly providerSubjectId: string;
    readonly reservation: IssuanceReservation;
  }) => Effect.Effect<void>;
  /** The secret of the exact owner-rendered slot, only while the issuance is Current. Never reproduced, never reissued. */
  readonly revealSecret: (input: {
    readonly flow: PortalAuthEmailFlow;
    readonly issuanceRef: PortalAuthIssuanceRef;
    readonly slot: string;
  }) => Effect.Effect<Redacted.Redacted, OwnerSlotStop | PortalAuthIssuanceStateUnavailable>;
  /** Auth's own lifecycle event: the issuance was spent or revoked. */
  readonly settle: (input: {
    readonly issuanceRef: PortalAuthIssuanceRef;
    readonly state: 'CONSUMED' | 'REVOKED';
  }) => Effect.Effect<void>;
  readonly takeReservation: (
    flow: PortalAuthEmailFlow,
    providerSubjectId: string,
  ) => Effect.Effect<Option.Option<IssuanceReservation>>;
}

export class CommercePortalAuthProtectedHandoff extends Context.Service<
  CommercePortalAuthProtectedHandoff,
  ProtectedHandoffService
>()('@app/commerce-customer-context/portal-auth/communications/protected-handoff/CommercePortalAuthProtectedHandoff') {}

interface Entry {
  readonly held: HeldIssuance;
  readonly settled: Option.Option<'CONSUMED' | 'REVOKED'>;
}
type Entries = HashMap.HashMap<PortalAuthIssuanceRef, Entry>;

const reservationKey = (flow: PortalAuthEmailFlow, providerSubjectId: string) => `${flow}|${providerSubjectId}`;
const isLive = (now: DateTime.Utc) => (entry: Entry) => DateTime.isGreaterThan(entry.held.issuance.expiresAt, now);

const revokeIfSameSubject = (incoming: PortalAuthIssuance) => (entry: Entry) =>
  entry.held.issuance.flow === incoming.flow &&
  entry.held.issuance.providerSubjectId === incoming.providerSubjectId &&
  Option.isNone(entry.settled)
    ? { ...entry, settled: Option.some('REVOKED' as const) }
    : entry;

/** The entries after one more issuance: expired entries are dropped (bounding memory), and a superseding issuance revokes its predecessor. */
const withIssuance = (entries: Entries, incoming: HeldIssuance, now: DateTime.Utc, supersede: boolean): Entries => {
  const live = entries.pipe(HashMap.filter(isLive(now)));
  const kept = supersede ? live.pipe(HashMap.map(revokeIfSameSubject(incoming.issuance))) : live;
  return kept.pipe(HashMap.set(incoming.issuance.issuanceRef, { held: incoming, settled: Option.none() }));
};

const settledAs = (state: 'CONSUMED' | 'REVOKED') => (entry: Entry) => ({
  ...entry,
  settled: Option.orElse(entry.settled, () => Option.some(state)),
});

/** The handoff over one process-local state. `ledgerProbe` is Auth's own Current-state reader of its ledger. */
export const protectedHandoffLayer = (ledgerProbe: IssuanceLedgerProbe) =>
  Layer.effect(
    CommercePortalAuthProtectedHandoff,
    Effect.gen(function* makeProtectedHandoff() {
      const held = yield* Ref.make<Entries>(HashMap.empty());
      const reservations = yield* Ref.make(HashMap.empty<string, IssuanceReservation>());

      const entryOf = (issuanceRef: PortalAuthIssuanceRef) =>
        Ref.get(held).pipe(Effect.map((entries) => entries.pipe(HashMap.get(issuanceRef))));

      const currentness = Effect.fn('CommercePortalAuthProtectedHandoff.currentness')(function* currentnessOf(
        issuanceRef: PortalAuthIssuanceRef,
      ): Effect.fn.Return<IssuanceCurrentness, PortalAuthIssuanceStateUnavailable> {
        const entry = yield* entryOf(issuanceRef);
        if (Option.isNone(entry)) {
          return 'NOT_RESUMABLE';
        }
        if (Option.isSome(entry.value.settled)) {
          return entry.value.settled.value;
        }
        const now = yield* DateTime.now;
        if (!isLive(now)(entry.value)) {
          return 'EXPIRED';
        }
        return yield* ledgerProbe(entry.value.held);
      });

      const hold = Effect.fn('CommercePortalAuthProtectedHandoff.hold')(function* holdIssuance(
        incoming: HeldIssuance,
        options: { readonly supersede: boolean },
      ) {
        const now = yield* DateTime.now;
        yield* Ref.update(held, (entries) => withIssuance(entries, incoming, now, options.supersede));
      });

      const revealSecret = Effect.fn('CommercePortalAuthProtectedHandoff.revealSecret')(function* reveal(input: {
        readonly flow: PortalAuthEmailFlow;
        readonly issuanceRef: PortalAuthIssuanceRef;
        readonly slot: string;
      }) {
        if (portalAuthOwnerRenderedSlotOf(input.flow) !== input.slot) {
          return yield* new OwnerSlotStop({ reason: 'SLOT_NOT_DECLARED' });
        }
        const state = yield* currentness(input.issuanceRef);
        if (state !== 'CURRENT') {
          return yield* new OwnerSlotStop({ reason: state });
        }
        const entry = yield* entryOf(input.issuanceRef);
        if (Option.isNone(entry) || entry.value.held.issuance.flow !== input.flow) {
          return yield* new OwnerSlotStop({ reason: 'NOT_RESUMABLE' });
        }
        return entry.value.held.secret;
      });

      const endpointOf = Effect.fn('CommercePortalAuthProtectedHandoff.endpointOf')(function* endpoint(
        issuanceRef: PortalAuthIssuanceRef,
      ) {
        const state = yield* currentness(issuanceRef);
        return state === 'CURRENT'
          ? (yield* entryOf(issuanceRef)).pipe(Option.map((entry) => entry.held.endpoint))
          : Option.none();
      });

      return {
        currentness,
        endpointOf,
        forget: (issuanceRef) => Ref.update(held, (entries) => entries.pipe(HashMap.remove(issuanceRef))),
        hold,
        issuanceOf: (issuanceRef) => entryOf(issuanceRef).pipe(Effect.map(Option.map((entry) => entry.held.issuance))),
        reserve: ({ flow, providerSubjectId, reservation }) =>
          Ref.update(reservations, (all) =>
            all.pipe(HashMap.set(reservationKey(flow, providerSubjectId), reservation)),
          ),
        revealSecret,
        settle: ({ issuanceRef, state }) =>
          Ref.update(held, (entries) => entries.pipe(HashMap.modify(issuanceRef, settledAs(state)))),
        takeReservation: (flow, providerSubjectId) =>
          Ref.modify(reservations, (all) => {
            const key = reservationKey(flow, providerSubjectId);
            return [all.pipe(HashMap.get(key)), all.pipe(HashMap.remove(key))] as const;
          }),
      } satisfies ProtectedHandoffService;
    }),
  );
