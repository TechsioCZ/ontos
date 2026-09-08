// Destructured members that are branded, plus a local shadow of a destructured member name.
import * as Schema from 'effect/Schema';
import { brand as makeBrand, String as SchemaString, Struct } from 'effect/Schema';

const { pipe } = Schema as unknown as { readonly pipe: <A>(value: A) => A };

// Branded through the directly-imported `brand`, and through the destructured leaf.
export const TenantId = SchemaString.pipe(makeBrand('TenantId'));
export const PrincipalId = Schema.String.pipe(Schema.brand('PrincipalId'));

export const RowSchema = Struct({
  tenantId: TenantId,
  principalId: PrincipalId,
  label: SchemaString,
});

// `Struct` and `SchemaString` here are locals, not the effect imports.
export function build(Struct: (fields: unknown) => unknown, SchemaString: unknown): unknown {
  return Struct({ tenantId: SchemaString, moduleKey: SchemaString });
}

export const passthrough = pipe;
