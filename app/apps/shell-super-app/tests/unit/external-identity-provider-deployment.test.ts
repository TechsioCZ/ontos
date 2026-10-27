import { AuthenticationNamespaceRegistry } from '@app/core-runtime/auth/external-identity-admission';
import { AuthenticationNamespaceIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { Context, Effect, Layer, Option, Predicate, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeModuleContractFixture } from '../../../../packages/core-runtime/src/testing/module-contract.ts';
import {
  ExternalIdentityProviderDeploymentConfigError,
  makeExternalIdentityProviderDeployment,
  parseExternalIdentityProviderDeploymentInput,
} from '../../api/auth/external-identity-provider-deployment.ts';
import { ExternalIdentityHttpConfigurationService } from '../../api/auth/external-identity/configuration.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../api/modules/installed-module-catalog.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';

const PROVIDER_NAMESPACE = 'ontos.example.portal.v1';
const contract = makeModuleContractFixture({ appId: 'example-portal', moduleId: 'example.portal' });
const catalog = {
  load: makeInstalledModuleCatalogLoader(
    makeCompositionSnapshot([
      {
        ...contract,
        manifest: {
          ...contract.manifest,
          publicSurface: {
            ...contract.manifest.publicSurface,
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
      },
    ]),
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
};
const configurationJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))(rawConfiguration);

it.effect('resolves no deployment input when the environment variable is unset', () =>
  Effect.gen(function* verifyUnset() {
    const input = yield* parseExternalIdentityProviderDeploymentInput({});
    expect(input).toBeUndefined();
  }),
);

it.effect('parses the deployment input from the JSON environment variable when set', () =>
  Effect.gen(function* verifySet() {
    const input = yield* parseExternalIdentityProviderDeploymentInput({
      ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT: configurationJson,
    });
    expect(input).toEqual(rawConfiguration);
  }),
);

it.effect('fails with a typed error when the environment variable is not valid JSON', () =>
  Effect.gen(function* verifyMalformed() {
    const result = yield* Effect.result(
      parseExternalIdentityProviderDeploymentInput({
        ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT: 'not-json',
      }),
    );
    const error = Option.getOrThrow(Result.getFailure(result));
    expect(Predicate.isTagged(error, 'ExternalIdentityProviderDeploymentConfigError')).toBe(true);
    expect(error).toBeInstanceOf(ExternalIdentityProviderDeploymentConfigError);
  }),
);

it.effect('keeps the staff-only default when no deployment data is supplied', () =>
  Effect.gen(function* verifyDefault() {
    const deployment = makeExternalIdentityProviderDeployment();
    const context = yield* Layer.build(
      Layer.merge(deployment.contextAccessLayer, deployment.externalIdentityDeploymentLayer).pipe(
        Layer.provide(Layer.succeed(ShellInstalledModuleCatalog, catalog)),
      ),
    );
    const registryResult = yield* Context.get(context, AuthenticationNamespaceRegistry).lookup(namespaceId);
    expect(Option.isNone(registryResult)).toBe(true);

    const configuration = Context.get(context, ExternalIdentityHttpConfigurationService);
    expect(configuration.grants).toEqual([]);
  }),
);

it.effect('makes the provider namespace reachable once deployment data is supplied', () =>
  Effect.gen(function* verifyConfigured() {
    const input = yield* parseExternalIdentityProviderDeploymentInput({
      ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT: configurationJson,
    });
    const deployment = makeExternalIdentityProviderDeployment(input);

    const context = yield* Layer.build(
      Layer.merge(deployment.contextAccessLayer, deployment.externalIdentityDeploymentLayer).pipe(
        Layer.provide(Layer.succeed(ShellInstalledModuleCatalog, catalog)),
      ),
    );
    const registryResult = yield* Context.get(context, AuthenticationNamespaceRegistry).lookup(namespaceId);
    expect(Option.isSome(registryResult)).toBe(true);

    const configuration = Context.get(context, ExternalIdentityHttpConfigurationService);
    expect(configuration.providerEndpointAudience).toBe(rawConfiguration.providerEndpointAudience);
    expect(configuration.grants).toHaveLength(1);
  }),
);
