#!/usr/bin/env node
/** LOCAL ONLY: repair explicit tenant/company administrator roles, without reseeding identities or data. */
import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Schema } from 'effect';

import { bootstrapRelationshipRequest } from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import type { BootstrapRelationship } from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import {
  demoId,
  demoTenantId,
  demoLegalEntityId,
  rentalDemoLegalEntityId,
  crmDemoLegalEntityId,
  eshopDemoLegalEntityId,
  akrosDemoLegalEntityId,
} from './fixture-ids.mts';
import { principalRelationships } from './permissions.mts';

const principalResource = 'core.principal';

class AdministratorRepairError extends Schema.TaggedError<AdministratorRepairError>()('AdministratorRepairError', {
  reason: Schema.String,
}) {}

export const administrators = [
  { legalEntityId: demoLegalEntityId, principalId: demoId(principalResource, 'obchod'), tenantRole: 'superadmin' },
  { legalEntityId: rentalDemoLegalEntityId, principalId: '72000000-0000-4000-8000-000000000021' },
  { legalEntityId: crmDemoLegalEntityId, principalId: demoId(principalResource, 'hanak-spravce') },
  { legalEntityId: eshopDemoLegalEntityId, principalId: demoId(principalResource, 'kavarna-eshop') },
  { legalEntityId: akrosDemoLegalEntityId, principalId: demoId(principalResource, 'akros-eshop') },
] as const;

export const administratorRelationships = (): readonly BootstrapRelationship[] =>
  administrators.flatMap((account) =>
    principalRelationships(
      account.principalId,
      'tenantRole' in account
        ? { companyRole: 'admin', label: 'Explicit administrator', modules: {}, tenantRole: account.tenantRole }
        : { companyRole: 'admin', label: 'Explicit administrator', modules: {} },
      [],
      account.legalEntityId,
      demoTenantId,
      'account-administration',
    ),
  );

/** No read_all, Action grant, or workforce dependency: task owners return only assigned work. */
export const ownTaskRelationships = (): readonly BootstrapRelationship[] =>
  ['72000000-0000-4000-8000-000000000023', '72000000-0000-4000-8000-000000000024'].flatMap((principalId) =>
    principalRelationships(
      principalId,
      {
        label: 'Assigned task reader',
        modules: { 'work.tasks': 'read' },
        restrictedModules: ['work.tasks'],
      },
      [],
      rentalDemoLegalEntityId,
      demoTenantId,
      'assigned-task-reader',
    ),
  );

export const repairAdministratorRelationships = Effect.fn('Demo.repairAdministratorRelationships')(
  function* repairAdministratorRelationships(relationships: readonly BootstrapRelationship[]) {
    const configuration = yield* loadSpiceDbConfig({
      envPath: yield* Config.String('ONTOS_DEMO_ENV_FILE').pipe(
        Config.withDefault(new URL('../../.env', import.meta.url).pathname),
      ),
    });
    if (
      configuration.deploymentEnvironment !== 'development' ||
      !/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/u.test(configuration.endpoint)
    ) {
      return yield* new AdministratorRepairError({ reason: 'Administrator repair requires local development SpiceDB' });
    }
    const client = yield* Effect.acquireRelease(
      Effect.try(() => openSpiceDbGrpcRpc(configuration, 5000)),
      (value) => Effect.sync(() => value.close()),
    );
    yield* client.writeRelationships(bootstrapRelationshipRequest(relationships));
    return yield* Effect.void;
  },
);

if (import.meta.main) {
  const program = Effect.gen(function* repairCompanyAdministrators() {
    const relationships = yield* Effect.try(() => [...administratorRelationships(), ...ownTaskRelationships()]);
    yield* repairAdministratorRelationships(relationships);
    yield* Console.log(
      `Administrator roles repaired (${relationships.length} relationships); no identities or data reset.`,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
  await Effect.runPromise(program);
}
