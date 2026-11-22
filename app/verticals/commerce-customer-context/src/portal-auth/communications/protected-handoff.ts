import type { CommunicationRequestEncoded } from '@app/communications-contracts/communication-request';
import { Context, DateTime, Effect, HashMap, Layer, Option, Ref } from 'effect';
import type { Redacted } from 'effect';

import { withSafeCause } from '../../../api/portal-auth/provider/safe-failure.ts';
import { portalAuthOwnerRenderedSlotOf } from '../../../shared/portal-auth-communications.ts';
import type { PortalAuthEmailFlow, PortalAuthIssuanceRef } from '../../../shared/portal-auth-communications.ts';
import { CommercePortalAuthCommunicationStore } from './communication-store.ts';
import type { StoredIssuance } from './communication-store.ts';
import { PortalAuthCommunicationUnavailable } from './communication-unavailable.ts';
import type { PortalAuthIssuanceStateUnavailable } from './issuance-state-unavailable.ts';
import type { HeldIssuance, IssuanceCurrentness, PortalAuthIssuance } from './issuance.ts';
import { OwnerSlotStop } from './owner-slot-stop.ts';
import { CommercePortalAuthProtectedValueSealer } from './protected-value.ts';
import { storedRequestOf } from './request.ts';

/**
 * The PROTECTED Auth handoff (ADR-0022): the one place that holds the secret of an issuance between the moment the
 * provider issues it and the moment Auth completes the owner-rendered slot of an approved message.
 *
 * D2: the protected side lives in Auth's own database, SEALED under the realm secret (`protected-value.ts`), so every Auth
 * process of the deployment answers the same way: the instance that issued, another instance and a restarted one all complete
 * the slot while Auth's Current lifecycle says the issuance is usable, and all of them stop once it is not. It is never a token
 * ledger: Auth's own recovery ledger stays the authority on the issuance (the ledger probe below), the sealed value only lives
 * until the issuance expires, is spent, superseded or decided not to be sent, and is then cleared. The single way out is
 * `revealSecret`, which answers only for the exact issuance, only for its own owner-rendered slot and only while Current.
 * Nothing is ever reproduced or reissued here; an issuance whose value is gone or does not open is a truthful stop.
 *
 * D1: `hold` writes the issuance and its Communication Request into the Auth-local outbox in ONE Auth transaction, so the
 * request exists exactly when the issuance does; the relay (`request-relay.ts`) submits it after that commit.
 */

/**
 * What Auth's own ledger says about a held issuance now, as the real distinct state its rows prove: a spent issuance is CONSUMED,
 * an expired one EXPIRED, a replaced one SUPERSEDED, and one its rows no longer say anything about NOT_RESUMABLE (never REVOKED:
 * the ledger holds no revocation, only Auth's own `settle` does). A flow without a ledger answers CURRENT and relies on expiry
 * and settlement.
 */
export type IssuanceLedgerProbe = (
  held: HeldIssuance,
) => Effect.Effect<
  'CONSUMED' | 'CURRENT' | 'EXPIRED' | 'NOT_RESUMABLE' | 'SUPERSEDED',
  PortalAuthIssuanceStateUnavailable
>;

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
  /** Clears the protected side of the issuance: nothing can complete its slot any more. */
  readonly forget: (issuanceRef: PortalAuthIssuanceRef) => Effect.Effect<void, PortalAuthIssuanceStateUnavailable>;
  /**
   * Holds one issuance and records its Communication Request in the Auth-local outbox, atomically. `supersede` marks every
   * earlier issuance of the same flow and subject SUPERSEDED (a new link or code replaces it).
   */
  readonly hold: (
    held: HeldIssuance,
    options: {
      readonly request: CommunicationRequestEncoded;
      readonly supersede: boolean;
      readonly tenantId: string;
    },
  ) => Effect.Effect<void, PortalAuthCommunicationUnavailable>;
  /** The safe facts Auth tells Communications about the issuance; never the protected side. */
  readonly issuanceOf: (
    issuanceRef: PortalAuthIssuanceRef,
  ) => Effect.Effect<Option.Option<PortalAuthIssuance>, PortalAuthIssuanceStateUnavailable>;
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
  }) => Effect.Effect<void, PortalAuthIssuanceStateUnavailable>;
  readonly takeReservation: (
    flow: PortalAuthEmailFlow,
    providerSubjectId: string,
  ) => Effect.Effect<Option.Option<IssuanceReservation>>;
}

export class CommercePortalAuthProtectedHandoff extends Context.Service<
  CommercePortalAuthProtectedHandoff,
  ProtectedHandoffService
>()('@app/commerce-customer-context/portal-auth/communications/protected-handoff/CommercePortalAuthProtectedHandoff') {}

const reservationKey = (flow: PortalAuthEmailFlow, providerSubjectId: string) => `${flow}|${providerSubjectId}`;

const RECORD_OPERATION = 'issuance-record';

const issuanceOfStored = (stored: StoredIssuance) => stored.issuance;
const endpointOfHeld = (held: HeldIssuance) => held.endpoint;
const heldWith =
  (issuance: PortalAuthIssuance) =>
  (value: Pick<HeldIssuance, 'endpoint' | 'ledgerToken' | 'secret'>): HeldIssuance => ({ ...value, issuance });

/**
 * The handoff over Auth's store. `ledgerProbe` is Auth's own Current-state reader of its ledger. The provider-issuance
 * reservation stays in this process on purpose: it only spans one provider call of one request (the enrollment gateway reserves,
 * the provider's callback in the same request takes it), so it holds no issuance and nothing to resume.
 */
export const protectedHandoffLayer = (ledgerProbe: IssuanceLedgerProbe) =>
  Layer.effect(
    CommercePortalAuthProtectedHandoff,
    Effect.gen(function* makeProtectedHandoff() {
      const store = yield* CommercePortalAuthCommunicationStore;
      const sealer = yield* CommercePortalAuthProtectedValueSealer;

      /** The held issuance of a stored row, when its protected side is still there and opens. */
      const heldOfStored = (stored: StoredIssuance) =>
        Option.match(stored.sealedValue, {
          onNone: () => Effect.succeedNone,
          onSome: (sealed) =>
            sealer.open(stored.issuance, sealed).pipe(Effect.map(Option.map(heldWith(stored.issuance)))),
        });
      const reservations = yield* Ref.make(HashMap.empty<string, IssuanceReservation>());

      /** The usable held issuance, or the state that stops it. */
      const usable = Effect.fn('CommercePortalAuthProtectedHandoff.usable')(function* usableIssuance(
        issuanceRef: PortalAuthIssuanceRef,
      ): Effect.fn.Return<
        { readonly held: Option.Option<HeldIssuance>; readonly state: IssuanceCurrentness },
        PortalAuthIssuanceStateUnavailable
      > {
        const stored = yield* store.find(issuanceRef);
        if (Option.isNone(stored)) {
          return { held: Option.none(), state: 'NOT_RESUMABLE' };
        }
        if (Option.isSome(stored.value.settled)) {
          return { held: Option.none(), state: stored.value.settled.value };
        }
        const now = yield* DateTime.now;
        if (!DateTime.isGreaterThan(stored.value.issuance.expiresAt, now)) {
          return { held: Option.none(), state: 'EXPIRED' };
        }
        const held = yield* heldOfStored(stored.value);
        if (Option.isNone(held)) {
          return { held, state: 'NOT_RESUMABLE' };
        }
        const state = yield* ledgerProbe(held.value);
        return { held: state === 'CURRENT' ? held : Option.none(), state };
      });

      const currentness = (issuanceRef: PortalAuthIssuanceRef) =>
        usable(issuanceRef).pipe(Effect.map(({ state }) => state));

      const hold = Effect.fn('CommercePortalAuthProtectedHandoff.hold')(function* holdIssuance(
        incoming: HeldIssuance,
        options: {
          readonly request: CommunicationRequestEncoded;
          readonly supersede: boolean;
          readonly tenantId: string;
        },
      ) {
        const [sealedValue, request] = yield* Effect.all(
          [
            sealer.seal(incoming),
            storedRequestOf(options.request).pipe(
              Effect.mapError((cause) =>
                withSafeCause(new PortalAuthCommunicationUnavailable({ operation: RECORD_OPERATION }), cause),
              ),
            ),
          ],
          { concurrency: 1 },
        );
        const now = yield* DateTime.now;
        yield* store.record({
          issuance: incoming.issuance,
          now,
          request,
          sealedValue,
          supersede: options.supersede,
          tenantId: options.tenantId,
        });
      });

      const revealSecret = Effect.fn('CommercePortalAuthProtectedHandoff.revealSecret')(function* reveal(input: {
        readonly flow: PortalAuthEmailFlow;
        readonly issuanceRef: PortalAuthIssuanceRef;
        readonly slot: string;
      }) {
        if (portalAuthOwnerRenderedSlotOf(input.flow) !== input.slot) {
          return yield* new OwnerSlotStop({ reason: 'SLOT_NOT_DECLARED' });
        }
        const { held, state } = yield* usable(input.issuanceRef);
        if (state !== 'CURRENT') {
          return yield* new OwnerSlotStop({ reason: state });
        }
        if (Option.isNone(held) || held.value.issuance.flow !== input.flow) {
          return yield* new OwnerSlotStop({ reason: 'NOT_RESUMABLE' });
        }
        return held.value.secret;
      });

      const endpointOf = (issuanceRef: PortalAuthIssuanceRef) =>
        usable(issuanceRef).pipe(Effect.map(({ held }) => held.pipe(Option.map(endpointOfHeld))));

      return {
        currentness,
        endpointOf,
        forget: store.forget,
        hold,
        issuanceOf: (issuanceRef) => store.find(issuanceRef).pipe(Effect.map(Option.map(issuanceOfStored))),
        reserve: ({ flow, providerSubjectId, reservation }) =>
          Ref.update(reservations, (all) =>
            all.pipe(HashMap.set(reservationKey(flow, providerSubjectId), reservation)),
          ),
        revealSecret,
        settle: store.settle,
        takeReservation: (flow, providerSubjectId) =>
          Ref.modify(reservations, (all) => {
            const key = reservationKey(flow, providerSubjectId);
            return [all.pipe(HashMap.get(key)), all.pipe(HashMap.remove(key))] as const;
          }),
      } satisfies ProtectedHandoffService;
    }),
  );
