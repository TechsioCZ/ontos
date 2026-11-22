import type { CommunicationRequestEncoded } from '@app/communications-contracts/communication-request';
import { NodeCrypto } from '@effect/platform-node';
import { eq, like } from 'drizzle-orm';
import { Config, DateTime, Effect, Layer, Option, Redacted, Ref, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';
import type { Scope } from 'effect';
import { randomUUID } from 'node:crypto';

import { CommercePortalAuthConfig, parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { PortalAuthIssuanceRefSchema } from '../../shared/portal-auth-communications.ts';
import type { PortalAuthEmailFlow } from '../../shared/portal-auth-communications.ts';
import { CommercePortalAuthCommunicationRequestSubmitter } from '../../src/portal-auth/communications/communication-request-submitter.ts';
import type { PortalAuthSubmission } from '../../src/portal-auth/communications/communication-request-submitter.ts';
import { CommercePortalAuthCommunicationStore } from '../../src/portal-auth/communications/communication-store.ts';
import type { PortalAuthCommunicationStoreService } from '../../src/portal-auth/communications/communication-store.ts';
import { PortalAuthCommunicationUnavailable } from '../../src/portal-auth/communications/communication-unavailable.ts';
import type { HeldIssuance } from '../../src/portal-auth/communications/issuance.ts';
import {
  CommercePortalAuthProtectedHandoff,
  protectedHandoffLayer,
} from '../../src/portal-auth/communications/protected-handoff.ts';
import type { ProtectedHandoffService } from '../../src/portal-auth/communications/protected-handoff.ts';
import { CommercePortalAuthProtectedValueSealerLive } from '../../src/portal-auth/communications/protected-value.ts';
import { relayCommunicationRequests } from '../../src/portal-auth/communications/request-relay.ts';
import type { RelayOptions } from '../../src/portal-auth/communications/request-relay.ts';
import { portalAuthCommunicationRequest, requestOfStored } from '../../src/portal-auth/communications/request.ts';
import { makeCommercePortalAuthCommunicationStore } from '../../src/portal-auth/persistence/portal-auth-communication-store.ts';
import { makeCommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import type { CommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import {
  communicationIssuance,
  communicationRequestOutbox,
} from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import { acquireOutlivingCleanup } from '../../../../packages/core-runtime/tests/support/database.ts';

/**
 * D1 and D2 of #1406 on native PostgreSQL as the realm's runtime role: the Auth-local outbox is written in the same Auth
 * transaction as its issuance, a rolled-back transaction leaves no request (#1392 scenario 3), two relays never submit one row
 * twice, a crashed relay's row is taken over after its lease and resubmitted to the SAME Communications idempotency, and the
 * sealed protected value serves every Auth process alike. Communications is a LABELLED in-memory intake double that keeps its
 * owner-local idempotency (same key, same decision); the real Action is the end-to-end suites'. Every value is FICTIONAL.
 */

const ORIGIN = 'https://portal.example.test';
const REALM_SECRET = 's'.repeat(64);
const TENANT = '7e000000-0000-4000-8000-0000000000aa';
const NOW = DateTime.makeUnsafe('2026-11-22T10:00:00.000Z');
const ADDRESS = 'outbox-holder@example.test';
const DATABASE_URL = Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.Redacted('DATABASE_URL')),
);
const decodeRef = Schema.decodeSync(PortalAuthIssuanceRefSchema);
const secretOf = (name: string) => `https://portal.example.test/verify?token=fictional-${name}`;

/** One "process": its own pool over the realm database, its own store and its own handoff. */
const openProcess = Effect.fn('PortalAuthOutboxIntegration.openProcess')(function* openProcess(): Effect.fn.Return<
  {
    readonly database: (typeof CommercePortalAuthDatabase)['Service'];
    readonly handoff: ProtectedHandoffService;
    readonly store: PortalAuthCommunicationStoreService;
  },
  unknown,
  Scope.Scope
> {
  const configuration = yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(yield* DATABASE_URL),
    COMMERCE_PORTAL_AUTH_SECRET: REALM_SECRET,
    COMMERCE_PORTAL_AUTH_URL: ORIGIN,
  });
  const database = yield* acquireOutlivingCleanup(makeCommercePortalAuthDatabase(configuration));
  const store = makeCommercePortalAuthCommunicationStore(database.executor);
  const handoff = yield* CommercePortalAuthProtectedHandoff.pipe(
    Effect.provide(
      protectedHandoffLayer(() => Effect.succeed('CURRENT')).pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(CommercePortalAuthCommunicationStore, store),
            // the deployment's own sealer: the realm secret of its configuration
            CommercePortalAuthProtectedValueSealerLive.pipe(
              Layer.provide(Layer.merge(Layer.succeed(CommercePortalAuthConfig, configuration), NodeCrypto.layer)),
            ),
          ),
        ),
      ),
    ),
  );
  return { database, handoff, store };
});

/** Every row this run wrote is removed after it, whatever happened. */
const scopedRun = Effect.fn('PortalAuthOutboxIntegration.scopedRun')(function* scopedRun() {
  const prefix = `pa-it-${randomUUID().slice(0, 8)}-`;
  const first = yield* openProcess();
  yield* Effect.addFinalizer(() =>
    first.database.executor
      .delete(communicationRequestOutbox)
      .where(like(communicationRequestOutbox.issuanceRef, `${prefix}%`))
      .pipe(
        Effect.andThen(
          first.database.executor
            .delete(communicationIssuance)
            .where(like(communicationIssuance.issuanceRef, `${prefix}%`)),
        ),
        Effect.ignore,
      ),
  );
  return { first, prefix };
});

const heldOf = (
  prefix: string,
  name: string,
  overrides: { readonly flow?: PortalAuthEmailFlow; readonly lifetimeMinutes?: number } = {},
): HeldIssuance => ({
  endpoint: Redacted.make(ADDRESS),
  issuance: {
    expiresAt: DateTime.add(NOW, { minutes: overrides.lifetimeMinutes ?? 30 }),
    flow: overrides.flow ?? 'verify-email',
    issuanceRef: decodeRef(`${prefix}${name}`),
    issuedAt: NOW,
    providerSubjectId: `subject-${prefix}${name}`,
  },
  secret: Redacted.make(secretOf(`${prefix}${name}`)),
});

const hold = (handoff: ProtectedHandoffService, held: HeldIssuance) =>
  portalAuthCommunicationRequest(held.issuance, { tenantId: TENANT }).pipe(
    Effect.flatMap((request) => handoff.hold(held, { request, supersede: false, tenantId: TENANT })),
  );

/**
 * LABELLED DOUBLE of the Communications intake: one decision per idempotency key, the stored decision again on a replay. It
 * counts every submission it was handed, and can lose its answer AFTER deciding (a timeout once the request was admitted).
 */
const decisionFor = (
  request: CommunicationRequestEncoded,
  known: PortalAuthSubmission | undefined,
): PortalAuthSubmission => {
  if (known === undefined) {
    return {
      decision: {
        intents: [{ intentId: `intent-${request.occurrence.occurrenceId}`, status: 'PENDING_HANDOFF' }],
        kind: 'MESSAGE_INTENTS',
      },
      decisionId: `decision-${request.occurrence.occurrenceId}`,
      outcome: 'DECIDED',
      replayed: false,
      requestId: `request-${request.occurrence.occurrenceId}`,
    };
  }
  return known.outcome === 'DECIDED' ? { ...known, replayed: true } : known;
};

const intakeDouble = Effect.gen(function* makeIntake() {
  const decisions = yield* Ref.make(new Map<string, PortalAuthSubmission>());
  const submissions = yield* Ref.make<readonly CommunicationRequestEncoded[]>([]);
  const loseNextAnswer = yield* Ref.make(false);
  const submit = (request: CommunicationRequestEncoded) =>
    Effect.gen(function* submitRequest() {
      yield* Ref.update(submissions, (all) => [...all, request]);
      const known = (yield* Ref.get(decisions)).get(request.idempotency.key);
      const decided = decisionFor(request, known);
      if (known === undefined) {
        yield* Ref.update(decisions, (all) => new Map([...all, [request.idempotency.key, decided]]));
      }
      if (yield* Ref.getAndSet(loseNextAnswer, false)) {
        return yield* new PortalAuthCommunicationUnavailable({ operation: 'submit-communication-request' });
      }
      return decided;
    });
  return { decisions, loseNextAnswer, submissions, submit };
});

type Submit = (
  request: CommunicationRequestEncoded,
) => Effect.Effect<PortalAuthSubmission, PortalAuthCommunicationUnavailable>;

const relayOver = (store: PortalAuthCommunicationStoreService, submit: Submit, leaseOwner: string) => {
  const options: RelayOptions = {
    leaseMillis: 30_000,
    leaseOwner,
    limit: 16,
    maxRetryMillis: 60_000,
    retryMillis: 1000,
    tenantId: TENANT,
  };
  return relayCommunicationRequests(options).pipe(
    Effect.provide(
      Layer.merge(
        Layer.succeed(CommercePortalAuthCommunicationStore, store),
        Layer.succeed(CommercePortalAuthCommunicationRequestSubmitter, { submit }),
      ),
    ),
  );
};

const outboxRowsOf = (database: (typeof CommercePortalAuthDatabase)['Service'], prefix: string) =>
  database.executor
    .select()
    .from(communicationRequestOutbox)
    .where(like(communicationRequestOutbox.issuanceRef, `${prefix}%`));
const issuanceRowsOf = (database: (typeof CommercePortalAuthDatabase)['Service'], prefix: string) =>
  database.executor
    .select()
    .from(communicationIssuance)
    .where(like(communicationIssuance.issuanceRef, `${prefix}%`));

const atNow = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  TestClock.setTime(NOW.epochMilliseconds).pipe(Effect.andThen(effect), Effect.provide(TestClock.layer()));

describe('The Portal Auth communication outbox on PostgreSQL (#1406 D1, D2)', () => {
  it.live(
    'the issuance and its request are ONE Auth transaction, and neither row holds the secret or the address',
    () =>
      atNow(
        Effect.gen(function* atomic() {
          const { first, prefix } = yield* scopedRun();
          const held = heldOf(prefix, 'a');
          yield* hold(first.handoff, held);
          const [row] = yield* outboxRowsOf(first.database, prefix);
          const [issuance] = yield* issuanceRowsOf(first.database, prefix);
          expect(row?.state).toBe('PENDING');
          expect(row?.tenantId).toBe(TENANT);
          const request = yield* requestOfStored(row?.request ?? '');
          expect(request).toStrictEqual(yield* portalAuthCommunicationRequest(held.issuance, { tenantId: TENANT }));
          const everything = JSON.stringify([row, issuance]);
          expect(everything).not.toContain(secretOf(`${prefix}a`));
          expect(everything).not.toContain('fictional-');
          expect(everything).not.toContain(ADDRESS);
          expect(issuance?.protectedValue).toMatch(/^v1\./u);
        }).pipe(Effect.scoped),
      ),
  );

  it.live(
    '[#1392 S3] a rolled-back Auth source transaction yields no request: nothing is stored, relayed or submitted',
    () =>
      atNow(
        Effect.gen(function* rolledBack() {
          const { first, prefix } = yield* scopedRun();
          const intake = yield* intakeDouble;
          // the request is written, then the Auth source transaction it belongs to fails and rolls back as a whole
          const failed = yield* first.database.executor
            .transaction(() =>
              hold(first.handoff, heldOf(prefix, 'rolled-back')).pipe(
                Effect.andThen(Effect.fail('the Auth source state could not be committed' as const)),
              ),
            )
            .pipe(Effect.flip);
          expect(failed).toBe('the Auth source state could not be committed');
          // a second issuance whose own transaction fails before it commits (a duplicate identity) leaves nothing either
          yield* hold(first.handoff, heldOf(prefix, 'kept'));
          const duplicate = yield* Effect.flip(hold(first.handoff, heldOf(prefix, 'kept')));
          expect(Schema.is(PortalAuthCommunicationUnavailable)(duplicate)).toBe(true);
          expect((yield* outboxRowsOf(first.database, prefix)).map(({ issuanceRef }) => issuanceRef)).toStrictEqual([
            `${prefix}kept`,
          ]);
          expect((yield* issuanceRowsOf(first.database, prefix)).map(({ issuanceRef }) => issuanceRef)).toStrictEqual([
            `${prefix}kept`,
          ]);
          yield* relayOver(first.store, intake.submit, 'relay-rollback');
          const submitted = (yield* Ref.get(intake.submissions)).map(({ occurrence }) => occurrence.occurrenceId);
          expect(submitted).not.toContain(`${prefix}rolled-back`);
          expect(submitted.filter((id) => id.startsWith(prefix))).toStrictEqual([`${prefix}kept`]);
        }).pipe(Effect.scoped),
      ),
  );

  it.live('two relays over one outbox submit every row exactly once and record every decision', () =>
    atNow(
      Effect.gen(function* twoRelays() {
        const { first, prefix } = yield* scopedRun();
        const second = yield* openProcess();
        const intake = yield* intakeDouble;
        const names = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'];
        yield* Effect.forEach(names, (name) => hold(first.handoff, heldOf(prefix, name)), { discard: true });
        const [a, b] = yield* Effect.all(
          [relayOver(first.store, intake.submit, 'relay-a'), relayOver(second.store, intake.submit, 'relay-b')],
          { concurrency: 2 },
        );
        const ours = (yield* Ref.get(intake.submissions)).filter(({ occurrence }) =>
          occurrence.occurrenceId.startsWith(prefix),
        );
        expect(ours).toHaveLength(names.length);
        expect(new Set(ours.map(({ idempotency }) => idempotency.key)).size).toBe(names.length);
        expect(a.decided + b.decided).toBeGreaterThanOrEqual(names.length);
        const rows = yield* outboxRowsOf(first.database, prefix);
        expect(rows.every(({ leaseOwner, state }) => state === 'DECIDED' && leaseOwner === null)).toBe(true);
        expect(rows.every(({ attempts }) => attempts === 1)).toBe(true);
      }).pipe(Effect.scoped),
    ),
  );

  it.live(
    'a crashed relay keeps its row only for its lease; another relay then submits the SAME request and the late one records nothing',
    () =>
      Effect.gen(function* crash() {
        yield* TestClock.setTime(NOW.epochMilliseconds);
        const { first, prefix } = yield* scopedRun();
        const intake = yield* intakeDouble;
        yield* hold(first.handoff, heldOf(prefix, 'crash'));
        // relay A takes the row and dies before it records anything
        const taken = yield* first.store.claimDue({
          leaseMillis: 30_000,
          leaseOwner: 'relay-crashed',
          limit: 16,
          now: NOW,
          tenantId: TENANT,
        });
        expect(taken.map(({ issuanceRef }) => issuanceRef)).toContain(`${prefix}crash`);
        // while the lease lives no other relay may take it
        expect((yield* relayOver(first.store, intake.submit, 'relay-b')).claimed).toBe(0);
        yield* TestClock.adjust('31 seconds');
        const later = yield* relayOver(first.store, intake.submit, 'relay-b');
        expect(later).toMatchObject({ claimed: 1, decided: 1 });
        // the crashed relay comes back: its lease is gone, its record is refused, the decision stands
        const late = yield* first.store.complete({
          forget: true,
          issuanceRef: decodeRef(`${prefix}crash`),
          leaseOwner: 'relay-crashed',
          now: yield* DateTime.now,
          outcome: Option.none(),
          state: 'CONFLICT',
        });
        expect(late).toBe(false);
        const [row] = yield* outboxRowsOf(first.database, prefix);
        expect(row?.state).toBe('DECIDED');
        expect(row?.attempts).toBe(2);
        expect(yield* first.handoff.currentness(decodeRef(`${prefix}crash`))).toBe('CURRENT');
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live(
    'a lost answer after Communications decided is replayed with the same request and lands on the SAME decision',
    () =>
      Effect.gen(function* lostAnswer() {
        yield* TestClock.setTime(NOW.epochMilliseconds);
        const { first, prefix } = yield* scopedRun();
        const intake = yield* intakeDouble;
        yield* hold(first.handoff, heldOf(prefix, 'lost'));
        yield* Ref.set(intake.loseNextAnswer, true);
        expect(yield* relayOver(first.store, intake.submit, 'relay-a')).toMatchObject({ claimed: 1, released: 1 });
        const [released] = yield* outboxRowsOf(first.database, prefix);
        expect(released?.state).toBe('PENDING');
        expect(released?.lastFailure).toBe('INTAKE_UNAVAILABLE');
        // before its retry delay the row is not due
        expect((yield* relayOver(first.store, intake.submit, 'relay-a')).claimed).toBe(0);
        yield* TestClock.adjust('2 seconds');
        expect(yield* relayOver(first.store, intake.submit, 'relay-a')).toMatchObject({ claimed: 1, decided: 1 });
        const ours = (yield* Ref.get(intake.submissions)).filter(({ occurrence }) =>
          occurrence.occurrenceId.startsWith(prefix),
        );
        expect(ours).toHaveLength(2);
        expect(ours[0]).toStrictEqual(ours[1]);
        const [row] = yield* outboxRowsOf(first.database, prefix);
        expect(row?.state).toBe('DECIDED');
        expect(row?.outcome).toContain('"replayed":true');
        expect(row?.outcome).toContain(`decision-${prefix}lost`);
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live(
    'an issuance that expired before its request was submitted is closed EXPIRED, never submitted, its value cleared',
    () =>
      Effect.gen(function* expired() {
        yield* TestClock.setTime(NOW.epochMilliseconds);
        const { first, prefix } = yield* scopedRun();
        const intake = yield* intakeDouble;
        yield* hold(first.handoff, heldOf(prefix, 'short', { lifetimeMinutes: 1 }));
        yield* TestClock.adjust('2 minutes');
        expect(yield* relayOver(first.store, intake.submit, 'relay-a')).toMatchObject({ claimed: 1, expired: 1 });
        expect(
          (yield* Ref.get(intake.submissions)).some(({ occurrence }) => occurrence.occurrenceId.startsWith(prefix)),
        ).toBe(false);
        const [row] = yield* outboxRowsOf(first.database, prefix);
        const [issuance] = yield* issuanceRowsOf(first.database, prefix);
        expect(row?.state).toBe('EXPIRED');
        expect(issuance?.protectedValue).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live(
    'D2: another Auth process completes the slot while Current, sees the settlement, and a moved sealed value never opens',
    () =>
      atNow(
        Effect.gen(function* crossProcess() {
          const { first, prefix } = yield* scopedRun();
          const second = yield* openProcess();
          yield* hold(first.handoff, heldOf(prefix, 'x1'));
          yield* hold(first.handoff, heldOf(prefix, 'x2'));
          const revealed = yield* second.handoff.revealSecret({
            flow: 'verify-email',
            issuanceRef: decodeRef(`${prefix}x1`),
            slot: 'verification_link',
          });
          expect(Redacted.value(revealed)).toBe(secretOf(`${prefix}x1`));
          expect(Redacted.value(Option.getOrThrow(yield* second.handoff.endpointOf(decodeRef(`${prefix}x1`))))).toBe(
            ADDRESS,
          );
          yield* second.handoff.settle({ issuanceRef: decodeRef(`${prefix}x1`), state: 'CONSUMED' });
          expect(yield* first.handoff.currentness(decodeRef(`${prefix}x1`))).toBe('CONSUMED');
          const settled = (yield* issuanceRowsOf(first.database, prefix)).find(
            ({ issuanceRef }) => issuanceRef === `${prefix}x1`,
          );
          expect(settled?.protectedValue).toBeNull();
          // a sealed value copied onto another issuance's row is bound to its own issuance and does not open there
          const x2 = (yield* issuanceRowsOf(first.database, prefix)).find(
            ({ issuanceRef }) => issuanceRef === `${prefix}x2`,
          );
          yield* hold(first.handoff, heldOf(prefix, 'x3'));
          yield* first.database.executor
            .update(communicationIssuance)
            .set({ protectedValue: x2?.protectedValue ?? null })
            .where(eq(communicationIssuance.issuanceRef, `${prefix}x3`));
          expect(yield* second.handoff.currentness(decodeRef(`${prefix}x3`))).toBe('NOT_RESUMABLE');
          expect(yield* second.handoff.currentness(decodeRef(`${prefix}x2`))).toBe('CURRENT');
        }).pipe(Effect.scoped),
      ),
  );
});
