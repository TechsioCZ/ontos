import { NodeServices } from '@effect/platform-node';
import { Config, ConfigProvider, Console, Effect, Exit, FileSystem, Layer, Path, Result, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { Command, Flag } from 'effect/cli';

import {
  demoAccounts,
  demoLegalEntityId,
  demoOwnerPorts,
  demoSearchDocuments,
  AccountsFixtureSchema,
  ContextFixtureSchema,
  PartyFixtureSchema,
  encodeOperatorFixture,
  demoTenantId,
  partyFixture,
  demoId,
} from './fixtures.mts';
import { readAccessCatalogArtifact } from '../authorization-catalog-artifact.mts';
import { resetChildEnvironment, resetEnvironment, validateResetEnvironment } from './reset-configuration.mts';
import { AccessCatalogModulesSchema } from '@app/core-runtime/access/catalog';
import type { AccessCatalogModule } from '@app/core-runtime';
import { policyReleaseEntries, policyRoleCellRows } from '../demo/access-policy.mts';
import type { PolicyCellRow, PolicyRole } from '../demo/access-policy.mts';
import { reviewedCompanyRole } from '../demo/reviewed-owner-role.mts';

class DemoResetError extends Schema.TaggedError<DemoResetError>()('DemoResetError', { reason: Schema.String }) {}
const workModuleId = 'work.tasks';
const relationshipsModuleId = 'crm.activities';
const financeModuleId = 'finance.billing';
const partyModuleId = 'party.registry';
/** Sales-demo MicroVerticals activated for the shared demo tenant (demo/sales-crm). */
const salesDemoModuleIds = [
  'demo.workforce',
  'demo.tagging',
  'demo.sales-pipeline',
  'demo.merchandise',
  'demo.sales-insights',
] as const;
const moduleIds = [
  partyModuleId,
  'property.portfolio',
  'property.leasing',
  'legal.agreements',
  workModuleId,
  financeModuleId,
  relationshipsModuleId,
  ...salesDemoModuleIds,
  // Customer segments (commerce customer groups). Kept last: module state ids derive from the index, and it has no
  // read_all/write_all context permissions, so it stays out of `salesDemoModuleIds`.
  'commerce.customer-context',
] as const;
/**
 * The reviewed Nájempark access policy, as canonical v2 intent (ADR-0030). The five accounts take part in
 * the demo company; their rights are Roles whose cells this seed compiles from the release it publishes, so
 * nothing here writes a SpiceDB relationship — the engine is a projection of this intent.
 */
/** Operations and provoz@ write the shared work; every other installed module stays readable to staff. */
const managementRoleKey = 'najempark-management';
const operationsRoleKey = 'najempark-operations';
const operationsStaffIndexes = new Set([1, 4]);
const operationsWriteModuleIds = [workModuleId, relationshipsModuleId, ...salesDemoModuleIds] as const;
const readModules = Object.fromEntries([...moduleIds, 'core.shell'].map((moduleId) => [moduleId, 'read' as const]));
const operationsModules = {
  ...readModules,
  ...Object.fromEntries(operationsWriteModuleIds.map((moduleId) => [moduleId, 'write' as const])),
};
/** The external salesperson reaches only the parties, work and activities their own records need. */
const externalModules = {
  'core.shell': 'read' as const,
  [partyModuleId]: 'read' as const,
  [relationshipsModuleId]: 'read' as const,
  [workModuleId]: 'read' as const,
};
const reviewedRoles = [
  {
    key: managementRoleKey,
    label: 'Vedení Nájempark',
    legalEntityId: demoLegalEntityId,
    policy: { label: 'Vedení Nájempark', modules: readModules },
    sourcePrincipalIds: [demoAccounts[0].principalId],
  },
  {
    key: operationsRoleKey,
    label: 'Provoz Nájempark',
    legalEntityId: demoLegalEntityId,
    policy: { label: 'Provoz Nájempark', modules: operationsModules },
    sourcePrincipalIds: [demoAccounts[1].principalId, demoAccounts[4].principalId],
  },
  {
    key: 'najempark-finance',
    label: 'Účetní Nájempark',
    legalEntityId: demoLegalEntityId,
    policy: { label: 'Účetní Nájempark', modules: readModules },
    sourcePrincipalIds: [demoAccounts[2].principalId],
  },
  {
    key: 'najempark-external',
    label: 'Externí obchodník',
    legalEntityId: demoLegalEntityId,
    policy: { label: 'Externí obchodník', modules: externalModules },
    sourcePrincipalIds: [demoAccounts[3].principalId],
  },
] as const satisfies readonly {
  readonly key: string;
  readonly label: string;
  readonly legalEntityId: string;
  readonly policy: PolicyRole;
  readonly sourcePrincipalIds: readonly [string, ...string[]];
}[];
const roleKeyForAccount = (index: number): string =>
  operationsStaffIndexes.has(index)
    ? operationsRoleKey
    : ([managementRoleKey, operationsRoleKey, 'najempark-finance', 'najempark-external', operationsRoleKey][index] ??
      managementRoleKey);
const sameCells = (left: readonly PolicyCellRow[], right: readonly PolicyCellRow[]): boolean =>
  left.length === right.length &&
  left.every(
    (cell, index) =>
      cell.capabilityKey === right[index]?.capabilityKey &&
      cell.mode === right[index]?.mode &&
      cell.selector === right[index]?.selector,
  );
export const reviewedSiamparkAccess = (accessModules: readonly AccessCatalogModule[]) => {
  const entries = policyReleaseEntries(accessModules, moduleIds);
  if (Result.isFailure(entries)) {
    return Result.fail(`The Nájempark release could not be built: ${entries.failure}`);
  }
  const wireModules = Schema.decodeUnknownResult(Schema.toEncoded(AccessCatalogModulesSchema))(accessModules);
  if (Result.isFailure(wireModules)) {
    return Result.fail(wireModules.failure.message);
  }
  const roles = reviewedRoles.map(({ key, label, legalEntityId, policy, sourcePrincipalIds }) => {
    const cells = policyRoleCellRows(
      reviewedCompanyRole(policy, legalEntityId, { principalId: sourcePrincipalIds[0], tenantId: demoTenantId }),
      entries.success,
    );
    if (Result.isSuccess(cells)) {
      for (const principalId of sourcePrincipalIds.slice(1)) {
        const peer = policyRoleCellRows(
          reviewedCompanyRole(policy, legalEntityId, { principalId, tenantId: demoTenantId }),
          entries.success,
        );
        if (Result.isFailure(peer) || !sameCells(cells.success, peer.success)) {
          return Result.fail(`Reviewed shared Role ${key} does not have identical source authority for every holder`);
        }
      }
    }
    return Result.isFailure(cells)
      ? Result.fail(cells.failure)
      : Result.succeed({ cells: [...cells.success], key, label, legalEntityId });
  });
  const failures = roles.flatMap((role) => (Result.isFailure(role) ? [role.failure] : []));
  if (failures.length > 0) {
    return Result.fail(failures.join('; '));
  }
  return Result.succeed({
    assignments: demoAccounts.map((account, index) => ({
      legalEntityId: demoLegalEntityId,
      principalId: account.principalId,
      roleKey: roleKeyForAccount(index),
    })),
    legalEntityIds: [demoLegalEntityId],
    // Every account takes part in the demo company; the owner's own memberships come from the bootstrap.
    memberships: demoAccounts.map((account) => ({
      kind: 'member' as const,
      legalEntityId: demoLegalEntityId,
      principalId: account.principalId,
    })),
    modules: wireModules.success,
    roles: roles.flatMap((role) => (Result.isSuccess(role) ? [role.success] : [])),
    workloads: [],
  });
};
const encodedPorts = Effect.gen(function* encodeDemoPortInputs() {
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL('../..', import.meta.url));
  // The pinned declaration set: the seed compiles each reviewed Role's cells from the release it publishes.
  const accessModules = yield* readAccessCatalogArtifact(root);
  const accounts = yield* encodeOperatorFixture(AccountsFixtureSchema, { accounts: demoAccounts });
  const access = reviewedSiamparkAccess(accessModules);
  if (Result.isFailure(access)) {
    return yield* new DemoResetError({ reason: access.failure });
  }
  const context = yield* encodeOperatorFixture(ContextFixtureSchema, {
    access: access.success,
    accounts: demoAccounts,
    companyMemberships: [
      { affiliation: 'employee', legalEntityId: demoLegalEntityId, principalId: demoAccounts[0].principalId },
      { affiliation: 'employee', legalEntityId: demoLegalEntityId, principalId: demoAccounts[1].principalId },
      { affiliation: 'employee', legalEntityId: demoLegalEntityId, principalId: demoAccounts[2].principalId },
      { affiliation: 'external', legalEntityId: demoLegalEntityId, principalId: demoAccounts[3].principalId },
      { affiliation: 'employee', legalEntityId: demoLegalEntityId, principalId: demoAccounts[4].principalId },
    ],
    legalEntity: {
      legalEntityId: demoLegalEntityId,
      legalName: 'Nájempark DEMO s.r.o.',
      registrationCountry: 'CZ',
      registrationNumber: 'DEMO-NAJEMPARK',
    },
    modules: moduleIds.map((moduleId, index) => ({
      moduleId,
      stateId: `78000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    })),
    searchDocuments: demoSearchDocuments,
    tenant: { defaultLocale: 'cs', displayName: 'Nájempark DEMO', slug: 'siampark-demo', tenantId: demoTenantId },
  });
  const parties = yield* encodeOperatorFixture(PartyFixtureSchema, {
    invocationId: demoId('seed.invocation'),
    legalEntityId: demoLegalEntityId,
    principalId: demoAccounts[1].principalId,
    tenantId: demoTenantId,
    ...partyFixture,
  });
  const ownerPorts = yield* demoOwnerPorts;
  const ports = [
    { encodedFixture: accounts, script: 'apps/shell-super-app/scripts/reset-demo-accounts.mts' },
    { encodedFixture: context, script: 'packages/core-runtime/scripts/bootstrap-development-context.mts' },
    { encodedFixture: parties, script: 'verticals/party-registry/scripts/reset-siampark-demo.mts' },
    ...ownerPorts,
  ];
  return ports;
});
const resetNajemparkDemo = (validateOnly: boolean, configuration?: Readonly<Record<string, string>>) =>
  Effect.gen(function* resetDemoPorts() {
    yield* Config.schema(Schema.Literal('development'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT').pipe(
      Config.withDefault('development'),
    );
    const ports = yield* encodedPorts;
    if (validateOnly) {
      return yield* Console.log(`Validated ${ports.length} typed demo fixture ports; no data changed.`);
    }

    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL('../..', import.meta.url));
    const provider =
      configuration === undefined
        ? ConfigProvider.orElse(
            ConfigProvider.fromEnv(),
            yield* ConfigProvider.fromDotEnv({ path: path.join(root, '.env') }),
          )
        : ConfigProvider.fromUnknown(configuration);
    const environment = yield* resetEnvironment.parse(provider);

    const childEnvironment = { ...configuration, ...resetChildEnvironment(environment) };
    yield* validateResetEnvironment(childEnvironment);
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'siampark-demo-' });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const run = Effect.fn('NajemparkDemo.runOwnerPort')(function* runOwnerPort(script: string, encodedFixture: string) {
      const file = path.join(directory, `${script.split('/').join('-')}.json`);
      yield* fs.writeFileString(file, encodedFixture);
      const code = yield* spawner.exitCode(
        ChildProcess.make(process.execPath, [path.join(root, script), '--fixture', file], {
          cwd: root,
          env: { ...childEnvironment, MISE_ARGV0: '' },
          stderr: 'inherit',
          stdin: 'ignore',
          stdout: 'inherit',
        }),
      );
      if (code !== ChildProcessSpawner.ExitCode(0)) {
        return yield* new DemoResetError({ reason: `Owner fixture port failed: ${script}` });
      }
      return yield* Effect.void;
    });
    for (const port of ports) {
      yield* run(port.script, port.encodedFixture);
    }
    return yield* Console.log(
      'Nájempark baseline restored. Sign in as operations@najempark.demo; password1234. Business date: 2026-10-05.',
    );
  });
const reportFailure = Effect.fn('NajemparkDemo.reportFailure')(function* reportFailure(
  failure: Effect.Error<ReturnType<typeof resetNajemparkDemo>>,
) {
  return yield* Console.error(`Nájempark reset failed (${failure._tag}); inspect the failing owner port.`);
});
const command = Command.make(
  'siampark-demo-reset',
  { validateOnly: Flag.Boolean('validate-only').pipe(Flag.withDefault(false)) },
  ({ validateOnly }) => resetNajemparkDemo(validateOnly).pipe(Effect.scoped, Effect.tapError(reportFailure)),
);
const runtimeLive = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(NodeServices.layer),
);
if (import.meta.main) {
  const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(runtimeLive)));
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
