import { randomUUID } from 'node:crypto';

import { nativeServices } from '@app/communications/testing/source-owner-world';
import type { PrivacyOwnerTransport } from '@app/communications/testing/source-owner-world';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentTenantIdSchema,
  PORTAL_AUTH_EMAIL_FLOWS,
  PORTAL_AUTH_RESOURCE_TYPE,
  PreVerificationPrivacyBindingUnavailable,
  portalAuthCommunicationPurposeOf,
} from '@app/commerce-customer-context/testing/portal-auth-communications';
import type {
  PortalAuthEmailFlow,
  PreVerificationPrivacyTransportService,
} from '@app/commerce-customer-context/testing/portal-auth-communications';
import {
  makePreVerificationPrivacyNative,
  preVerificationPrivacyDatabaseLive,
} from '@app/privacy/testing/pre-verification-binding-native';
import type { PreVerificationPrivacyNative } from '@app/privacy/testing/pre-verification-binding-native';
import { Deferred, Effect, Layer, Option, Predicate, Redacted, Schema } from 'effect';
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
} from './support/auth-communications-world.spec.mts';
import type { AuthWorld } from './support/auth-communications-world.spec.mts';

/**
 * #1406 D.8 and AC-06/AC-09: POSITIVE END-TO-END of each flow against the REAL Privacy owner contract.
 *
 * Before the address of a Portal Auth account is verified, Privacy binds the subject: Auth's REAL production binding asks
 * Privacy's public `bind-pre-verification-subject` Action with Auth's own account reference, the flow's Auth purpose and the
 * issuance expiry only; Privacy answers with its own subject and the exact scope its policy allows. The REAL Communications
 * Privacy-gate adapter then asks Privacy's public `pre-verification-eligibility` Read, at the decision and again at the last
 * stoppable handoff, and reads ALLOWED / NOT_ALLOWED / INDETERMINATE from Privacy's own evidence.
 *
 * What is REAL: the Auth realm and issuance, Auth's binding over Privacy's published bind contract, Privacy's bind / withdraw /
 * eligibility bodies over Privacy's own table in native PostgreSQL as the runtime role (row-level security on, Tenant-wide
 * with no Legal Entity, exactly as the Portal Auth realm), Communications' adapter, intake, decision, intents and handoff step.
 * What is NOT run: the HTTP gateway, the access gate and SpiceDB (each transport calls the owner body the governed entrypoint
 * runs after authorization), and D1 (the production principal Auth would call Privacy under). The Privacy POLICY values and the
 * copy are FICTIONAL: no Privacy purpose, controller, scope or legal basis has been approved for any Auth flow.
 */

const decodeInvocation = Schema.decodeSync(EnrollmentActionInvocationIdSchema);
const decodeAttempt = Schema.decodeSync(EnrollmentAttemptIdSchema);
const decodeTenant = Schema.decodeSync(EnrollmentTenantIdSchema);
const POLL_MS = 25;
const RESET = 'reset-password';
const POLL_LIMIT = 200;

/** A FICTIONAL Privacy owner policy for one Auth flow in one Tenant, with no Legal Entity: test data, never a product value. */
const fictionalPolicy = (tenantId: string, flow: PortalAuthEmailFlow) =>
  ({
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    legalBasisRef: 'fictional-legal-basis:contract',
    policyRef: `fictional-policy:${flow}`,
    revision: 'fictional-r1',
    scope: {
      controllerRef: 'fictional-controller',
      dataCategoryRefs: ['fictional:contact'],
      operation: 'FICTIONAL_SEND_AUTH_MESSAGE',
      processingScopeRef: { scopeId: `fictional-scope:${flow}`, scopeType: 'privacy.processing-scope' },
      purposeRef: `fictional-purpose:${flow}`,
      purposeVersionId: 'fictional-purpose-v1',
      recipientRefs: ['fictional.communications'],
    },
    sourceModuleId: 'commerce.customer-context',
    sourcePurposeRef: portalAuthCommunicationPurposeOf(flow),
    sourceResourceType: PORTAL_AUTH_RESOURCE_TYPE.account,
    tenantId,
    validUntil: '2099-01-01T00:00:00.000Z',
  }) as const;

/**
 * The world composed with the REAL Privacy contract. The world's Tenant exists only once the world does, so both transports
 * wait for the Privacy seam built for that Tenant; every request either side puts to Privacy is recorded for the secret scan.
 */
const realPrivacyWorld = Effect.fn('PrivacyPositiveE2E.world')(function* makeWorld(withPolicies: boolean) {
  const seam = yield* Deferred.make<PreVerificationPrivacyNative>();
  const principalId = randomUUID();
  const tenantRef = { current: '' };
  const callAs = (callerAppId: string) => ({ callerAppId, principalId, tenantId: tenantRef.current });
  const asked: unknown[] = [];
  const bindings: string[] = [];
  // Auth's REAL binding asks Privacy's bind Action body as the verified calling module `commerce-customer-context`
  const binding: PreVerificationPrivacyTransportService = {
    bind: (payload) =>
      Deferred.await(seam).pipe(
        Effect.tap(() => Effect.sync(() => asked.push(payload))),
        Effect.flatMap((privacy) => privacy.bind(callAs('commerce-customer-context'), payload)),
        Effect.tap((bound) => Effect.sync(() => bindings.push(bound.bindingRef))),
        Effect.mapError(
          (failure) =>
            new PreVerificationPrivacyBindingUnavailable({
              reason: Predicate.isTagged(failure, 'PreVerificationBindingRejected')
                ? 'PRIVACY_REFUSED'
                : 'PRIVACY_UNAVAILABLE',
            }),
        ),
      ),
  };
  // Communications' REAL Privacy gate asks Privacy's eligibility Read body as the verified calling module `communications`
  const privacyGate: PrivacyOwnerTransport = (question) => {
    asked.push(question.request);
    return question.kind === 'PRE_VERIFICATION'
      ? Deferred.await(seam).pipe(
          Effect.flatMap((privacy) => privacy.eligibility(callAs('communications'), question.request)),
          Effect.mapError((cause) => ({ cause, status: 503 })),
        )
      : Effect.fail({ status: 503 });
  };
  const world = yield* authWorld({ binding, mode: 'B', privacyGate });
  tenantRef.current = world.tenantId;
  const privacy = yield* makePreVerificationPrivacyNative(
    withPolicies ? PORTAL_AUTH_EMAIL_FLOWS.map((flow) => fictionalPolicy(world.tenantId, flow)) : [],
  );
  yield* Deferred.succeed(seam, privacy);
  return { asked, bindings, callAs, privacy, world };
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

const services = Layer.mergeAll(nativeServices, preVerificationPrivacyDatabaseLive);

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
        const { bindings, callAs, privacy, world } = yield* realPrivacyWorld(true);
        const realm = yield* makePostgresRealm(world, 'reset');
        yield* signUp(realm);
        yield* requestReset(realm);
        const intentId = yield* onlyIntentOf(world, RESET);
        for (const bindingRef of new Set(bindings)) {
          yield* privacy.withdraw(callAs('privacy'), { bindingRef, evidenceRef: 'fictional-dsr-case' });
        }
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
      // suppressed because Privacy could establish nothing for an unbound subject: INDETERMINATE, never NOT_ALLOWED
      const history = (yield* (yield* historyReads(world)).list()).items.map(({ headline }) => headline);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        providerAccepted: false,
        reasonCodes: ['PRIVACY_INDETERMINATE'],
        status: 'SUPPRESSED',
      });
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});
