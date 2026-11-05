import { Result, Schema } from 'effect';

import { TrustedPrincipalContextSchema } from '../../actions/principal-context.ts';
import type { TrustedPrincipalContext } from '../../actions/principal-context.ts';
import {
  isVerifiedGatewayPrincipalContext,
  preserveSystemPrincipalContextTrust,
} from '../../auth/system-principal-context-provenance.ts';
import { accessPortalRefusal } from './portal-access.ts';
import type { AccessPortalError } from './portal-access.ts';

/*
 * A person admitted to a company in the middle of one request still holds the assertion it presented
 * before: a tenant one, because the company was not yet selectable for it. The request continues in the
 * company it was admitted to with the same verified principal, named into that company. Nothing is taken on
 * trust here: resolving the operation scope selects the company through the access gate again (O28), so a
 * company the person cannot select is refused exactly as if the assertion had named it.
 */
export const portalPrincipalInLegalEntity = (
  principal: TrustedPrincipalContext,
  legalEntityId: string,
): Result.Result<TrustedPrincipalContext, AccessPortalError> => {
  if (!isVerifiedGatewayPrincipalContext(principal)) {
    return Result.fail(
      accessPortalRefusal(
        'access_portal_scope_mismatch',
        'Only a verified gateway principal can be named into a company',
      ),
    );
  }
  if (principal.legalEntityId !== undefined && principal.legalEntityId !== legalEntityId) {
    return Result.fail(
      accessPortalRefusal('access_portal_scope_mismatch', 'The principal already acts in another company'),
    );
  }
  return Schema.decodeUnknownResult(TrustedPrincipalContextSchema)({ ...principal, legalEntityId }).pipe(
    Result.map((scoped) => preserveSystemPrincipalContextTrust(principal, Object.freeze(scoped))),
    Result.mapError(() =>
      accessPortalRefusal('access_portal_scope_mismatch', `Company ${legalEntityId} cannot scope this principal`),
    ),
  );
};
