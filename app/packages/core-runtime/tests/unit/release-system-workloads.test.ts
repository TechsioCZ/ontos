import { NodeCrypto } from '@effect/platform-node';
import { Context, Effect, Layer, Predicate, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { AccessReleaseStoreLive } from '../../src/access/changes/persistence/drizzle-store.ts';
import { WorkloadKeySchema } from '../../src/authorization/access-declaration.ts';
import { registerSystemWorkload } from '../../src/auth/system-workload-registration.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../src/db/database-identities.ts';
import { enrollReleaseSystemWorkload } from '../../src/install/release-system-workloads.ts';
import type { ReleaseSystemWorkloadInput } from '../../src/install/release-system-workloads.ts';
import { OntosModuleDeploymentContractSchema } from '../../src/modules/manifest.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import { testCoreDatabase } from '../../src/testing/owner-evidence.ts';
import { scriptedPgClientLayer, testSqlConnection } from '../../src/testing/scripted-pg-client.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const workloadKey = WorkloadKeySchema.make('commerce.inventory.source-provision');
const registration = registerSystemWorkload({ jobKey: workloadKey });
const base = makeModuleContractFixture({ appId: 'inventory', moduleId: 'commerce.inventory' });
const contract = Schema.decodeUnknownSync(OntosModuleDeploymentContractSchema)({
  ...base,
  manifest: { ...base.manifest, systemWorkloads: [workloadKey] },
});
const input: ReleaseSystemWorkloadInput = {
  contract,
  declaredWorkloadKeys: [workloadKey],
  registration,
  runReference: '30000000-0000-4000-8000-000000000001',
  tenantId,
};
interface Holder {
  readonly bindingId: string;
  readonly bindingIncarnation: string;
  readonly principalId: string;
}
const fixture = (
  options: {
    readonly holders?: readonly Holder[];
    readonly inactiveModule?: boolean;
    readonly inactiveTenant?: boolean;
  } = {},
) => {
  let holders = [...(options.holders ?? [])];
  const statements: { readonly parameters: readonly unknown[]; readonly sql: string }[] = [];
  const connection = testSqlConnection((sql, parameters) => {
    statements.push({ parameters, sql });
    if (sql.includes('current_user')) {
      return Effect.succeed([{ legal_entity_id: '', role: 'ontos_runtime', tenant_id: tenantId }]);
    }
    if (sql.startsWith('select') && sql.includes('"platform_role"')) {
      return Effect.succeed([{ kind: 'system', platformRole: 'access_release_actor', status: 'active', tenantId }]);
    }
    if (sql.startsWith('select') && sql.includes('"kind"') && sql.includes('join "core"."tenants"')) {
      return Effect.succeed([{ kind: 'system', principalStatus: 'active', tenantStatus: 'active' }]);
    }
    if (sql.startsWith('select') && sql.includes('from "core"."tenants"')) {
      return Effect.succeed([{ status: options.inactiveTenant === true ? 'disabled' : 'active' }]);
    }
    if (sql.startsWith('select') && sql.includes('"tenant_module_states"')) {
      return Effect.succeed([{ state: options.inactiveModule === true ? 'read_only' : 'active' }]);
    }
    if (sql.startsWith('select') && sql.includes('"access_workload_bindings"')) {
      return Effect.succeed(
        holders.map(({ bindingId, bindingIncarnation, principalId: holderPrincipalId }) => ({
          bindingId,
          bindingIncarnation,
          principalId: holderPrincipalId,
        })),
      );
    }
    if (sql.startsWith('insert into "core"."principals"') && sql.includes('returning')) {
      return Effect.succeed([{ principalId }]);
    }
    if (sql.startsWith('insert into "core"."access_workload_bindings"')) {
      const ids = parameters.filter(
        (value): value is string =>
          Schema.is(Schema.String)(value) &&
          /^[0-9a-f-]{36}$/u.test(value) &&
          value !== tenantId &&
          value !== principalId,
      );
      const [bindingId, bindingIncarnation] = ids;
      if (bindingId === undefined || bindingIncarnation === undefined) {
        return Effect.die('Binding identifiers absent');
      }
      holders = [{ bindingId, bindingIncarnation, principalId }];
    }
    return Effect.succeed([]);
  });
  const dbLayer = Layer.effect(CoreDatabase, testCoreDatabase.pipe(Effect.map((executor) => ({ executor })))).pipe(
    Layer.provide(scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer))),
  );
  const layer = AccessReleaseStoreLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        dbLayer,
        NodeCrypto.layer,
        Layer.succeed(DatabaseIdentityEnrollmentContext, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
      ),
    ),
  );
  const enroll = (value: ReleaseSystemWorkloadInput = input) =>
    Effect.gen(function* enrollActualNativeLifecycle() {
      const context = yield* Layer.build(layer);
      const { executor } = Context.get(context, CoreDatabase);
      return yield* enrollReleaseSystemWorkload(
        { enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT, executor },
        value,
      ).pipe(Effect.provideContext(context));
    }).pipe(Effect.scoped);
  return { enroll, statements };
};

it.effect(
  'enrolls and replays through native Core writers under the release actor, never an invocation or company alias',
  () =>
    Effect.gen(function* nativeEnrollment() {
      const current = fixture();
      const created = yield* current.enroll();
      expect(created).toMatchObject({
        outcome: 'ENROLLED',
        principalId,
        runReference: input.runReference,
        tenantId,
        workloadKey,
      });
      const repeated = yield* current.enroll();
      expect(repeated).toEqual({ ...created, outcome: 'ALREADY_ENROLLED' });
      expect(
        current.statements.filter(
          ({ sql }) => sql.startsWith('insert into "core"."principals"') && sql.includes('returning'),
        ),
      ).toHaveLength(1);
      expect(
        current.statements.filter(({ sql }) => sql.startsWith('insert into "core"."access_workload_bindings"')),
      ).toHaveLength(1);
      expect(current.statements.filter(({ sql }) => sql.startsWith('insert into "core"."audit_events"'))).toHaveLength(
        2,
      );
      expect(current.statements.some(({ sql }) => sql.includes('for no key update'))).toBe(true);
      expect(
        current.statements.some(({ sql }) =>
          /insert into.*(?:company_bindings|roles|assignments|action_invocations|outbox|auth_bindings)/u.test(sql),
        ),
      ).toBe(false);
    }),
);

it.effect('keeps a sole existing SYSTEM holder unchanged and refuses ambiguity atomically', () =>
  Effect.gen(function* existingEnrollments() {
    const holder = {
      bindingId: '40000000-0000-4000-8000-000000000001',
      bindingIncarnation: '40000000-0000-4000-8000-000000000002',
      principalId,
    };
    const existing = fixture({ holders: [holder] });
    expect(yield* existing.enroll()).toMatchObject({ ...holder, outcome: 'ALREADY_ENROLLED' });
    expect(existing.statements.some(({ sql }) => sql.startsWith('insert into "core"."access_workload_bindings"'))).toBe(
      false,
    );
    const ambiguous = fixture({
      holders: [holder, { ...holder, principalId: '20000000-0000-4000-8000-000000000002' }],
    });
    const ambiguity = yield* ambiguous.enroll().pipe(Effect.flip);
    expect(Predicate.isTagged(ambiguity, 'ReleaseSystemWorkloadEnrollmentError')).toBe(true);
    expect(ambiguity.reason).toContain('More than one');
    expect(ambiguous.statements.some(({ sql }) => sql === 'ROLLBACK')).toBe(true);
    expect(ambiguous.statements.some(({ sql }) => sql.startsWith('insert into "core"."audit_events"'))).toBe(false);
  }),
);

it.effect('requires a genuine owner registration, reviewed vocabulary and module declaration before any SQL', () =>
  Effect.gen(function* invalidDeclarations() {
    const other = makeModuleContractFixture({ appId: 'catalog', moduleId: 'commerce.catalog' });
    for (const value of [
      { ...input, declaredWorkloadKeys: [] },
      { ...input, contract: { ...contract, manifest: { ...contract.manifest, systemWorkloads: [] } } },
      { ...input, contract: { ...contract, manifest: { ...contract.manifest, module: other.manifest.module } } },
      { ...input, registration: { allowServicePrincipal: false, jobKey: workloadKey } },
      { ...input, registration: registerSystemWorkload({ allowServicePrincipal: true, jobKey: workloadKey }) },
      { ...input, runReference: 'not:a:run' },
    ]) {
      const current = fixture();
      expect(
        Predicate.isTagged(yield* current.enroll(value).pipe(Effect.flip), 'ReleaseSystemWorkloadEnrollmentError'),
      ).toBe(true);
      expect(current.statements).toEqual([]);
    }
  }),
);

it.effect('refuses inactive tenant or module before creating a receiver or binding', () =>
  Effect.gen(function* inactiveAuthority() {
    for (const options of [{ inactiveTenant: true }, { inactiveModule: true }]) {
      const current = fixture(options);
      expect(
        Predicate.isTagged(yield* current.enroll().pipe(Effect.flip), 'ReleaseSystemWorkloadEnrollmentError'),
      ).toBe(true);
      expect(
        current.statements.some(
          ({ sql }) => sql.startsWith('insert into "core"."principals"') && sql.includes('returning'),
        ),
      ).toBe(false);
      expect(
        current.statements.some(({ sql }) => sql.startsWith('insert into "core"."access_workload_bindings"')),
      ).toBe(false);
    }
  }),
);
