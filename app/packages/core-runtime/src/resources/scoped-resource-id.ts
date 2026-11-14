import { Schema } from 'effect';

/** Native owner identities keep their existing 300-character bound. */
export const NativeResourceIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
  Schema.brand('NativeResourceId'),
);
export type NativeResourceId = typeof NativeResourceIdSchema.Type;

const isCompanyId = Schema.is(Schema.String.check(Schema.isUUID()));
const isNativeResourceId = Schema.is(NativeResourceIdSchema);

/**
 * A UUID company prefix reserves the scoped form, including for short identities.
 * Other strings remain native IDs and cannot use the extra 37 characters.
 * This codec preserves the wire value; it does not establish company access.
 */
export const ResourceIdentitySchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(337),
  Schema.makeFilter((value) =>
    value[36] === '.' && isCompanyId(value.slice(0, 36))
      ? isNativeResourceId(value.slice(37))
      : isNativeResourceId(value),
  ),
).pipe(Schema.brand('ResourceIdentity'));

export type ResourceIdentity = typeof ResourceIdentitySchema.Type;
