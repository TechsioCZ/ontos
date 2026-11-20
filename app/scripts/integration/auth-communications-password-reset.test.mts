import { eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Redacted, Ref } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { portalAuthCommunicationRequest } from '../../verticals/commerce-customer-context/src/portal-auth/communications/request.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../../verticals/commerce-customer-context/api/portal-auth/provider/config.ts';
import { user } from '../../verticals/commerce-customer-context/src/portal-auth/persistence/portal-auth-tables.ts';
import { deliveryAttempts, messageIntents } from '../../verticals/communications/src/database/schema.ts';
import { nativeServices } from '../../verticals/communications/tests/support/persistence.fixture.ts';
import {
  privacyIndeterminate,
  privacyNotAllowed,
} from '../../verticals/communications/tests/unit/support/privacy-fixtures.ts';
import {
  FICTIONAL_COPY,
  authWorld,
  pendingIntentsOf,
  step,
  decisionIdOf,
  issuanceRefOf,
} from './support/auth-communications-world.spec.mts';
import type { AuthWorld } from './support/auth-communications-world.spec.mts';
import {
  PASSWORD,
  REPLACEMENT_PASSWORD,
  headersOf,
  makePostgresRealm,
  signUp,
} from './support/auth-communications-realms.spec.mts';
import type { PostgresRealm } from './support/auth-communications-realms.spec.mts';
import {
  captureLogs,
  expectNoSecretAnywhere,
  historyReads,
  textOf,
  tokenFromLink,
} from './support/auth-communications-checks.spec.mts';

/**
 * #1406 END-TO-END of the PASSWORD RESET e-mail: the real Auth realm and its recovery ledger issue the reset link, Auth's
 * Communications-routed delivery submits the request to the real public `submit-communication-request` handler, Communications
 * stores the durable decision and intent, the pre-handoff step re-checks every Current fact, the labelled Messaging Adapter
 * double renders FICTIONAL copy with Auth's real owner-slot completion, and the authorized history Reads show only safe status.
 *
 * Labelled doubles (see `support/auth-communications-world.spec.mts`): the Privacy gate and the missing pre-verification Privacy
 * path, the trusted language, and the provider. No approved Czech or English copy exists; every text here is FICTIONAL.
 * Nothing here is Privacy, delivery or provider evidence.
 */

const requestReset = (realm: PostgresRealm, address = realm.email) =>
  Effect.promise(
    async () => await realm.auth.api.requestPasswordReset({ body: { email: address }, headers: headersOf(realm.ip) }),
  );

const setup = Effect.fn('PasswordResetE2E.setup')(function* setupWorld(options?: Parameters<typeof authWorld>[0]) {
  const world = yield* authWorld(options ?? { mode: 'B' });
  const realm = yield* makePostgresRealm(world, 'reset');
  const subjectId = yield* signUp(realm);
  return { realm, subjectId, world };
});

const onlyIntent = (world: AuthWorld) => {
  const [intentId] = pendingIntentsOf(world);
  return Option.match(Option.fromNullishOr(intentId), {
    onNone: () => Effect.die('the reset request decided no pending intent'),
    onSome: (found) => Effect.succeed(found),
  });
};

/** The pre-handoff step run at a later instant: the world's Auth and Communications both read that clock. */
const stepAfterMinutes = (world: AuthWorld, intentId: string, minutes: number) =>
  Effect.gen(function* later() {
    const now = yield* DateTime.now;
    return yield* Effect.gen(function* atInstant() {
      yield* TestClock.setTime(DateTime.add(now, { minutes }).epochMilliseconds);
      return yield* step(world, world.messageHandoff, intentId);
    }).pipe(Effect.provide(TestClock.layer()));
  });

const attemptsOf = (world: AuthWorld) => world.read((tx) => tx.select().from(deliveryAttempts));

describe('Password reset: real Auth source -> public Action -> durable decision/intent -> authorized Read (#1406)', () => {
  it.live(
    '[AC-05 S2.1] a reset request is committed post-issuance, decided once and reaches the recipient with Czech copy by default',
    () =>
      Effect.gen(function* happyPath() {
        const { realm, subjectId, world } = yield* setup();
        yield* requestReset(realm);

        // one request, one stored decision, one intent pinned to the original subject and the issuance (never the e-mail)
        expect(world.submissions).toHaveLength(1);
        const [{ request, submission }] = world.submissions;
        expect(submission).toMatchObject({
          decision: { kind: 'MESSAGE_INTENTS' },
          outcome: 'DECIDED',
          replayed: false,
        });
        expect(request.source.moduleKey).toBe('commerce.customer-context');
        expect(request.originalRecipients[0]?.recipientRef.resourceId).toBe(subjectId);
        expect(request.idempotency.key).toMatch(/^portal-auth\.reset-password\.pa-/u);

        const intentId = yield* onlyIntent(world);
        expect((yield* step(world, world.messageHandoff, intentId)).kind).toBe('HANDED_OFF');
        expect(world.mailbox).toHaveLength(1);
        const [mail] = world.mailbox;
        // no trusted language is established: the sole default and fallback is Czech
        expect(mail?.language).toBe('cs');
        expect(mail?.subject).toContain(FICTIONAL_COPY);
        expect(textOf(mail)).toContain('/reset-password');
        expect(Redacted.value(mail?.to ?? Redacted.make(''))).toBe(realm.email);

        // the authorized Read shows the language, revision and mode actually used, and that the provider only ACCEPTED
        const page = yield* (yield* historyReads(world)).list();
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({
          headline: {
            attention: 'NO_FAILURE',
            deliveryProven: false,
            providerAccepted: true,
            status: 'PROVIDER_ACCEPTED',
          },
          recipient: { channel: 'email', role: 'account-holder' },
          template: { language: 'cs', mode: 'B', revisionNumber: 1 },
        });
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('[AC-04 AC-06 S2.2] no reset link, token, URL, password or address is stored, shown or logged anywhere', () =>
    Effect.gen(function* secretFree() {
      const { realm, world } = yield* setup();
      const { lines } = yield* captureLogs(
        Effect.gen(function* run() {
          yield* requestReset(realm);
          yield* step(world, world.messageHandoff, yield* onlyIntent(world));
        }),
      );
      const [mail] = world.mailbox;
      const link = textOf(mail);
      const token = Option.getOrThrow(tokenFromLink(link));
      const found = yield* expectNoSecretAnywhere(
        world,
        [token, link.slice(link.indexOf('http')), PASSWORD, REPLACEMENT_PASSWORD, realm.email],
        lines,
      );
      expect(found).toStrictEqual([]);
      // the secret exists only where the labelled provider received it: in memory, protected
      expect(Redacted.isRedacted(mail?.text)).toBe(true);
      expect(JSON.stringify(mail?.text)).toBe('"<redacted>"');
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S1.2 S1.3] trusted English with both revisions approved gets the English revision; with only Czech approved it falls back to Czech',
    () =>
      Effect.gen(function* languages() {
        const both = yield* setup({ mode: 'B' });
        yield* Ref.set(both.world.languageRef, { kind: 'trusted', language: 'en' });
        yield* requestReset(both.realm);
        yield* step(both.world, both.world.messageHandoff, yield* onlyIntent(both.world));
        expect(both.world.mailbox[0]?.language).toBe('en');
        expect((yield* (yield* historyReads(both.world)).list()).items[0]?.template).toMatchObject({
          language: 'en',
          mode: 'B',
        });

        const czechOnly = yield* setup({ languages: ['cs'], mode: 'B' });
        yield* Ref.set(czechOnly.world.languageRef, { kind: 'trusted', language: 'en' });
        yield* requestReset(czechOnly.realm);
        yield* step(czechOnly.world, czechOnly.world.messageHandoff, yield* onlyIntent(czechOnly.world));
        expect(czechOnly.world.mailbox[0]?.language).toBe('cs');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S1.4 outline] trusted English with an approved English revision but no usable Czech one: stopped in B, pinned in A, nothing is sent in B',
    () =>
      Effect.gen(function* outline() {
        const modeB = yield* setup({ languages: ['en'], mode: 'B' });
        yield* Ref.set(modeB.world.languageRef, { kind: 'trusted', language: 'en' });
        yield* requestReset(modeB.realm);
        expect(pendingIntentsOf(modeB.world)).toHaveLength(0);
        expect(modeB.world.mailbox).toHaveLength(0);
        expect((yield* attemptsOf(modeB.world)).length).toBe(0);
        const stopped = yield* (yield* historyReads(modeB.world)).list();
        expect(stopped.items[0]?.headline).toMatchObject({
          reasonCodes: ['CZECH_REVISION_REQUIRED_BY_MODE_B'],
          status: 'SUPPRESSED',
        });

        const modeA = yield* setup({ languages: ['en'], mode: 'A' });
        yield* Ref.set(modeA.world.languageRef, { kind: 'trusted', language: 'en' });
        yield* requestReset(modeA.realm);
        yield* step(modeA.world, modeA.world.messageHandoff, yield* onlyIntent(modeA.world));
        expect(modeA.world.mailbox[0]?.language).toBe('en');
        expect((yield* (yield* historyReads(modeA.world)).list()).items[0]?.template).toMatchObject({
          language: 'en',
          mode: 'A',
        });
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('[S1.6] without an approved Czech fallback revision and no trusted language nothing is sent', () =>
    Effect.gen(function* noFallback() {
      const { realm, world } = yield* setup({ languages: ['en'], mode: 'B' });
      yield* requestReset(realm);
      expect(world.mailbox).toHaveLength(0);
      expect(pendingIntentsOf(world)).toHaveLength(0);
      const page = yield* (yield* historyReads(world)).list();
      expect(page.items[0]?.headline.status).toBe('SUPPRESSED');
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S2.3 AC-07] an expired reset link stops before the handoff with a reason and nothing is reissued or sent',
    () =>
      Effect.gen(function* expired() {
        const { realm, world } = yield* setup();
        yield* requestReset(realm);
        const intentId = yield* onlyIntent(world);
        const outcome = yield* stepAfterMinutes(world, intentId, 16);
        expect(outcome.kind).not.toBe('HANDED_OFF');
        expect(world.mailbox).toHaveLength(0);
        expect(realm.issued.reset).toHaveLength(1);
        const page = yield* (yield* historyReads(world)).list();
        expect(page.items[0]?.headline).toMatchObject({ reasonCodes: ['SOURCE_STALE'] });
        expect(page.items[0]?.headline.status).not.toBe('PROVIDER_ACCEPTED');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live("[S2.4] a reset link spent before the handoff stops it, read from Auth's own ledger", () =>
    Effect.gen(function* spent() {
      const { realm, world } = yield* setup();
      yield* requestReset(realm);
      const [token] = realm.issued.reset;
      yield* realm.recovery.resetPassword({
        newPassword: Redacted.make(REPLACEMENT_PASSWORD),
        token: Redacted.make(token ?? ''),
      });
      const outcome = yield* step(world, world.messageHandoff, yield* onlyIntent(world));
      expect(outcome.kind).not.toBe('HANDED_OFF');
      expect(world.mailbox).toHaveLength(0);
      expect((yield* (yield* historyReads(world)).list()).items[0]?.headline.reasonCodes).toEqual(['SOURCE_STALE']);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('[AUTH-COM-04] the ORIGINAL address is kept: a later profile edit does not redirect the message', () =>
    Effect.gen(function* originalBinding() {
      const { realm, world } = yield* setup();
      yield* requestReset(realm);
      const replacement = `moved-${realm.email}`;
      yield* realm.database.executor.update(user).set({ email: replacement }).where(eq(user.email, realm.email));
      yield* step(world, world.messageHandoff, yield* onlyIntent(world));
      expect(Redacted.value(world.mailbox[0]?.to ?? Redacted.make(''))).toBe(realm.email);
      expect(world.mailbox).toHaveLength(1);
      yield* realm.database.executor.update(user).set({ email: realm.email }).where(eq(user.email, replacement));
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S3.1 AC-05] the same issuance replayed returns the original decision; a new issuance is a separate message',
    () =>
      Effect.gen(function* idempotency() {
        const { realm, world } = yield* setup();
        yield* requestReset(realm);
        const [{ request, submission }] = world.submissions;
        const replayed = yield* world.submitter.submit(request);
        expect(replayed).toMatchObject({
          decisionId: decisionIdOf(submission),
          replayed: true,
        });
        expect(world.submissions).toHaveLength(2);
        // the replay is the SAME intent: one intent row, not two
        expect(yield* world.read((tx) => tx.select().from(messageIntents))).toHaveLength(1);

        // only a new Auth-authorized issuance creates a separate security message
        yield* requestReset(realm);
        expect(world.submissions).toHaveLength(3);
        expect(new Set(world.submissions.map(({ request: sent }) => sent.occurrence.occurrenceId)).size).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    "[AC-03] the lifetime and the original binding of the reset issuance are Auth's own, whatever the language or the mode",
    () =>
      Effect.gen(function* lifetime() {
        const lifetimes: number[] = [];
        for (const [mode, language] of [
          ['B', 'cs'],
          ['A', 'en'],
          ['B', 'en'],
        ] as const) {
          const { realm, subjectId, world } = yield* setup({ mode });
          yield* Ref.set(world.languageRef, { kind: 'trusted', language });
          yield* requestReset(realm);
          const issuance = Option.getOrThrow(yield* world.handoff.issuanceOf(issuanceRefOf(world)));
          expect(issuance.providerSubjectId).toBe(subjectId);
          lifetimes.push(issuance.expiresAt.epochMilliseconds - issuance.issuedAt.epochMilliseconds);
        }
        expect(new Set(lifetimes)).toEqual(
          new Set([COMMERCE_PORTAL_AUTH_POLICY.password.resetTokenExpiresInSeconds * 1000]),
        );
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S2.5 AC-08] an unknown address creates no request and no history; an operator without access learns nothing, an authorized one sees status only',
    () =>
      Effect.gen(function* enumeration() {
        const { realm, world } = yield* setup();
        const known = yield* requestReset(realm);
        const unknown = yield* requestReset(realm, `nobody-${realm.email}`);
        // the same answer for an account that exists and one that does not
        expect(known).toStrictEqual(unknown);
        expect(world.submissions).toHaveLength(1);

        const denied = yield* historyReads(world, 'denied');
        const deniedList = yield* Effect.flip(denied.list());
        const deniedDetail = yield* Effect.flip(denied.detail(yield* onlyIntent(world)));
        expect(JSON.stringify([deniedList, deniedDetail])).not.toContain(realm.email);

        const allowed = yield* historyReads(world);
        const page = yield* allowed.list();
        expect(page.items).toHaveLength(1);
        const detail = yield* allowed.detail(yield* onlyIntent(world));
        expect(JSON.stringify(detail)).not.toMatch(/https?:\/\//iu);
        expect(JSON.stringify([page, detail])).not.toContain(
          Option.getOrThrow(Option.fromNullishOr(realm.issued.reset[0])),
        );
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    "[S2.6 AUTH-COM-04] the same address under another subject never merges: a message for one account cannot use another account's issuance",
    () =>
      Effect.gen(function* twoSubjects() {
        const { realm, subjectId, world } = yield* setup();
        yield* requestReset(realm);
        const other = yield* signUp(realm, `second-${realm.email}`);
        const issuance = yield* world.handoff.issuanceOf(issuanceRefOf(world));
        // the crafted request names ANOTHER subject for this account's issuance (a different purpose, so a different identity)
        const crafted = yield* portalAuthCommunicationRequest(
          { ...Option.getOrThrow(issuance), flow: 'verify-email', providerSubjectId: other },
          { tenantId: world.tenantId },
        );
        const outcome = yield* world.submitter.submit(crafted);
        expect(outcome).toMatchObject({ decision: { intents: [{ status: 'SUPPRESSED' }], kind: 'MESSAGE_INTENTS' } });
        expect(other).not.toBe(subjectId);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S2.7 AC-06] Privacy: a prohibition suppresses, an unproven allowance holds, and an address Privacy cannot bind stops with its own reason',
    () =>
      Effect.gen(function* privacyStops() {
        const prohibited = yield* setup();
        prohibited.world.privacyAnswers.set(prohibited.subjectId, privacyNotAllowed());
        yield* requestReset(prohibited.realm);
        expect(prohibited.world.mailbox).toHaveLength(0);
        const proven = (yield* (yield* historyReads(prohibited.world)).list()).items[0]?.headline;

        const unproven = yield* setup();
        unproven.world.privacyAnswers.set(unproven.subjectId, privacyIndeterminate);
        yield* requestReset(unproven.realm);
        expect(unproven.world.mailbox).toHaveLength(0);
        const held = (yield* (yield* historyReads(unproven.world)).list()).items[0]?.headline;
        expect(proven?.reasonCodes).not.toEqual(held?.reasonCodes);

        // the Privacy owner has no supported pre-verification binding: Auth cannot evidence it, so nothing is sent, safely
        const unbound = yield* setup({ evidencing: false, mode: 'B' });
        yield* requestReset(unbound.realm);
        expect(unbound.world.mailbox).toHaveLength(0);
        expect(pendingIntentsOf(unbound.world)).toHaveLength(0);
        const stop = (yield* (yield* historyReads(unbound.world)).list()).items[0]?.headline;
        expect(stop).toMatchObject({ attention: 'FAILURE', status: 'SUPPRESSED' });
        expect(stop?.reasonCodes).not.toEqual(proven?.reasonCodes);
        // the stop is Privacy's own class: an unevidenced scope is stored as unresolved and Privacy is never asked about a guess
        expect(stop?.reasonCodes).toEqual(['PRIVACY_INDETERMINATE']);
        expect(unbound.world.privacyQueries).toHaveLength(0);
        expect(held?.reasonCodes).toEqual(['PRIVACY_INDETERMINATE']);
        expect(unproven.world.privacyQueries.length).toBeGreaterThan(0);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S3.2 S3.5 AC-07] a provider timeout leaves the effect UNKNOWN and nothing is sent twice; acceptance never completes the reset',
    () =>
      Effect.gen(function* providerUncertainty() {
        const { realm, world } = yield* setup();
        world.providerAnswer.current = () => ({ kind: 'INDETERMINATE', reason: 'timeout' });
        yield* requestReset(realm);
        const intentId = yield* onlyIntent(world);
        yield* step(world, world.messageHandoff, intentId);
        yield* step(world, world.messageHandoff, intentId);
        yield* step(world, world.messageHandoff, intentId);
        expect(world.mailbox).toHaveLength(1);
        expect(realm.issued.reset).toHaveLength(1);
        expect((yield* attemptsOf(world)).length).toBe(1);
        const page = yield* (yield* historyReads(world)).list();
        expect(page.items[0]?.headline).toMatchObject({ attention: 'UNKNOWN', providerAccepted: false });

        // a SEPARATE account: acceptance by the provider is not the reset: the link is still unspent and the password unchanged
        const accepted = yield* setup();
        yield* requestReset(accepted.realm);
        yield* step(accepted.world, accepted.world.messageHandoff, yield* onlyIntent(accepted.world));
        expect((yield* (yield* historyReads(accepted.world)).list()).items[0]?.headline.status).toBe(
          'PROVIDER_ACCEPTED',
        );
        expect(yield* accepted.world.handoff.currentness(issuanceRefOf(accepted.world))).toBe('CURRENT');
        // the reset link is still unspent in Auth's own ledger: the provider's acceptance never completed the reset
        const [token] = accepted.realm.issued.reset;
        const ledger = yield* accepted.realm.store.peekPasswordResetLedger({ token: Redacted.make(token ?? '') });
        expect(Option.isSome(ledger)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AUTH-COM-09 recovery NONE] a proven refusal by the provider is final: no automatic second attempt and no reissued link',
    () =>
      Effect.gen(function* refusal() {
        const { realm, world } = yield* setup();
        world.providerAnswer.current = () => ({ kind: 'REJECTED', reason: 'provider_rejected' });
        yield* requestReset(realm);
        const intentId = yield* onlyIntent(world);
        yield* step(world, world.messageHandoff, intentId);
        yield* step(world, world.messageHandoff, intentId);
        expect((yield* attemptsOf(world)).length).toBe(1);
        expect(world.mailbox).toHaveLength(1);
        expect(realm.issued.reset).toHaveLength(1);
        expect((yield* (yield* historyReads(world)).list()).items[0]?.headline.status).toBe('FAILED');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-06 restart] after a restart Auth cannot resume the issuance: a truthful stop and the link is never reproduced',
    () =>
      Effect.gen(function* restart() {
        const { realm, world } = yield* setup();
        yield* requestReset(realm);
        const intentId = yield* onlyIntent(world);
        // a restart drops the process-local protected handoff: the entry is gone, observably the same
        yield* world.handoff.forget(issuanceRefOf(world));
        const outcome = yield* step(world, world.messageHandoff, intentId);
        expect(outcome.kind).not.toBe('HANDED_OFF');
        expect(world.mailbox).toHaveLength(0);
        expect(realm.issued.reset).toHaveLength(1);
        expect((yield* (yield* historyReads(world)).list()).items[0]?.headline.reasonCodes).toEqual(['SOURCE_STALE']);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
