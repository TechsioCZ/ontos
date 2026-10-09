import { AuthenticationNamespaceRegistry } from '@app/core-runtime/auth/external-identity-admission';
import { AuthenticationNamespaceIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '@app/commerce-customer-context/portal-auth/contracts';
import { Effect, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CommerceExternalIdentityDeploymentConfigError,
  makeCommerceExternalIdentityDeployment,
  parseCommerceExternalIdentityDeploymentInput,
} from '../../api/auth/commerce-external-identity-deployment.ts';
import { ExternalIdentityHttpConfigurationService } from '../../api/auth/external-identity/configuration.ts';

const namespaceId = Schema.decodeUnknownSync(AuthenticationNamespaceIdSchema)(COMMERCE_AUTHENTICATION_NAMESPACE_ID);

const rawConfiguration = {
  attesterPrincipalId: '10000000-0000-4000-8000-000000000005',
  authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  grants: [
    {
      operation: 'resolve',
      receivingAudience: 'commerce-customer-context',
      targetAuthenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      tenantId: '10000000-0000-4000-8000-000000000001',
      workloadAuthenticationNamespaceId: 'ontos.staff.gateway-api-key.v1',
      workloadPrincipalId: '10000000-0000-4000-8000-000000000002',
    },
  ],
  providerEndpointAudience: 'commerce-customer-context',
  providerOrigin: 'https://commerce.example.test',
};

it.effect('resolves no deployment input when the environment variable is unset', () =>
  Effect.gen(function* verifyUnset() {
    const input = yield* parseCommerceExternalIdentityDeploymentInput({});
    expect(input).toBeUndefined();
  }),
);

it.effect('parses the deployment input from the JSON environment variable when set', () =>
  Effect.gen(function* verifySet() {
    const input = yield* parseCommerceExternalIdentityDeploymentInput({
      ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT: JSON.stringify(rawConfiguration),
    });
    expect(input).toEqual(rawConfiguration);
  }),
);

it.effect('fails with a typed error when the environment variable is not valid JSON', () =>
  Effect.gen(function* verifyMalformed() {
    const error = yield* Effect.flip(
      parseCommerceExternalIdentityDeploymentInput({
        ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT: 'not-json',
      }),
    );
    expect(Predicate.isTagged(error, 'CommerceExternalIdentityDeploymentConfigError')).toBe(true);
    expect(error).toBeInstanceOf(CommerceExternalIdentityDeploymentConfigError);
  }),
);

it.effect('keeps the staff-only default when no deployment data is supplied', () =>
  Effect.gen(function* verifyDefault() {
    const deployment = makeCommerceExternalIdentityDeployment();
    const registryResult = yield* AuthenticationNamespaceRegistry.pipe(
      Effect.flatMap((registry) => registry.lookup(namespaceId)),
      Effect.provide(deployment.contextAccessLayer),
    );
    expect(Option.isNone(registryResult)).toBe(true);

    const configuration = yield* ExternalIdentityHttpConfigurationService.pipe(
      Effect.provide(deployment.externalIdentityDeploymentLayer),
    );
    expect(configuration.grants).toEqual([]);
  }),
);

it.effect('makes the Commerce namespace reachable once deployment data is supplied', () =>
  Effect.gen(function* verifyConfigured() {
    const input = yield* parseCommerceExternalIdentityDeploymentInput({
      ONTOS_COMMERCE_EXTERNAL_IDENTITY_DEPLOYMENT: JSON.stringify(rawConfiguration),
    });
    const deployment = makeCommerceExternalIdentityDeployment(input);

    const registryResult = yield* AuthenticationNamespaceRegistry.pipe(
      Effect.flatMap((registry) => registry.lookup(namespaceId)),
      Effect.provide(deployment.contextAccessLayer),
    );
    expect(Option.isSome(registryResult)).toBe(true);

    const configuration = yield* ExternalIdentityHttpConfigurationService.pipe(
      Effect.provide(deployment.externalIdentityDeploymentLayer),
    );
    expect(configuration.providerEndpointAudience).toBe(rawConfiguration.providerEndpointAudience);
    expect(configuration.grants).toHaveLength(1);
  }),
);
