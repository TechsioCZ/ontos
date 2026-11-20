import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { readActiveWorkloadBindingHolders } from '../../src/access/workloads/binding-holders.ts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '../../src/auth/staff-authentication-namespace.ts';
import { makeTestDatabase } from '../support/database.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const integrationId = '20000000-0000-4000-8000-000000000002';
const systemId = '30000000-0000-4000-8000-000000000003';
const workloadKey = 'commerce.catalog.symmy-product-import';

it.effect('lists every active holder of one workload in an active Tenant, its kind and whether an API key is it', () =>
  Effect.gen(function* readHolders() {
    const parameters: (readonly unknown[])[] = [];
    const database = yield* makeTestDatabase((statement, values) => {
      expect(statement).toContain('"core"."access_workload_bindings"');
      expect(statement).toContain('"core"."principals"');
      expect(statement).toContain('"core"."tenants"');
      expect(statement).toContain('exists (select');
      expect(statement).toContain('"core"."principal_auth_bindings"');
      expect(statement).toContain('"revoked_at" is null');
      expect(statement).not.toContain('limit');
      parameters.push(values);
      return Effect.succeed([
        { apiKey: true, kind: 'integration', principalId: integrationId },
        { apiKey: false, kind: 'system', principalId: systemId },
      ]);
    });
    expect(yield* readActiveWorkloadBindingHolders(database, tenantId, workloadKey)).toEqual([
      { apiKey: true, kind: 'integration', principalId: integrationId },
      { apiKey: false, kind: 'system', principalId: systemId },
    ]);
    expect(parameters).toEqual([
      [
        'better_auth',
        STAFF_AUTHENTICATION_NAMESPACE_ID,
        'api_key',
        'active',
        tenantId,
        workloadKey,
        'active',
        'active',
        'active',
      ],
    ]);
  }),
);

it.effect('rejects a malformed Tenant or workload key before reaching the database', () =>
  Effect.gen(function* rejectInvalidQuery() {
    let queries = 0;
    const database = yield* makeTestDatabase(() => {
      queries += 1;
      return Effect.succeed([]);
    });
    const failures = [
      yield* Effect.flip(readActiveWorkloadBindingHolders(database, 'not-a-tenant', workloadKey)),
      yield* Effect.flip(readActiveWorkloadBindingHolders(database, tenantId, 'not a workload')),
    ];
    expect(failures.every((failure) => Predicate.isTagged(failure, 'AccessDecisionUnavailable'))).toBe(true);
    expect(queries).toBe(0);
  }),
);
