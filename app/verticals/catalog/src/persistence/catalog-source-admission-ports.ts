import { Effect, Option, Schema } from 'effect';

import {
  CatalogSourceFactValueSchema,
  catalogFactAdmissionForScope,
  isCatalogSourceFactValueValid,
} from '../domain/catalog-source-admission.ts';
import { catalogLocalOverridePermission } from '../domain/catalog-local-override.ts';
import type { CatalogLocalOverrideOperation } from '../domain/catalog-local-override.ts';
import type { CatalogFactAdmissionPorts } from './catalog-source-resolution-ports.ts';

export const catalogSourceAdmissionPorts = (input: {
  readonly allowedOverrideOperation: CatalogLocalOverrideOperation | null;
  readonly principalId: string;
}): CatalogFactAdmissionPorts<Schema.Json> => ({
  authorizeOverrideOperation: ({ operation, permissionKey, principalId, scope }) =>
    Effect.succeed(
      input.allowedOverrideOperation === operation &&
        input.principalId === principalId &&
        permissionKey === catalogLocalOverridePermission[operation] &&
        catalogFactAdmissionForScope(scope)?.admission.overridePermitted === true,
    ),
  isAssertionValueValid: ({ assertion, scope }) =>
    Effect.succeed(
      Schema.is(CatalogSourceFactValueSchema)(assertion.value) && isCatalogSourceFactValueValid(scope, assertion.value),
    ),
  isOverrideValueValid: ({ principalId, scope, value }) =>
    Effect.succeed(
      input.principalId === principalId &&
        Schema.is(CatalogSourceFactValueSchema)(value) &&
        isCatalogSourceFactValueValid(scope, value),
    ),
  readAdmission: (scope) => Effect.succeed(Option.fromNullishOr(catalogFactAdmissionForScope(scope)?.admission)),
});
