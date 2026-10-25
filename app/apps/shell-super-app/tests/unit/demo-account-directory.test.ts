import { makeEffectDrizzleAuthAdapter } from '@app/better-auth-effect-drizzle/server';
import { ReadRuntime } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { DateTime, Effect, Layer, Predicate, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';
import { expect, it } from 'effect-rstest';

import { scriptedPgClientLayer } from '../../../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../../../../packages/core-runtime/tests/support/sql-connection.ts';
import { AuthDatabase } from '../../api/auth/db/client.ts';
import { authDatabaseSchema, authRelations } from '../../api/auth/db/schema.ts';
import {
  BetterAuthStaffRoleTemplateAccountProviderLive,
  StaffAccountDirectoryLive,
} from '../../api/auth/db/staff-account-directory-live.ts';
import { StaffAccountDirectory } from '../../api/auth/db/staff-account-directory.ts';
import { companyRoleTemplates } from '../../api/auth/demo-accounts.ts';

const company = '71000000-0000-4000-8000-000000000021';
const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '00000000-0000-4000-8000-000000000005',
  authContextRef: 'better-auth-session:demo-role-template',
  authMethod: 'session',
  legalEntityId: company,
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
});
const caller = { legalName: 'Company', principal: { ...principal, legalEntityId: company } };
const transport = { correlationId: 'original-role-template-read' };
const emails = [
  'obchod@demo.ontos',
  'management@siampark.demo',
  'operations@siampark.demo',
  'obchodnik@demo.ontos',
  'finance@siampark.demo',
  'external@siampark.demo',
];
const retainedAccounts = emails.map((email, index) => ({ email, providerSubjectId: `retained-user-${index}` }));
const retainedBindings = retainedAccounts.map(({ providerSubjectId }, index) => ({
  principalId: `00000000-0000-4000-8000-00000000001${index}`,
  providerSubjectId,
}));
const fixture = (
  options: { readonly authOutage?: boolean; readonly denied?: boolean; readonly missing?: boolean } = {},
) =>
  Effect.gen(function* nativeDirectoryFixture() {
    const harness = yield* makeReadTestHarness({
      executeOwnerQuery: (query) => {
        expect(query.scope).toEqual({ legalEntityId: company, tenantId: principal.tenantId });
        expect(query.sql).toContain('"core"."principal_auth_bindings"');
        expect(query.sql).toContain('"core"."principals"');
        expect(query.sql).toContain('"core"."principal_company_memberships"');
        expect(query.sql).toContain('"authentication_namespace_id" =');
        expect(query.sql).toContain('"subject_type" =');
        expect(query.sql).toContain('"provider_subject_id" in');
        expect(query.sql).not.toContain('"auth".');
        expect(query.params).toContain(company);
        expect(query.params).toContain(principal.tenantId);
        expect(query.params).toContain('ontos.staff.better-auth.v1');
        expect(query.params).toContain('better-auth');
        expect(query.params).toContain('user');
        expect(query.params).toContain('human');
        expect(query.params.filter((value) => value === 'active')).toHaveLength(3);
        expect(query.params.filter((value) => Predicate.isString(value) && value.startsWith('retained-user-'))).toEqual(
          retainedAccounts.map((account) => account.providerSubjectId),
        );
        return Effect.succeed(retainedBindings);
      },
      operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-25T12:00:00.000Z')),
      ownerAuthorizationDecision: 'allowed',
      permissionDecision: options.denied === true ? 'denied' : 'allowed',
      scope: { ...caller.principal, correlationId: transport.correlationId },
    });
    const authQueries: string[] = [];
    const executor = yield* makeWithDefaults({ relations: authRelations }).pipe(
      Effect.provide(
        scriptedPgClientLayer(
          Effect.succeed(
            testSqlConnection((sql, params) => {
              authQueries.push(sql);
              expect(sql).toContain('"auth"."user"');
              expect(sql).not.toContain('"core".');
              expect(sql).not.toContain('join');
              expect(params).toEqual(emails);
              expect(harness.snapshot().stages).not.toContain('scope_installed');
              if (options.authOutage === true) {
                return Effect.fail(new SqlError({ reason: new ConnectionError({ cause: 'controlled Auth outage' }) }));
              }
              return Effect.succeed(options.missing === true ? [] : retainedAccounts);
            }),
          ),
        ).pipe(Layer.provideMerge(Reactivity.layer)),
      ),
    );
    const adapter = yield* makeEffectDrizzleAuthAdapter(executor, authDatabaseSchema);
    const directory = StaffAccountDirectoryLive.pipe(Layer.provide(Layer.succeed(AuthDatabase, { adapter, executor })));
    const provider = BetterAuthStaffRoleTemplateAccountProviderLive.pipe(Layer.provide(directory));
    const read = companyRoleTemplates(caller, transport).pipe(
      Effect.provideService(ReadRuntime, harness.runtime),
      Effect.provide(provider),
    );
    return { authQueries, directory, harness, read };
  });

it.effect('resolves six unchanged presets through retained Auth users then exact scoped active Core bindings', () =>
  Effect.gen(function* sixNativeRoleTemplates() {
    const test = yield* fixture();
    const templates = yield* test.read;
    expect(templates.map((role) => role.key)).toEqual([
      'spravce',
      'management',
      'operations',
      'sales',
      'finance',
      'external',
    ]);
    expect(templates.map((role) => role.label)).toEqual([
      'Správce',
      'Vedení',
      'Provoz',
      'Obchod',
      'Účetní',
      'Externí obchodník',
    ]);
    expect(templates.map((role) => role.templatePrincipalId)).toEqual(
      retainedBindings.map((binding) => binding.principalId),
    );
    expect(test.authQueries).toHaveLength(1);
    expect(test.harness.snapshot().ownerQueries).toHaveLength(1);
    expect(test.harness.snapshot().evidenceWrites).toBe(1);
    expect(test.harness.snapshot().statements.at(-1)).toBe('COMMIT');
  }),
);

it.effect('does not query Auth or Core owner tables before native company admission', () =>
  Effect.gen(function* deniedBeforeDirectory() {
    const test = yield* fixture({ denied: true });
    const failure = yield* test.read.pipe(Effect.flip);
    expect(Predicate.isTagged(failure, 'DemoAccountForbidden')).toBe(true);
    expect(test.authQueries).toEqual([]);
    expect(test.harness.snapshot().ownerQueries).toEqual([]);
    // Context denial has no verified scope in which to persist read evidence.
    expect(test.harness.snapshot().stages).not.toContain('scope_resolved');
    expect(test.harness.snapshot().evidenceWrites).toBe(0);
  }),
);

it.effect('does not fabricate a user ID or principal when a preset login has not been retained', () =>
  Effect.gen(function* missingRetainedUser() {
    const test = yield* fixture({ missing: true });
    expect(Predicate.isTagged(yield* test.read.pipe(Effect.flip), 'DemoAccountUnavailable')).toBe(true);
    expect(test.authQueries).toHaveLength(1);
    expect(test.harness.snapshot().ownerQueries).toEqual([]);
  }),
);

it.effect(
  'keeps an Auth directory outage typed without opening the Core owner transaction or returning partial roles',
  () =>
    Effect.gen(function* authDirectoryOutage() {
      const test = yield* fixture({ authOutage: true });
      expect(Predicate.isTagged(yield* test.read.pipe(Effect.flip), 'DemoAccountUnavailable')).toBe(true);
      expect(test.authQueries).toHaveLength(1);
      expect(test.harness.snapshot().ownerQueries).toEqual([]);
      expect(test.harness.snapshot().stages).not.toContain('scope_installed');
      expect(test.harness.snapshot().evidenceWrites).toBe(0);
    }),
);

it.effect('rejects an over-bound directory request before executing Auth SQL', () =>
  Effect.gen(function* boundedDirectory() {
    const test = yield* fixture();
    const error = yield* StaffAccountDirectory.pipe(
      Effect.flatMap((directory) => directory.lookup([...emails, 'another@example.invalid'])),
      Effect.provide(test.directory),
      Effect.flip,
    );
    expect(Predicate.isTagged(error, 'ReadHandlerUnavailable')).toBe(true);
    expect(test.authQueries).toEqual([]);
  }),
);
