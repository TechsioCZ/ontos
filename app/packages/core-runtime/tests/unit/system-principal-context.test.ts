import { Effect, Schema, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { decodeTrustedPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import {
  registerSystemWorkload,
  systemPrincipalContextResolverFromRepository,
} from '../../src/auth/system-principal-context.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';

const resolverFor = (record: {
  readonly kind: 'human' | 'service' | 'system';
  readonly principalStatus: 'active' | 'disabled';
  readonly tenantStatus: 'active' | 'suspended';
}) =>
  systemPrincipalContextResolverFromRepository({
    load: () => Effect.succeedSome(record),
  });

it.effect('constructs one immutable trusted system context from a branded registration', () =>
  Effect.gen(function* testScenario1() {
    const registration = registerSystemWorkload({
      jobKey: 'inventory-reconcile',
    });
    const context = yield* resolverFor({
      kind: 'system',
      principalStatus: 'active',
      tenantStatus: 'active',
    }).resolve({
      principalId,
      registration,
      runReference: 'run-42',
      tenantId,
    });

    expect(Object.isFrozen(registration)).toBe(true);
    expect(Object.isFrozen(context)).toBe(true);
    expect(context).toEqual({
      authContextRef: 'job:inventory-reconcile:run:run-42',
      authMethod: 'system',
      principalId,
      tenantId,
    });
    expect(yield* Schema.decodeEffect(TrustedPrincipalContextSchema)(context)).toEqual(context);
    expect(yield* decodeTrustedPrincipalContext(context)).toEqual(context);
    expect(yield* Effect.flip(decodeTrustedPrincipalContext({ ...context }))).toBeDefined();
  }),
);

it.effect('rejects forged registrations, unsafe refs, wrong kinds, and inactive state', () =>
  Effect.gen(function* testScenario2() {
    const registration = registerSystemWorkload({
      jobKey: 'inventory-reconcile',
    });
    const forged = { ...registration };
    const invalid = yield* Effect.flip(
      resolverFor({
        kind: 'system',
        principalStatus: 'active',
        tenantStatus: 'active',
      }).resolve({
        principalId,
        registration: forged,
        runReference: 'run-42',
        tenantId,
      }),
    );
    const wrongKind = yield* Effect.flip(
      resolverFor({
        kind: 'human',
        principalStatus: 'active',
        tenantStatus: 'active',
      }).resolve({
        principalId,
        registration,
        runReference: 'run-42',
        tenantId,
      }),
    );
    const inactive = yield* Effect.flip(
      resolverFor({
        kind: 'system',
        principalStatus: 'disabled',
        tenantStatus: 'active',
      }).resolve({
        principalId,
        registration,
        runReference: 'run-42',
        tenantId,
      }),
    );

    expect(Predicate.isTagged(invalid, 'SystemPrincipalContextInvalidError')).toBe(true);
    expect(Predicate.isTagged(wrongKind, 'SystemPrincipalContextDeniedError')).toBe(true);
    expect(Predicate.isTagged(inactive, 'SystemPrincipalContextDeniedError')).toBe(true);
    expect(() => registerSystemWorkload({ jobKey: 'unsafe:key' })).toThrow(TypeError);
  }),
);

it.effect('permits service principals only when the trusted registration opts in', () =>
  Effect.gen(function* testScenario3() {
    const denied = yield* Effect.flip(
      resolverFor({
        kind: 'service',
        principalStatus: 'active',
        tenantStatus: 'active',
      }).resolve({
        principalId,
        registration: registerSystemWorkload({ jobKey: 'service-job' }),
        runReference: 'run-1',
        tenantId,
      }),
    );
    const allowed = yield* resolverFor({
      kind: 'service',
      principalStatus: 'active',
      tenantStatus: 'active',
    }).resolve({
      principalId,
      registration: registerSystemWorkload({
        allowServicePrincipal: true,
        jobKey: 'service-job',
      }),
      runReference: 'run-1',
      tenantId,
    });

    expect(Predicate.isTagged(denied, 'SystemPrincipalContextDeniedError')).toBe(true);
    expect(allowed.authMethod).toBe('system');
  }),
);

it('enforces mode-specific trusted context cross-field invariants', () => {
  const binding = '30000000-0000-4000-8000-000000000001';
  const original = '40000000-0000-4000-8000-000000000001';
  const valid = [
    {
      authBindingId: binding,
      authContextRef: 'better-auth-session:session-id',
      authMethod: 'session',
      principalId,
      tenantId,
    },
    {
      authBindingId: binding,
      authContextRef: 'better-auth-api-key:key-id',
      authMethod: 'api_key',
      principalId,
      tenantId,
    },
    {
      authBindingId: binding,
      authContextRef: 'better-auth-session:impersonated-session-id',
      authMethod: 'support_impersonation',
      impersonatedByPrincipalId: original,
      principalId,
      tenantId,
    },
  ];
  for (const context of valid) {
    expect(() => Schema.decodeUnknownSync(TrustedPrincipalContextSchema)(context)).not.toThrow();
  }
  expect(() =>
    Schema.decodeSync(TrustedPrincipalContextSchema)({
      authContextRef: 'better-auth-api-key:key-id',
      authMethod: 'api_key',
      principalId,
      tenantId,
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeSync(TrustedPrincipalContextSchema)({
      authBindingId: binding,
      authContextRef: 'better-auth-session:nested',
      authMethod: 'support_impersonation',
      impersonatedByPrincipalId: principalId,
      principalId,
      tenantId,
    }),
  ).toThrow();
});
