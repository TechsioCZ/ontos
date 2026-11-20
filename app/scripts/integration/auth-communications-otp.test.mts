import { DateTime, Effect, Option, Redacted, Ref } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { deliveryAttempts, messageIntents } from '../../verticals/communications/src/database/schema.ts';
import { nativeServices } from '../../verticals/communications/tests/support/persistence.fixture.ts';
import { privacyNotAllowed } from '../../verticals/communications/tests/unit/support/privacy-fixtures.ts';
import {
  FICTIONAL_COPY,
  authWorld,
  pendingIntentsOf,
  step,
  decisionIdOf,
  issuanceRefOf,
} from './support/auth-communications-world.spec.mts';
import type { AuthWorld } from './support/auth-communications-world.spec.mts';
import { PASSWORD, makeOtpRealm } from './support/auth-communications-realms.spec.mts';
import type { OtpRealm } from './support/auth-communications-realms.spec.mts';
import {
  captureLogs,
  expectNoSecretAnywhere,
  historyReads,
  textOf,
} from './support/auth-communications-checks.spec.mts';

/**
 * #1406 END-TO-END of the ONE-TIME CODE e-mail: the real two-factor plugin of the Portal Auth realm issues the code, Auth's
 * Communications-routed delivery submits the request, Communications decides and pins it, and Auth's own owner-slot completion
 * is the only thing that ever hands the code to the labelled Messaging Adapter double. Issuing a code is NOT a verification:
 * the second step stays pending until the account owner presents the code to the provider.
 *
 * Labelled doubles (see `support/auth-communications-world.spec.mts`): the Privacy gate and the missing pre-verification Privacy
 * path, the trusted language, the provider. Every text is FICTIONAL; no approved copy exists.
 */

const POLL_MS = 25;
const POLL_LIMIT = 200;

const setup = Effect.fn('OtpE2E.setup')(function* setupWorld(options?: Parameters<typeof authWorld>[0]) {
  const world = yield* authWorld(options ?? { mode: 'B' });
  const realm = makeOtpRealm(world);
  const challenge = yield* realm.pendingChallenge;
  return { challenge, realm, world };
});

/** The provider may run the code callback in the background: wait until it has submitted its request. */
const sendCode = Effect.fn('OtpE2E.sendCode')(function* send(
  world: AuthWorld,
  realm: OtpRealm,
  headers: Headers,
  expectedSubmissions?: number,
) {
  const wanted = expectedSubmissions ?? world.submissions.length + 1;
  yield* Effect.promise(async () => await realm.auth.api.sendTwoFactorOTP({ body: { trustDevice: false }, headers }));
  for (let attempt = 0; attempt < POLL_LIMIT && world.submissions.length < wanted; attempt += 1) {
    yield* Effect.sleep(POLL_MS);
  }
  expect(world.submissions.length).toBeGreaterThanOrEqual(wanted);
});

const onlyIntent = (world: AuthWorld, index = 0) => {
  const intentId = pendingIntentsOf(world)[index];
  return Option.match(Option.fromNullishOr(intentId), {
    onNone: () => Effect.die('the code request decided no pending intent'),
    onSome: (found) => Effect.succeed(found),
  });
};
const codeIn = (text: string) => /\b(?<code>\d{6})\b/u.exec(text)?.groups?.code ?? '';

describe('One-time code e-mail: real Auth source -> public Action -> durable decision/intent -> authorized Read (#1406)', () => {
  it.live(
    '[AC-05 S1.7] an issued code is committed, decided once and reaches the recipient with the approved Czech copy, completed by Auth alone',
    () =>
      Effect.gen(function* happyPath() {
        const { challenge, realm, world } = yield* setup();
        yield* sendCode(world, realm, challenge.headers);
        const [{ request, submission }] = world.submissions;
        expect(submission).toMatchObject({
          decision: { kind: 'MESSAGE_INTENTS' },
          outcome: 'DECIDED',
          replayed: false,
        });
        expect(request.originalRecipients[0]?.recipientRef.resourceId).toBe(challenge.subjectId);
        expect(request.idempotency.key).toMatch(/^portal-auth\.otp\.pa-/u);
        // nothing in the request can hold the code
        expect(JSON.stringify(request)).not.toContain(realm.issued[0] ?? 'no-code');

        expect((yield* step(world, world.messageHandoff, yield* onlyIntent(world))).kind).toBe('HANDED_OFF');
        const [mail] = world.mailbox;
        expect(mail?.language).toBe('cs');
        expect(mail?.subject).toContain(FICTIONAL_COPY);
        expect(codeIn(textOf(mail))).toBe(realm.issued[0]);
        expect(Redacted.value(mail?.to ?? Redacted.make(''))).toBe(realm.email);
        expect((yield* (yield* historyReads(world)).list()).items[0]).toMatchObject({
          headline: { deliveryProven: false, providerAccepted: true, status: 'PROVIDER_ACCEPTED' },
          template: { language: 'cs', mode: 'B', revisionNumber: 1 },
        });
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-04 S2.1] the code is never in a request, intent, history row, preview or log; Communications never sees it',
    () =>
      Effect.gen(function* secretFree() {
        const { challenge, realm, world } = yield* setup();
        const { lines } = yield* captureLogs(
          Effect.gen(function* run() {
            yield* sendCode(world, realm, challenge.headers);
            yield* step(world, world.messageHandoff, yield* onlyIntent(world));
          }),
        );
        const [code] = realm.issued;
        const found = yield* expectNoSecretAnywhere(world, [code ?? 'no-code', PASSWORD, realm.email], lines);
        expect(found).toStrictEqual([]);
        expect(JSON.stringify(world.mailbox[0]?.text)).toBe('"<redacted>"');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S1.7 AUTH-COM-07] issuing a code is NOT a verification: the second step stays pending and no session exists',
    () =>
      Effect.gen(function* notVerification() {
        const { challenge, realm, world } = yield* setup();
        yield* sendCode(world, realm, challenge.headers);
        yield* step(world, world.messageHandoff, yield* onlyIntent(world));
        expect((yield* (yield* historyReads(world)).list()).items[0]?.headline.status).toBe('PROVIDER_ACCEPTED');
        expect(realm.database.session).toHaveLength(0);
        const session = yield* Effect.promise(
          async () => await realm.auth.api.getSession({ headers: challenge.headers }),
        );
        expect(session).toBeNull();
        // the challenge is still answerable: the provider accepted a message, nobody answered the challenge
        const verified = yield* Effect.promise(
          async () =>
            await realm.auth.api.verifyTwoFactorOTP({
              body: { code: realm.issued[0] ?? '' },
              headers: challenge.headers,
            }),
        );
        expect(verified).toBeDefined();
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S1.2 S1.4 outline] trusted English with an approved English revision but no usable Czech one: stopped in B, pinned in A',
    () =>
      Effect.gen(function* outline() {
        const modeB = yield* setup({ languages: ['en'], mode: 'B' });
        yield* Ref.set(modeB.world.languageRef, { kind: 'trusted', language: 'en' });
        yield* sendCode(modeB.world, modeB.realm, modeB.challenge.headers);
        expect(modeB.world.mailbox).toHaveLength(0);
        expect(pendingIntentsOf(modeB.world)).toHaveLength(0);
        expect((yield* (yield* historyReads(modeB.world)).list()).items[0]?.headline.reasonCodes).toEqual([
          'CZECH_REVISION_REQUIRED_BY_MODE_B',
        ]);

        const modeA = yield* setup({ languages: ['en'], mode: 'A' });
        yield* Ref.set(modeA.world.languageRef, { kind: 'trusted', language: 'en' });
        yield* sendCode(modeA.world, modeA.realm, modeA.challenge.headers);
        yield* step(modeA.world, modeA.world.messageHandoff, yield* onlyIntent(modeA.world));
        expect(modeA.world.mailbox[0]?.language).toBe('en');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S2.4 AC-06] an expired code and one the owner already used stop before the handoff with a reason and are never reproduced',
    () =>
      Effect.gen(function* stops() {
        const expired = yield* setup();
        yield* sendCode(expired.world, expired.realm, expired.challenge.headers);
        const now = yield* DateTime.now;
        const later = yield* Effect.gen(function* laterStep() {
          yield* TestClock.setTime(DateTime.add(now, { minutes: 11 }).epochMilliseconds);
          return yield* step(expired.world, expired.world.messageHandoff, yield* onlyIntent(expired.world));
        }).pipe(Effect.provide(TestClock.layer()));
        expect(later.kind).not.toBe('HANDED_OFF');
        expect(expired.world.mailbox).toHaveLength(0);

        const consumed = yield* setup();
        yield* sendCode(consumed.world, consumed.realm, consumed.challenge.headers);
        yield* Effect.promise(
          async () =>
            await consumed.realm.auth.api.verifyTwoFactorOTP({
              body: { code: consumed.realm.issued[0] ?? '' },
              headers: consumed.challenge.headers,
            }),
        );
        // Auth's own lifecycle event for a spent code. The MFA verification path does not call it yet (see the #1406 report).
        yield* consumed.world.handoff.settle({
          issuanceRef: issuanceRefOf(consumed.world),
          state: 'CONSUMED',
        });
        expect(
          (yield* step(consumed.world, consumed.world.messageHandoff, yield* onlyIntent(consumed.world))).kind,
        ).not.toBe('HANDED_OFF');
        expect(consumed.world.mailbox).toHaveLength(0);
        expect(consumed.realm.issued).toHaveLength(1);
        expect((yield* (yield* historyReads(consumed.world)).list()).items[0]?.headline.reasonCodes).toEqual([
          'SOURCE_STALE',
        ]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('[AUTH-COM-07] a newer code revokes the older one: only the current code can be completed', () =>
    Effect.gen(function* supersede() {
      const { challenge, realm, world } = yield* setup();
      yield* sendCode(world, realm, challenge.headers);
      yield* sendCode(world, realm, challenge.headers);
      expect(world.submissions).toHaveLength(2);
      const older = yield* onlyIntent(world, 0);
      const newer = yield* onlyIntent(world, 1);
      expect((yield* step(world, world.messageHandoff, older)).kind).not.toBe('HANDED_OFF');
      expect((yield* step(world, world.messageHandoff, newer)).kind).toBe('HANDED_OFF');
      expect(world.mailbox).toHaveLength(1);
      expect(codeIn(textOf(world.mailbox[0]))).toBe(realm.issued[1]);
      expect(new Set(world.submissions.map(({ request }) => request.idempotency.key)).size).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-06 restart] after a restart Auth cannot resume the code: a truthful stop and nothing is reproduced or reissued',
    () =>
      Effect.gen(function* restart() {
        const { challenge, realm, world } = yield* setup();
        yield* sendCode(world, realm, challenge.headers);
        const intentId = yield* onlyIntent(world);
        yield* world.handoff.forget(issuanceRefOf(world));
        expect((yield* step(world, world.messageHandoff, intentId)).kind).not.toBe('HANDED_OFF');
        expect(world.mailbox).toHaveLength(0);
        expect(realm.issued).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    "[AC-08 S2.5] an operator without access learns nothing about an account's code; an authorized one sees status only",
    () =>
      Effect.gen(function* access() {
        const { challenge, realm, world } = yield* setup();
        yield* sendCode(world, realm, challenge.headers);
        const intentId = yield* onlyIntent(world);
        yield* step(world, world.messageHandoff, intentId);
        const denied = yield* historyReads(world, 'denied');
        const failures = JSON.stringify([
          yield* Effect.flip(denied.list()),
          yield* Effect.flip(denied.detail(intentId)),
        ]);
        expect(failures).not.toContain(realm.email);
        expect(failures).not.toContain(challenge.subjectId);
        const allowed = yield* historyReads(world);
        const detail = yield* allowed.detail(intentId);
        expect(JSON.stringify(detail)).not.toContain(realm.issued[0] ?? 'no-code');
        expect(JSON.stringify(detail)).not.toContain(realm.email);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S3.1 S3.2 AC-07] the same issuance replayed returns the original decision; an unknown provider outcome is never resent',
    () =>
      Effect.gen(function* idempotency() {
        const { challenge, realm, world } = yield* setup();
        world.providerAnswer.current = () => ({ kind: 'INDETERMINATE', reason: 'timeout' });
        yield* sendCode(world, realm, challenge.headers);
        const [{ request, submission }] = world.submissions;
        const replayed = yield* world.submitter.submit(request);
        expect(replayed).toMatchObject({
          decisionId: decisionIdOf(submission),
          replayed: true,
        });
        expect(yield* world.read((tx) => tx.select().from(messageIntents))).toHaveLength(1);
        const intentId = yield* onlyIntent(world);
        yield* step(world, world.messageHandoff, intentId);
        yield* step(world, world.messageHandoff, intentId);
        expect(world.mailbox).toHaveLength(1);
        expect(yield* world.read((tx) => tx.select().from(deliveryAttempts))).toHaveLength(1);
        expect((yield* (yield* historyReads(world)).list()).items[0]?.headline).toMatchObject({
          attention: 'UNKNOWN',
          providerAccepted: false,
        });
        expect(realm.issued).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S2.7] Privacy: a prohibition stops the code; a missing Privacy binding stops it without ever asking Privacy',
    () =>
      Effect.gen(function* privacyStops() {
        const prohibited = yield* setup();
        prohibited.world.privacyAnswers.set(prohibited.challenge.subjectId, privacyNotAllowed());
        yield* sendCode(prohibited.world, prohibited.realm, prohibited.challenge.headers);
        expect(prohibited.world.mailbox).toHaveLength(0);
        expect((yield* (yield* historyReads(prohibited.world)).list()).items[0]?.headline.reasonCodes).toEqual([
          'PRIVACY_NOT_ALLOWED',
        ]);

        const unbound = yield* setup({ evidencing: false, mode: 'B' });
        yield* sendCode(unbound.world, unbound.realm, unbound.challenge.headers);
        expect(unbound.world.mailbox).toHaveLength(0);
        expect(unbound.world.privacyQueries).toHaveLength(0);
        expect((yield* (yield* historyReads(unbound.world)).list()).items[0]?.headline.status).toBe('SUPPRESSED');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
