// @effect-diagnostics anyUnknownInErrorContext:off asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import {
  registerSystemWorkload,
  systemPrincipalContextResolverFromRepository,
} from '../../src/auth/system-principal-context.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { decodeTrustedPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';

const resolverFor = (record: {
  readonly kind: 'human' | 'service' | 'system';
  readonly principalStatus: 'active' | 'disabled';
  readonly tenantStatus: 'active' | 'suspended';
}) =>
  systemPrincipalContextResolverFromRepository({
    load: () => Promise.resolve(record),
  });

test('constructs one immutable trusted system context from a branded registration', async () => {
  const registration = registerSystemWorkload({ jobKey: 'inventory-reconcile' });
  const context = await Effect.runPromise(
    resolverFor({ kind: 'system', principalStatus: 'active', tenantStatus: 'active' }).resolve({
      principalId,
      registration,
      runReference: 'run-42',
      tenantId,
    }),
  );

  assert.equal(Object.isFrozen(registration), true);
  assert.equal(Object.isFrozen(context), true);
  assert.deepEqual(context, {
    authContextRef: 'job:inventory-reconcile:run:run-42',
    authMethod: 'system',
    principalId,
    tenantId,
  });
  assert.deepEqual(Schema.decodeUnknownSync(TrustedPrincipalContextSchema)(context), context);
  assert.deepEqual(await Effect.runPromise(decodeTrustedPrincipalContext(context)), context);
  await assert.rejects(Effect.runPromise(decodeTrustedPrincipalContext({ ...context })));
});

test('rejects forged registrations, unsafe refs, wrong kinds, and inactive state', async () => {
  const registration = registerSystemWorkload({ jobKey: 'inventory-reconcile' });
  const forged = { ...registration };
  const invalid = await Effect.runPromise(
    Effect.flip(
      resolverFor({ kind: 'system', principalStatus: 'active', tenantStatus: 'active' }).resolve({
        principalId,
        registration: forged,
        runReference: 'run-42',
        tenantId,
      }),
    ),
  );
  const wrongKind = await Effect.runPromise(
    Effect.flip(
      resolverFor({ kind: 'human', principalStatus: 'active', tenantStatus: 'active' }).resolve({
        principalId,
        registration,
        runReference: 'run-42',
        tenantId,
      }),
    ),
  );
  const inactive = await Effect.runPromise(
    Effect.flip(
      resolverFor({ kind: 'system', principalStatus: 'disabled', tenantStatus: 'active' }).resolve({
        principalId,
        registration,
        runReference: 'run-42',
        tenantId,
      }),
    ),
  );

  assert.equal(invalid._tag, 'SystemPrincipalContextInvalidError');
  assert.equal(wrongKind._tag, 'SystemPrincipalContextDeniedError');
  assert.equal(inactive._tag, 'SystemPrincipalContextDeniedError');
  assert.throws(() => registerSystemWorkload({ jobKey: 'unsafe:key' }), TypeError);
});

test('permits service principals only when the trusted registration opts in', async () => {
  const denied = await Effect.runPromise(
    Effect.flip(
      resolverFor({ kind: 'service', principalStatus: 'active', tenantStatus: 'active' }).resolve({
        principalId,
        registration: registerSystemWorkload({ jobKey: 'service-job' }),
        runReference: 'run-1',
        tenantId,
      }),
    ),
  );
  const allowed = await Effect.runPromise(
    resolverFor({ kind: 'service', principalStatus: 'active', tenantStatus: 'active' }).resolve({
      principalId,
      registration: registerSystemWorkload({ allowServicePrincipal: true, jobKey: 'service-job' }),
      runReference: 'run-1',
      tenantId,
    }),
  );

  assert.equal(denied._tag, 'SystemPrincipalContextDeniedError');
  assert.equal(allowed.authMethod, 'system');
});

test('enforces mode-specific trusted context cross-field invariants', () => {
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
    assert.doesNotThrow(() => Schema.decodeUnknownSync(TrustedPrincipalContextSchema)(context));
  }
  assert.throws(() =>
    Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      authContextRef: 'better-auth-api-key:key-id',
      authMethod: 'api_key',
      principalId,
      tenantId,
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      authBindingId: binding,
      authContextRef: 'better-auth-session:nested',
      authMethod: 'support_impersonation',
      impersonatedByPrincipalId: principalId,
      principalId,
      tenantId,
    }),
  );
});
