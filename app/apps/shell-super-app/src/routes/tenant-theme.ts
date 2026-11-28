import { TenantThemeDefinitionSchema } from '@app/core-runtime/themes/contract';
import { businessBrand } from '@techsio/ui-kit/theme/built-in-brands';
import { Effect, Schema } from 'effect';

import { executeTenantTheme } from '../api/auth-client.ts';
import type { ShellAuthenticationClientOptions } from '../api/auth-client.ts';
import type { TenantThemeResponse } from '../../shared/core-reads/tenant-theme.ts';

/*
 * The tenant's theme as the Shell renders it: the kit brand Core answers for the signed-in tenant and the revision
 * that names that exact definition. Core decides which theme a tenant has; the Shell only applies what it reads.
 */

const ShellThemeSchema = Schema.Struct({ brand: TenantThemeDefinitionSchema, revision: Schema.String });
export type ShellTheme = typeof ShellThemeSchema.Type;

/** What a page without a session renders in. */
export const businessShellTheme: ShellTheme = { brand: businessBrand, revision: 'business' };

/** The theme as Core's tenant-theme read answers it. */
export const shellThemeOf = ({ revision, theme }: TenantThemeResponse): ShellTheme => ({ brand: theme, revision });

/** The signed-in tenant's effective theme. */
export const readShellTheme = (options: ShellAuthenticationClientOptions = {}) =>
  executeTenantTheme({}, options).pipe(Effect.map(shellThemeOf));

/* A page model that carries a theme: Home's own, or the Shell model every other signed-in page embeds. */
const ThemedModelSchema = Schema.Struct({ theme: ShellThemeSchema });
const ThemedPageModelSchema = Schema.Union([ThemedModelSchema, Schema.Struct({ shell: ThemedModelSchema })]);
export const isThemedPageModel = Schema.is(ThemedPageModelSchema);
const isThemedModel = Schema.is(ThemedModelSchema);

export const themeOfPageModel = (model: typeof ThemedPageModelSchema.Type): ShellTheme =>
  isThemedModel(model) ? model.theme : model.shell.theme;
