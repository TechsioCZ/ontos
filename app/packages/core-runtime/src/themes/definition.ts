import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { Context, Effect, Schema } from 'effect';

import { TenantThemeDefinitionSchema } from './contract.ts';
import type { TenantThemeDefinition } from './contract.ts';
import type { TenantThemeInvalid } from './errors.ts';

/*
 * What a tenant theme is, decided by the UI kit: its brand validator (it carries the whole token foundation, so it
 * never ships to a browser) and its Business brand for a tenant that has no theme attached. The kit reaches the theme
 * operations as this service, bound only by the host that serves them (`@app/core-runtime/themes/kit`): every owner
 * loads Core's operation catalogs, and an owner neither depends on the kit nor runs a theme operation. Nothing here
 * knows which tenant gets which theme; that is data in core.tenant_theme_attachments.
 */
export interface TenantThemeKitService {
  /** The theme of every tenant without an attachment. */
  readonly defaultTheme: TenantThemeDefinition;
  /** The theme as the kit accepts it, or every issue that blocks it. Warnings never block. */
  readonly validate: (input: TenantThemeDefinition) => Effect.Effect<TenantThemeDefinition, TenantThemeInvalid>;
}

export class TenantThemeKit extends Context.Service<TenantThemeKit, TenantThemeKitService>()(
  '@app/core-runtime/themes/definition/TenantThemeKit',
) {}

const encodeTheme = Schema.encodeEffect(Schema.fromJsonString(TenantThemeDefinitionSchema));

/** A short name for one exact theme definition: an equal definition shares it, any change gives a new one. */
export const tenantThemeRevision = (theme: TenantThemeDefinition) =>
  encodeTheme(theme).pipe(Effect.map((json) => bytesToHex(sha256(utf8ToBytes(json))).slice(0, 16)));
