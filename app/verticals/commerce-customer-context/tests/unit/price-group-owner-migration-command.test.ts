import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

it.effect('keeps the temporal receiver on Party’s source-owned migration preparation and convergence path', () =>
  Effect.gen(function* nativePartyMigrationCommand() {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.readFileString(
      path.resolve(import.meta.dirname, '../support/price-group-current-receiver.fixture.ts'),
    );
    const partyBranchStart = source.indexOf("if (owner === 'party')");
    const partyBranch = source.slice(partyBranchStart, source.indexOf('const history =', partyBranchStart));
    expect(partyBranch).toContain("ChildProcess.make('pnpm', ['run', 'db:migrate']");
    expect(partyBranch).toContain('DATABASE_ADMIN_URL: Redacted.value(bootstrap.database.adminUrl)');
    expect(partyBranch).toContain('DATABASE_URL: Redacted.value(bootstrap.database.runtimeUrl)');
    expect(partyBranch).toContain("stderr: 'inherit'");
    expect(partyBranch).not.toContain('drizzle.contacts.config.ts');
    expect(partyBranch).not.toContain('prepare-contacts-migration.mts');
    const owner = yield* fs
      .readFileString(path.resolve(import.meta.dirname, '../../../party-registry/package.json'))
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Struct({ scripts: Schema.Struct({ 'db:migrate': Schema.String }) })),
          ),
        ),
      );
    expect(owner.scripts['db:migrate']).toBe('node ../../scripts/migration-convergence-cli.mts party');
  }).pipe(Effect.provide(NodeServices.layer)),
);
