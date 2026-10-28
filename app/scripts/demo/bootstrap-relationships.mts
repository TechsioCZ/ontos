import { commercialDemoCompany } from '@app/core-runtime/demo-company-profiles';
import { Effect, FileSystem, Path, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import type { BootstrapRelationship } from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import type { DemoResetChildEnvironment } from '../siampark/reset-configuration.mts';
import { demoTenantId } from './fixture-ids.mts';

class DemoRelationshipBootstrapError extends Schema.TaggedError<DemoRelationshipBootstrapError>()(
  'DemoRelationshipBootstrapError',
  { reason: Schema.String },
) {}

const Text = Schema.String;
const RelationshipRepairFixtureSchema = Schema.Struct({
  accounts: Schema.Array(Schema.Never),
  legalEntity: Schema.Struct({
    legalEntityId: Schema.toEncoded(Text.pipe(Schema.brand('BootstrapLegalEntityId'))),
    legalName: Text,
    registrationCountry: Text,
    registrationNumber: Text,
  }),
  modules: Schema.Array(Schema.Never),
  relationships: Schema.Array(
    Schema.Struct({
      relation: Text,
      resourceId: Schema.toEncoded(Text.pipe(Schema.brand('BootstrapResourceId'))),
      resourceType: Text,
      subjectId: Schema.toEncoded(Text.pipe(Schema.brand('BootstrapSubjectId'))),
      subjectRelation: Schema.optionalKey(Text),
      subjectType: Text,
    }),
  ),
  tenant: Schema.Struct({
    defaultLocale: Text,
    displayName: Text,
    slug: Text,
    tenantId: Schema.toEncoded(Text.pipe(Schema.brand('BootstrapTenantId'))),
  }),
});

/** TOUCH-only relationship repair through Core's guarded local-development owner port. */
export const writeBootstrapRelationships = Effect.fn('Demo.writeBootstrapRelationships')(
  function* writeBootstrapRelationships(
    root: string,
    environment: DemoResetChildEnvironment,
    relationships: readonly BootstrapRelationship[],
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixture = yield* Schema.encodeEffect(Schema.fromJsonString(RelationshipRepairFixtureSchema))({
      accounts: [],
      legalEntity: {
        legalEntityId: commercialDemoCompany.legalEntityId,
        legalName: commercialDemoCompany.legalName,
        registrationCountry: 'CZ',
        registrationNumber: 'DEMO-SIAMPARK',
      },
      modules: [],
      relationships,
      tenant: { defaultLocale: 'cs', displayName: 'Nájempark DEMO', slug: 'siampark-demo', tenantId: demoTenantId },
    });
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'demo-relationships-' });
    const file = path.join(directory, 'context.json');
    yield* fs.writeFileString(file, fixture, { mode: 0o600 });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const code = yield* spawner.exitCode(
      ChildProcess.make(
        process.execPath,
        [path.join(root, 'packages/core-runtime/scripts/bootstrap-development-context.mts'), '--fixture', file],
        { cwd: root, env: { ...environment, MISE_ARGV0: '' }, stderr: 'inherit', stdin: 'ignore', stdout: 'inherit' },
      ),
    );
    if (code !== ChildProcessSpawner.ExitCode(0)) {
      return yield* new DemoRelationshipBootstrapError({ reason: 'Core development relationship bootstrap failed' });
    }
    return yield* Effect.void;
  },
);
