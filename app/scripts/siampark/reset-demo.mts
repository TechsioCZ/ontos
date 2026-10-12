import { NodeServices } from '@effect/platform-node';
import { counterpartyResourceDescriptor } from '@app/party-registry/resources/counterparty';
import { toSpiceDbActionObjectId } from '@app/core-runtime/actions/runtime-wiring';
import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from '@app/core-runtime';
import { Config, ConfigProvider, Console, Effect, Exit, FileSystem, Layer, Path, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { Command, Flag } from 'effect/unstable/cli';

import {
  demoAccounts,
  demoId,
  demoLegalEntityId,
  demoOwnerPorts,
  demoSearchDocuments,
  AccountsFixtureSchema,
  ContextFixtureSchema,
  PartyFixtureSchema,
  encodeOperatorFixture,
  demoRef,
  demoTenantId,
  partyFixture,
} from './fixtures.mts';
import type { Relationship } from './fixtures.mts';
import { resetChildEnvironment, resetEnvironment, validateResetEnvironment } from './reset-configuration.mts';

class DemoResetError extends Schema.TaggedError<DemoResetError>()('DemoResetError', { reason: Schema.String }) {}
const workModuleId = 'siampark.work';
const relationshipsModuleId = 'siampark.relationships';
const financeModuleId = 'siampark.billing-finance';
const partyModuleId = 'party.registry';
const moduleIds = [
  partyModuleId,
  'siampark.property',
  'siampark.occupancy',
  'siampark.agreements',
  workModuleId,
  financeModuleId,
  relationshipsModuleId,
] as const;
type AddRelationship = (
  resourceType: string,
  resourceId: string,
  relation: string,
  subjectType: string,
  subjectId: string,
) => number;
const actionModulesFor = (index: number): readonly string[] => {
  if (index === 1) {
    return moduleIds.filter((moduleId) => moduleId !== partyModuleId);
  }
  if (index === 2) {
    return [financeModuleId];
  }
  return [];
};
const addPermissionRelationships = (add: AddRelationship, index: number, principalId: string) => {
  for (const moduleId of [workModuleId, relationshipsModuleId]) {
    for (const permission of ['read_all', 'write_all']) {
      const objectId =
        toContextPermissionAccessObjectId(demoTenantId, demoLegalEntityId, {
          moduleId,
          permission: `${moduleId}.${permission}`,
        }) ?? '';
      add('context_permission', objectId, 'tenant', 'tenant', demoTenantId);
      if ((permission === 'read_all' && index < 3) || (permission === 'write_all' && index === 1)) {
        add('context_permission', objectId, 'grantee', 'principal', principalId);
      }
    }
  }
};
const addActionRelationships = (add: AddRelationship, index: number, principalId: string) => {
  const actions = actionModulesFor(index);
  for (const moduleId of actions) {
    const actionKey = `${moduleId}.apply-command`;
    const action = toSpiceDbActionObjectId(actionKey);
    add('action', action, 'restriction', 'action', action);
    add('action', action, 'executor', 'principal', principalId);
  }
};
const relationships = (): readonly Relationship[] => {
  const result: Relationship[] = [];
  const add = (resourceType: string, resourceId: string, relation: string, subjectType: string, subjectId: string) =>
    result.push({ relation, resourceId, resourceType, subjectId, subjectType });
  const legal = toLegalEntityAccessObjectId(demoTenantId, demoLegalEntityId) ?? '';
  add('legal_entity', legal, 'tenant', 'tenant', demoTenantId);
  for (const [index, account] of demoAccounts.entries()) {
    add('tenant', demoTenantId, 'member', 'principal', account.principalId);
    add('legal_entity', legal, 'member', 'principal', account.principalId);
    const shell = toModuleAccessObjectId(demoTenantId, demoLegalEntityId, 'core.shell') ?? '';
    add('module_access', shell, 'legal_entity', 'legal_entity', legal);
    add('module_access', shell, 'accessor', 'principal', account.principalId);
    if (index < 3) {
      add('tenant', demoTenantId, 'party_identity_reader', 'principal', account.principalId);
      add('legal_entity', legal, 'counterparty_reader', 'principal', account.principalId);
      for (const counterparty of partyFixture.counterparties) {
        const reference = {
          moduleId: partyModuleId,
          resourceId: counterparty.id,
          resourceType: counterpartyResourceDescriptor.key,
        };
        const resource = toResourceAccessObjectId(demoTenantId, demoLegalEntityId, reference) ?? '';
        add(
          'resource',
          resource,
          'module',
          'module_access',
          toModuleAccessObjectId(demoTenantId, demoLegalEntityId, partyModuleId) ?? '',
        );
        add('resource', resource, 'reader', 'principal', account.principalId);
      }
    }
    for (const moduleId of moduleIds) {
      const module = toModuleAccessObjectId(demoTenantId, demoLegalEntityId, moduleId) ?? '';
      add('module_access', module, 'legal_entity', 'legal_entity', legal);
      if (index < 3 || moduleId === partyModuleId || moduleId === workModuleId || moduleId === relationshipsModuleId) {
        add('module_access', module, 'accessor', 'principal', account.principalId);
      }
    }
    addPermissionRelationships(add, index, account.principalId);
    addActionRelationships(add, index, account.principalId);
  }
  for (const reference of [
    demoRef(workModuleId, 'task', 'task.external-agent-assigned'),
    demoRef(relationshipsModuleId, 'activity', 'activity.external'),
    demoRef(partyModuleId, 'counterparty', 'counterparty.b201'),
  ]) {
    const objectId = toResourceAccessObjectId(demoTenantId, demoLegalEntityId, reference) ?? '';
    add(
      'resource',
      objectId,
      'module',
      'module_access',
      toModuleAccessObjectId(demoTenantId, demoLegalEntityId, reference.moduleId) ?? '',
    );
    add('resource', objectId, 'reader', 'principal', demoAccounts[3].principalId);
  }
  return [
    ...new Map(
      result.map((relationship) => [
        [
          relationship.resourceType,
          relationship.resourceId,
          relationship.relation,
          relationship.subjectType,
          relationship.subjectId,
        ].join('|'),
        relationship,
      ]),
    ).values(),
  ];
};
const encodedPorts = Effect.gen(function* encodeDemoPortInputs() {
  const accounts = yield* encodeOperatorFixture(AccountsFixtureSchema, { accounts: demoAccounts });
  const context = yield* encodeOperatorFixture(ContextFixtureSchema, {
    accounts: demoAccounts,
    legalEntity: {
      legalEntityId: demoLegalEntityId,
      legalName: 'Siampark DEMO s.r.o.',
      registrationCountry: 'CZ',
      registrationNumber: 'DEMO-SIAMPARK',
    },
    modules: moduleIds.map((moduleId, index) => ({
      moduleId,
      stateId: `78000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    })),
    relationships: relationships(),
    searchDocuments: demoSearchDocuments,
    tenant: { defaultLocale: 'cs', displayName: 'Siampark DEMO', slug: 'siampark-demo', tenantId: demoTenantId },
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
const main = (validateOnly: boolean) =>
  Effect.gen(function* resetSiamparkDemo() {
    yield* Config.schema(Schema.Literal('development'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT').pipe(
      Config.withDefault('development'),
    );
    const ports = yield* encodedPorts;
    if (validateOnly) {
      return yield* Console.log(`Validated ${ports.length} typed demo fixture ports; no data changed.`);
    }

    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL('../..', import.meta.url));
    const fileProvider = yield* ConfigProvider.fromDotEnv({ path: path.join(root, '.env') });
    const provider = ConfigProvider.orElse(ConfigProvider.fromEnv(), fileProvider);
    const environment = yield* resetEnvironment.parse(provider);

    const childEnvironment = resetChildEnvironment(environment);
    yield* validateResetEnvironment(childEnvironment);
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'siampark-demo-' });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const run = Effect.fn('SiamparkDemo.runOwnerPort')(function* runOwnerPort(script: string, encodedFixture: string) {
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
      'Siampark baseline restored. Sign in as operations@siampark.demo; password1234. Business date: 2026-10-05.',
    );
  });
const reportFailure = Effect.fn('SiamparkDemo.reportFailure')(function* reportFailure(
  failure: Effect.Error<ReturnType<typeof main>>,
) {
  return yield* Console.error(`Siampark reset failed (${failure._tag}); inspect the failing owner port.`);
});
const command = Command.make(
  'siampark-demo-reset',
  { validateOnly: Flag.Boolean('validate-only').pipe(Flag.withDefault(false)) },
  ({ validateOnly }) => main(validateOnly).pipe(Effect.scoped, Effect.tapError(reportFailure)),
);
const runtimeLive = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(NodeServices.layer),
);
const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(runtimeLive)));
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
