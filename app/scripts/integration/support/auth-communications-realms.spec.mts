import {
  makeEnrollmentGateway as makePortalAuthEnrollmentGateway,
  makePostgresRealm as makePortalAuthPostgresRealm,
  otpChallengeOf,
} from '@app/commerce-customer-context/testing/portal-auth-communications';
import type { PortalAuthSourceOutcome } from '@app/commerce-customer-context/testing/portal-auth-communications';
import { Effect } from 'effect';

import type { AuthWorld } from './auth-communications-world.spec.mts';
import { historyOfRequest } from './auth-communications-world.spec.mts';

/**
 * TEST-ONLY real Better Auth realms of the Portal Auth e-mail flows, bound to a world. The realms themselves are the Portal
 * Auth seam's (`@app/commerce-customer-context/testing/portal-auth-communications`): the deployment's own realm with its REAL
 * recovery ledger and the Communications-routed delivery installed behind the ledger registration, and the real two-factor
 * plugin for the one-time code. What this file adds is the test's side: the inbox tap that plays the account owner, the
 * world's relay, and the enrollment gateway learning an issuance's outcome from the REAL Communications history of the world.
 */

export {
  headersOf,
  PASSWORD,
  REPLACEMENT_PASSWORD,
  signUp,
} from '@app/commerce-customer-context/testing/portal-auth-communications';

interface IssuedTokens {
  readonly otp: string[];
  readonly reset: string[];
  readonly verification: string[];
}

/** One real Postgres realm of the world's Auth: ledger, provider and the Communications-routed delivery. */
export const makePostgresRealm = Effect.fn('AuthCommunicationsRealm.postgres')(function* makeRealm(
  world: AuthWorld,
  caseName: string,
) {
  // the provider's callback data as the account owner's inbox would see it: only tests read it, to play that owner
  const issued: IssuedTokens = { otp: [], reset: [], verification: [] };
  const tappedDelivery = {
    sendOTP: (
      data: Parameters<typeof world.rawDelivery.sendOTP>[0],
      context: Parameters<typeof world.rawDelivery.sendOTP>[1],
    ) => {
      issued.otp.push(data.otp);
      return world.rawDelivery.sendOTP(data, context);
    },
    sendResetPassword: (data: Parameters<typeof world.rawDelivery.sendResetPassword>[0]) => {
      issued.reset.push(data.token);
      return world.rawDelivery.sendResetPassword(data);
    },
    sendVerificationEmail: (data: Parameters<typeof world.rawDelivery.sendVerificationEmail>[0]) => {
      issued.verification.push(data.token);
      return world.rawDelivery.sendVerificationEmail(data);
    },
  };
  const realm = yield* makePortalAuthPostgresRealm(
    { delivery: tappedDelivery, ledgerProbe: world.ledgerProbe, recoveryStore: world.recoveryStore },
    caseName,
  );
  return { ...realm, issued, relay: world.relay };
});
export type PostgresRealm = Effect.Success<ReturnType<typeof makePostgresRealm>>;

/** What Communications proves about the message of one issuance, as the SOURCE learns it from the real outcome feed. */
export const outcomeOfIssuance = (world: AuthWorld, issuanceRef: string): Effect.Effect<PortalAuthSourceOutcome> =>
  Effect.gen(function* readOutcome() {
    const known = world.submissions.find(({ request }) => request.occurrence.occurrenceId === issuanceRef);
    if (known === undefined || known.submission.outcome !== 'DECIDED') {
      return 'NOT_SUBMITTED' as const;
    }
    const history = yield* historyOfRequest(world, known.submission.requestId);
    const statuses = history.feed.messages.map(({ status }) => status);
    if (
      statuses.length === 0 ||
      statuses.some((status) => status === 'SUPPRESSED' || status === 'HELD_UNPROVEN' || status === 'NO_MESSAGE')
    ) {
      return 'STOPPED' as const;
    }
    if (statuses.some((status) => status === 'PROVIDER_SUBMITTED' || status === 'INDETERMINATE')) {
      return 'UNCERTAIN' as const;
    }
    if (statuses.some((status) => status === 'FAILED')) {
      return 'NON_ACCEPTANCE_PROVEN' as const;
    }
    return statuses.every((status) => status === 'PREPARED') ? ('IN_PROGRESS' as const) : ('ACCEPTED' as const);
  }).pipe(Effect.orDie);

/** The enrollment account-creation gateway over the realm, with the verification replay rule installed (or not). */
export const makeEnrollmentGateway = (
  world: AuthWorld,
  realm: PostgresRealm,
  options: { readonly withReplay: boolean },
) =>
  makePortalAuthEnrollmentGateway(realm, {
    handoff: world.handoff,
    outcomeOf: (issuanceRef) => outcomeOfIssuance(world, issuanceRef),
    withReplay: options.withReplay,
  });

/**
 * The one-time code realm: the REAL Portal Auth provider (the real two-factor plugin over the real Postgres schema), delivering
 * through the world's Auth. The challenge Better Auth stores for each code is the very row Auth's Current-state read looks at.
 */
export const makeOtpRealm = Effect.fn('AuthCommunicationsRealm.otp')(function* makeOtp(world: AuthWorld) {
  const realm = yield* makePostgresRealm(world, 'otp');
  const { auth, email, ip } = realm;
  const { authenticatedSessionCount, pendingChallenge } = otpChallengeOf(realm);
  return { auth, authenticatedSessionCount, email, ip, issued: realm.issued.otp, pendingChallenge, realm };
});
export type OtpRealm = Effect.Success<ReturnType<typeof makeOtpRealm>>;
