import type { OTPOptions } from 'better-auth/plugins/two-factor';
import { Context } from 'effect';
import type { Effect, Option } from 'effect';

import type { CommercePortalAuthOtpChallengeKey } from './recovery/store-service.ts';

/** Better Auth's endpoint context of a `sendOTP` call: the one thing the one-time-code delivery reads a challenge key from. */
export type OtpContext = NonNullable<Parameters<NonNullable<OTPOptions['sendOTP']>>[1]>;

/** How the challenge key of an issued one-time code is named; a service so a fixture never has to forge Better Auth's context. */
export interface OtpChallengeKeyReaderService {
  readonly keyOf: (ctx: OtpContext | undefined) => Effect.Effect<Option.Option<CommercePortalAuthOtpChallengeKey>>;
}

export class CommercePortalAuthOtpChallengeKeyReader extends Context.Service<
  CommercePortalAuthOtpChallengeKeyReader,
  OtpChallengeKeyReaderService
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/otp-challenge-key-service/CommercePortalAuthOtpChallengeKeyReader',
) {}
