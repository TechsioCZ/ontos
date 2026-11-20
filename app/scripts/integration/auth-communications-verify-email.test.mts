import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Array as EffectArray, DateTime, Effect, Order, Option, Redacted, Ref, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { CommercePortalAuthAccountCreationUnavailable } from '../../verticals/commerce-customer-context/api/portal-auth/provider/account-creation-unavailable.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentTenantIdSchema,
} from '../../verticals/commerce-customer-context/shared/enrollment-contracts.ts';
import { PortalAuthIssuanceRefSchema } from '../../verticals/commerce-customer-context/shared/portal-auth-communications.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../../verticals/commerce-customer-context/api/portal-auth/provider/config.ts';
import { privacyNotAllowed } from '../../verticals/communications/tests/unit/support/privacy-fixtures.ts';
import {
  user,
  verification,
} from '../../verticals/commerce-customer-context/src/portal-auth/persistence/portal-auth-tables.ts';
import { approvedMessageTypes } from '../../verticals/communications/src/domain/catalog/approved-registry.ts';
import { deliveryAttempts, messageIntents } from '../../verticals/communications/src/database/schema.ts';
import { nativeServices } from '../../verticals/communications/tests/support/persistence.fixture.ts';
import {
  FICTIONAL_COPY,
  authWorld,
  pendingIntentsOf,
  step,
  decisionIdOf,
} from './support/auth-communications-world.spec.mts';
import type { AuthWorld } from './support/auth-communications-world.spec.mts';
import { PASSWORD, makeEnrollmentGateway, makePostgresRealm } from './support/auth-communications-realms.spec.mts';
import type { PostgresRealm } from './support/auth-communications-realms.spec.mts';
import {
  captureLogs,
  expectNoSecretAnywhere,
  historyReads,
  textOf,
  tokenFromLink,
} from './support/auth-communications-checks.spec.mts';

/**
 * #1406 END-TO-END of the VERIFICATION e-mail, driven the way enrollment drives it: the real account-creation gateway commits
 * the account and then asks the provider to issue the verification link, whose callback submits the Communication Request to the
 * real public Action. The replay scenarios prove the changed enrollment behaviour (AUTH-COM-09): a replay of the SAME owner
 * invocation correlates the previous issuance, intent and last outcome and sends or issues nothing on uncertainty.
 *
 * Labelled doubles (see `support/auth-communications-world.spec.mts`): the Privacy gate and the missing pre-verification Privacy
 * path, the trusted language, the provider, and the source outcome Read Auth does not have yet (read here from the real
 * Communications history). Every text is FICTIONAL; no approved copy exists. Nothing here is delivery or provider evidence.
 */

const decodeInvocation = Schema.decodeSync(EnrollmentActionInvocationIdSchema);
const decodeAttempt = Schema.decodeSync(EnrollmentAttemptIdSchema);
const decodeTenant = Schema.decodeSync(EnrollmentTenantIdSchema);

/** One enrollment operation: the identities its gateway call carries. A replay is the SAME object again. */
const enrollmentOf = (realm: PostgresRealm) => ({
  email: realm.email,
  enrollmentAttemptId: decodeAttempt(randomUUID()),
  name: 'Verification e-mail fixture',
  ownerInvocationId: decodeInvocation(randomUUID()),
  password: Redacted.make(PASSWORD),
  tenantId: decodeTenant(randomUUID()),
});

/** The recovery rule a FICTIONAL owner approval would give the verification type: test data, never a production limit. */
const withFictionalRecovery = () =>
  approvedMessageTypes.map((type) =>
    type.purpose.endsWith('.verify-email')
      ? { ...type, recovery: { kind: 'RETRY_ON_PROVEN_NON_ACCEPTANCE' as const, maxAttempts: 3 } }
      : type,
  );

const setup = Effect.fn('VerifyEmailE2E.setup')(function* setupWorld(
  options?: Parameters<typeof authWorld>[0],
  gateway?: { readonly withReplay: boolean },
) {
  const world = yield* authWorld(options ?? { mode: 'B' });
  const realm = yield* makePostgresRealm(world, 'verify');
  const enrollment = enrollmentOf(realm);
  const create = yield* makeEnrollmentGateway(world, realm, gateway ?? { withReplay: true });
  return { create: () => create.create(enrollment), enrollment, realm, world };
});

const onlyIntent = (world: AuthWorld) => {
  const [intentId] = pendingIntentsOf(world);
  return Option.match(Option.fromNullishOr(intentId), {
    onNone: () => Effect.die('the verification request decided no pending intent'),
    onSome: (found) => Effect.succeed(found),
  });
};

const attemptsOf = (world: AuthWorld) => world.read((tx) => tx.select().from(deliveryAttempts));
const intentsOf = (world: AuthWorld) => world.read((tx) => tx.select().from(messageIntents));
const verificationRows = (realm: PostgresRealm, subjectId: string) =>
  realm.database.executor.select({ id: verification.id }).from(verification).where(eq(verification.value, subjectId));

describe('Verification e-mail: real Auth source -> public Action -> durable decision/intent -> authorized Read (#1406)', () => {
  it.live(
    '[AC-05 S1.1] a committed account issues one verification, decided once, and reaches the recipient with Czech copy by default',
    () =>
      Effect.gen(function* happyPath() {
        const { create, realm, world } = yield* setup();
        const created = yield* create();
        expect(world.submissions).toHaveLength(1);
        const [{ request, submission }] = world.submissions;
        expect(submission).toMatchObject({
          decision: { kind: 'MESSAGE_INTENTS' },
          outcome: 'DECIDED',
          replayed: false,
        });
        expect(request.originalRecipients[0]?.recipientRef.resourceId).toBe(created.providerSubjectId);
        // the issuance has its OWN identity: the enrollment invocation id is neither the occurrence nor the idempotency key
        expect(request.occurrence.occurrenceId).toMatch(/^pae-[0-9a-f]{40}$/u);

        expect((yield* step(world, world.messageHandoff, yield* onlyIntent(world))).kind).toBe('HANDED_OFF');
        const [mail] = world.mailbox;
        expect(mail?.language).toBe('cs');
        expect(mail?.subject).toContain(FICTIONAL_COPY);
        expect(textOf(mail)).toContain('/verify-email?');
        expect(Redacted.value(mail?.to ?? Redacted.make(''))).toBe(realm.email);
        const page = yield* (yield* historyReads(world)).list();
        expect(page.items[0]).toMatchObject({
          headline: { deliveryProven: false, providerAccepted: true, status: 'PROVIDER_ACCEPTED' },
          template: { language: 'cs', mode: 'B', revisionNumber: 1 },
        });
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-04 S2.1] no verification link, token, URL, password or address is stored, shown or logged anywhere',
    () =>
      Effect.gen(function* secretFree() {
        const { create, enrollment, realm, world } = yield* setup();
        const { lines } = yield* captureLogs(
          Effect.gen(function* run() {
            yield* create();
            yield* step(world, world.messageHandoff, yield* onlyIntent(world));
          }),
        );
        const link = textOf(world.mailbox[0]);
        const token = Option.getOrThrow(tokenFromLink(link));
        const found = yield* expectNoSecretAnywhere(
          world,
          [token, link.slice(link.indexOf('http')), PASSWORD, realm.email],
          lines,
        );
        expect(found).toStrictEqual([]);
        // neither the enrollment operation nor the attempt travel in a request: only the issuance does
        expect(JSON.stringify(world.submissions)).not.toContain(enrollment.ownerInvocationId);
        expect(JSON.stringify(world.submissions)).not.toContain(enrollment.enrollmentAttemptId);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S1.2 S1.3 outline] language: trusted English is pinned in A without a usable Czech revision and stopped in B; with both approved it is English',
    () =>
      Effect.gen(function* languages() {
        const modeB = yield* setup({ languages: ['en'], mode: 'B' });
        yield* Ref.set(modeB.world.languageRef, { kind: 'trusted', language: 'en' });
        // the account is committed but no verification message can leave: the creation reports it truthfully, as unavailable
        expect(Schema.is(CommercePortalAuthAccountCreationUnavailable)(yield* Effect.flip(modeB.create()))).toBe(true);
        expect(modeB.world.mailbox).toHaveLength(0);
        expect(pendingIntentsOf(modeB.world)).toHaveLength(0);
        expect((yield* (yield* historyReads(modeB.world)).list()).items[0]?.headline.reasonCodes).toEqual([
          'CZECH_REVISION_REQUIRED_BY_MODE_B',
        ]);

        const modeA = yield* setup({ languages: ['en'], mode: 'A' });
        yield* Ref.set(modeA.world.languageRef, { kind: 'trusted', language: 'en' });
        yield* modeA.create();
        yield* step(modeA.world, modeA.world.messageHandoff, yield* onlyIntent(modeA.world));
        expect(modeA.world.mailbox[0]?.language).toBe('en');

        const both = yield* setup({ mode: 'B' });
        yield* Ref.set(both.world.languageRef, { kind: 'trusted', language: 'en' });
        yield* both.create();
        yield* step(both.world, both.world.messageHandoff, yield* onlyIntent(both.world));
        expect(both.world.mailbox[0]?.language).toBe('en');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-06] an expired verification link and one spent before the handoff stop it with a reason, and nothing is reissued',
    () =>
      Effect.gen(function* stops() {
        const expired = yield* setup();
        yield* expired.create();
        const now = yield* DateTime.now;
        const later = yield* Effect.gen(function* laterStep() {
          yield* TestClock.setTime(DateTime.add(now, { minutes: 16 }).epochMilliseconds);
          return yield* step(expired.world, expired.world.messageHandoff, yield* onlyIntent(expired.world));
        }).pipe(Effect.provide(TestClock.layer()));
        expect(later.kind).not.toBe('HANDED_OFF');
        expect(expired.world.mailbox).toHaveLength(0);
        expect(expired.realm.issued.verification).toHaveLength(1);
        expect((yield* (yield* historyReads(expired.world)).list()).items[0]?.headline.reasonCodes).toEqual([
          'SOURCE_NO_LONGER_VALID',
        ]);

        const spent = yield* setup();
        yield* spent.create();
        const [token] = spent.realm.issued.verification;
        yield* spent.realm.recovery.verifyEmail({ token: Redacted.make(token ?? '') });
        expect((yield* step(spent.world, spent.world.messageHandoff, yield* onlyIntent(spent.world))).kind).not.toBe(
          'HANDED_OFF',
        );
        expect(spent.world.mailbox).toHaveLength(0);
        expect(spent.realm.issued.verification).toHaveLength(1);
        const codes = (yield* (yield* historyReads(spent.world)).list()).items[0]?.headline.reasonCodes ?? [];
        // the source-state fact is the PRIMARY reason (the labelled recipient double adds its own SOURCE_NO_LONGER_VALID for an
        // issuance whose original endpoint Auth no longer offers); the generic category SOURCE_STALE is never the reason shown
        expect(codes[0]).toBe('SOURCE_CONSUMED');
        expect(codes).not.toContain('SOURCE_STALE');
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AUTH-COM-04] the ORIGINAL address is bound: a later address change of the account does not redirect the message',
    () =>
      Effect.gen(function* originalBinding() {
        const { create, realm, world } = yield* setup();
        yield* create();
        yield* realm.database.executor
          .update(user)
          .set({ email: `moved-${realm.email}` })
          .where(eq(user.email, realm.email));
        yield* step(world, world.messageHandoff, yield* onlyIntent(world));
        expect(Redacted.value(world.mailbox[0]?.to ?? Redacted.make(''))).toBe(realm.email);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-09 S3.3] committed account, first submission possibly accepted then timed out, then a REPLAY of the same enrollment invocation: no second submission and no new issuance',
    () =>
      Effect.gen(function* replayAfterTimeout() {
        const { create, realm, world } = yield* setup();
        world.providerAnswer.current = () => ({ kind: 'INDETERMINATE', reason: 'timeout' });
        const first = yield* create();
        const intentId = yield* onlyIntent(world);
        yield* step(world, world.messageHandoff, intentId);
        expect(world.mailbox).toHaveLength(1);
        expect((yield* (yield* historyReads(world)).list()).items[0]?.headline).toMatchObject({
          attention: 'UNKNOWN',
          providerAccepted: false,
        });

        const issuedBefore = realm.issued.verification.length;
        const ledgerBefore = (yield* verificationRows(realm, first.providerSubjectId)).length;
        const replayed = yield* create();
        // the replay converges on the same committed subject, and sends nothing
        expect(replayed.providerSubjectId).toBe(first.providerSubjectId);
        expect(realm.issued.verification).toHaveLength(issuedBefore);
        expect(world.submissions).toHaveLength(1);
        yield* step(world, world.messageHandoff, intentId);
        expect(world.mailbox).toHaveLength(1);
        expect(world.messageHandoff.calls).toHaveLength(1);
        expect(yield* attemptsOf(world)).toHaveLength(1);
        expect(yield* verificationRows(realm, first.providerSubjectId)).toHaveLength(ledgerBefore);
        expect(yield* intentsOf(world)).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-09 S3.4] a PROVEN non-acceptance continues the SAME intent under the approved recovery rule: the same link, a new attempt, never a new issuance',
    () =>
      Effect.gen(function* continuation() {
        const { create, realm, world } = yield* setup({ mode: 'B', types: withFictionalRecovery() });
        world.providerAnswer.current = () => ({ kind: 'REJECTED', reason: 'rate_limited' });
        yield* create();
        const intentId = yield* onlyIntent(world);
        const first = yield* step(world, world.messageHandoff, intentId);
        expect(first).toMatchObject({ followUp: 'RETRY_DUE', kind: 'HANDED_OFF' });
        const firstLink = textOf(world.mailbox[0]);

        // a replay of the enrollment between the two attempts sends nothing and issues nothing
        yield* create();
        expect(realm.issued.verification).toHaveLength(1);

        world.providerAnswer.current = () => ({
          kind: 'ACCEPTED',
          providerKey: 'fictional-provider',
          providerRef: 'fictional-ref-2',
        });
        yield* step(world, world.messageHandoff, intentId);
        expect(world.mailbox).toHaveLength(2);
        expect(textOf(world.mailbox[1])).toBe(firstLink);
        expect(
          EffectArray.sort(
            (yield* attemptsOf(world)).map(({ attemptNumber }) => attemptNumber),
            Order.Number,
          ),
        ).toEqual([1, 2]);
        expect(realm.issued.verification).toHaveLength(1);
        expect(yield* intentsOf(world)).toHaveLength(1);
        expect(world.submissions).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-09] a first submission whose answer never came back is NEVER treated as not submitted: the replay issues no second link',
    () =>
      Effect.gen(function* neverSubmitted() {
        const { create, realm, world } = yield* setup();
        world.unavailableSubject.current = true;
        const failure = yield* Effect.flip(create());
        expect(Schema.is(CommercePortalAuthAccountCreationUnavailable)(failure)).toBe(true);
        expect(world.submissions).toHaveLength(0);

        // Auth cannot tell "never reached Communications" from "admitted, answer lost": the replay issues nothing new, and the held
        // issuance is continued only by resubmitting the SAME request (the idempotent retry of the issuance identity)
        world.unavailableSubject.current = false;
        yield* create();
        expect(realm.issued.verification).toHaveLength(1);
        expect(world.submissions).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-09 REGRESSION] the request is persisted, the submit then reports unavailable: the replay must not issue a second provider link',
    () =>
      Effect.gen(function* lostAnswer() {
        const { create, realm, world } = yield* setup();
        world.lostAnswerSubject.current = true;
        const failure = yield* Effect.flip(create());
        expect(Schema.is(CommercePortalAuthAccountCreationUnavailable)(failure)).toBe(true);
        // Communications admitted and decided the request; only the answer was lost
        expect(world.submissions).toHaveLength(1);
        expect(yield* intentsOf(world)).toHaveLength(1);

        world.lostAnswerSubject.current = false;
        yield* create();
        // never a second link, never a second request, never a second intent
        expect(realm.issued.verification).toHaveLength(1);
        expect(world.submissions).toHaveLength(1);
        expect(yield* intentsOf(world)).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-09 unavailable reconciliation] when the last outcome cannot be established the replay sends nothing new and stays retryable',
    () =>
      Effect.gen(function* unavailableReconciliation() {
        const { create, realm, world } = yield* setup({ evidencing: false, mode: 'B' });
        // Privacy cannot be evidenced: the first message is stopped; a replay must not repair it by issuing another link
        expect(Schema.is(CommercePortalAuthAccountCreationUnavailable)(yield* Effect.flip(create()))).toBe(true);
        expect(world.submissions).toHaveLength(1);
        const failure = yield* Effect.flip(create());
        expect(Schema.is(CommercePortalAuthAccountCreationUnavailable)(failure)).toBe(true);
        expect(realm.issued.verification).toHaveLength(1);
        expect(world.submissions).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    "[S3.1 AC-03] the same issuance replayed returns the original decision, and its lifetime is Auth's own policy whatever the language",
    () =>
      Effect.gen(function* idempotency() {
        const { create, world } = yield* setup();
        yield* create();
        const [{ request, submission }] = world.submissions;
        const replayed = yield* world.submitter.submit(request);
        expect(replayed).toMatchObject({
          decisionId: decisionIdOf(submission),
          replayed: true,
        });
        expect(yield* intentsOf(world)).toHaveLength(1);
        const issuance = Option.getOrThrow(
          yield* world.handoff.issuanceOf(
            Schema.decodeSync(PortalAuthIssuanceRefSchema)(request.occurrence.occurrenceId),
          ),
        );
        // the request states the expiry Auth STORED, a few milliseconds before the callback
        const policyMs = COMMERCE_PORTAL_AUTH_POLICY.emailVerification.expiresInSeconds * 1000;
        const lifetime = issuance.expiresAt.epochMilliseconds - issuance.issuedAt.epochMilliseconds;
        expect(lifetime).toBeLessThanOrEqual(policyMs);
        expect(lifetime).toBeGreaterThan(policyMs - 5000);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[S2.7 AC-06 AC-08] Privacy prohibition and a restart stop the message; an operator without access learns nothing',
    () =>
      Effect.gen(function* stopsAndAccess() {
        const prohibited = yield* setup();
        const subject = (yield* prohibited.create()).providerSubjectId;
        prohibited.world.privacyAnswers.set(subject, privacyNotAllowed());
        // the account was committed before the verdict; a replay finds the stopped message and refuses to repair it
        const intentId = yield* onlyIntent(prohibited.world);
        yield* step(prohibited.world, prohibited.world.messageHandoff, intentId);
        expect(prohibited.world.mailbox).toHaveLength(0);
        expect((yield* (yield* historyReads(prohibited.world)).list()).items[0]?.headline.reasonCodes).toEqual([
          'PRIVACY_NOT_ALLOWED',
        ]);

        const restarted = yield* setup();
        yield* restarted.create();
        const restartedIntent = yield* onlyIntent(restarted.world);
        const [{ request }] = restarted.world.submissions;
        yield* restarted.world.handoff.forget(
          Schema.decodeSync(PortalAuthIssuanceRefSchema)(request.occurrence.occurrenceId),
        );
        expect((yield* step(restarted.world, restarted.world.messageHandoff, restartedIntent)).kind).not.toBe(
          'HANDED_OFF',
        );
        expect(restarted.world.mailbox).toHaveLength(0);
        expect(restarted.realm.issued.verification).toHaveLength(1);

        const denied = yield* historyReads(restarted.world, 'denied');
        const failures = JSON.stringify([
          yield* Effect.flip(denied.list()),
          yield* Effect.flip(denied.detail(restartedIntent)),
        ]);
        expect(failures).not.toContain(restarted.realm.email);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[regression] a deployment WITHOUT Communications keeps the direct behaviour: a replay reissues the link',
    () =>
      Effect.gen(function* legacy() {
        const { create, realm } = yield* setup({ mode: 'B' }, { withReplay: false });
        yield* create();
        yield* create();
        expect(realm.issued.verification).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
