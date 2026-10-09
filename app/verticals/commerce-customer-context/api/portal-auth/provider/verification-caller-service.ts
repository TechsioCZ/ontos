import { Context } from 'effect';
import type { Effect } from 'effect';

import type { CommercePortalAuthVerificationAuthorization } from './verification.ts';
import type { CommercePortalAuthVerificationCallerRejected } from './verification-caller-rejected.ts';
import type { CommercePortalAuthVerificationCallerUnavailable } from './verification-caller-unavailable.ts';

export class CommercePortalAuthVerificationCaller extends Context.Service<
  CommercePortalAuthVerificationCaller,
  {
    readonly authorize: (
      input: CommercePortalAuthVerificationAuthorization,
    ) => Effect.Effect<
      void,
      CommercePortalAuthVerificationCallerRejected | CommercePortalAuthVerificationCallerUnavailable
    >;
  }
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/verification-caller-service/CommercePortalAuthVerificationCaller',
) {}
