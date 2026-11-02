import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';
import { parseDocument } from 'yaml';

import type { ApplicationMigrationPlan } from '../application-migration-plan.mts';
import {
  applicationMigrationPublicationMode,
  materializeApplicationMigrationProvider,
  MIGRATION_REQUIREMENTS_ENV,
  MIGRATION_VERIFY_ONLY_ENV,
} from '../application-migration-publication.mts';

const intentFile = 'topology/application-release-intent.json';
const provider = `zerops:
  - setup: migrator
    build:
      deployFiles:
        - app/scripts
        - app/topology
    run:
      start: cd app && node scripts/run-zerops-migrator.mjs
      envVariables:
        DATABASE_ADMIN_URL: original-admin-reference
        ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: production
  - setup: catalog
    run:
      start: unchanged-catalog-command
`;
const owner: ApplicationMigrationPlan['owners'][number] = {
  before: {
    catalogFingerprint: 'a'.repeat(64),
    entries: [],
    journalExists: false,
    journalName: '__drizzle_migrations_catalog',
    ownerId: 'catalog',
    schemaEvidence: 'absent',
    schemasPresent: [],
  },
  migrate: false,
  ownerId: 'catalog',
  pendingMigrations: [],
  verification: 'pending',
  verify: true,
};
const plan: ApplicationMigrationPlan = {
  initializationOwners: ['catalog'],
  mode: 'selected',
  owners: [owner],
  schemaVersion: 1,
};
it('uses no lock/deployment for empty selection and distinguishes actual pending DDL from verifier-only work', () => {
  expect(applicationMigrationPublicationMode({ ...plan, initializationOwners: [], mode: 'none', owners: [] })).toBe(
    'none',
  );
  expect(applicationMigrationPublicationMode(plan)).toBe('verify-only');
  expect(
    applicationMigrationPublicationMode({
      ...plan,
      owners: [
        { ...owner, migrate: true, pendingMigrations: [{ hash: 'b'.repeat(64), name: '20260101000000_catalog' }] },
      ],
    }),
  ).toBe('migrate');
});
it.effect(
  'materializes the reviewed file and categorical verify-only runtime guard without changing target or other services',
  () =>
    Effect.gen(function* materializedRuntimeGuard() {
      const materialized = yield* materializeApplicationMigrationProvider(provider, { intentFile, verifyOnly: true });
      const document = parseDocument(materialized);
      expect(document.getIn(['zerops', 0, 'run', 'envVariables', MIGRATION_REQUIREMENTS_ENV])).toBe(intentFile);
      expect(document.getIn(['zerops', 0, 'run', 'envVariables', MIGRATION_VERIFY_ONLY_ENV])).toBe('true');
      expect(document.getIn(['zerops', 0, 'run', 'envVariables', 'DATABASE_ADMIN_URL'])).toBe(
        'original-admin-reference',
      );
      expect(document.getIn(['zerops', 0, 'run', 'envVariables', 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'])).toBe(
        'production',
      );
      expect(document.getIn(['zerops', 1, 'run', 'start'])).toBe('unchanged-catalog-command');
      expect(document.getIn(['zerops', 0, 'run', 'start'])).toBe('cd app && node scripts/run-zerops-migrator.mjs');
      expect(provider).not.toContain(MIGRATION_REQUIREMENTS_ENV);
      const migration = yield* materializeApplicationMigrationProvider(provider, { intentFile, verifyOnly: false });
      expect(parseDocument(migration).getIn(['zerops', 0, 'run', 'envVariables', MIGRATION_VERIFY_ONLY_ENV])).toBe(
        'false',
      );
    }),
);
it.effect('rejects an unshipped custom reviewed intent and path escapes before deployment', () =>
  Effect.gen(function* rejectsMissingArtifact() {
    const unshipped = yield* materializeApplicationMigrationProvider(provider, {
      intentFile: 'release/custom-intent.json',
      verifyOnly: true,
    }).pipe(Effect.flip);
    expect(unshipped.reason).toBe('The reviewed migration intent is not included in the supplied provider artifact');
    const escaped = yield* materializeApplicationMigrationProvider(provider, {
      intentFile: '../custom-intent.json',
      verifyOnly: true,
    }).pipe(Effect.flip);
    expect(escaped.reason).toBe('The reviewed migration intent must be an application-relative packaged file');
  }),
);

it.effect('accepts the actual generated provider artifact and preserves its native runner command', () =>
  Effect.gen(function* actualGeneratedProvider() {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.readFileString(new URL('../../zerops.yaml', import.meta.url).pathname);
    const generated = yield* materializeApplicationMigrationProvider(source, { intentFile, verifyOnly: true });
    expect(generated).toContain(MIGRATION_REQUIREMENTS_ENV);
    expect(generated).toContain(MIGRATION_VERIFY_ONLY_ENV);
  }).pipe(Effect.provide(NodeServices.layer)),
);
