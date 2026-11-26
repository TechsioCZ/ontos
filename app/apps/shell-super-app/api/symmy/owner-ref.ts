import { Result, Schema } from 'effect';

/** Any owner reference schema: its module and resource type are fixed by the owner, so a caller never states them. */
type SymmyOwnerRefSource<Ref> = Schema.ConstraintDecoder<Ref> & {
  readonly fields: {
    readonly moduleId: { readonly literal: string };
    readonly resourceType: { readonly literal: string };
  };
};

/**
 * The full owner reference behind a plain id of a public Symmy body. A public body names only the id, which the
 * request schema already checked with the owner's own `resourceId`; the tenant is the one of the admitted route.
 */
export const symmyOwnerRef = <Ref>(schema: SymmyOwnerRefSource<Ref>, tenantId: string, resourceId: string): Ref =>
  Result.getOrThrow(
    Schema.decodeUnknownResult(schema)({
      moduleId: schema.fields.moduleId.literal,
      resourceId,
      resourceType: schema.fields.resourceType.literal,
      tenantId,
    }),
  );
