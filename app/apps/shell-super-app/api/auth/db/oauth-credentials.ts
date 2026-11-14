import { Context } from 'effect';
import type { Effect, Option } from 'effect';

import type { OAuthCredentialsUnavailable } from './oauth-credentials-unavailable.ts';

export interface OAuthRefreshCredential {
  readonly clientId: string;
  readonly id: string;
  readonly referenceId: string | null;
  readonly revoked: Date | null;
  readonly rotatedAt: Date | null;
  readonly rotationReplayExpiresAt: Date | null;
  readonly userId: string;
}
export interface OAuthRefreshFamily {
  readonly clientId: string;
  readonly id: string;
  readonly referenceId: string | null;
}
/** Auth-owned credential facts only. No SQL, schema, token material or executor escapes. */
export class OAuthCredentials extends Context.Service<
  OAuthCredentials,
  {
    readonly loadRefresh: (
      storageKey: string,
    ) => Effect.Effect<Option.Option<OAuthRefreshCredential>, OAuthCredentialsUnavailable>;
    readonly loadUserAccount: (userId: string) => Effect.Effect<
      Option.Option<{
        readonly banned: boolean;
        readonly emailVerified: boolean;
        readonly name: string;
      }>,
      OAuthCredentialsUnavailable
    >;
    readonly revokeFamily: (family: OAuthRefreshFamily) => Effect.Effect<void, OAuthCredentialsUnavailable>;
  }
>()('@app/shell-super-app/api/auth/db/oauth-credentials/OAuthCredentials') {}
