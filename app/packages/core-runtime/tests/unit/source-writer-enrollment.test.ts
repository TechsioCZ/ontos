import { DateTime, Effect, Option, Result, Schema } from 'effect';
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
interface Enrollment {
  readonly bindingIncarnation: string;
  readonly principalId: string;
}

const run = (input: {
  readonly company?: boolean;
  readonly services?: readonly Enrollment[];
  readonly systems?: readonly Enrollment[];
  readonly workloadKey: string;
}) =>
  Effect.gen(function* readEnrollment() {
    const statements: { sql: string; values: readonly unknown[] }[] = [];
    const inputPrincipal = {
      authBindingId: '10000000-0000-4000-8000-000000000005',
      authContextRef: 'source-writer-enrollment-unit',
      authMethod: 'session',
      principalId: legacyId,
      tenantId,
    };
    const scope = {
      ...(yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(
        input.company === false ? inputPrincipal : { ...inputPrincipal, legalEntityId },
      )),
      correlationId: 'source-writer-enrollment-unit',
    };
    const database = yield* makeTestDatabase((sql, values) => {
      if (sql.includes("set_config('ontos.tenant_id'")) {
        return Effect.succeed([
          {
            legal_entity_id: scope.legalEntityId ?? '',
            operation_at: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-23T00:00:00Z')),
            role: 'ontos_runtime',
            tenant_id: tenantId,
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
      const principalId = internalWorkloadPrincipalId({ legalEntityId, tenantId, workloadKey });
      const { result, statements } = yield* run({
        services: [{ bindingIncarnation: incarnation, principalId }],
        workloadKey,
      });
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        expect(result.success).toEqual(Option.some({ bindingIncarnation: incarnation, principalId }));
      }
      expect(statements).toHaveLength(2);
      const [, service] = statements;
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
      company: false,
      systems: [{ bindingIncarnation: incarnation, principalId: legacyId }],
      workloadKey: nativeSourceWriters[0] ?? '',
    });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success).toEqual(Option.some({ bindingIncarnation: incarnation, principalId: legacyId }));
    }
    expect(statements).toHaveLength(1);
  }),
);

it.effect('does not hide ambiguous legacy enrollment behind a service candidate', () =>
  Effect.gen(function* test() {
    const { result, statements } = yield* run({
      systems: [
        { bindingIncarnation: incarnation, principalId: legacyId },
        { bindingIncarnation: incarnation, principalId: legalEntityId },
      ],
      workloadKey: 'party.registry.source-write',
    });
    expect(Result.isFailure(result)).toBe(true);
    expect(statements).toHaveLength(1);
  }),
);

it.effect('never widens unrelated jobs or tenant-only source requests to service principals', () =>
  Effect.gen(function* test() {
    for (const input of [
      { workloadKey: 'integration.symmy.execute-symmy-job' },
      { company: false, workloadKey: 'party.registry.source-write' },
      { workloadKey: 'commerce.customer-context.source-read' },
    ]) {
      const { result, statements } = yield* run(input);
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        expect(result.success).toEqual(Option.none());
      }
      expect(statements).toHaveLength(1);
    }
  }),
);

it.effect('returns no enrollment when the exact active company service binding is absent', () =>
  Effect.gen(function* test() {
    const { result, statements } = yield* run({ workloadKey: 'party.registry.source-write' });
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success).toEqual(Option.none());
    }
    expect(statements).toHaveLength(2);
  }),
);
