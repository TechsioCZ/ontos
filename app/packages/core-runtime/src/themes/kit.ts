import { Effect, Function as Fn, Layer, Schema } from 'effect';

import { TenantThemeDefinitionSchema } from './contract.ts';
import type { TenantThemeDefinition } from './contract.ts';
import { TenantThemeKit, tenantThemeStorageIssues } from './definition.ts';
import { TenantThemeInvalid } from './errors.ts';

/*
 * The UI kit bound as Core's TenantThemeKit, for the host that serves the theme operations (the Shell). The kit ships
 * import-only ESM, and the host's Node BFF bundle is CommonJS that keeps installed packages external: a static import
 * would become a require() the kit's exports refuse. So this binding loads the kit with import() as the host loads it,
 * and a host without the kit fails to start rather than on the first theme request.
 */

const invalid = (issues: readonly string[]) =>
  new TenantThemeInvalid({
    code: 'tenant_theme_invalid',
    issues: [...issues],
    reason: 'The theme does not pass the brand validation',
  });

const decodeTheme = Schema.decodeEffect(TenantThemeDefinitionSchema);

export const TenantThemeKitLive = Layer.effect(
  TenantThemeKit,
  Effect.suspend(() => {
    // Loaded when the layer is built, not when this module is evaluated: a kit that fails to load fails the layer.
    const kitModules = Promise.all([
      import('@techsio/ui-kit/theme/brand-validator'),
      import('@techsio/ui-kit/theme/built-in-brands'),
    ]);
    return Effect.promise(Fn.constant(kitModules));
  }).pipe(
    // A load from the host's own node_modules; one that hangs stops the host's start instead of holding it.
    Effect.timeout('10 seconds'),
    Effect.orDie,
    Effect.map(([{ validateBrand }, { businessBrand }]) => ({
      defaultTheme: businessBrand,
      validate: (input: TenantThemeDefinition) => {
        const storageIssues = tenantThemeStorageIssues(input);
        const validation = validateBrand(input);
        if (!validation.ok) {
          return Effect.fail(invalid([...storageIssues, ...validation.errors]));
        }
        return storageIssues.length > 0
          ? Effect.fail(invalid(storageIssues))
          : decodeTheme(validation.brand).pipe(Effect.mapError((decodeFailure) => invalid([decodeFailure.message])));
      },
    })),
  ),
);
