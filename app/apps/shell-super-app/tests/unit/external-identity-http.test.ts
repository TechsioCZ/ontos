import { PrincipalResolver, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { ApiKeyService } from '../../api/auth/api-key-service.ts';
import {
  ExternalIdentityHttpConfigurationSchema,
  ExternalIdentityHttpConfigurationService,
  ExternalIdentityWorkloadAuthorization,
  externalIdentityWorkloadAuthorizationLive,
} from '../../api/auth/external-identity/index.ts';
import type { ExternalIdentityHttpConfiguration } from '../../api/auth/external-identity/index.ts';
import type { ExternalIdentityWorkloadAuthorizationError } from '../../api/auth/external-identity/workload-authorization.ts';
import { Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeApiKeyServiceDouble, makePrincipalResolverDouble } from '../support/identity-service-doubles.ts';

const tenantId = '30000000-0000-4000-8000-000000000001';
const workloadPrincipalId = '40000000-0000-4000-8000-000000000001';
const workloadBindingId = '45000000-0000-4000-8000-000000000001';
const staffNamespace = 'test.staff.better-auth.v1';
const customerNamespace = 'test.customer.external.v1';
const audience = 'shell-super-app';

const configuration = Schema.decodeUnknownSync(ExternalIdentityHttpConfigurationSchema)({
  grants: [
    {
      operation: 'read',
      receivingAudience: audience,
      targetAuthenticationNamespaceId: customerNamespace,
      tenantId,
      workloadAuthenticationNamespaceId: staffNamespace,
      workloadPrincipalId,
    },
  ],
  providerEndpointAudience: audience,
});

const makeAuthorization = (
  overrides: {
    readonly configuration?: ExternalIdentityHttpConfiguration;
    readonly verify?: (rawKey: string) => Effect.Effect<{ providerKeyId: string }>;
  } = {},
) => {
  let verificationCalls = 0;
  const apiKeyService = makeApiKeyServiceDouble({
    verify: (rawKey) => {
      verificationCalls += 1;
      return overrides.verify?.(rawKey) ?? Effect.succeed({ providerKeyId: 'better-auth-workload-key' });
    },
  });
  const principalResolver = makePrincipalResolverDouble({
    authenticationNamespaceId: staffNamespace,
    resolveBetterAuthApiKey: () =>
      Effect.succeed({
        authBindingId: workloadBindingId,
        displayName: 'Fixture workload',
        principalId: workloadPrincipalId,
        principalKind: 'service',
        tenantId,
      }),
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(ApiKeyService, apiKeyService),
    Layer.succeed(ExternalIdentityHttpConfigurationService, overrides.configuration ?? configuration),
    Layer.succeed(PrincipalResolver, principalResolver),
    externalIdentityWorkloadAuthorizationLive,
  );
  const authorize = <A>(
    effect: Effect.Effect<
      A,
      ExternalIdentityWorkloadAuthorizationError,
      | ExternalIdentityWorkloadAuthorization
      | ApiKeyService
      | PrincipalResolver
      | ExternalIdentityHttpConfigurationService
    >,
  ) => effect.pipe(Effect.provide(dependencies));
  return { authorize, verificationCalls: () => verificationCalls };
};

it.effect('verifies the workload key on every authorization and returns an API-key principal context', () =>
  Effect.gen(function* workloadAuthenticationScenario() {
    const fixture = makeAuthorization();
    const result = yield* fixture.authorize(
      ExternalIdentityWorkloadAuthorization.pipe(
        Effect.flatMap((authorization) =>
          authorization.authorize({
            apiKey: Redacted.make('workload-api-key'),
            operation: 'read',
            targetAuthenticationNamespaceId: customerNamespace,
          }),
        ),
      ),
    );
    const decoded = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)(result);
    expect(decoded).toEqual({
      authBindingId: workloadBindingId,
      authContextRef: 'better-auth-api-key:better-auth-workload-key',
      authenticationNamespaceId: staffNamespace,
      authMethod: 'api_key',
      principalId: workloadPrincipalId,
      tenantId,
    });
    expect(fixture.verificationCalls()).toBe(1);
  }),
);

it.effect('requires an exact configured target namespace and does not re-use a wildcard grant', () =>
  Effect.gen(function* exactNamespaceScenario() {
    const fixture = makeAuthorization();
    const exit = yield* Effect.exit(
      fixture.authorize(
        ExternalIdentityWorkloadAuthorization.pipe(
          Effect.flatMap((authorization) =>
            authorization.authorize({
              apiKey: Redacted.make('workload-api-key'),
              operation: 'read',
              targetAuthenticationNamespaceId: 'test.other.external.v1',
            }),
          ),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fixture.verificationCalls()).toBe(1);
  }),
);

it.effect('rejects a grant that omits the target namespace', () =>
  Effect.gen(function* wildcardGrantScenario() {
    const fixture = makeAuthorization({
      configuration: Schema.decodeUnknownSync(ExternalIdentityHttpConfigurationSchema)({
        grants: [
          {
            operation: 'read',
            receivingAudience: audience,
            tenantId,
            workloadAuthenticationNamespaceId: staffNamespace,
            workloadPrincipalId,
          },
        ],
        providerEndpointAudience: audience,
      }),
    });
    const exit = yield* Effect.exit(
      fixture.authorize(
        ExternalIdentityWorkloadAuthorization.pipe(
          Effect.flatMap((authorization) =>
            authorization.authorize({
              apiKey: Redacted.make('workload-api-key'),
              operation: 'read',
              targetAuthenticationNamespaceId: customerNamespace,
            }),
          ),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fixture.verificationCalls()).toBe(1);
  }),
);

it.effect('rejects an absent key before invoking the provider verifier', () =>
  Effect.gen(function* missingKeyScenario() {
    const fixture = makeAuthorization();
    const exit = yield* Effect.exit(
      fixture.authorize(
        ExternalIdentityWorkloadAuthorization.pipe(
          Effect.flatMap((authorization) =>
            authorization.authorize({
              apiKey: Redacted.make(''),
              operation: 'read',
              targetAuthenticationNamespaceId: customerNamespace,
            }),
          ),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fixture.verificationCalls()).toBe(0);
  }),
);
