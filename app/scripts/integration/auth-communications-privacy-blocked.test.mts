import { randomUUID } from 'node:crypto';

import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentTenantIdSchema,
} from '@app/commerce-customer-context/testing/portal-auth-communications';
import type { PortalAuthEmailFlow } from '@app/commerce-customer-context/testing/portal-auth-communications';
import { Effect, Option, Predicate, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { historyReads, textOf } from './support/auth-communications-checks.spec.mts';
import {
  PASSWORD,
  headersOf,
  makeEnrollmentGateway,
  makeOtpRealm,
  makePostgresRealm,
  signUp,
} from './support/auth-communications-realms.spec.mts';
import type { PostgresRealm } from './support/auth-communications-realms.spec.mts';
import {
  FICTIONAL_COPY,
  authWorld,
  flowOfPurpose,
  pendingIntentsOf,
  step,
  worldServices,
} from './support/auth-communications-world.spec.mts';
import type { AuthWorld } from './support/auth-communications-world.spec.mts';

/**
 * #1406 D.8 and AC-06/AC-09: POSITIVE END-TO-END of each flow against the REAL Privacy owner contract.
 *
 * Before the address of a Portal Auth account is verified, Privacy binds the subject: Auth's REAL production binding asks
 * Privacy's public `bind-pre-verification-subject` Action with Auth's own account reference, the flow's Auth purpose and the
 * issuance expiry only; Privacy answers with its own subject and the exact scope its policy allows. The PRODUCTION
 * Communications Privacy-gate adapter then asks Privacy's public `pre-verification-eligibility` Read, at the decision and again
 * at the last stoppable handoff, and reads ALLOWED / NOT_ALLOWED / INDETERMINATE from Privacy's own evidence.
 *
 * Every suite of this family now runs on this real Privacy (see `support/auth-communications-world.spec.mts`); this one keeps the
 * Privacy-specific proofs: what crossed to Privacy, the withdrawal after the decision and the absence of any policy.
 *
 * What is REAL: the Auth realm and issuance, Auth's binding over Privacy's published bind contract, Privacy's bind / withdraw /
 * eligibility bodies over Privacy's own table in native PostgreSQL as the runtime role (row-level security on, Tenant-wide
 * with no Legal Entity, exactly as the Portal Auth realm), the PRODUCTION owner ports of Communications (Portal Auth source
 * authority and recipient gate, Privacy gate), its intake, decision, intents and handoff step.
 * Labelled stubs that remain: the producer's Privacy-scope declaration (production declares none: open owner gate #1396 J), the
 * Messaging Adapter (step 22), the in-process transport to Auth's Read and to the public Action. What is NOT run: the HTTP
 * gateway, the access gate and SpiceDB (each transport calls the owner body the governed entrypoint runs after authorization),
 * and D1 (the production principal Auth would call Privacy under). The Privacy POLICY values and the copy are FICTIONAL: no
 * Privacy purpose, controller, scope or legal basis has been approved for any Auth flow.
 */

const decodeInvocation = Schema.decodeSync(EnrollmentActionInvocationIdSchema);
const decodeAttempt = Schema.decodeSync(EnrollmentAttemptIdSchema);
const decodeTenant = Schema.decodeSync(EnrollmentTenantIdSchema);
const POLL_MS = 25;
const RESET = 'reset-password';
const POLL_LIMIT = 200;

/** The world on the REAL Privacy owner; a world with no Privacy policy cannot bind, so nothing is ever asked or sent. */
const realPrivacyWorld = Effect.fn('PrivacyPositiveE2E.world')(function* makeWorld(withPolicies: boolean) {
  const world = yield* authWorld({ mode: 'B', withPrivacyPolicies: withPolicies });
  return { asked: world.privacyAsked, bindings: world.privacyBindings, world };
});

/** The handoff step of an intent, as the pre-handoff worker runs it (the world runs it under an operation in progress). */
const handoffOf = (world: AuthWorld, intentId: string) => step(world, world.messageHandoff, intentId);

/** The user asks for a reset; the issuance commits with its request, and one relay tick submits it. */
const requestReset = (realm: PostgresRealm) =>
  Effect.promise(
    async () =>
      await realm.auth.api.requestPasswordReset({ body: { email: realm.email }, headers: headersOf(realm.ip) }),
  ).pipe(Effect.tap(() => realm.relay));

const onlyIntentOf = (world: AuthWorld, flow: PortalAuthEmailFlow) => {
  const [intentId] = world.submissions
    .filter(({ request }) => flowOfPurpose(request.purpose) === flow)
    .flatMap(({ submission }) =>
      submission.outcome === 'DECIDED' && submission.decision.kind === 'MESSAGE_INTENTS'
        ? submission.decision.intents.filter(({ status }) => status === 'PENDING_HANDOFF')
        : [],
    )
    .map((intent) => intent.intentId);
  return Option.match(Option.fromNullishOr(intentId), {
    onNone: () => Effect.die(`the ${flow} request decided no pending intent`),
    onSome: (found) => Effect.succeed(found),
  });
};

/** Nothing either Auth or Communications put to Privacy carries the address, the password or the secret of the mail. */
const expectNothingSecretAskedOf = (asked: readonly unknown[], secrets: readonly string[]) => {
  const wire = JSON.stringify(asked);
  for (const secret of secrets.filter((value) => value.length > 0)) {
    expect(wire).not.toContain(secret);
  }
};

const services = worldServices;

describe('#1406 D.8 positive end-to-end against the REAL Privacy owner contract (native PostgreSQL)', () => {
  it.live('verify-email: a Portal Auth issuance is bound by Privacy before the address is verified, then sent', () =>
    Effect.gen(function* verifyEmail() {
      const { asked, bindings, world } = yield* realPrivacyWorld(true);
      const realm = yield* makePostgresRealm(world, 'verify');
      const gateway = yield* makeEnrollmentGateway(world, realm, { withReplay: true });
      yield* gateway.create({
        email: realm.email,
        enrollmentAttemptId: decodeAttempt(randomUUID()),
        name: 'Verification e-mail fixture',
        ownerInvocationId: decodeInvocation(randomUUID()),
        password: Redacted.make(PASSWORD),
        tenantId: decodeTenant(randomUUID()),
        verificationOrigin: new URL('https://portal.example.test'),
      });
      // the creation committed the account, the issuance and its request; one relay tick submits what it committed
      yield* world.relay;
      // Privacy bound the subject before anything was decided, and the decision asked Privacy about exactly that subject
      expect(bindings).toHaveLength(1);
      expect(world.submissions[0]?.submission).toMatchObject({
        decision: { kind: 'MESSAGE_INTENTS' },
        outcome: 'DECIDED',
      });
      expect((yield* handoffOf(world, yield* onlyIntentOf(world, 'verify-email'))).kind).toBe('HANDED_OFF');
      const [mail] = world.mailbox;
      expect(mail?.subject).toContain(FICTIONAL_COPY);
      expect(textOf(mail)).toContain('/verify-email?');
      expect(Redacted.value(mail?.to ?? Redacted.make(''))).toBe(realm.email);
      // the decision and the last stoppable handoff each asked Privacy's eligibility Read about the bound subject
      expect(asked.filter((request) => Predicate.hasProperty(request, 'bindingRef')).length).toBeGreaterThanOrEqual(2);
      expectNothingSecretAskedOf(asked, [realm.email, PASSWORD, textOf(mail)]);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live('password reset: a Portal Auth issuance is bound by Privacy before the address is verified, then sent', () =>
    Effect.gen(function* passwordReset() {
      const { asked, bindings, world } = yield* realPrivacyWorld(true);
      const realm = yield* makePostgresRealm(world, 'reset');
      yield* signUp(realm);
      yield* requestReset(realm);
      expect(bindings.length).toBeGreaterThan(0);
      expect((yield* handoffOf(world, yield* onlyIntentOf(world, RESET))).kind).toBe('HANDED_OFF');
      const mail = world.mailbox.find(({ flow }) => flow === RESET);
      expect(mail?.subject).toContain(FICTIONAL_COPY);
      expect(Redacted.value(mail?.to ?? Redacted.make(''))).toBe(realm.email);
      // the decision and the last stoppable handoff each asked Privacy's eligibility Read about the bound subject
      expect(asked.filter((request) => Predicate.hasProperty(request, 'bindingRef')).length).toBeGreaterThanOrEqual(2);
      expectNothingSecretAskedOf(asked, [realm.email, PASSWORD, mail === undefined ? '' : textOf(mail)]);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live('one-time code: a Portal Auth issuance is bound by Privacy before the address is verified, then sent', () =>
    Effect.gen(function* oneTimeCode() {
      const { asked, bindings, world } = yield* realPrivacyWorld(true);
      const realm = yield* makeOtpRealm(world);
      const challenge = yield* realm.pendingChallenge;
      const before = world.submissions.length;
      yield* Effect.promise(
        async () => await realm.auth.api.sendTwoFactorOTP({ body: { trustDevice: false }, headers: challenge.headers }),
      );
      // the provider may run the code callback in the background: relay until its committed request has been submitted
      for (let attempt = 0; attempt < POLL_LIMIT && world.submissions.length <= before; attempt += 1) {
        yield* world.relay;
        if (world.submissions.length <= before) {
          yield* Effect.sleep(POLL_MS);
        }
      }
      expect(bindings.length).toBeGreaterThan(0);
      expect((yield* handoffOf(world, yield* onlyIntentOf(world, 'otp'))).kind).toBe('HANDED_OFF');
      const mail = world.mailbox.find(({ flow }) => flow === 'otp');
      expect(mail?.subject).toContain(FICTIONAL_COPY);
      expect(textOf(mail ?? world.mailbox[0])).toContain(realm.issued[0] ?? 'no-code');
      // the decision and the last stoppable handoff each asked Privacy's eligibility Read about the bound subject
      expect(asked.filter((request) => Predicate.hasProperty(request, 'bindingRef')).length).toBeGreaterThanOrEqual(2);
      expectNothingSecretAskedOf(asked, [realm.email, realm.issued[0] ?? '']);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live(
    'a Privacy withdrawal after the decision stops the message at the last stoppable handoff as NOT_ALLOWED',
    () =>
      Effect.gen(function* withdrawn() {
        const { world } = yield* realPrivacyWorld(true);
        const realm = yield* makePostgresRealm(world, 'reset');
        yield* signUp(realm);
        yield* requestReset(realm);
        const intentId = yield* onlyIntentOf(world, RESET);
        yield* world.withdrawBindings;
        expect((yield* handoffOf(world, intentId)).kind).toBe('STOPPED');
        expect(world.mailbox.filter(({ flow }) => flow === RESET)).toHaveLength(0);
        const reasons = (yield* (yield* historyReads(world)).list()).items.flatMap(
          ({ headline }) => headline.reasonCodes,
        );
        expect(reasons).toContain('PRIVACY_NOT_ALLOWED');
      }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live('without a Privacy policy nothing is bound, Privacy is never asked about a guess and nothing is sent', () =>
    Effect.gen(function* unconfigured() {
      const { asked, bindings, world } = yield* realPrivacyWorld(false);
      const realm = yield* makePostgresRealm(world, 'reset');
      yield* signUp(realm);
      yield* requestReset(realm);
      expect(bindings).toHaveLength(0);
      // Auth asked Privacy to bind and Privacy refused; the eligibility Read was never asked without a binding
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.every((request) => Predicate.hasProperty(request, 'source'))).toBe(true);
      expect(pendingIntentsOf(world)).toHaveLength(0);
      expect(world.mailbox).toHaveLength(0);
      // suppressed because no scope could be declared for an unbound subject: an unresolved Privacy context, never NOT_ALLOWED
      const history = (yield* (yield* historyReads(world)).list()).items.map(({ headline }) => headline);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        providerAccepted: false,
        reasonCodes: ['PRIVACY_CONTEXT_AMBIGUOUS'],
        status: 'SUPPRESSED',
      });
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});
