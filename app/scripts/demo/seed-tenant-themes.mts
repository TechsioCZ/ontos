#!/usr/bin/env node
/**
 * Gives one demo tenant its theme (tenant-themes.mts) through the Shell's own Core Actions, as a tenant administrator:
 * save-tenant-theme stores the theme (Core runs the kit's brand validator), attach-tenant-theme makes the tenant wear
 * it. Without --apply it validates the theme, signs in and shows the tenant's current theme, and writes nothing.
 *
 *   export ONTOS_DEMO_SEED_URL=https://ontos-stage.web-revolution.cz
 *   export ONTOS_DEMO_SEED_TENANT_ID=bceaa540-13eb-5508-9ac0-9ed7e40a2ee9      # AKROS
 *   export ONTOS_DEMO_SEED_LEGAL_ENTITY_ID=c0c78a3e-6e2a-57e0-9d0d-86253499fee7
 *   export ONTOS_DEMO_SEED_EMAIL=<tenant administrator>
 *   read -r -s -p 'Password: ' ONTOS_DEMO_SEED_PASSWORD; export ONTOS_DEMO_SEED_PASSWORD
 *   mise exec -- pnpm demo:seed:themes [--apply]
 *
 * The password is never printed. Rerunning is safe: saving the same theme replaces it, attaching it again keeps it.
 */
import { NodeServices } from '@effect/platform-node';
import {
  AttachTenantThemePayloadSchema,
  SaveTenantThemeResultSchema,
  TenantThemeDefinitionSchema,
  TenantThemeRequestSchema,
  TenantThemeResponseSchema,
} from '@app/core-runtime/themes/contract';
import { validateBrand } from '@techsio/ui-kit/theme/brand-validator';
import { Config, Console, Effect, Exit, FileSystem, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import { connectSeedClient, DemoSeedError, validateSeedTarget } from './seed-client.mts';
import { seedCheckpointDirectory, seedWriteCheckpoint } from './seed-checkpoint.mts';
import { demoTenantThemes } from './tenant-themes.mts';

const configuration = Config.all({
  email: Config.String('ONTOS_DEMO_SEED_EMAIL'),
  legalEntityId: Config.String('ONTOS_DEMO_SEED_LEGAL_ENTITY_ID'),
  password: Config.Redacted('ONTOS_DEMO_SEED_PASSWORD'),
  shellUrl: Config.String('ONTOS_DEMO_SEED_URL'),
  tenantId: Config.String('ONTOS_DEMO_SEED_TENANT_ID'),
});

const main = (apply: boolean) =>
  Effect.gen(function* seedTenantTheme() {
    const { email, password, ...configuredTarget } = yield* configuration;
    const origin = yield* validateSeedTarget(configuredTarget);
    const target = { ...configuredTarget, shellUrl: origin };
    const theme = demoTenantThemes[target.tenantId];
    if (theme === undefined) {
      return yield* new DemoSeedError({
        reason: `Tenant ${target.tenantId} has no demo theme; it wears the default Business brand.`,
      });
    }
    const validation = validateBrand(theme);
    if (!validation.ok) {
      return yield* new DemoSeedError({
        reason: `Theme ${theme.key} fails the kit's brand validator: ${validation.errors.join('; ')}`,
      });
    }
    const payload = yield* Schema.decodeUnknownEffect(TenantThemeDefinitionSchema)(validation.brand);
    const fs = yield* FileSystem.FileSystem;
    const root = yield* Config.String('ONTOS_DEMO_SEED_CHECKPOINT_DIR').pipe(Config.withDefault('.scratch/demo-seed'));
    const directory = seedCheckpointDirectory(target, root);
    if (apply) {
      yield* fs.makeDirectory(directory, { mode: 0o700, recursive: true });
    }
    const client = yield* connectSeedClient(target, email, password, seedWriteCheckpoint(fs, directory));
    const readTheme = client.coreRead('tenant-theme', TenantThemeRequestSchema, {}, TenantThemeResponseSchema);
    const before = yield* readTheme;
    yield* Console.log(`Tenant ${target.tenantId} wears ${before.theme.key} (revision ${before.revision}).`);
    if (!apply) {
      yield* Console.log(
        `Theme ${theme.key} passes the kit's brand validator. No data changed; run with --apply to save and attach it.`,
      );
      return yield* client.signOut;
    }
    const saved = yield* client.coreAction(
      'save-tenant-theme',
      TenantThemeDefinitionSchema,
      payload,
      SaveTenantThemeResultSchema,
    );
    const attachment = yield* Schema.decodeUnknownEffect(AttachTenantThemePayloadSchema)({ themeKey: saved.themeKey });
    yield* client.coreAction(
      'attach-tenant-theme',
      AttachTenantThemePayloadSchema,
      attachment,
      AttachTenantThemePayloadSchema,
    );
    const after = yield* readTheme;
    yield* client.signOut;
    if (after.theme.key !== theme.key) {
      return yield* new DemoSeedError({
        reason: `Tenant still wears ${after.theme.key} after attaching ${theme.key}.`,
      });
    }
    return yield* Console.log(`Tenant ${target.tenantId} now wears ${after.theme.key} (revision ${after.revision}).`);
  });

const command = Command.make(
  'tenant-theme-seed',
  { apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)) },
  ({ apply }) =>
    main(apply).pipe(
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(DemoSeedError)(failure)
            ? failure.reason
            : `Theme seed stopped (${failure._tag}); configuration, credentials and response bodies are not logged.`,
        ),
      ),
    ),
);

if (import.meta.main) {
  const runtime = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );
  const result = await Effect.runPromiseExit(Effect.scoped(Layer.build(runtime)));
  process.exitCode = Exit.isFailure(result) ? 1 : 0;
}
