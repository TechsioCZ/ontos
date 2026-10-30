import type { OperationalScope } from '@app/core-runtime';
import type { Effect, Redacted } from 'effect';
import { Context } from 'effect';

import type { PrivacyOperationPersistenceError } from './privacy-operation-persistence-error.ts';

/** Trusted transport assembly only. Each attempt needs a fresh Party-audience credential.
 * The Privacy bearer, business payload and stored admission evidence cannot provide it. */
export class PrivacySubjectPartyCredentials extends Context.Service<
  PrivacySubjectPartyCredentials,
  {
    readonly acquire: (scope: OperationalScope) => Effect.Effect<
      {
        readonly authorization: Redacted.Redacted;
        readonly baseUrl: string;
        readonly compositionRevision: string;
      },
      PrivacyOperationPersistenceError
    >;
  }
>()('@app/privacy/persistence/privacy-subject-party-credentials/PrivacySubjectPartyCredentials') {}
