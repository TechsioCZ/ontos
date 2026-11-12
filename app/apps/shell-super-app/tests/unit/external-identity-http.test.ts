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
import { Cause, Effect, Exit, Layer, Option, Predicate, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { ModuleCredentialEnrolmentSource } from '../../api/auth/gateway-delegation-policy.ts';
import { makeApiKeyServiceDouble, makePrincipalResolverDouble } from '../support/identity-service-doubles.ts';
import {
  enrolledModuleCredentials,
  unreadableModuleCredentialEnrolment,
} from '../support/module-credential-enrolment.ts';

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
    readonly enrolment?: Layer.Layer<ModuleCredentialEnrolmentSource>;
    readonly verify?: (rawKey: string) => Effect.Effect<{ providerKeyId: string }>;
  } = {},
) => {
  let resolutions = 0;
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
      Effect.sync(() => {
        resolutions += 1;
      }).pipe(
        Effect.as({
          authBindingId: workloadBindingId,
          displayName: 'Fixture workload',
          principalId: workloadPrincipalId,
          principalKind: 'service' as const,
          tenantId,
        }),
      ),
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(ApiKeyService, apiKeyService),
    Layer.succeed(ExternalIdentityHttpConfigurationService, overrides.configuration ?? configuration),
    Layer.succeed(PrincipalResolver, principalResolver),
    externalIdentityWorkloadAuthorizationLive.pipe(Layer.provide(overrides.enrolment ?? enrolledModuleCredentials([]))),
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
  return { authorize, resolutions: () => resolutions, verificationCalls: () => verificationCalls };
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

/** One workload authorization over the given enrolment, and how many principals it resolved on the way. */
const attemptWorkload = (enrolment: Layer.Layer<ModuleCredentialEnrolmentSource>) => {
  const fixture = makeAuthorization({ enrolment });
  return fixture
    .authorize(
      ExternalIdentityWorkloadAuthorization.pipe(
        Effect.flatMap((authorization) =>
          authorization.authorize({
            apiKey: Redacted.make('module-api-key'),
            operation: 'read',
            targetAuthenticationNamespaceId: customerNamespace,
          }),
        ),
      ),
    )
    .pipe(
      Effect.flip,
      Effect.map((error) => ({ error, resolutions: fixture.resolutions() })),
    );
};

it.effect('refuses a platform module credential as a workload and answers an unreadable enrolment as unavailable', () =>
  Effect.gen(function* moduleCredentialScenario() {
    // The verified key is the commerce-customer-context module credential: refused before any principal resolves.
    const moduleKey = yield* attemptWorkload(
      enrolledModuleCredentials([{ appId: 'commerce-customer-context', providerKeyId: 'better-auth-workload-key' }]),
    );
    expect(Predicate.isTagged(moduleKey.error, 'ExternalIdentityWorkloadForbiddenError')).toBe(true);
    expect(moduleKey.resolutions).toBe(0);
    const unreadable = yield* attemptWorkload(unreadableModuleCredentialEnrolment);
    expect(Predicate.isTagged(unreadable.error, 'ExternalIdentityWorkloadUnavailableError')).toBe(true);
    expect(unreadable.resolutions).toBe(0);
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

it.effect(
  'rejects a customer session principal from a workload-authorized grant with ExternalIdentityWorkloadForbiddenError',
  () =>
    Effect.gen(function* sessionPrincipalForbiddenScenario() {
      const fixture = makeAuthorization();
      // Same principalId/namespace/tenant as the configured workload grant, but authMethod is
      // 'session' rather than 'api_key' — the shape a customer's browser session would carry.
      const sessionPrincipal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
        authBindingId: workloadBindingId,
        authContextRef: 'session:fixture-customer-session',
        authenticationNamespaceId: staffNamespace,
        authMethod: 'session',
        principalId: workloadPrincipalId,
        tenantId,
      });
      const exit = yield* Effect.exit(
        fixture.authorize(
          ExternalIdentityWorkloadAuthorization.pipe(
            Effect.flatMap((authorization) =>
              authorization.authorizePrincipal(sessionPrincipal, {
                operation: 'read',
                targetAuthenticationNamespaceId: customerNamespace,
              }),
            ),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
      expect(
        Option.isSome(failure) && Predicate.isTagged(failure.value, 'ExternalIdentityWorkloadForbiddenError'),
      ).toBe(true);
    }),
);

it.effect('a valid workload principal is never granted an operation outside its exact configured grant', () =>
  Effect.gen(function* workloadPrincipalNeverUnionedScenario() {
    const fixture = makeAuthorization();
    const workloadPrincipal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
      authBindingId: workloadBindingId,
      authContextRef: 'better-auth-api-key:better-auth-workload-key',
      authenticationNamespaceId: staffNamespace,
      authMethod: 'api_key',
      principalId: workloadPrincipalId,
      tenantId,
    });
    const granted = yield* fixture.authorize(
      ExternalIdentityWorkloadAuthorization.pipe(
        Effect.flatMap((authorization) =>
          authorization.authorizePrincipal(workloadPrincipal, {
            operation: 'read',
            targetAuthenticationNamespaceId: customerNamespace,
          }),
        ),
      ),
    );
    expect(granted).toEqual(workloadPrincipal);

    // An ungranted capability (a session-only 'status' operation) must not be unioned in just
    // because the principal was already authorized for something else.
    const ungrantedExit = yield* Effect.exit(
      fixture.authorize(
        ExternalIdentityWorkloadAuthorization.pipe(
          Effect.flatMap((authorization) =>
            authorization.authorizePrincipal(workloadPrincipal, {
              operation: 'status',
              targetAuthenticationNamespaceId: customerNamespace,
            }),
          ),
        ),
      ),
    );
    expect(Exit.isFailure(ungrantedExit)).toBe(true);
    const ungrantedFailure = Exit.isFailure(ungrantedExit) ? Cause.findErrorOption(ungrantedExit.cause) : Option.none();
    expect(
      Option.isSome(ungrantedFailure) &&
        Predicate.isTagged(ungrantedFailure.value, 'ExternalIdentityWorkloadForbiddenError'),
    ).toBe(true);
  }),
);
