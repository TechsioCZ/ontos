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

/** A record with its keys in code-point order. */
const byKey = <Value>(record: Readonly<Record<string, Value>>): Record<string, Value> =>
  Object.fromEntries(Object.entries(record).toSorted(([left], [right]) => (left < right ? -1 : 1)));

/*
 * The theme with its records in key order. The schema encodes a struct's fields in its own order, but a record's keys
 * in the order they come, and the order of a theme's tokens is not part of it (jsonb, for one, gives them back
 * reordered). Arrays keep their order: the order of the modes is the theme's own.
 */
const canonicalTheme = ({ defaults, tokens, ...theme }: TenantThemeDefinition): TenantThemeDefinition => {
  const canonical = { ...theme, tokens: byKey(tokens) };
  if (defaults === undefined) {
    return canonical;
  }
  const { components, ...rest } = defaults;
  return { ...canonical, defaults: components === undefined ? rest : { ...rest, components: byKey(components) } };
};

/** A short name for one exact theme definition: an equal definition shares it, any change gives a new one. */
export const tenantThemeRevision = (theme: TenantThemeDefinition) =>
  encodeTheme(canonicalTheme(theme)).pipe(Effect.map((json) => bytesToHex(sha256(utf8ToBytes(json))).slice(0, 16)));
