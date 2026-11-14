import {
  LegalEntityContext,
  OperationalScopeResolver,
  OperationContextUnavailable,
  PrincipalResolver,
} from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Layer, Predicate, Result } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { ApiKeyService } from '../../api/auth/api-key-service.ts';
import { agentPlatformKeyCaller } from '../../api/index.ts';
import {
  enrolledModuleCredentials,
  noInternalWorkloadPrincipals,
  refusingInternalWorkloadKeys,
  unreadableModuleCredentialEnrolment,
} from '../support/module-credential-enrolment.ts';
import { makeShellTestAccessGate } from '../support/access-decision-double.ts';
import { makeApiKeyServiceDouble, makePrincipalResolverDouble } from '../support/identity-service-doubles.ts';

const identity = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  displayName: 'Test agent',
  principalId: '20000000-0000-4000-8000-000000000001',
  principalKind: 'agent' as const,
  tenantId: '10000000-0000-4000-8000-000000000001',
};
const company = {
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  legalName: 'Test company',
};
const resolutionUnavailable = new OperationContextUnavailable({
  code: 'operation_context_unavailable',
  reason: 'Test scope unavailable',
});

const run = Effect.fn('test.agentKeyCaller')(function* run(
  options: {
    /** The platform's module credential enrolment; by default it holds no credential. */
    readonly enrolment?: 'module-key-1' | 'unreadable';
    readonly providerKeyId?: string;
    readonly resolutionUnavailable?: boolean;
    readonly selectable?: boolean;
    readonly selectionUnavailable?: boolean;
    /** The key's principal is a module's internal workload and the key is not the one the platform issued it. */
    readonly workloadKeyRefused?: boolean;
  } = {},
) {
  const events: string[] = [];
  const scopes: OperationalScope[] = [];
  const gate = makeShellTestAccessGate({
    selectableLegalEntityIds: options.selectable === false ? [] : [company.legalEntityId],
    selectionUnavailable: options.selectionUnavailable === true,
  });
  const resolver: (typeof OperationalScopeResolver)['Service'] = {
    resolve: (input) => {
      events.push('resolve-scope');
      expect(input.legalEntityScope).toBe('required');
      expect(input.principal).toEqual({
        authBindingId: identity.authBindingId,
        authContextRef: 'better-auth-api-key:provider-key-1',
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        authMethod: 'api_key',
        legalEntityId: company.legalEntityId,
        principalId: identity.principalId,
        tenantId: identity.tenantId,
      });
      const scope: OperationalScope = { ...input.principal, correlationId: input.correlationId };
      scopes.push(scope);
      return options.resolutionUnavailable === true ? Effect.fail(resolutionUnavailable) : Effect.succeed(scope);
    },
  };
  const result = yield* agentPlatformKeyCaller('raw-key', company.legalEntityId).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        options.workloadKeyRefused === true ? refusingInternalWorkloadKeys : noInternalWorkloadPrincipals,
        Layer.succeed(
          ApiKeyService,
          makeApiKeyServiceDouble({
            verify: (key) => {
              events.push('verify-key');
              expect(key).toBe('raw-key');
              return Effect.succeed({ providerKeyId: options.providerKeyId ?? 'provider-key-1' });
            },
          }),
        ),
        Layer.succeed(
          PrincipalResolver,
          makePrincipalResolverDouble({
            resolveBetterAuthApiKey: (key) => {
              events.push('resolve-principal');
              expect(key).toBe('provider-key-1');
              return Effect.succeed(identity);
            },
          }),
        ),
        Layer.succeed(OperationalScopeResolver, resolver),
        Layer.succeed(AccessDecisionGate, gate),
        Layer.succeed(LegalEntityContext, {
          listActiveForTenant: () => Effect.die('Unexpected company list'),
          validateSelection: (tenantId, legalEntityId) => {
            events.push('validate-company');
            expect(tenantId).toBe(identity.tenantId);
            expect(legalEntityId).toBe(company.legalEntityId);
            return Effect.succeed(company);
          },
        }),
        Layer.succeed(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request('https://shell.test/agent')),
        ),
      ),
    ),
    Effect.provide(
      options.enrolment === 'unreadable'
        ? unreadableModuleCredentialEnrolment
        : enrolledModuleCredentials(
            options.enrolment === undefined
              ? []
              : [{ appId: 'commerce-customer-context', providerKeyId: options.enrolment }],
          ),
    ),
    Effect.result,
  );
  return { events, gate, result, scopes };
});

it.effect('asks company selection in the original revalidated API-key scope and returns that scope unchanged', () =>
  Effect.gen(function* keyScopeIsPreserved() {
    const { events, gate, result, scopes } = yield* run();
    expect(events).toEqual(['verify-key', 'resolve-principal', 'resolve-scope', 'validate-company']);
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success.legalName).toBe(company.legalName);
      expect(result.success.scope).toBe(scopes[0]);
      const { correlationId, ...resolvedPrincipal } = result.success.scope;
      expect(correlationId.length).toBeGreaterThan(0);
      expect(result.success.principal).toEqual(resolvedPrincipal);
    }
    expect(gate.selectableAsks).toHaveLength(1);
    expect(gate.selectableAsks[0]?.scope).toBe(scopes[0]);
  }),
);

it.effect('refuses a key of an internal workload principal the platform did not issue, before any scope is asked', () =>
  Effect.gen(function* refusesUnattestedWorkloadKey() {
    const { events, result } = yield* run({ workloadKeyRefused: true });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Predicate.isTagged(result.failure, 'ShellTargetForbiddenProblem')).toBe(true);
      expect(result.failure.status).toBe(403);
    }
    expect(events).not.toContain('resolve-scope');
  }),
);

it.effect('refuses a company that the canonical gate does not offer', () =>
  Effect.gen(function* unselectableCompany() {
    const { result } = yield* run({ selectable: false });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Predicate.isTagged(result.failure, 'ShellTargetForbiddenProblem')).toBe(true);
      expect(result.failure.status).toBe(403);
    }
  }),
);

it.effect('keeps unavailable selection retryable instead of reporting a forbidden company', () =>
  Effect.gen(function* unavailableCompanySelection() {
    const { result } = yield* run({ selectionUnavailable: true });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Predicate.isTagged(result.failure, 'ShellCapabilityUnavailableProblem')).toBe(true);
      expect(result.failure.status).toBe(503);
    }
  }),
);

it.effect('does not ask company authority before the API-key scope has been revalidated', () =>
  Effect.gen(function* scopeResolutionFailsFirst() {
    const { events, gate, result } = yield* run({ resolutionUnavailable: true });
    expect(events).toEqual(['verify-key', 'resolve-principal', 'resolve-scope']);
    expect(gate.selectableAsks).toEqual([]);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Predicate.isTagged(result.failure, 'ShellCapabilityUnavailableProblem')).toBe(true);
      expect(result.failure.status).toBe(503);
    }
  }),
);

it.effect('refuses an enrolled module credential before acting as its principal', () =>
  Effect.gen(function* moduleCredentialRefused() {
    const { events, gate, result } = yield* run({ enrolment: 'module-key-1', providerKeyId: 'module-key-1' });
    expect(events).toEqual(['verify-key']);
    expect(gate.selectableAsks).toEqual([]);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Predicate.isTagged(result.failure, 'ShellTargetForbiddenProblem')).toBe(true);
      expect(result.failure.status).toBe(403);
    }
  }),
);

it.effect('admits an agent key that is not an enrolled module credential', () =>
  Effect.gen(function* agentKeyAdmitted() {
    const { events, result } = yield* run({ enrolment: 'module-key-1' });
    expect(events).toEqual(['verify-key', 'resolve-principal', 'resolve-scope', 'validate-company']);
    expect(Result.isSuccess(result)).toBe(true);
  }),
);

it.effect('answers an unreadable module enrolment as unavailable instead of admitting the key', () =>
  Effect.gen(function* enrolmentUnavailable() {
    const { events, result } = yield* run({ enrolment: 'unreadable' });
    expect(events).toEqual(['verify-key']);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Predicate.isTagged(result.failure, 'ShellCapabilityUnavailableProblem')).toBe(true);
      expect(result.failure.status).toBe(503);
    }
  }),
);
