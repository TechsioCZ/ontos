/** Resolves the configured external identity provider from the active composition at the time of each call. */
import { externalIdentityFailure } from '@app/core-runtime/auth/external-identity-admission';
import type { ExternalIdentityFailure } from '@app/core-runtime/auth/external-identity-admission';
import { Context, Effect, Layer } from 'effect';
import type { Option } from 'effect';

import { ShellInstalledModuleCatalog } from '../../modules/installed-module-catalog.ts';
import {
  ExternalIdentityProviderConfigurationService,
  installedExternalIdentityProviderOf,
} from '../external-identity-provider.ts';
import type { InstalledExternalIdentityProvider } from '../external-identity-provider.ts';

const unavailable = (reason: string, cause?: unknown): ExternalIdentityFailure =>
  externalIdentityFailure('identity_unavailable', reason, cause);

export class InstalledExternalIdentityProviderResolver extends Context.Service<
  InstalledExternalIdentityProviderResolver,
  {
    readonly find: Effect.Effect<Option.Option<InstalledExternalIdentityProvider>, ExternalIdentityFailure>;
    readonly resolve: Effect.Effect<InstalledExternalIdentityProvider, ExternalIdentityFailure>;
  }
>()('@app/shell-super-app/api/auth/external-identity/provider-resolver/InstalledExternalIdentityProviderResolver') {}

export const InstalledExternalIdentityProviderResolverLive = Layer.effect(
  InstalledExternalIdentityProviderResolver,
  Effect.gen(function* makeInstalledExternalIdentityProviderResolver() {
    const catalog = yield* ShellInstalledModuleCatalog;
    const configuration = yield* ExternalIdentityProviderConfigurationService;
    const find = catalog.load.pipe(
      Effect.mapError((cause) => unavailable('The active composition is unavailable', cause)),
      Effect.map((installed) =>
        installedExternalIdentityProviderOf(installed, configuration.authenticationNamespaceId),
      ),
    );
    const resolve = find.pipe(
      Effect.flatMap((installed) =>
        Effect.fromOption(installed, () =>
          unavailable('No installed module provides the configured external identity namespace'),
        ),
      ),
    );
    return { find, resolve };
  }),
);
