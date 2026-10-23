import { StageAccountsFileSchema } from '@app/core-runtime/install/stage-accounts-file';
import type { SpiceDbConfigValue } from '../../packages/core-runtime/src/permissions/config.ts';
import { Config, Effect, FileSystem, Path, Redacted, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import { verificationAccount, verificationContext } from './verification-context.mts';

export class StageVerificationBootstrapError extends Schema.TaggedError<StageVerificationBootstrapError>()(
  'StageVerificationBootstrapError',
  { reason: Schema.String },
) {}

/** Native stage installer input, never the development fixture or a customer tenant. */
export const stageVerificationAccounts = Effect.fn('Stage.verificationAccounts')(function* stageVerificationAccounts(
  password: Redacted.Redacted,
) {
  const context = yield* verificationContext();
  const [module] = context.modules;
  if (module === undefined) {
    return yield* new StageVerificationBootstrapError({ reason: 'Verification module is required' });
  }
  return {
    retiredAccountEmails: [],
    retiredTenants: [],
    schemaVersion: 2 as const,
    tenants: [
      {
        accounts: [
          {
            authBindingId: verificationAccount.authBindingId,
            displayName: verificationAccount.displayName,
            email: verificationAccount.email,
            grants: { explicitActions: ['work.tasks.apply-command'], tenantRelations: [] },
            password: Redacted.value(password),
            principalId: verificationAccount.principalId,
          },
        ],
        defaultLocale: context.tenant.defaultLocale,
        displayName: context.tenant.displayName,
        legalEntity: context.legalEntity,
        moduleKey: module.moduleId,
        moduleStateId: module.stateId,
        slug: context.tenant.slug,
        tenantId: context.tenant.tenantId,
      },
    ],
  } as const;
});

/** Reuses the guarded stage Better Auth/Core installer; the scoped 0600 file is removed on every exit. */
export const ensureStageVerification = Effect.fn('Stage.ensureVerification')(function* ensureStageVerification(
  configuration: SpiceDbConfigValue,
) {
  if (
    configuration.deploymentEnvironment !== 'stage' ||
    configuration.endpoint !== 'spicedb:50051' ||
    configuration.caCertificate === undefined
  ) {
    return yield* new StageVerificationBootstrapError({
      reason: 'Verification bootstrap requires native private stage authorization',
    });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const password = yield* Config.Redacted('E2E_PASSWORD').pipe(Config.withDefault(Redacted.make('password1234')));
  const contents = yield* stageVerificationAccounts(password).pipe(
    Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(Schema.toEncoded(StageAccountsFileSchema)))),
  );
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-stage-verification-' });
  const file = path.join(directory, 'accounts.json');
  yield* fs.writeFileString(file, contents, { mode: 0o600 });
  const root = new URL('../..', import.meta.url).pathname;
  const code = yield* spawner.exitCode(
    ChildProcess.make(
      process.execPath,
      [path.join(root, 'apps/shell-super-app/scripts/bootstrap-stage-accounts.mts')],
      {
        cwd: root,
        env: {
          ONTOS_STAGE_ACCOUNTS_FILE: file,
          SPICEDB_CA_CERT: configuration.caCertificate,
          SPICEDB_ENDPOINT: configuration.endpoint,
          SPICEDB_PRESHARED_KEY: configuration.preSharedKey,
          ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
        },
        extendEnv: true,
        stderr: 'inherit',
        stdin: 'ignore',
        stdout: 'inherit',
      },
    ),
  );
  if (code !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new StageVerificationBootstrapError({ reason: 'Native stage verification account bootstrap failed' });
  }
  return yield* Effect.void;
});
