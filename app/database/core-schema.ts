import type { PgPolicy } from 'drizzle-orm/pg-core';
import { Schema } from 'effect';

import type { DatabaseIdentityEnrollment } from '../packages/core-runtime/src/db/database-identity-manifest.ts';
import { makeCoreIdentityPolicies } from '../packages/core-runtime/src/db/identity-policies.ts';
import {
  coreDatabaseSchema,
  coreSchema,
  domainEventTenantSequence,
  emailDeliveries,
  emailSchema,
  emailSettings,
} from '../packages/core-runtime/src/db/schema.ts';

const CoreMigrationPolicyInvariantError = Schema.TaggedError<Error>()('CoreMigrationPolicyInvariantError', {
  message: Schema.String,
});

const baseMigrationExports = Object.freeze({
  ...coreDatabaseSchema,
  coreSchema,
  domainEventTenantSequence,
  emailDeliveries,
  emailSchema,
  emailSettings,
});

export type CoreMigrationExport = PgPolicy | (typeof baseMigrationExports)[keyof typeof baseMigrationExports];

/** Drizzle's top-level collector must receive every linked policy, for every enrolled owner. */
export const makeCoreMigrationSchema = (
  enrollment: DatabaseIdentityEnrollment,
): Readonly<Record<string, CoreMigrationExport>> => {
  const descriptors = makeCoreIdentityPolicies(enrollment);
  const policies: Record<string, PgPolicy> = Object.fromEntries(descriptors.map(({ policy }) => [policy.name, policy]));
  if (
    Object.keys(policies).length !== descriptors.length ||
    Object.keys(policies).some((name) => Object.hasOwn(baseMigrationExports, name))
  ) {
    throw new CoreMigrationPolicyInvariantError({ message: 'Core migration exports contain a duplicate name' });
  }
  // The tables are the runtime objects. Only the export record and newly linked policies are frozen.
  return Object.freeze({ ...baseMigrationExports, ...policies });
};
