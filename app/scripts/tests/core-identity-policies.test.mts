import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { NodeServices } from '@effect/platform-node';
import { is } from 'drizzle-orm';
import { getTableConfig, PgPolicy, PgTable } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Config, Effect, FileSystem, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { makeCoreMigrationSchema } from '../../database/core-schema.ts';
import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../../database/identity-enrollment.ts';
import { defineDatabaseIdentityEnrollment } from '../../packages/core-runtime/src/db/database-identity-manifest.ts';
import type { DatabaseOwnerIdentityDescriptor } from '../../packages/core-runtime/src/db/database-identity-manifest.ts';
import { makeCoreIdentityPolicies } from '../../packages/core-runtime/src/db/identity-policies.ts';
import { coreDatabaseSchema } from '../../packages/core-runtime/src/db/schema.ts';

const fixtureOwner = (prefix: string): DatabaseOwnerIdentityDescriptor => ({
  moduleKey: `fixture.${prefix}`,
  policyPrefix: prefix,
  request: {
    cloudflareHyperdrive: null,
    gatewayScopeAudiences: [`${prefix}-fixture`],
    handlesBearerAssertions: true,
    id: `${prefix}_request`,
    ownerModuleKey: `fixture.${prefix}`,
    registersGatewayScopeGrants: false,
    role: `${prefix}_runtime`,
    scopeAuthority: 'gateway_grant',
    urlKey: `${prefix.toUpperCase()}_DATABASE_URL`,
  },
  schemas: [`${prefix}_fixture`],
  worker: {
    cloudflareHyperdrive: null,
    gatewayScopeAudiences: [],
    handlesBearerAssertions: false,
    id: `${prefix}_worker`,
    ownerModuleKey: `fixture.${prefix}`,
    registersGatewayScopeGrants: false,
    role: `${prefix}_worker`,
    scopeAuthority: 'session_setting',
    urlKey: `${prefix.toUpperCase()}_WORKER_DATABASE_URL`,
  },
});

const enrollments = [
  { enrollment: APP_DATABASE_IDENTITY_ENROLLMENT, name: 'application', policyCount: 43 },
  { enrollment: defineDatabaseIdentityEnrollment([]), name: 'empty', policyCount: 11 },
  {
    enrollment: defineDatabaseIdentityEnrollment([fixtureOwner('stock'), fixtureOwner('orders')]),
    name: 'two unrelated owners',
    policyCount: 75,
  },
];

for (const { enrollment, name, policyCount } of enrollments) {
  it(`exposes the complete ${name} enrollment as top-level Drizzle policies without changing runtime tables`, () => {
    const migrationSchema = makeCoreMigrationSchema(enrollment);
    const policies = Object.values(migrationSchema).filter((value) => is(value, PgPolicy));
    const tables = Object.values(migrationSchema).filter((value) => is(value, PgTable));
    const descriptors = makeCoreIdentityPolicies(enrollment);

    expect(Object.isFrozen(migrationSchema)).toBe(true);
    expect(policies).toHaveLength(policyCount);
    expect(
      EffectArray.sort(
        policies.map((policy) => policy.name),
        Order.String,
      ),
    ).toEqual(
      EffectArray.sort(
        descriptors.map(({ policy }) => policy.name),
        Order.String,
      ),
    );
    for (const table of Object.values(coreDatabaseSchema)) {
      expect(tables).toContain(table);
    }
    for (const policy of policies) {
      const table = descriptors.find((candidate) => candidate.policy.name === policy.name)?.table;
      expect(table).toBeDefined();
      // Drizzle's standalone serializer reads this link rather than table extraConfig.
      expect(Object.getOwnPropertyDescriptor(policy, '_linkedTable')?.value).toBe(table);
    }
  });
}

const encodeSourceLiteral = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const DrizzleExportSchema = Schema.fromJsonString(
  Schema.Struct({ statements: Schema.Array(Schema.String), status: Schema.Literal('ok') }),
);
const migrationFactoryPath = fileURLToPath(new URL('../../database/core-schema.ts', import.meta.url));
const enrollmentFactoryPath = fileURLToPath(
  new URL('../../packages/core-runtime/src/db/database-identity-manifest.ts', import.meta.url),
);
const applicationSchemaPath = fileURLToPath(new URL('../../database/core-schema.cts', import.meta.url));
const drizzleBinPath = fileURLToPath(
  new URL('../../packages/core-runtime/node_modules/drizzle-kit/bin.cjs', import.meta.url),
);
const appRoot = fileURLToPath(new URL('../..', import.meta.url));

for (const { enrollment, name } of enrollments) {
  const fixtureSource = [
    `import { makeCoreMigrationSchema } from ${encodeSourceLiteral(migrationFactoryPath)};`,
    `import { defineDatabaseIdentityEnrollment } from ${encodeSourceLiteral(enrollmentFactoryPath)};`,
    `const enrollment = defineDatabaseIdentityEnrollment(${encodeSourceLiteral(enrollment.owners)});`,
    'export = makeCoreMigrationSchema(enrollment);',
  ].join('\n');
  it.live(`the installed Drizzle collector exports every ${name} policy through the native .cts module`, () =>
    Effect.gen(function* verifyDrizzlePolicyCollection() {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const temporaryRoot = yield* Config.String('OWNED_TEMP_DIR').pipe(Config.withDefault(tmpdir()));
      const directory = yield* fs.makeTempDirectoryScoped({ directory: temporaryRoot });
      const fixturePath = `${directory}/core-schema.cts`;
      yield* fs.writeFileString(fixturePath, fixtureSource);
      const sourcePath = name === 'application' ? applicationSchemaPath : fixturePath;
      const outputPath = `${directory}/drizzle-export.json`;
      // Drizzle exits before piped stdout drains; a regular file preserves the complete native export.
      // Positional arguments avoid shell interpolation, and explicit flags bypass DB/config discovery.
      const exitCode = yield* spawner.exitCode(
        ChildProcess.make(
          '/bin/sh',
          [
            '-c',
            'output=$1; shift; exec "$@" > "$output"',
            'drizzle-export',
            outputPath,
            process.execPath,
            drizzleBinPath,
            'export',
            '--dialect',
            'postgresql',
            '--schema',
            sourcePath,
            '--output',
            'json',
          ],
          {
            cwd: appRoot,
            env: { APP_ENV_PATH: '/dev/null', DOTENV_CONFIG_PATH: '/dev/null', JITI_FS_CACHE: 'false' },
            stderr: 'inherit',
          },
        ),
      );
      expect(exitCode).toBe(0);
      const output = yield* fs.readFileString(outputPath);
      const dump = yield* Schema.decodeUnknownEffect(DrizzleExportSchema)(output);
      const exportedPolicyNames = dump.statements.flatMap((statement) =>
        Object.values(/^CREATE POLICY "(?<policyName>[^"]+)"/u.exec(statement)?.groups ?? {}),
      );
      for (const { policy } of makeCoreIdentityPolicies(enrollment)) {
        expect(exportedPolicyNames.filter((candidate) => candidate === policy.name)).toEqual([policy.name]);
      }
      const expectedPolicies = [
        ...makeCoreIdentityPolicies(enrollment).map(({ policy }) => policy.name),
        ...Object.values(makeCoreMigrationSchema(enrollment))
          .filter((value) => is(value, PgTable))
          .flatMap((table) => getTableConfig(table).policies.map((policy) => policy.name)),
      ];
      expect(EffectArray.sort(exportedPolicyNames, Order.String)).toEqual(
        EffectArray.sort(expectedPolicies, Order.String),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
