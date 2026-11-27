import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { validateBrand } from '@techsio/ui-kit/theme/brand-validator';
import { businessBrand } from '@techsio/ui-kit/theme/built-in-brands';
import { Effect, Schema } from 'effect';

import { TenantThemeDefinitionSchema } from './contract.ts';
import type { TenantThemeDefinition } from './contract.ts';
import { TenantThemeInvalid } from './errors.ts';

/*
 * What a tenant theme is, decided by the UI kit: Core runs the kit's brand validator (it carries the whole token
 * foundation, so it never ships to a browser) and answers the kit's Business brand for a tenant that has no theme
 * attached. Nothing here knows which tenant gets which theme; that is data in core.tenant_theme_attachments.
 */

/** The theme of every tenant without an attachment. */
export const DEFAULT_TENANT_THEME = businessBrand;

const invalid = (issues: readonly string[]) =>
  new TenantThemeInvalid({
    code: 'tenant_theme_invalid',
    issues: [...issues],
    reason: 'The theme does not pass the brand validation',
  });

/** The theme as the kit accepts it, or every issue that blocks it. Warnings never block. */
export const validateTenantTheme = (input: TenantThemeDefinition) => {
  const validation = validateBrand(input);
  return validation.ok
    ? Schema.decodeEffect(TenantThemeDefinitionSchema)(validation.brand).pipe(
        Effect.mapError((decodeFailure) => invalid([decodeFailure.message])),
      )
    : Effect.fail(invalid(validation.errors));
};

const encodeTheme = Schema.encodeEffect(Schema.fromJsonString(TenantThemeDefinitionSchema));

/** A short name for one exact theme definition: an equal definition shares it, any change gives a new one. */
export const tenantThemeRevision = (theme: TenantThemeDefinition) =>
  encodeTheme(theme).pipe(Effect.map((json) => bytesToHex(sha256(utf8ToBytes(json))).slice(0, 16)));

/** The theme a tenant sees: its attached theme, else the default. */
export const effectiveTenantTheme = (attached?: TenantThemeDefinition): TenantThemeDefinition =>
  attached ?? DEFAULT_TENANT_THEME;
