import type { Effect } from 'effect';
import { Context, Schema } from 'effect';

import type { OAuthAuthenticationAuditUnavailable } from './oauth-authentication-audit-unavailable.ts';

import { OAuthAuditGrantSchema } from './oauth-authentication-audit-contract.ts';

export const OAuthGrantOwnerSchema = Schema.Struct({
  grantId: OAuthAuditGrantSchema.fields.grantId,
  legalEntityId: OAuthAuditGrantSchema.fields.legalEntityId,
  tenantId: OAuthAuditGrantSchema.fields.tenantId,
  userPrincipalId: OAuthAuditGrantSchema.fields.userPrincipalId,
});
export type OAuthGrantOwner = typeof OAuthGrantOwnerSchema.Type;
export interface OAuthGrantOwnerQuery {
  readonly grantIds: readonly string[];
  readonly legalEntityId: string;
  readonly tenantId: string;
}

/** Auth supplies retained grant owners, never caller-asserted ownership or an imported Auth SQL schema. */
export class OAuthGrantOwners extends Context.Service<
  OAuthGrantOwners,
  {
    readonly owners: (
      query: OAuthGrantOwnerQuery,
    ) => Effect.Effect<readonly OAuthGrantOwner[], OAuthAuthenticationAuditUnavailable>;
  }
>()('@app/core-runtime/auth/oauth-grant-owners/OAuthGrantOwners') {}

export const retainedOAuthRevocationGrantOwners = (
  query: OAuthGrantOwnerQuery,
  owners: readonly OAuthGrantOwner[],
): readonly OAuthGrantOwner[] => {
  const requested = new Set(query.grantIds);
  return owners.filter(
    (owner) =>
      owner.tenantId === query.tenantId && owner.legalEntityId === query.legalEntityId && requested.has(owner.grantId),
  );
};

export const ownedOAuthRevocationGrantIds = (
  query: OAuthGrantOwnerQuery & { readonly principalId: string },
  owners: readonly OAuthGrantOwner[],
): readonly string[] =>
  retainedOAuthRevocationGrantOwners(query, owners).flatMap((owner) =>
    owner.userPrincipalId === query.principalId ? [owner.grantId] : [],
  );
