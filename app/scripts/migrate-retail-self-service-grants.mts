#!/usr/bin/env node
import type { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { Console, Effect, Exit, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { RETAIL_PORTAL_SELF_SERVICE_BASELINE } from '../verticals/commerce-customer-context/shared/domain/profile-contracts.ts';
import { BusinessPermissionCodeSchema } from '../packages/core-runtime/src/permissions/business-permission.ts';
import { loadSpiceDbConfig } from '../packages/core-runtime/src/permissions/config.ts';
import { migrateRetailSelfServiceGrant } from '../packages/core-runtime/src/permissions/business-permission-mutation.ts';
import { newSpiceDbGrpcClient } from '../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';

const migrationScopeSchema = Schema.Struct({
  legalEntityId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId')),
  principalId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrincipalId')),
  profileId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('RetailProfileId')),
  tenantId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId')),
});

/** One-time graph migration, not an enrollment retry: move only an existing exact native grant. */
const migrateRetailSelfServiceGrants = Effect.fn('migrateRetailSelfServiceGrants')(
  function* migrateRetailSelfServiceGrantsEffect(
    client: v1.ZedClientInterface,
    scope: typeof migrationScopeSchema.Encoded,
    apply: boolean,
  ) {
    const verified = yield* Schema.decodeEffect(migrationScopeSchema)(scope);
    let existing = 0;
    let migrated = 0;
    for (const code of RETAIL_PORTAL_SELF_SERVICE_BASELINE) {
      const permission = yield* Schema.decodeEffect(BusinessPermissionCodeSchema)(code);
      const result = yield* migrateRetailSelfServiceGrant(
        client.promises,
        {
          operation: 'grant',
          permission,
          principal: { principalId: verified.principalId, tenantId: verified.tenantId },
          target: {
            kind: 'retail_profile',
            legalEntityId: verified.legalEntityId,
            profileId: verified.profileId,
            tenantId: verified.tenantId,
          },
        },
        apply,
      );
      existing += result.existing;
      migrated += result.migrated;
    }
    return { existing, migrated };
  },
);

const command = Command.make(
  'migrate-retail-self-service-grants',
  {
    apply: Flag.Boolean('apply'),
    legalEntityId: Flag.String('legal-entity-id'),
    principalId: Flag.String('principal-id'),
    profileId: Flag.String('profile-id'),
    tenantId: Flag.String('tenant-id'),
  },
  ({ apply, ...scope }) =>
    Effect.scoped(
      Effect.gen(function* migrate() {
        const configuration = yield* loadSpiceDbConfig();
        const client = yield* Effect.acquireRelease(
          Effect.sync(() => newSpiceDbGrpcClient(configuration)),
          (resource) => Effect.sync(() => resource.close()),
        );
        const result = yield* migrateRetailSelfServiceGrants(client, scope, apply);
        yield* Console.log(
          `retail self-service migration: apply=${apply}; existing=${result.existing}; migrated=${result.migrated}`,
        );
      }),
    ),
);

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.tapError(() =>
        Console.error('Retail self-service grant migration failed; no credential values are logged'),
      ),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
