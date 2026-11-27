import type { UIAppearance, UISize } from '@techsio/ui-kit/theme/ui-provider';
import { Schema } from 'effect';

/*
 * The public shape of a tenant theme: the UI kit's `BrandDefinition` as data (key, label, the colour modes it
 * ships, the token overrides and optional component defaults). This module is browser-safe and only checks the
 * structure. What makes a theme acceptable (safe token names and values, tokens the foundation has, WCAG AA on the
 * checked pairs) is decided on save by the kit's brand validator, which runs only in Core.
 */

export const CORE_THEMES_MODULE_ID = 'core.themes';

const ThemeColorModeSchema = Schema.Literals(['light', 'dark']);

/* The kit's component size and fill vocabularies, so a decoded theme is a kit `BrandDefinition` as it is. */
const UI_SIZES = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', 'full'] as const satisfies readonly UISize[];
const UI_APPEARANCES = ['solid', 'subtle', 'outline', 'ghost', 'plain'] as const satisfies readonly UIAppearance[];

/** The `data-theme` value of a theme a tenant saved: lowercase kebab-case, as the kit requires. */
export const TenantThemeKeySchema = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
).pipe(Schema.brand('TenantThemeKey'));

const ThemeComponentDefaultsSchema = Schema.Struct({
  appearance: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.String),
});

export const TenantThemeDefaultsSchema = Schema.Struct({
  appearance: Schema.optionalKey(Schema.Literals(UI_APPEARANCES)),
  components: Schema.optionalKey(Schema.Record(Schema.String, ThemeComponentDefaultsSchema)),
  size: Schema.optionalKey(Schema.Literals(UI_SIZES)),
});
export type TenantThemeDefaults = typeof TenantThemeDefaultsSchema.Type;

export const TenantThemeDefinitionSchema = Schema.Struct({
  defaults: Schema.optionalKey(TenantThemeDefaultsSchema),
  key: Schema.String,
  label: Schema.String,
  modes: Schema.Array(ThemeColorModeSchema),
  tokens: Schema.Record(Schema.String, Schema.String),
});
export type TenantThemeDefinition = typeof TenantThemeDefinitionSchema.Type;

/** Saving a theme sends the theme itself; a theme with the same key is replaced. */
export const SaveTenantThemePayloadSchema = TenantThemeDefinitionSchema;
export type SaveTenantThemePayload = typeof SaveTenantThemePayloadSchema.Type;
export const SaveTenantThemeResultSchema = Schema.Struct({ themeKey: TenantThemeKeySchema });

/** `null` detaches the tenant's theme, which brings back the default. */
export const AttachTenantThemePayloadSchema = Schema.Struct({
  themeKey: Schema.Union([TenantThemeKeySchema, Schema.Null]),
});
export type AttachTenantThemePayload = typeof AttachTenantThemePayloadSchema.Type;
export const AttachTenantThemeResultSchema = AttachTenantThemePayloadSchema;

/** The read names nothing: it always answers the theme of the caller's own tenant. */
export const TenantThemeRequestSchema = Schema.Struct({});
export type TenantThemeRequest = typeof TenantThemeRequestSchema.Type;

/** The tenant's effective theme and a short revision a client compares to notice a change. */
export const TenantThemeResponseSchema = Schema.Struct({
  revision: Schema.String,
  theme: TenantThemeDefinitionSchema,
});
export type TenantThemeResponse = typeof TenantThemeResponseSchema.Type;
