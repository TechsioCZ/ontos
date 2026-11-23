import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { readScopedSystemWorkloadEnrollment } from '../../src/access/workloads/system-enrollment.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { internalWorkloadPrincipalId } from '../../src/auth/module-credentials.ts';
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import { makeTestDatabase } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '10000000-0000-4000-8000-000000000002';
const legacyId = '10000000-0000-4000-8000-000000000003';
const incarnation = '10000000-0000-4000-8000-000000000004';
const nativeSourceWriters = ['party.registry.source-write', 'commerce.customer-context.source-write'];
type Enrollment = { readonly principalId: string; readonly bindingIncarnation: string };

const run = (input: {
  readonly workloadKey: string;
  readonly company?: boolean;
  readonly systems?: readonly Enrollment[];
  readonly services?: readonly Enrollment[];
}) =>
  Effect.gen(function* readEnrollment() {
    const statements: { sql: string; values: readonly unknown[] }[] = [];
    const scope = {
      ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
        authBindingId: '10000000-0000-4000-8000-000000000005',
        authContextRef: 'source-writer-enrollment-unit',
        authMethod: 'session',
        ...(input.company === false ? {} : { legalEntityId }),
        principalId: legacyId,
        tenantId,
      }),
      correlationId: 'source-writer-enrollment-unit',
    };
    const database = yield* makeTestDatabase((sql, values) => {
      if (sql.includes("set_config('ontos.tenant_id'")) {
        return Effect.succeed([
          {
            legal_entity_id: scope.legalEntityId ?? '',
            role: 'ontos_runtime',
            tenant_id: tenantId,
            operation_at: new Date('2026-11-23T00:00:00Z'),
          },
        ]);
      }
      if (sql.includes('"core"."access_workload_bindings"')) {
        statements.push({ sql, values });
        const rows = sql.includes('"platform_role"') ? (input.services ?? []) : (input.systems ?? []);
        return Effect.succeed(rows.map(({ bindingIncarnation, principalId }) => ({ bindingIncarnation, principalId })));
      }
      return Effect.succeed([]);
    });
    const result = yield* database
      .transaction((transaction) =>
        installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
          Effect.flatMap((scoped) => readScopedSystemWorkloadEnrollment(scoped, input.workloadKey)),
        ),
      )
      .pipe(Effect.result);
    return { result, statements };
  });

it.effect('resolves both real owner source-write jobs through exact platform company service bindings', () =>
  Effect.gen(function* test() {
    for (const workloadKey of nativeSourceWriters) {
      const principalId = internalWorkloadPrincipalId({ tenantId, legalEntityId, workloadKey });
      const { result, statements } = yield* run({
        workloadKey,
        services: [{ principalId, bindingIncarnation: incarnation }],
      });
      expect(result._tag).toBe('Success');
      if (result._tag === 'Success') {
        expect(result.success).toEqual(Option.some({ principalId, bindingIncarnation: incarnation }));
      }
      expect(statements).toHaveLength(2);
      const service = statements[1];
      expect(service?.sql).toContain('"core"."access_workload_company_bindings"');
      expect(service?.sql).toContain('"core"."legal_entities"');
      expect(service?.values).toContain('service');
      expect(service?.values).toContain('internal_workload');
      expect(service?.values).toContain(principalId);
      expect(service?.values).toContain(legalEntityId);
      expect(service?.sql).toContain('"workload_binding_id" = "core"."access_workload_bindings"."binding_id"');
      expect(service?.sql).toContain('"core"."access_workload_company_bindings"."status"');
      expect(service?.sql).toContain('"core"."legal_entities"."status"');
    }
  }),
);

it.effect('preserves unique legacy system identity without requiring a company row or querying services', () =>
  Effect.gen(function* test() {
    const { result, statements } = yield* run({
      workloadKey: nativeSourceWriters[0] ?? '',
      company: false,
      systems: [{ principalId: legacyId, bindingIncarnation: incarnation }],
    });
    expect(result._tag).toBe('Success');
    if (result._tag === 'Success') {
      expect(result.success).toEqual(Option.some({ principalId: legacyId, bindingIncarnation: incarnation }));
    }
    expect(statements).toHaveLength(1);
  }),
);

it.effect('does not hide ambiguous legacy enrollment behind a service candidate', () =>
  Effect.gen(function* test() {
    const { result, statements } = yield* run({
      workloadKey: 'party.registry.source-write',
      systems: [
        { principalId: legacyId, bindingIncarnation: incarnation },
        { principalId: legalEntityId, bindingIncarnation: incarnation },
      ],
    });
    expect(result._tag).toBe('Failure');
    expect(statements).toHaveLength(1);
  }),
);

it.effect('never widens unrelated jobs or tenant-only source requests to service principals', () =>
  Effect.gen(function* test() {
    for (const input of [
      { workloadKey: 'integration.symmy.execute-symmy-job' },
      { workloadKey: 'party.registry.source-write', company: false },
      { workloadKey: 'commerce.customer-context.source-read' },
    ]) {
      const { result, statements } = yield* run(input);
      expect(result._tag).toBe('Success');
      if (result._tag === 'Success') {
        expect(result.success).toEqual(Option.none());
      }
      expect(statements).toHaveLength(1);
    }
  }),
);

it.effect('returns no enrollment when the exact active company service binding is absent', () =>
  Effect.gen(function* test() {
    const { result, statements } = yield* run({ workloadKey: 'party.registry.source-write' });
    expect(result._tag).toBe('Success');
    if (result._tag === 'Success') {
      expect(result.success).toEqual(Option.none());
    }
    expect(statements).toHaveLength(2);
  }),
);
