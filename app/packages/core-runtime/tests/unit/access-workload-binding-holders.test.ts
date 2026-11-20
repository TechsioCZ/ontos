import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { readActiveWorkloadBindingHolders } from '../../src/access/workloads/binding-holders.ts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '../../src/auth/staff-authentication-namespace.ts';
import { makeTestDatabase } from '../support/database.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const integrationId = '20000000-0000-4000-8000-000000000002';
const systemId = '30000000-0000-4000-8000-000000000003';
const otherSystemId = '30000000-0000-4000-8000-000000000033';
const legalEntityId = '40000000-0000-4000-8000-000000000004';
const workloadKey = 'commerce.catalog.symmy-product-import';
/** The API-key subquery's parameters, then the holder filter's. */
const apiKeyParameters = ['better_auth', STAFF_AUTHENTICATION_NAMESPACE_ID, 'api_key', 'active'];
const holderParameters = [tenantId, workloadKey, 'active', 'active', 'active'];

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
      // A tenant-only read asks nothing of a company registration.
      expect(statement).not.toContain('"core"."access_workload_company_bindings"');
      parameters.push(values);
      return Effect.succeed([
        { apiKey: true, companyRegistration: null, kind: 'integration', principalId: integrationId },
        { apiKey: false, companyRegistration: null, kind: 'system', principalId: systemId },
      ]);
    });
    expect(yield* readActiveWorkloadBindingHolders(database, tenantId, workloadKey)).toStrictEqual([
      { apiKey: true, kind: 'integration', principalId: integrationId },
      { apiKey: false, kind: 'system', principalId: systemId },
    ]);
    expect(parameters).toEqual([[...apiKeyParameters, ...holderParameters]]);
  }),
);

it.effect(
  "reports where each holder is registered for the company a binding must serve, by the company gate's predicate",
  () =>
    Effect.gen(function* readRegisteredHolders() {
      const statements: string[] = [];
      const parameters: (readonly unknown[])[] = [];
      const database = yield* makeTestDatabase((statement, values) => {
        statements.push(statement);
        parameters.push(values);
        // Neither holder is filtered out by its registration: the caller decides on the whole list.
        return Effect.succeed([
          { apiKey: true, companyRegistration: 'other_binding', kind: 'integration', principalId: integrationId },
          { apiKey: false, companyRegistration: 'binding', kind: 'system', principalId: systemId },
          { apiKey: false, companyRegistration: 'none', kind: 'system', principalId: otherSystemId },
        ]);
      });
      expect(yield* readActiveWorkloadBindingHolders(database, tenantId, workloadKey, legalEntityId)).toStrictEqual([
        { apiKey: true, companyRegistration: 'other_binding', kind: 'integration', principalId: integrationId },
        { apiKey: false, companyRegistration: 'binding', kind: 'system', principalId: systemId },
        { apiKey: false, companyRegistration: 'none', kind: 'system', principalId: otherSystemId },
      ]);
      const [statement] = statements;
      // First the registration of the holder's own binding of the workload, then one of any other active binding it
      // holds; each is active and names an active company of its Tenant (D6).
      expect(statement).toContain(
        `case when exists (select "core"."access_workload_company_bindings"."legal_entity_id" from "core"."access_workload_company_bindings" inner join "core"."legal_entities" on (("core"."legal_entities"."tenant_id" = "core"."access_workload_company_bindings"."tenant_id") and ("core"."legal_entities"."legal_entity_id" = "core"."access_workload_company_bindings"."legal_entity_id") and ("core"."legal_entities"."status" = $5)) where (((("core"."access_workload_company_bindings"."tenant_id" = "core"."access_workload_bindings"."tenant_id") and ("core"."access_workload_company_bindings"."workload_binding_id" = "core"."access_workload_bindings"."binding_id") and ("core"."access_workload_company_bindings"."status" = $6))) and ("core"."access_workload_company_bindings"."legal_entity_id" = $7))) then 'binding'`,
      );
      expect(statement).toContain(
        `when exists (select "core"."access_workload_company_bindings"."legal_entity_id" from "core"."access_workload_bindings" "holder_binding" inner join "core"."access_workload_company_bindings" on (("core"."access_workload_company_bindings"."tenant_id" = "holder_binding"."tenant_id") and ("core"."access_workload_company_bindings"."workload_binding_id" = "holder_binding"."binding_id") and ("core"."access_workload_company_bindings"."status" = $8)) inner join "core"."legal_entities" on (("core"."legal_entities"."tenant_id" = "core"."access_workload_company_bindings"."tenant_id") and ("core"."legal_entities"."legal_entity_id" = "core"."access_workload_company_bindings"."legal_entity_id") and ("core"."legal_entities"."status" = $9)) where (("holder_binding"."tenant_id" = "core"."access_workload_bindings"."tenant_id") and ("holder_binding"."principal_id" = "core"."access_workload_bindings"."principal_id") and ("holder_binding"."status" = $10) and ("core"."access_workload_company_bindings"."legal_entity_id" = $11))) then 'other_binding' else 'none' end`,
      );
      expect(statement).not.toContain('limit');
      expect(parameters).toEqual([
        [
          ...apiKeyParameters,
          'active',
          'active',
          legalEntityId,
          'active',
          'active',
          'active',
          legalEntityId,
          ...holderParameters,
        ],
      ]);
    }),
);

it.effect('answers unavailable for a registration answer it does not know, never a guessed one', () =>
  Effect.gen(function* unknownRegistration() {
    const database = yield* makeTestDatabase(() =>
      Effect.succeed([{ apiKey: false, companyRegistration: 'revoked', kind: 'system', principalId: systemId }]),
    );
    const failure = yield* Effect.flip(
      readActiveWorkloadBindingHolders(database, tenantId, workloadKey, legalEntityId),
    );
    expect(Predicate.isTagged(failure, 'AccessDecisionUnavailable')).toBe(true);
  }),
);

it.effect('rejects a malformed Tenant, workload key or company before reaching the database', () =>
  Effect.gen(function* rejectInvalidQuery() {
    let queries = 0;
    const database = yield* makeTestDatabase(() => {
      queries += 1;
      return Effect.succeed([]);
    });
    const failures = [
      yield* Effect.flip(readActiveWorkloadBindingHolders(database, 'not-a-tenant', workloadKey)),
      yield* Effect.flip(readActiveWorkloadBindingHolders(database, tenantId, 'not a workload')),
      yield* Effect.flip(readActiveWorkloadBindingHolders(database, tenantId, workloadKey, 'not-a-company')),
    ];
    expect(failures.every((failure) => Predicate.isTagged(failure, 'AccessDecisionUnavailable'))).toBe(true);
    expect(queries).toBe(0);
  }),
);
