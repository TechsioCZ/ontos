import { pipe } from 'effect';
import { brand as makeBrand } from 'effect/Schema';
import * as Schema from 'effect/Schema';

// Brand introduced through a direct (and aliased) named import of `brand`.
export const TenantIdSchema = Schema.String.pipe(makeBrand('TenantId'));
export const PrincipalIdSchema = pipe(Schema.String.check(Schema.isUUID()), makeBrand('PrincipalId'));

// Brand applied after a wrapper, and through computed access.
export const ModuleIdSchema = Schema.NullOr(Schema.String.pipe(Schema['brand']('ModuleId')));

export const RowSchema = Schema.Struct({
  tenantId: TenantIdSchema,
  principalId: PrincipalIdSchema,
  moduleId: ModuleIdSchema,
  contactId: Schema.String.pipe(makeBrand('ContactId')),
});
