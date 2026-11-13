import { LegalEntityContext, OperationalScopeResolver, PrincipalResolver } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Layer, Predicate, Result } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { ApiKeyService } from '../../api/auth/api-key-service.ts';
import { GatewayIssuer } from '../../api/auth/gateway-issuer.ts';
import { issueApiKeyContext } from '../../api/index.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../api/modules/installed-module-catalog.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import {
  enrolledModuleCredentials,
  noInternalWorkloadPrincipals,
  unreadableModuleCredentialEnrolment,
} from '../support/module-credential-enrolment.ts';
import { makeApiKeyServiceDouble, makePrincipalResolverDouble } from '../support/identity-service-doubles.ts';

const MODULE_KEY = 'commerce-module-key';
const INTEGRATION_KEY = 'tenant-integration-key';
const identity = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  displayName: 'Tenant workload',
  principalId: '20000000-0000-4000-8000-000000000001',
  principalKind: 'service' as const,
  tenantId: '10000000-0000-4000-8000-000000000001',
};

const issue = Effect.fn('test.apiKeyGatewayContext')(function* issue(
  providerKeyId: string,
  options: { readonly enrolmentUnreadable?: boolean } = {},
) {
  const snapshot = yield* makeCompositionSnapshot([]);
  const catalog = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
  const events: string[] = [];
  const scopeResolver: (typeof OperationalScopeResolver)['Service'] = {
    resolve: (input) => {
      events.push('resolve-scope');
      const scope: OperationalScope = { ...input.principal, correlationId: input.correlationId };
      return Effect.succeed(scope);
    },
  };
  const result = yield* issueApiKeyContext(
    { audience: 'party-registry', compositionRevision: catalog.composition.revision },
    'raw-key',
    { headers: {} },
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        noInternalWorkloadPrincipals,
        options.enrolmentUnreadable === true
          ? unreadableModuleCredentialEnrolment
          : enrolledModuleCredentials([{ appId: 'commerce-customer-context', providerKeyId: MODULE_KEY }]),
        Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
        Layer.succeed(ApiKeyService, makeApiKeyServiceDouble({ verify: () => Effect.succeed({ providerKeyId }) })),
        Layer.succeed(
          PrincipalResolver,
          makePrincipalResolverDouble({
            resolveBetterAuthApiKey: () => {
              events.push('resolve-principal');
              return Effect.succeed(identity);
            },
          }),
        ),
        Layer.succeed(OperationalScopeResolver, scopeResolver),
        Layer.mock(AccessDecisionGate, {}),
        Layer.mock(LegalEntityContext, {}),
        Layer.succeed(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request('https://shell.test/shell-super-app-api/auth/api-key/gateway-context')),
        ),
        Layer.mock(GatewayIssuer, {
          issue: () => {
            events.push('issue-assertion');
            return Effect.succeed({
              apiBaseUrl: '/shell-super-app-api/module-api/party-registry',
              compositionRevision: catalog.composition.revision,
              expiresAt: 1_900_000_000,
              token: 'issued-token',
            });
          },
        }),
      ),
    ),
    Effect.result,
  );
  return { events, result };
});

it.effect('refuses to mint a subject context for an enrolled module credential before resolving its principal', () =>
  Effect.gen(function* moduleCredentialRefused() {
    const { events, result } = yield* issue(MODULE_KEY);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Predicate.isTagged(result.failure, 'GatewayForbiddenProblem')).toBe(true);
      expect(result.failure.status).toBe(403);
    }
    expect(events).toEqual([]);
  }),
);

it.effect('mints a subject context for an integration key that is not a module credential', () =>
  Effect.gen(function* integrationKeyAdmitted() {
    const { events, result } = yield* issue(INTEGRATION_KEY);
    expect(Result.isSuccess(result)).toBe(true);
    expect(events).toEqual(['resolve-principal', 'resolve-scope', 'issue-assertion']);
  }),
);

it.effect('answers an unreadable module enrolment as unavailable instead of admitting the key', () =>
  Effect.gen(function* enrolmentUnavailable() {
    const { events, result } = yield* issue(INTEGRATION_KEY, { enrolmentUnreadable: true });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Predicate.isTagged(result.failure, 'GatewayUnavailableProblem')).toBe(true);
    }
    expect(events).toEqual([]);
  }),
);
