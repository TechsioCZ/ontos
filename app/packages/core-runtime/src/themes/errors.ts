import { Schema } from 'effect';

import { actionErrorSchema } from '../actions/error-schema.ts';

/** The theme failed the kit's brand validation; `issues` lists every problem, so a caller can fix them at once. */
const TenantThemeInvalidValue = actionErrorSchema('TenantThemeInvalid', {
  code: Schema.Literal('tenant_theme_invalid'),
  issues: Schema.Array(Schema.String),
  reason: Schema.String,
});
export type TenantThemeInvalid = InstanceType<typeof TenantThemeInvalidValue>;
export { TenantThemeInvalidValue as TenantThemeInvalid };

/** The tenant has no saved theme with this key. */
const TenantThemeNotFoundValue = actionErrorSchema('TenantThemeNotFound', {
  code: Schema.Literal('tenant_theme_not_found'),
  reason: Schema.String,
});
export type TenantThemeNotFound = InstanceType<typeof TenantThemeNotFoundValue>;
export { TenantThemeNotFoundValue as TenantThemeNotFound };

/** The theme store could not answer; a retry may succeed. */
const TenantThemeUnavailableValue = actionErrorSchema('TenantThemeUnavailable', {
  code: Schema.Literal('tenant_theme_unavailable'),
  reason: Schema.String,
});
export type TenantThemeUnavailable = InstanceType<typeof TenantThemeUnavailableValue>;
export { TenantThemeUnavailableValue as TenantThemeUnavailable };

export const tenantThemeUnavailable = (cause: unknown): TenantThemeUnavailable =>
  Object.defineProperty(
    new TenantThemeUnavailableValue({
      code: 'tenant_theme_unavailable',
      reason: 'Tenant themes are temporarily unavailable',
    }),
    'cause',
    { configurable: true, value: cause },
  );
