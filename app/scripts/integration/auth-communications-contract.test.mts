import { Effect, Option, Ref, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE,
  PORTAL_AUTH_EMAIL_FLOWS,
  PORTAL_AUTH_ISSUANCE_STATE,
  PORTAL_AUTH_RECIPIENT_ROLE,
  PORTAL_AUTH_RESOURCE_TYPE,
  PortalAuthIssuanceRefSchema,
  portalAuthCommunicationPurposeOf,
  portalAuthOwnerRenderedSlotOf,
} from '../../verticals/commerce-customer-context/shared/portal-auth-communications.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../../verticals/commerce-customer-context/api/portal-auth/provider/config.ts';
import { COMMERCE_PORTAL_AUTH_MFA_POLICY } from '../../verticals/commerce-customer-context/api/portal-auth/provider/mfa/plugin.ts';
import { approvedMessageTypes } from '../../verticals/communications/src/domain/catalog/approved-registry.ts';
import { recoveryPolicyOf, resendPolicyOf } from '../../verticals/communications/src/domain/catalog/message-type.ts';
import {
  findMessageTypeByPurpose,
  buildMessageTypeRegistry,
} from '../../verticals/communications/src/domain/catalog/registry.ts';
import { CommunicationPurposeKeySchema } from '../../verticals/communications/src/domain/catalog/vocabulary.ts';
import { authWorld, flowOfPurpose } from './support/auth-communications-world.spec.mts';
import { makeOtpRealm } from './support/auth-communications-realms.spec.mts';
import { nativeServices } from '../../verticals/communications/tests/support/persistence.fixture.ts';

/**
 * #1406: the two owners' strings are SEPARATE source files that must agree. Auth publishes its vocabulary; Communications
 * approves its types; this suite is where a drift between them fails CI. It also pins that language never moves an issuance's
 * lifetime (AC-03).
 */

describe('The Portal Auth vocabulary and the approved Communications catalog agree (#1406)', () => {
  it("every Auth flow has exactly one approved type, owned by Auth, with Auth's own source state, role and contact source", () => {
    expect(approvedMessageTypes).toHaveLength(PORTAL_AUTH_EMAIL_FLOWS.length);
    for (const flow of PORTAL_AUTH_EMAIL_FLOWS) {
      const type = approvedMessageTypes.find(({ purpose }) => purpose === portalAuthCommunicationPurposeOf(flow));
      expect(type).toBeDefined();
      expect(flowOfPurpose(type?.purpose ?? '')).toBe(flow);
      expect(type?.sourceOwner).toBe(PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE);
      expect(type?.eligibleSourceStates).toEqual([PORTAL_AUTH_ISSUANCE_STATE.current]);
      expect(type?.result.kind).toBe('MESSAGE_INTENTS');
      if (type?.result.kind === 'MESSAGE_INTENTS') {
        expect(type.result.slots).toHaveLength(1);
        expect(type.result.slots[0]).toMatchObject({
          cardinality: 'EXACTLY_ONE',
          recipientRole: PORTAL_AUTH_RECIPIENT_ROLE,
          source: {
            contactOwner: PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE,
            contactResourceType: PORTAL_AUTH_RESOURCE_TYPE.endpoint,
            evidenceKinds: ['HISTORICAL_SNAPSHOT'],
          },
        });
      }
      // Auth security meaning: required; no automatic recovery, no resend, no document (Auth owner approves none of them)
      expect(type?.requiredness).toBe('REQUIRED');
      expect(type === undefined ? undefined : recoveryPolicyOf(type)).toEqual({ kind: 'NONE' });
      expect(type === undefined ? undefined : resendPolicyOf(type)).toBe('NOT_ALLOWED');
      expect(type?.documents).toBeUndefined();
      expect(type?.privacyPurposeRefs).toEqual([portalAuthCommunicationPurposeOf(flow)]);
    }
    expect(new Set(PORTAL_AUTH_EMAIL_FLOWS.map(portalAuthOwnerRenderedSlotOf)).size).toBe(3);
    expect(Schema.is(CommunicationPurposeKeySchema)(portalAuthCommunicationPurposeOf('otp'))).toBe(true);
    const registry = Result.getOrThrow(buildMessageTypeRegistry(approvedMessageTypes));
    expect(
      Option.isSome(
        findMessageTypeByPurpose(
          registry,
          Schema.decodeSync(CommunicationPurposeKeySchema)(portalAuthCommunicationPurposeOf('otp')),
        ),
      ),
    ).toBe(true);
  });

  it.live(
    "[AC-03] the lifetime of an issuance is Auth's own policy and does not change with the language, the mode or the revision",
    () =>
      Effect.gen(function* lifetimeOfIssuance() {
        const policySeconds = {
          otp: COMMERCE_PORTAL_AUTH_MFA_POLICY.otpPeriodMinutes * 60,
          'reset-password': COMMERCE_PORTAL_AUTH_POLICY.password.resetTokenExpiresInSeconds,
          'verify-email': COMMERCE_PORTAL_AUTH_POLICY.emailVerification.expiresInSeconds,
        } as const;
        const measured: number[] = [];
        for (const [mode, trusted] of [
          ['B', 'cs'],
          ['A', 'en'],
          ['B', 'en'],
        ] as const) {
          const world = yield* authWorld({ mode });
          yield* Ref.set(world.languageRef, { kind: 'trusted', language: trusted });
          const realm = makeOtpRealm(world);
          const challenge = yield* realm.pendingChallenge;
          yield* Effect.promise(
            async () =>
              await realm.auth.api.sendTwoFactorOTP({ body: { trustDevice: false }, headers: challenge.headers }),
          );
          for (let attempt = 0; attempt < 200 && world.submissions.length === 0; attempt += 1) {
            yield* Effect.sleep(25);
          }
          const issuance = Option.getOrThrow(
            yield* world.handoff.issuanceOf(
              Schema.decodeSync(PortalAuthIssuanceRefSchema)(
                world.submissions[0]?.request.occurrence.occurrenceId ?? '',
              ),
            ),
          );
          measured.push(issuance.expiresAt.epochMilliseconds - issuance.issuedAt.epochMilliseconds);
        }
        expect(new Set(measured)).toEqual(new Set([policySeconds.otp * 1000]));
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
