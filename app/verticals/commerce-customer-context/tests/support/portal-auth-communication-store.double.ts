import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Layer, Option, Redacted, Ref } from 'effect';

import type { PortalAuthIssuanceRef } from '../../shared/portal-auth-communications.ts';
import { CommercePortalAuthCommunicationStore } from '../../src/portal-auth/communications/communication-store.ts';
import type {
  ClaimedCommunicationRequest,
  IssuanceSettlement,
  PortalAuthCommunicationStoreService,
  StoredIssuance,
} from '../../src/portal-auth/communications/communication-store.ts';
import { PortalAuthCommunicationUnavailable } from '../../src/portal-auth/communications/communication-unavailable.ts';
import type { HeldIssuance, PortalAuthIssuance } from '../../src/portal-auth/communications/issuance.ts';
import { protectedHandoffLayer } from '../../src/portal-auth/communications/protected-handoff.ts';
import type {
  IssuanceLedgerProbe,
  ProtectedHandoffService,
} from '../../src/portal-auth/communications/protected-handoff.ts';
import { protectedValueSealerLayer } from '../../src/portal-auth/communications/protected-value.ts';
import { portalAuthCommunicationRequest } from '../../src/portal-auth/communications/request.ts';

/**
 * TEST-ONLY, LABELLED DOUBLE of Auth's PostgreSQL communication store (`portal-auth-communication-store.ts`), for unit tests that
 * cannot reach PostgreSQL. It keeps the same contract: one `record` writes the issuance, its request and the supersession
 * together or not at all; a lease is the only thing that lets a relay end a row. The native PostgreSQL behaviour (locking, two
 * relays, rollback) is proven by the integration suite, never by this double.
 */

interface OutboxRow {
  readonly attempts: number;
  readonly availableAt: DateTime.Utc;
  readonly issuanceRef: PortalAuthIssuanceRef;
  readonly lastFailure: Option.Option<string>;
  readonly leaseExpiresAt: Option.Option<DateTime.Utc>;
  readonly leaseOwner: Option.Option<string>;
  readonly outcome: Option.Option<string>;
  readonly request: string;
  readonly state: string;
  readonly tenantId: string;
}

export interface CommunicationStoreDouble {
  /** The next `record` fails before anything is written: the double of a rolled-back Auth transaction. */
  readonly failNextRecord: Ref.Ref<boolean>;
  readonly issuances: Ref.Ref<ReadonlyMap<string, StoredIssuance>>;
  readonly outbox: Ref.Ref<ReadonlyMap<string, OutboxRow>>;
  readonly service: PortalAuthCommunicationStoreService;
}

const settled = (stored: StoredIssuance, state: IssuanceSettlement): StoredIssuance =>
  Option.isSome(stored.settled) ? stored : { ...stored, sealedValue: Option.none(), settled: Option.some(state) };
const cleared = (stored: StoredIssuance): StoredIssuance => ({ ...stored, sealedValue: Option.none() });

const leasedRow = (rows: ReadonlyMap<string, OutboxRow>, issuanceRef: string, leaseOwner: string) =>
  Option.fromNullishOr(rows.get(issuanceRef)).pipe(
    Option.filter((row) => row.state === 'PENDING' && Option.contains(row.leaseOwner, leaseOwner)),
  );

const isDue = (now: DateTime.Utc) => (row: OutboxRow) =>
  row.state === 'PENDING' &&
  DateTime.isLessThanOrEqualTo(row.availableAt, now) &&
  Option.match(row.leaseExpiresAt, { onNone: () => true, onSome: (until) => DateTime.isLessThanOrEqualTo(until, now) });

const isExpiredHeld = (now: DateTime.Utc) => (stored: StoredIssuance) =>
  Option.isSome(stored.sealedValue) && DateTime.isLessThanOrEqualTo(stored.issuance.expiresAt, now);

const supersededBy = (incoming: PortalAuthIssuance) => (stored: StoredIssuance) =>
  stored.issuance.flow === incoming.flow && stored.issuance.providerSubjectId === incoming.providerSubjectId;

const entryOf = (row: OutboxRow) => [row.issuanceRef, row] as const;
const withRow = (rows: ReadonlyMap<string, OutboxRow>, row: OutboxRow) => new Map([...rows, [row.issuanceRef, row]]);

const freshRow = (input: {
  readonly issuanceRef: PortalAuthIssuanceRef;
  readonly now: DateTime.Utc;
  readonly request: string;
  readonly tenantId: string;
}): OutboxRow => ({
  attempts: 0,
  availableAt: input.now,
  issuanceRef: input.issuanceRef,
  lastFailure: Option.none(),
  leaseExpiresAt: Option.none(),
  leaseOwner: Option.none(),
  outcome: Option.none(),
  request: input.request,
  state: 'PENDING',
  tenantId: input.tenantId,
});

const recordFailure = () => Effect.fail(new PortalAuthCommunicationUnavailable({ operation: 'issuance-record' }));

/** A fresh, empty double. */
export const makeCommunicationStoreDouble = (): CommunicationStoreDouble => {
  const issuances = Ref.makeUnsafe<ReadonlyMap<string, StoredIssuance>>(new Map());
  const outbox = Ref.makeUnsafe<ReadonlyMap<string, OutboxRow>>(new Map());
  const failNextRecord = Ref.makeUnsafe(false);

  const updateIssuance = (issuanceRef: string, update: (stored: StoredIssuance) => StoredIssuance) =>
    Ref.update(issuances, (all) =>
      Option.match(Option.fromNullishOr(all.get(issuanceRef)), {
        onNone: () => all,
        onSome: (stored) => new Map([...all, [issuanceRef, update(stored)]]),
      }),
    );

  const claimDue: PortalAuthCommunicationStoreService['claimDue'] = ({
    leaseMillis,
    leaseOwner,
    limit,
    now,
    tenantId,
  }) =>
    Effect.gen(function* claim() {
      const due = [...(yield* Ref.get(outbox)).values()]
        .filter((row) => row.tenantId === tenantId)
        .filter(isDue(now))
        .slice(0, limit);
      const leaseExpiresAt = Option.some(DateTime.add(now, { milliseconds: leaseMillis }));
      const claimed = due.map((row) => ({
        ...row,
        attempts: row.attempts + 1,
        leaseExpiresAt,
        leaseOwner: Option.some(leaseOwner),
      }));
      yield* Ref.update(outbox, (rows) => new Map([...rows, ...claimed.map(entryOf)]));
      const all = yield* Ref.get(issuances);
      return claimed.map((row): ClaimedCommunicationRequest => ({
        attempts: row.attempts,
        expiresAt: all.get(row.issuanceRef)?.issuance.expiresAt ?? DateTime.makeUnsafe(0),
        issuanceRef: row.issuanceRef,
        request: row.request,
      }));
    });

  const complete: PortalAuthCommunicationStoreService['complete'] = ({
    forget,
    issuanceRef,
    leaseOwner,
    outcome,
    state,
  }) =>
    Effect.gen(function* completeRow() {
      const row = leasedRow(yield* Ref.get(outbox), issuanceRef, leaseOwner);
      if (Option.isNone(row)) {
        return false;
      }
      yield* Ref.update(outbox, (rows) =>
        withRow(rows, { ...row.value, leaseExpiresAt: Option.none(), leaseOwner: Option.none(), outcome, state }),
      );
      if (forget) {
        yield* updateIssuance(issuanceRef, cleared);
      }
      return true;
    });

  const record: PortalAuthCommunicationStoreService['record'] = ({
    issuance,
    now,
    request,
    sealedValue,
    supersede,
    tenantId,
  }) =>
    Effect.gen(function* recordIssuance() {
      const current = yield* Ref.get(issuances);
      if ((yield* Ref.getAndSet(failNextRecord, false)) || current.has(issuance.issuanceRef)) {
        return yield* recordFailure();
      }
      const superseded = supersede
        ? [...current.values()]
            .filter(supersededBy(issuance))
            .map((stored) => [stored.issuance.issuanceRef, settled(stored, 'SUPERSEDED')] as const)
        : [];
      const stored: StoredIssuance = { issuance, sealedValue: Option.some(sealedValue), settled: Option.none() };
      yield* Ref.set(issuances, new Map([...current, ...superseded, [issuance.issuanceRef, stored]]));
      return yield* Ref.update(outbox, (rows) =>
        withRow(rows, freshRow({ issuanceRef: issuance.issuanceRef, now, request, tenantId })),
      );
    });

  const release: PortalAuthCommunicationStoreService['release'] = ({ availableAt, failure, issuanceRef, leaseOwner }) =>
    Effect.gen(function* releaseRow() {
      const row = leasedRow(yield* Ref.get(outbox), issuanceRef, leaseOwner);
      if (Option.isNone(row)) {
        return false;
      }
      yield* Ref.update(outbox, (rows) =>
        withRow(rows, {
          ...row.value,
          availableAt,
          lastFailure: Option.some(failure),
          leaseExpiresAt: Option.none(),
          leaseOwner: Option.none(),
        }),
      );
      return true;
    });

  const service: PortalAuthCommunicationStoreService = {
    claimDue,
    complete,
    find: (issuanceRef) => Ref.get(issuances).pipe(Effect.map((all) => Option.fromNullishOr(all.get(issuanceRef)))),
    forget: (issuanceRef) => updateIssuance(issuanceRef, cleared),
    forgetExpired: (now) =>
      Ref.modify(issuances, (all) => {
        const expired = [...all.values()].filter(isExpiredHeld(now));
        const replaced = expired.map((stored) => [stored.issuance.issuanceRef, cleared(stored)] as const);
        return [expired.length, new Map([...all, ...replaced])] as const;
      }),
    record,
    release,
    settle: ({ issuanceRef, state }) => updateIssuance(issuanceRef, (stored) => settled(stored, state)),
  };
  return { failNextRecord, issuances, outbox, service };
};

/** A FICTIONAL realm secret for the sealer; never a deployment value. */
export const FICTIONAL_REALM_SECRET = Redacted.make('fictional-portal-auth-realm-secret-for-tests-only-0123456789');

/** The store double and the REAL sealer over a fictional realm secret, as the protected handoff requires them. */
export const communicationStoreLayers = (store: PortalAuthCommunicationStoreService) =>
  Layer.merge(
    Layer.succeed(CommercePortalAuthCommunicationStore, store),
    protectedValueSealerLayer(FICTIONAL_REALM_SECRET).pipe(Layer.provide(NodeCrypto.layer)),
  );

/** A fresh store double per layer build (one per `Effect.provide`), with the real sealer. */
export const communicationStoreDoubleLayer = Layer.merge(
  Layer.sync(CommercePortalAuthCommunicationStore, () => makeCommunicationStoreDouble().service),
  protectedValueSealerLayer(FICTIONAL_REALM_SECRET).pipe(Layer.provide(NodeCrypto.layer)),
);

export const FICTIONAL_TENANT = '7e000000-0000-4000-8000-000000000001';

/** Holds an issuance the way the delivery does: together with its Communication Request, in the fictional Tenant. */
export const holdWithRequest = (handoff: ProtectedHandoffService, held: HeldIssuance, supersede: boolean) =>
  portalAuthCommunicationRequest(held.issuance, { tenantId: FICTIONAL_TENANT }).pipe(
    Effect.flatMap((request) => handoff.hold(held, { request, supersede, tenantId: FICTIONAL_TENANT })),
  );

/** The protected handoff over a fresh store double (one per `Effect.provide`). */
export const handoffOverDouble = (probe: IssuanceLedgerProbe) =>
  protectedHandoffLayer(probe).pipe(Layer.provide(communicationStoreDoubleLayer));
