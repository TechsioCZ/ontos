import { Context } from 'effect';
import type { Effect, Option } from 'effect';

import type {
  OAuthGrantAccessChange,
  OAuthGrantActivation,
  OAuthGrantApproval,
  OAuthGrantBindingKey,
  OAuthGrantBindingStatusChange,
  OAuthGrantDraft,
  OAuthGrantKey,
  OAuthGrantListFilter,
  OAuthGrantPrincipal,
  OAuthGrantRecord,
  OAuthGrantSession,
  OAuthGrantStatusChange,
} from './oauth-grant-registry-contract.ts';
import type { OAuthGrantRegistryUnavailable } from './oauth-grant-registry-unavailable.ts';
import type { OAuthGrantOwner, OAuthGrantOwnerQuery } from './oauth-grant-owners.ts';

type RegistryResult<A> = Effect.Effect<A, OAuthGrantRegistryUnavailable>;

/** Native authentication issuer, callable before admission and after binding disablement. */
export class OAuthGrantRegistry extends Context.Service<
  OAuthGrantRegistry,
  {
    readonly approveDraftGrant: (input: OAuthGrantApproval) => RegistryResult<Option.Option<OAuthGrantActivation>>;
    readonly findGrant: (grantId: string) => RegistryResult<Option.Option<OAuthGrantRecord>>;
    readonly findPreviousProfileId: (input: OAuthGrantKey) => RegistryResult<Option.Option<string>>;
    readonly findSessionGrant: (input: OAuthGrantSession) => RegistryResult<Option.Option<OAuthGrantRecord>>;
    readonly insertDraftGrant: (input: OAuthGrantDraft) => RegistryResult<OAuthGrantRecord>;
    readonly listAgentPrincipals: (
      tenantId: string,
    ) => RegistryResult<readonly { readonly displayName: string; readonly principalId: string }[]>;
    readonly listGrants: (filter: OAuthGrantListFilter) => RegistryResult<readonly OAuthGrantRecord[]>;
    readonly loadBindingStatus: (input: OAuthGrantBindingKey) => RegistryResult<Option.Option<string>>;
    readonly loadPrincipals: (
      tenantId: string,
      principalIds: readonly string[],
    ) => RegistryResult<ReadonlyMap<string, OAuthGrantPrincipal>>;
    readonly owners: (input: OAuthGrantOwnerQuery) => RegistryResult<readonly OAuthGrantOwner[]>;
    readonly setGrantBindingStatus: (input: OAuthGrantBindingStatusChange) => RegistryResult<void>;
    /** Grant terminal transition and derived-binding disablement commit together. */
    readonly setGrantStatus: (input: OAuthGrantStatusChange) => RegistryResult<Option.Option<OAuthGrantRecord>>;
    readonly touchGrantLastUsed: (grantId: string) => RegistryResult<boolean>;
    readonly updateGrantAccess: (input: OAuthGrantAccessChange) => RegistryResult<Option.Option<OAuthGrantRecord>>;
  }
>()('@app/core-runtime/auth/oauth-grant-registry-service/OAuthGrantRegistry') {}
