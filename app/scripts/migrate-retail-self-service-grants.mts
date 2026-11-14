#!/usr/bin/env node
/**
 * Retail self-service grant migration: retired.
 *
 * The command moved an existing native `business_permission` grant for a Retail profile to the migration baseline.
 * Authorization v2 retired the business-permission mutation runtime (`ADR-0030`): a capability is a declared
 * `accessDeclaration`, and use comes from an adopted grant in an assigned Role within one scope. There is no graph
 * migration or import step, so this command refuses before it opens the engine and names the canonical replacement.
 */
import { NodeServices } from '@effect/platform-node';
import { Console, Effect, Exit, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

export class RetailSelfServiceMigrationError extends Schema.TaggedError<RetailSelfServiceMigrationError>()(
  'RetailSelfServiceMigrationError',
  { reason: Schema.String },
) {}

export const RETIRED_RETAIL_SELF_SERVICE_MIGRATION_REMEDIATION =
  'The legacy business_permission grant migration is retired by ADR-0030 and has no translation. Grant the retail self-service capability through a canonical Role and Assignment for the exact company scope, using the declaration key the module publishes.';

export const refuseRetiredRetailSelfServiceMigration = Effect.fail(
  new RetailSelfServiceMigrationError({
    reason: `The legacy retail self-service grant migration cannot run. ${RETIRED_RETAIL_SELF_SERVICE_MIGRATION_REMEDIATION}`,
  }),
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
  ({ apply }) =>
    Effect.gen(function* migrate() {
      yield* Console.error(
        `retail self-service migration: apply=${String(apply)}; the legacy graph migration is retired.`,
      );
      return yield* refuseRetiredRetailSelfServiceMigration;
    }),
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
