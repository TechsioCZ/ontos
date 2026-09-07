import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { DateTime, Effect, flow, Predicate } from 'effect';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrincipalResolutionRecord } from '../../src/auth/principal-resolver.ts';
import {
  classifyApiKeyPrincipal,
  classifyAvailableTenants,
  classifyDefaultPrincipal,
  classifySelectedPrincipal,
  makePrincipalResolver,
} from '../../src/auth/principal-resolver.ts';
import { makeTestDatabase } from '../support/database.ts';

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
    assert.ok(
      Predicate.isTagged(
        yield* Effect.flip(classifySelectedPrincipal([activeRecord, selected], 'foreign-tenant')),
        'PrincipalBindingMissingError',
      ),
    );
  }),
);

effectTest(
  'rejects Better Auth user bindings to non-human principals',
  Effect.all(
    (['service', 'integration', 'agent', 'system'] as const).map((principalKind) =>
      Effect.gen(function* rejectsNonHumanPrincipal() {
        const record = { ...activeRecord, principalKind };
        assert.ok(
          Predicate.isTagged(
            yield* Effect.flip(classifyDefaultPrincipal([record])),
            'PrincipalInactiveError',
          ),
        );
        assert.ok(
          Predicate.isTagged(
            yield* Effect.flip(classifySelectedPrincipal([record], record.tenantId)),
            'PrincipalInactiveError',
          ),
        );
        assert.ok(
          Predicate.isTagged(
            yield* Effect.flip(classifyAvailableTenants([record])),
            'PrincipalInactiveError',
          ),
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
    assert.ok(
      Predicate.isTagged(
        yield* Effect.flip(
          classifyApiKeyPrincipal([activeRecord, { ...activeRecord, tenantId: 't-2' }]),
        ),
        'PrincipalBindingAmbiguousError',
      ),
    );
  }),
);

effectTest(
  'fails closed for empty, inactive, and duplicate eligible resolver states',
  Effect.gen(function* rejectsInvalidResolverStates() {
    assert.ok(
      Predicate.isTagged(
        yield* Effect.flip(classifyAvailableTenants([])),
        'PrincipalBindingMissingError',
      ),
    );
    assert.ok(
      Predicate.isTagged(
        yield* Effect.flip(
          classifyAvailableTenants([{ ...activeRecord, bindingStatus: 'revoked' }]),
        ),
        'PrincipalBindingInactiveError',
      ),
    );
    assert.ok(
      Predicate.isTagged(
        yield* Effect.flip(
          classifyAvailableTenants([
            {
              ...activeRecord,
              bindingRevokedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-03-01T00:00:00.000Z')),
            },
          ]),
        ),
        'PrincipalBindingInactiveError',
      ),
    );
    assert.ok(
      Predicate.isTagged(
        yield* Effect.flip(
          classifyAvailableTenants([{ ...activeRecord, principalStatus: 'disabled' }]),
        ),
        'PrincipalInactiveError',
      ),
    );
    assert.ok(
      Predicate.isTagged(
        yield* Effect.flip(
          classifyAvailableTenants([{ ...activeRecord, tenantStatus: 'suspended' }]),
        ),
        'TenantInactiveError',
      ),
    );
    assert.ok(
      Predicate.isTagged(
        yield* Effect.flip(
          classifyAvailableTenants([
            activeRecord,
            { ...activeRecord, principalId: 'duplicate-principal' },
          ]),
        ),
        'PrincipalBindingAmbiguousError',
      ),
    );
  }),
);

effectTest(
  'types database failures as resolver unavailability',
  Effect.gen(function* sanitizesResolverDatabaseFailure() {
    const error = yield* Effect.flip(
      makePrincipalResolver({
        executor: makeTestDatabase(() =>
          Effect.fail(
            new SqlError({
              reason: new ConnectionError({ cause: new Error('secret database error') }),
            }),
          ),
        ),
      }).listAvailableTenants('subject'),
    );
    assert.ok(Predicate.isTagged(error, 'PrincipalResolverUnavailableError'));
    assert.doesNotMatch(error.reason, /secret database error/u);
  }),
);
