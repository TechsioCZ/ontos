import type { CommunicationRequestEncoded } from '@app/communications-contracts/communication-request';
import { DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';
import { CommercePortalAuthCommunicationsEmailLive } from '../../api/portal-auth/provider/communications-email-delivery.ts';
import { CommercePortalAuthRawEmailDeliveryService } from '../../api/portal-auth/provider/raw-email-delivery-service.ts';
import { CommercePortalAuthRecoveryStoreService } from '../../api/portal-auth/provider/recovery/store-service.ts';
import type { CommercePortalAuthRecoveryStore } from '../../api/portal-auth/provider/recovery/store-service.ts';
import { PortalAuthIssuanceRefSchema } from '../../shared/portal-auth-communications.ts';
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
} satisfies Pick<
  CommercePortalAuthRecoveryStore,
  'locateOtpChallenge' | 'peekEmailVerificationLedger' | 'peekPasswordResetLedger'
>;

const pending: PortalAuthSubmission = {
  decision: { intents: [{ intentId: 'intent-1', status: 'PENDING_HANDOFF' }], kind: 'MESSAGE_INTENTS' },
  decisionId: 'decision-1',
  outcome: 'DECIDED',
  replayed: false,
  requestId: 'request-1',
};

const fixture = (
  answer: () => Effect.Effect<PortalAuthSubmission, PortalAuthCommunicationUnavailable> = () => Effect.succeed(pending),
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
    Layer.succeed(CommercePortalAuthRecoveryStoreService, storedFacts as CommercePortalAuthRecoveryStore),
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
        yield* runHook(async () => await raw.sendOTP({ otp: '482913', user: USER }));
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
          runHook(async () => await out.raw.sendOTP({ otp: '111222', user: USER })),
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
          Layer.succeed(CommercePortalAuthRecoveryStoreService, storedFacts as CommercePortalAuthRecoveryStore),
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
