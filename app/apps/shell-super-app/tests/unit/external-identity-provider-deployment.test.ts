import { AuthenticationNamespaceRegistry } from '@app/core-runtime/auth/external-identity-admission';
import { AuthenticationNamespaceIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { Effect, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ExternalIdentityProviderDeploymentConfigError,
  makeExternalIdentityProviderDeployment,
  parseExternalIdentityProviderDeploymentInput,
} from '../../api/auth/external-identity-provider-deployment.ts';
import { ExternalIdentityHttpConfigurationService } from '../../api/auth/external-identity/configuration.ts';
import { ShellInstalledModuleCatalog } from '../../api/modules/installed-module-catalog.ts';
import type { ShellInstalledCatalog } from '../../api/modules/installed-module-catalog.ts';

const PROVIDER_NAMESPACE = 'ontos.example.portal.v1';
const catalog = {
  load: Effect.succeed(
    // SAFETY: test double; the provider resolution reads only `composition.modules[].{deployment.appId,contractDocument}`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Test double of the installed catalog.
    {
      composition: {
        modules: [
          {
            contractDocument: JSON.stringify({
              manifest: {
                publicSurface: {
                  externalIdentityProviders: [
                    {
                      admissionDeadlineMs: 5000,
                      authenticationNamespaceId: PROVIDER_NAMESPACE,
                      provider: 'example-provider',
                      verification: { operation: 'example-portal.verify.v1', path: '/portal/internal/verify' },
                    },
                  ],
                },
              },
            }),
            deployment: { appId: 'example-portal' },
            moduleId: 'example.portal',
          },
        ],
      },
    } as unknown as ShellInstalledCatalog,
  ),
};

const namespaceId = Schema.decodeUnknownSync(AuthenticationNamespaceIdSchema)(PROVIDER_NAMESPACE);

const rawConfiguration = {
  attesterPrincipalId: '10000000-0000-4000-8000-000000000005',
  authenticationNamespaceId: PROVIDER_NAMESPACE,
  grants: [
    {
      operation: 'resolve',
      receivingAudience: 'example-portal',
      targetAuthenticationNamespaceId: PROVIDER_NAMESPACE,
      tenantId: '10000000-0000-4000-8000-000000000001',
      workloadAuthenticationNamespaceId: 'ontos.staff.gateway-api-key.v1',
      workloadPrincipalId: '10000000-0000-4000-8000-000000000002',
    },
  ],
  providerEndpointAudience: 'example-portal',
  providerOrigin: 'https://provider.example.test',
};

it.effect('resolves no deployment input when the environment variable is unset', () =>
  Effect.gen(function* verifyUnset() {
    const input = yield* parseExternalIdentityProviderDeploymentInput({});
    expect(input).toBeUndefined();
  }),
);

it.effect('parses the deployment input from the JSON environment variable when set', () =>
  Effect.gen(function* verifySet() {
    const input = yield* parseExternalIdentityProviderDeploymentInput({
      ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT: JSON.stringify(rawConfiguration),
    });
    expect(input).toEqual(rawConfiguration);
  }),
);

it.effect('fails with a typed error when the environment variable is not valid JSON', () =>
  Effect.gen(function* verifyMalformed() {
    const error = yield* Effect.flip(
      parseExternalIdentityProviderDeploymentInput({
        ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT: 'not-json',
      }),
    );
    expect(Predicate.isTagged(error, 'ExternalIdentityProviderDeploymentConfigError')).toBe(true);
    expect(error).toBeInstanceOf(ExternalIdentityProviderDeploymentConfigError);
  }),
);

it.effect('keeps the staff-only default when no deployment data is supplied', () =>
  Effect.gen(function* verifyDefault() {
    const deployment = makeExternalIdentityProviderDeployment();
    const registryResult = yield* AuthenticationNamespaceRegistry.pipe(
      Effect.flatMap((registry) => registry.lookup(namespaceId)),
      Effect.provide(deployment.contextAccessLayer),
      Effect.provideService(ShellInstalledModuleCatalog, catalog),
    );
    expect(Option.isNone(registryResult)).toBe(true);

    const configuration = yield* ExternalIdentityHttpConfigurationService.pipe(
      Effect.provide(deployment.externalIdentityDeploymentLayer),
      Effect.provideService(ShellInstalledModuleCatalog, catalog),
    );
    expect(configuration.grants).toEqual([]);
  }),
);

it.effect('makes the provider namespace reachable once deployment data is supplied', () =>
  Effect.gen(function* verifyConfigured() {
    const input = yield* parseExternalIdentityProviderDeploymentInput({
      ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT: JSON.stringify(rawConfiguration),
    });
    const deployment = makeExternalIdentityProviderDeployment(input);

    const registryResult = yield* AuthenticationNamespaceRegistry.pipe(
      Effect.flatMap((registry) => registry.lookup(namespaceId)),
      Effect.provide(deployment.contextAccessLayer),
      Effect.provideService(ShellInstalledModuleCatalog, catalog),
    );
    expect(Option.isSome(registryResult)).toBe(true);

    const configuration = yield* ExternalIdentityHttpConfigurationService.pipe(
      Effect.provide(deployment.externalIdentityDeploymentLayer),
      Effect.provideService(ShellInstalledModuleCatalog, catalog),
    );
    expect(configuration.providerEndpointAudience).toBe(rawConfiguration.providerEndpointAudience);
    expect(configuration.grants).toHaveLength(1);
  }),
);
