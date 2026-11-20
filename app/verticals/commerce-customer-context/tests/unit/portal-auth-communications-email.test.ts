import type { CommunicationRequestEncoded } from '@app/communications-contracts/communication-request';
import type { OTPOptions } from 'better-auth/plugins/two-factor';
import { inspect } from 'node:util';
import { Cause, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { withCause } from '../../api/portal-auth/problems-support.ts';
import { CommercePortalAuthRecoveryUnavailable } from '../../api/portal-auth/provider/recovery/unavailable.ts';
import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';
import { CommercePortalAuthCommunicationsEmailLive } from '../../api/portal-auth/provider/communications-email-delivery.ts';
import { CommercePortalAuthRawEmailDeliveryService } from '../../api/portal-auth/provider/raw-email-delivery-service.ts';
import { PortalAuthIssuanceRefSchema } from '../../shared/portal-auth-communications.ts';
import { CommercePortalAuthIssuedFacts } from '../../src/portal-auth/communications/issued-facts.ts';
import type { IssuedFactsService } from '../../src/portal-auth/communications/issued-facts.ts';
import { CommercePortalAuthCommunicationRequestSubmitter } from '../../src/portal-auth/communications/communication-request-submitter.ts';
import type { PortalAuthSubmission } from '../../src/portal-auth/communications/communication-request-submitter.ts';
import { PortalAuthCommunicationUnavailable } from '../../src/portal-auth/communications/communication-unavailable.ts';
import {
  CommercePortalAuthOwnerSlotCompletion,
  ownerSlotCompletionLayer,
} from '../../src/portal-auth/communications/owner-completion.ts';
import {
  CommercePortalAuthProtectedHandoff,
  protectedHandoffLayer,
} from '../../src/portal-auth/communications/protected-handoff.ts';
import {
  CommercePortalAuthTrustedScope,
  unconfiguredTrustedScopeLayer,
} from '../../src/portal-auth/communications/trusted-scope.ts';

/**
 * #1406 AUTH-COM-01/06/08: the Communications-routed form of the three Auth callbacks. The submitter below is scripted, so these
 * tests prove what AUTH does with an issuance and with each answer of Communications; the real Action is exercised by the
 * end-to-end suites. Every token, link, code and address is FICTIONAL.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const EPOCH = DateTime.toDateUtc(DateTime.makeUnsafe(0));
const USER = {
  createdAt: EPOCH,
  email: 'holder@example.test',
  emailVerified: false,
  id: 'subject-1',
  name: 'Holder',
  twoFactorEnabled: true,
  updatedAt: EPOCH,
};
const decodeRef = Schema.decodeSync(PortalAuthIssuanceRefSchema);

/**
 * The slice of Better Auth's endpoint context the delivery reads to name the two-factor challenge of a code (a pending sign-in
 * names it by its signed cookie), scripted and FICTIONAL. The real plugin is exercised by the end-to-end suite of the one-time code.
 */
// SAFETY: the delivery reads only the cookie name, the secret and getSignedCookie of the context, and tolerates a context that
// cannot name a session; Better Auth's whole endpoint context is not reproduced by this fixture.
const OTP_CONTEXT = {
  context: { createAuthCookie: () => ({ name: 'two_factor' }), secret: 'fictional-secret' },
  getSignedCookie: () => Promise.resolve('fictional-challenge-cookie'),
} as unknown as Parameters<NonNullable<OTPOptions['sendOTP']>>[1];

/** The expiry Auth itself stored for each issuance (the ledger rows and Better Auth's challenge row), scripted and FICTIONAL. */
const STORED_EXPIRY = new Date('2026-11-19T10:15:00.000Z');
const storedFacts = {
  locateOtpChallenge: () =>
    Effect.succeed(
      Option.some({ attempts: 0, challenge: Redacted.make('2fa-otp-fictional-key'), expiresAt: STORED_EXPIRY }),
    ),
  peekEmailVerificationLedger: () =>
    Effect.succeed(
      Option.some({ email: USER.email, expiresAt: STORED_EXPIRY, providerSubjectId: USER.id, tokenDigest: 'digest' }),
    ),
  peekPasswordResetLedger: () =>
    Effect.succeed(
      Option.some({ email: USER.email, expiresAt: STORED_EXPIRY, providerSubjectId: USER.id, tokenDigest: 'digest' }),
    ),
} satisfies IssuedFactsService;

const pending: PortalAuthSubmission = {
  decision: { intents: [{ intentId: 'intent-1', status: 'PENDING_HANDOFF' }], kind: 'MESSAGE_INTENTS' },
  decisionId: 'decision-1',
  outcome: 'DECIDED',
  replayed: false,
  requestId: 'request-1',
};

const fixture = (
  answer: () => Effect.Effect<PortalAuthSubmission, PortalAuthCommunicationUnavailable> = () => Effect.succeed(pending),
  facts: IssuedFactsService = storedFacts,
) => {
  const requests: CommunicationRequestEncoded[] = [];
  const submitter = Layer.succeed(CommercePortalAuthCommunicationRequestSubmitter, {
    submit: (request) => {
      requests.push(request);
      return answer();
    },
  });
  const handoffLayer = protectedHandoffLayer(() => Effect.succeed('CURRENT'));
  const base = Layer.mergeAll(
    handoffLayer,
    submitter,
    Layer.succeed(CommercePortalAuthTrustedScope, { current: Effect.succeed({ tenantId: TENANT }) }),
    // the delivery reads only these three of the store: the stored expiry of the issuance it was just handed
    Layer.succeed(CommercePortalAuthIssuedFacts, facts),
    commercePortalAuthPlatformCryptoLive,
  );
  const delivery = CommercePortalAuthCommunicationsEmailLive.pipe(Layer.provide(base));
  const completion = ownerSlotCompletionLayer.pipe(Layer.provide(handoffLayer));
  return { base, completion, delivery, handoffLayer, requests };
};

const servicesOf = (world: ReturnType<typeof fixture>) =>
  Effect.gen(function* services() {
    return {
      handoff: yield* CommercePortalAuthProtectedHandoff,
      raw: yield* CommercePortalAuthRawEmailDeliveryService,
    };
  }).pipe(Effect.provide(Layer.merge(world.delivery, world.handoffLayer)));

const runHook = <Value>(run: () => Promise<Value>) => Effect.tryPromise({ catch: (cause) => cause, try: run });

describe('The Communications-routed Portal Auth e-mail callbacks (#1406)', () => {
  it.effect(
    'each flow submits ONE secret-free request and holds the secret and the original address in the protected handoff',
    () => {
      const world = fixture();
      const everything = Layer.mergeAll(world.delivery, world.handoffLayer, world.completion);
      return Effect.gen(function* threeFlows() {
        const handoff = yield* CommercePortalAuthProtectedHandoff;
        const completion = yield* CommercePortalAuthOwnerSlotCompletion;
        const raw = yield* CommercePortalAuthRawEmailDeliveryService;
        yield* runHook(
          async () =>
            await raw.sendVerificationEmail({
              token: 'fictional-token-v',
              url: 'https://portal.example.test/verify?token=fictional-token-v',
              user: USER,
            }),
        );
        yield* runHook(
          async () =>
            await raw.sendResetPassword({
              token: 'fictional-token-r',
              url: 'https://portal.example.test/reset/fictional-token-r',
              user: USER,
            }),
        );
        yield* runHook(async () => await raw.sendOTP({ otp: '482913', user: USER }, OTP_CONTEXT));
        expect(world.requests).toHaveLength(3);
        const sent = JSON.stringify(world.requests);
        for (const secret of ['fictional-token-v', 'fictional-token-r', '482913', 'holder@example.test', 'https://']) {
          expect(sent).not.toContain(secret);
        }
        const { requests } = world;
        expect(new Set(requests.map(({ idempotency }) => idempotency.key)).size).toBe(3);
        expect(requests.map(({ idempotency }) => idempotency.key.split('.').slice(0, 2).join('.'))).toStrictEqual([
          'portal-auth.verify-email',
          'portal-auth.reset-password',
          'portal-auth.otp',
        ]);
        // Auth alone can complete each slot: the link, the link, the code
        const expected = [
          ['verify-email', 'verification_link', 'https://portal.example.test/verify?token=fictional-token-v'],
          ['reset-password', 'reset_link', 'https://portal.example.test/reset/fictional-token-r'],
          ['otp', 'otp_code', '482913'],
        ] as const;
        for (const [index, [flow, slot, value]] of expected.entries()) {
          const issuanceRef = decodeRef(requests[index]?.occurrence.occurrenceId ?? '');
          expect(yield* handoff.currentness(issuanceRef)).toBe('CURRENT');
          const completed = yield* completion.complete({ flow, issuanceRef, slots: [slot] });
          expect(Redacted.value(completed.get(slot) ?? Redacted.make(''))).toBe(value);
        }
      }).pipe(Effect.provide(everything));
    },
  );

  it.effect(
    "a failing read of Auth's stored facts carries NO secret anywhere in its error, its Cause or its log output (a live code is never echoed)",
    () => {
      const SECRET_CODE = '739204';
      const SECRET_TOKEN = 'fictional-token-leak';
      // a database failure as the driver reports it: the statement text with every bound parameter echoed
      const echoed = new Error(
        `Failed query: select ... where value like '${SECRET_CODE}:%' and identifier = '${SECRET_TOKEN}' params: ${SECRET_CODE}:%,${SECRET_TOKEN}`,
        { cause: new Error(`params: ${SECRET_CODE}`) },
      );
      const unavailable = () =>
        Effect.fail(
          withCause(
            new CommercePortalAuthRecoveryUnavailable({
              operation: 'stored-facts',
              reason: 'The store is unavailable',
            }),
            echoed,
          ),
        );
      const failingFacts = {
        locateOtpChallenge: unavailable,
        peekEmailVerificationLedger: unavailable,
        peekPasswordResetLedger: unavailable,
      } satisfies IssuedFactsService;
      const world = fixture(() => Effect.succeed(pending), failingFacts);
      return Effect.gen(function* scan() {
        const { raw } = yield* servicesOf(world);
        const failures = [
          yield* Effect.flip(runHook(async () => await raw.sendOTP({ otp: SECRET_CODE, user: USER }, OTP_CONTEXT))),
          yield* Effect.flip(
            runHook(
              async () =>
                await raw.sendVerificationEmail({
                  token: SECRET_TOKEN,
                  url: `https://portal.example.test/verify?token=${SECRET_TOKEN}`,
                  user: USER,
                }),
            ),
          ),
          yield* Effect.flip(
            runHook(
              async () =>
                await raw.sendResetPassword({
                  token: SECRET_TOKEN,
                  url: `https://portal.example.test/reset/${SECRET_TOKEN}`,
                  user: USER,
                }),
            ),
          ),
        ];
        for (const failure of failures) {
          expect(Schema.is(PortalAuthCommunicationUnavailable)(failure)).toBe(true);
          // everything an operator, a log or a Cause printer could ever reach: the error, its hidden properties and its causes
          const everything = [
            inspect(failure, { depth: 12, showHidden: true }),
            JSON.stringify(failure),
            String(failure),
            Cause.pretty(Cause.fail(failure)),
          ].join('\n');
          expect(everything).not.toContain(SECRET_CODE);
          expect(everything).not.toContain(SECRET_TOKEN);
        }
      });
    },
  );

  it.effect('a one-time code whose challenge cannot be named is never submitted: no challenge key, no request', () => {
    const world = fixture();
    return Effect.gen(function* unnamed() {
      const { raw } = yield* servicesOf(world);
      const failure = yield* Effect.flip(runHook(async () => await raw.sendOTP({ otp: '555111', user: USER })));
      expect(Schema.is(PortalAuthCommunicationUnavailable)(failure)).toBe(true);
      expect(world.requests).toEqual([]);
    });
  });

  it.effect(
    'the challenge of a code is located by the KEY of its challenge and the user, never by the code alone',
    () => {
      const located: { challengeKey: unknown; userId: string }[] = [];
      const world = fixture(() => Effect.succeed(pending), {
        ...storedFacts,
        locateOtpChallenge: (input) => {
          located.push({ challengeKey: input.challengeKey, userId: input.userId });
          return storedFacts.locateOtpChallenge();
        },
      });
      return Effect.gen(function* byKey() {
        const { raw } = yield* servicesOf(world);
        yield* runHook(async () => await raw.sendOTP({ otp: '482913', user: USER }, OTP_CONTEXT));
        expect(located).toHaveLength(1);
        expect(located[0]?.userId).toBe(USER.id);
        expect(located[0]?.challengeKey).toMatchObject({ kind: 'SIGN_IN' });
      });
    },
  );

  it.effect(
    'an unavailable intake keeps the held issuance (the request may exist) and a decided stop forgets it, never reissuing',
    () => {
      const outage = fixture(() =>
        Effect.fail(new PortalAuthCommunicationUnavailable({ operation: 'submit-communication-request' })),
      );
      const stopped = fixture(() =>
        Effect.succeed({
          decision: { kind: 'NO_MESSAGE', reason: 'UNKNOWN_PURPOSE' },
          decisionId: 'decision-2',
          outcome: 'DECIDED',
          replayed: false,
          requestId: 'request-2',
        }),
      );
      const suppressed = fixture(() =>
        Effect.succeed({
          decision: {
            intents: [{ intentId: 'intent-3', reason: 'PRIVACY_INDETERMINATE', status: 'SUPPRESSED' }],
            kind: 'MESSAGE_INTENTS',
          },
          decisionId: 'decision-3',
          outcome: 'DECIDED',
          replayed: false,
          requestId: 'request-3',
        }),
      );
      return Effect.gen(function* stops() {
        const out = yield* servicesOf(outage);
        const outageFailure = yield* Effect.flip(
          runHook(async () => await out.raw.sendOTP({ otp: '111222', user: USER }, OTP_CONTEXT)),
        );
        expect(JSON.stringify(outageFailure)).not.toContain('111222');
        expect(outage.requests).toHaveLength(1);

        for (const world of [stopped, suppressed]) {
          const { handoff, raw } = yield* servicesOf(world);
          const failure = yield* Effect.flip(
            runHook(
              async () =>
                await raw.sendResetPassword({
                  token: 'fictional-token-x',
                  url: 'https://portal.example.test/r/x',
                  user: USER,
                }),
            ),
          );
          expect(JSON.stringify(failure)).not.toContain('fictional-token-x');
          const [request] = world.requests;
          // the held secret serves nothing now: gone, not reproduced
          expect(yield* handoff.currentness(decodeRef(request.occurrence.occurrenceId))).toBe('NOT_RESUMABLE');
        }
      });
    },
  );

  it.effect('without a trusted scope nothing is held and nothing is submitted: the deployment fails closed', () => {
    const world = fixture();
    const unconfigured = CommercePortalAuthCommunicationsEmailLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          world.handoffLayer,
          unconfiguredTrustedScopeLayer,
          Layer.succeed(CommercePortalAuthIssuedFacts, storedFacts),
          commercePortalAuthPlatformCryptoLive,
          Layer.succeed(CommercePortalAuthCommunicationRequestSubmitter, { submit: () => Effect.die('never called') }),
        ),
      ),
    );
    return Effect.gen(function* failClosed() {
      const raw = yield* CommercePortalAuthRawEmailDeliveryService;
      const failure = yield* Effect.flip(
        runHook(
          async () =>
            await raw.sendVerificationEmail({
              token: 'fictional-token-s',
              url: 'https://portal.example.test/v/s',
              user: USER,
            }),
        ),
      );
      expect(JSON.stringify(failure)).not.toContain('fictional-token-s');
    }).pipe(Effect.provide(unconfigured));
  });

  it.effect(
    'an enrollment reservation names the issuance, which is then a DIFFERENT identity from the enrollment operation',
    () => {
      const world = fixture();
      return Effect.gen(function* reserved() {
        const { handoff, raw } = yield* servicesOf(world);
        yield* handoff.reserve({
          flow: 'verify-email',
          providerSubjectId: 'subject-1',
          reservation: {
            enrollmentOwnerInvocationId: '22222222-2222-4222-8222-222222222222',
            issuanceRef: decodeRef('pae-reserved-1'),
          },
        });
        yield* runHook(
          async () =>
            await raw.sendVerificationEmail({
              token: 'fictional-token-e',
              url: 'https://portal.example.test/v/e',
              user: USER,
            }),
        );
        const [request] = world.requests;
        expect(request?.occurrence.occurrenceId).toBe('pae-reserved-1');
        expect(request?.idempotency.key).toBe('portal-auth.verify-email.pae-reserved-1');
        expect(JSON.stringify(world.requests)).not.toContain('22222222-2222-4222-8222-222222222222');
        const issuance = yield* handoff.issuanceOf(decodeRef('pae-reserved-1'));
        expect(Option.getOrThrow(issuance).enrollmentOwnerInvocationId).toBe('22222222-2222-4222-8222-222222222222');
        expect(Redacted.isRedacted(Redacted.make('x'))).toBe(true);
      });
    },
  );
});
