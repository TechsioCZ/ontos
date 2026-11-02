import path from 'node:path';

import { Effect, Schema } from 'effect';
import { parseDocument } from 'yaml';

import type { ApplicationMigrationPlan } from './application-migration-plan.mts';

export const MIGRATION_REQUIREMENTS_ENV = 'ONTOS_MIGRATION_REQUIREMENTS_FILE';
export const MIGRATION_VERIFY_ONLY_ENV = 'ONTOS_MIGRATION_VERIFY_ONLY';
export class ApplicationMigrationPublicationError extends Schema.TaggedError<ApplicationMigrationPublicationError>()(
  'ApplicationMigrationPublicationError',
  { reason: Schema.String },
) {}

/** Actual native pending SQL determines the existing fence path, independently of build selection. */
export const applicationMigrationPublicationMode = (
  plan: ApplicationMigrationPlan,
): 'none' | 'migrate' | 'verify-only' => {
  if (plan.owners.length === 0) {
    return 'none';
  }
  return plan.owners.some((owner) => owner.pendingMigrations.length > 0) ? 'migrate' : 'verify-only';
};
const ProviderYamlSchema = Schema.Struct({
  zerops: Schema.Array(
    Schema.Struct({
      build: Schema.optionalKey(Schema.Struct({ deployFiles: Schema.Array(Schema.NonEmptyString) })),
      run: Schema.optionalKey(Schema.Struct({ start: Schema.NonEmptyString })),
      setup: Schema.NonEmptyString,
    }),
  ),
});

/** Edit a deployment COPY only, preserving other setups, target environment, credentials, and runtime command. */
export const materializeApplicationMigrationProvider = Effect.fn('ApplicationMigrationPublication.materializeProvider')(
  function* materializeApplicationMigrationProviderEffect(
    source: string,
    input: { readonly intentFile: string; readonly verifyOnly: boolean },
  ) {
    const normalized = path.posix.normalize(input.intentFile);
    if (
      path.posix.isAbsolute(normalized) ||
      normalized !== input.intentFile ||
      normalized === '..' ||
      normalized.startsWith('../')
    ) {
      return yield* new ApplicationMigrationPublicationError({
        reason: 'The reviewed migration intent must be an application-relative packaged file',
      });
    }
    const document = parseDocument(source);
    if (document.errors.length > 0) {
      return yield* new ApplicationMigrationPublicationError({ reason: 'Invalid migration provider YAML' });
    }
    const decoded = yield* Schema.decodeUnknownEffect(ProviderYamlSchema)(document.toJSON()).pipe(
      Effect.mapError(
        () => new ApplicationMigrationPublicationError({ reason: 'Invalid migration provider configuration' }),
      ),
    );
    const candidates = decoded.zerops
      .map((setup, index) => ({ index, setup }))
      .filter(({ setup }) => setup.setup === 'migrator');
    const [candidate] = candidates;
    if (
      candidates.length !== 1 ||
      candidate === undefined ||
      candidate.setup.build === undefined ||
      candidate.setup.run === undefined ||
      !candidate.setup.run.start.includes('scripts/run-zerops-migrator.mjs')
    ) {
      return yield* new ApplicationMigrationPublicationError({
        reason: 'Expected exactly one configured native migration provider',
      });
    }
    const packagedFile = `app/${normalized}`;
    if (
      !candidate.setup.build.deployFiles.some(
        (entry) => entry === packagedFile || packagedFile.startsWith(`${entry.replace(/\/$/u, '')}/`),
      )
    ) {
      return yield* new ApplicationMigrationPublicationError({
        reason: 'The reviewed migration intent is not included in the supplied provider artifact',
      });
    }
    const variables = ['zerops', candidate.index, 'run', 'envVariables'];
    document.setIn([...variables, MIGRATION_REQUIREMENTS_ENV], normalized);
    document.setIn([...variables, MIGRATION_VERIFY_ONLY_ENV], input.verifyOnly ? 'true' : 'false');
    return document.toString({ lineWidth: 0 });
  },
);
