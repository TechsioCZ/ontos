import { Effect, Option } from 'effect';

import { catalogFactAdmissionForScope } from '../domain/catalog-source-admission.ts';
import { resolveCatalogSourceAuthority } from '../domain/catalog-source-authority.ts';
import type { CatalogSourceAuthorityGrant } from '../domain/catalog-source-authority.ts';
import type { CatalogSourceAuthorityPorts } from './catalog-source-resolution-ports.ts';

/**
 * Source authority is deployment evidence. This repository ships no invented grant: a deployment
 * must bind exact Tenant, issuer, target kind, and admitted fact grants from reviewed configuration.
 */
const CATALOG_DEPLOYMENT_SOURCE_AUTHORITY_GRANTS: readonly CatalogSourceAuthorityGrant[] = [];

export const catalogSourceAuthorityPorts = (
  grants: readonly CatalogSourceAuthorityGrant[] = CATALOG_DEPLOYMENT_SOURCE_AUTHORITY_GRANTS,
): CatalogSourceAuthorityPorts => ({
  resolveAuthority: (request) => {
    if (catalogFactAdmissionForScope(request.scope) === null) {
      return Effect.succeedNone;
    }
    return Effect.succeed(Option.fromNullishOr(resolveCatalogSourceAuthority(grants, request)));
  },
});
