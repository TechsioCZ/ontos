import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime, Effect, flow } from 'effect';
import {
  classifyAvailableTenants,
  classifyApiKeyPrincipal,
  classifyDefaultPrincipal,
  classifySelectedPrincipal,
  listAvailableTenantsFromRepository,
} from '../../src/auth/principal-resolver.ts';
import type { PrincipalResolutionRecord } from '../../src/auth/principal-resolver.ts';
import type { PrincipalResolutionError } from '../../src/auth/principal-resolver-errors.ts';

const effectTest = <Value, Failure>(name: string, effect: Effect.Effect<Value, Failure>): void => {
  test(
    name,
    flow(() => Effect.asVoid(effect), runEffectTestPromise),
  );
};

const activeRecord: PrincipalResolutionRecord = {
  authBindingId: 'binding-1',
  bindingCreatedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T00:00:00.000Z')),
  bindingRevokedAt: null,
  bindingStatus: 'active',
  displayName: 'Ada Lovelace',
  principalId: 'principal-1',
  principalKind: 'human',
  principalStatus: 'active',
  tenantId: 'tenant-1',
  tenantName: 'Zeta tenant',
  tenantStatus: 'active',
};

const failureTag = <Value>(effect: Effect.Effect<Value, PrincipalResolutionError>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => error._tag,
      onSuccess: () => assert.fail('Expected principal resolution to fail'),
    }),
  );

effectTest(
  'lists safe eligible tenants by name and tenant ID',
  Effect.gen(function* listsEligibleTenants() {
    const records = [
      activeRecord,
      {
        ...activeRecord,
        bindingCreatedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-02-01T00:00:00.000Z')),
        displayName: 'Grace Hopper',
        principalId: 'principal-2',
        tenantId: 'tenant-2',
        tenantName: 'Alpha tenant',
      },
      {
        ...activeRecord,
        principalId: 'principal-3',
        tenantId: 'tenant-3',
        tenantName: 'Alpha tenant',
      },
      {
        ...activeRecord,
        bindingStatus: 'disabled',
        principalId: 'principal-disabled',
        tenantId: 'tenant-disabled',
        tenantName: 'Hidden binding',
      },
      {
        ...activeRecord,
        principalId: 'principal-inactive',
        principalStatus: 'disabled',
        tenantId: 'tenant-principal-inactive',
        tenantName: 'Hidden principal',
      },
      {
        ...activeRecord,
        principalId: 'principal-suspended',
        tenantId: 'tenant-suspended',
        tenantName: 'Hidden tenant',
        tenantStatus: 'suspended',
      },
    ];

    const result = yield* classifyAvailableTenants(records);
    assert.deepEqual(result, [
      { name: 'Alpha tenant', tenantId: 'tenant-2' },
      { name: 'Alpha tenant', tenantId: 'tenant-3' },
      { name: 'Zeta tenant', tenantId: 'tenant-1' },
    ]);
  }),
);

effectTest(
  'lists and resolves one active tenant binding',
  Effect.gen(function* listsAndResolvesActiveTenant() {
    assert.deepEqual(yield* classifyAvailableTenants([activeRecord]), [
      { name: 'Zeta tenant', tenantId: 'tenant-1' },
    ]);
    assert.deepEqual(yield* classifyDefaultPrincipal([activeRecord]), {
      authBindingId: 'binding-1',
      displayName: 'Ada Lovelace',
      principalId: 'principal-1',
      principalKind: 'human',
      tenantId: 'tenant-1',
    });
    assert.deepEqual(yield* classifySelectedPrincipal([activeRecord], 'tenant-1'), {
      authBindingId: 'binding-1',
      displayName: 'Ada Lovelace',
      principalId: 'principal-1',
      principalKind: 'human',
      tenantId: 'tenant-1',
    });
  }),
);

effectTest(
  'chooses the oldest eligible binding and breaks creation ties by tenant ID',
  Effect.gen(function* choosesOldestBinding() {
    const result = yield* classifyDefaultPrincipal([
      activeRecord,
      {
        ...activeRecord,
        displayName: 'Tie winner',
        principalId: 'principal-0',
        tenantId: 'tenant-0',
      },
      {
        ...activeRecord,
        bindingCreatedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-02-01T00:00:00.000Z')),
        principalId: 'principal-2',
        tenantId: 'tenant-2',
      },
    ]);

    assert.deepEqual(result, {
      authBindingId: 'binding-1',
      displayName: 'Tie winner',
      principalId: 'principal-0',
      principalKind: 'human',
      tenantId: 'tenant-0',
    });
  }),
);

effectTest(
  'resolves only the exact eligible selected tenant',
  Effect.gen(function* resolvesExactTenant() {
    const selected = {
      ...activeRecord,
      displayName: 'Grace Hopper',
      principalId: 'principal-2',
      tenantId: 'tenant-2',
    };
    assert.deepEqual(yield* classifySelectedPrincipal([activeRecord, selected], 'tenant-2'), {
      authBindingId: 'binding-1',
      displayName: 'Grace Hopper',
      principalId: 'principal-2',
      principalKind: 'human',
      tenantId: 'tenant-2',
    });
    assert.equal(
      yield* failureTag(classifySelectedPrincipal([activeRecord, selected], 'foreign-tenant')),
      'PrincipalBindingMissingError',
    );
  }),
);

effectTest(
  'rejects Better Auth user bindings to non-human principals',
  Effect.all(
    (['service', 'integration', 'agent', 'system'] as const).map((principalKind) =>
      Effect.gen(function* rejectsNonHumanPrincipal() {
        const record = { ...activeRecord, principalKind };
        assert.equal(
          yield* failureTag(classifyDefaultPrincipal([record])),
          'PrincipalInactiveError',
        );
        assert.equal(
          yield* failureTag(classifySelectedPrincipal([record], record.tenantId)),
          'PrincipalInactiveError',
        );
        assert.equal(
          yield* failureTag(classifyAvailableTenants([record])),
          'PrincipalInactiveError',
        );
      }),
    ),
  ),
);

effectTest(
  'resolves exactly one API-key subject for human, service, or integration principals',
  Effect.gen(function* resolvesApiKeySubject() {
    yield* Effect.all(
      (['human', 'service', 'integration'] as const).map((principalKind) =>
        Effect.gen(function* resolvesPrincipalKind() {
          const resolved = yield* classifyApiKeyPrincipal([{ ...activeRecord, principalKind }]);
          assert.equal(resolved.principalKind, principalKind);
          assert.equal(resolved.authBindingId, activeRecord.authBindingId);
        }),
      ),
    );
    assert.equal(
      yield* failureTag(
        classifyApiKeyPrincipal([activeRecord, { ...activeRecord, tenantId: 't-2' }]),
      ),
      'PrincipalBindingAmbiguousError',
    );
  }),
);

effectTest(
  'fails closed for empty, inactive, and duplicate eligible resolver states',
  Effect.gen(function* rejectsInvalidResolverStates() {
    assert.equal(yield* failureTag(classifyAvailableTenants([])), 'PrincipalBindingMissingError');
    assert.equal(
      yield* failureTag(classifyAvailableTenants([{ ...activeRecord, bindingStatus: 'revoked' }])),
      'PrincipalBindingInactiveError',
    );
    assert.equal(
      yield* failureTag(
        classifyAvailableTenants([
          {
            ...activeRecord,
            bindingRevokedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-03-01T00:00:00.000Z')),
          },
        ]),
      ),
      'PrincipalBindingInactiveError',
    );
    assert.equal(
      yield* failureTag(
        classifyAvailableTenants([{ ...activeRecord, principalStatus: 'disabled' }]),
      ),
      'PrincipalInactiveError',
    );
    assert.equal(
      yield* failureTag(classifyAvailableTenants([{ ...activeRecord, tenantStatus: 'suspended' }])),
      'TenantInactiveError',
    );
    assert.equal(
      yield* failureTag(
        classifyAvailableTenants([
          activeRecord,
          { ...activeRecord, principalId: 'duplicate-principal' },
        ]),
      ),
      'PrincipalBindingAmbiguousError',
    );
  }),
);

effectTest(
  'types database failures as resolver unavailability',
  Effect.gen(function* sanitizesResolverDatabaseFailure() {
    const error = yield* Effect.flip(
      listAvailableTenantsFromRepository(
        {
          load: flow(() => Effect.die(new Error('secret database error')), runEffectTestPromise),
        },
        'subject',
      ),
    );
    assert.equal(error._tag, 'PrincipalResolverUnavailableError');
    assert.doesNotMatch(error.reason, /secret database error/u);
  }),
);
