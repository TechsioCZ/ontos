import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem, Schedule, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { ownerVerifierPaths, verifyOwnerSchema } from '../verify-application-db-schema.mts';

it('retains all 29 owner verifiers including Projects and invokes Core through the application enrollment wrapper', () => {
  expect(ownerVerifierPaths).toHaveLength(29);
  expect(ownerVerifierPaths).toEqual([
    './verify-core-db-schema.mts',
    '../apps/shell-super-app/scripts/verify-auth-db-schema.mts',
    '../verticals/assortment/scripts/verify-db-schema.mts',
    '../verticals/party-registry/scripts/verify-db-schema.mts',
    '../verticals/party-registry/scripts/verify-engagement-db-schema.mts',
    '../verticals/payment-term-catalog/scripts/verify-db-schema.mts',
    '../verticals/price-group-catalog/scripts/verify-db-schema.mts',
    '../verticals/commerce-customer-context/scripts/verify-db-schema.mts',
    '../verticals/commerce-market-catalog/scripts/verify-db-schema.mts',
    '../verticals/catalog/scripts/verify-db-schema.mts',
    '../verticals/inventory/scripts/verify-db-schema.mts',
    '../verticals/pricing/scripts/verify-db-schema.mts',
    '../verticals/privacy/scripts/verify-db-schema.mts',
    '../verticals/legal-agreements/scripts/verify-db-schema.mts',
    '../verticals/finance-billing/scripts/verify-db-schema.mts',
    '../verticals/property-leasing/scripts/verify-db-schema.mts',
    '../verticals/property-portfolio/scripts/verify-db-schema.mts',
    '../verticals/crm-activities/scripts/verify-db-schema.mts',
    '../verticals/work-tasks/scripts/verify-db-schema.mts',
    '../verticals/workforce/scripts/verify-db-schema.mts',
    '../verticals/tagging/scripts/verify-db-schema.mts',
    '../verticals/crm/scripts/verify-db-schema.mts',
    '../verticals/sales-pipeline/scripts/verify-db-schema.mts',
    '../verticals/merchandise/scripts/verify-db-schema.mts',
    '../verticals/sales-insights/scripts/verify-db-schema.mts',
    '../verticals/facility-operations/scripts/verify-db-schema.mts',
    '../verticals/storefront-registry/scripts/verify-db-schema.mts',
    '../verticals/tax/scripts/verify-db-schema.mts',
    '../verticals/projects/scripts/verify-db-schema.mts',
  ]);
});

const ownerFixture = (source: string) =>
  Effect.gen(function* createOwnerFixture() {
    const fs = yield* FileSystem.FileSystem;
    const temporaryRoot = yield* Config.String('OWNED_TEMP_DIR').pipe(Config.withDefault(tmpdir()));
    const directory = yield* fs.makeTempDirectoryScoped({ directory: temporaryRoot });
    const file = path.join(directory, 'verify-owner.mjs');
    yield* fs.writeFileString(file, source);
    return { directory, file: pathToFileURL(file).href };
  });

it.effect('waits for asynchronous owner verification before reporting readiness', () =>
  Effect.gen(function* waitForOwner() {
    const fs = yield* FileSystem.FileSystem;
    const fixture = yield* ownerFixture(`
      import { writeFileSync } from 'node:fs';
      setTimeout(() => writeFileSync(new URL('./finished', import.meta.url), 'verified'), 30);
    `);

    yield* verifyOwnerSchema(fixture.file);

    expect(yield* fs.readFileString(path.join(fixture.directory, 'finished'))).toBe('verified');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('rejects a delayed owner exit-code failure instead of treating import completion as success', () =>
  Effect.gen(function* delayedOwnerFailure() {
    const fixture = yield* ownerFixture('setTimeout(() => { process.exitCode = 7; }, 30);');

    const failure = yield* Effect.flip(verifyOwnerSchema(fixture.file));

    expect(failure.reason).toContain('exited with code 7');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('keeps each owner exit status isolated from subsequent successful verifiers', () =>
  Effect.gen(function* isolatedOwnerFailures() {
    const failing = yield* ownerFixture('process.exitCode = 1;');
    const successful = yield* ownerFixture('process.exitCode = 0;');

    const failure = yield* Effect.flip(verifyOwnerSchema(failing.file));
    yield* verifyOwnerSchema(successful.file);

    expect(failure.reason).toContain('exited with code 1');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const verifierUrl = new URL('../verify-application-db-schema.mts', import.meta.url);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  it.live(`CLI ${signal} waits for the active owner verifier to exit`, () =>
    Effect.gen(function* cancelActiveOwner() {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fixture = yield* ownerFixture(`
        import { writeFileSync } from 'node:fs';
        process.once('SIGTERM', () => {
          setTimeout(() => {
            writeFileSync(new URL('./stopped', import.meta.url), 'finalized');
            process.exit(0);
          }, 50);
        });
        writeFileSync(new URL('./ready', import.meta.url), String(process.pid));
        setTimeout(() => process.exit(99), 10000);
      `);
      const readyPath = path.join(fixture.directory, 'ready');
      // Exercise the production footer verbatim, substituting only the database-free main.
      // Keeping Exit imported also lets the previous runPromiseExit footer run as a negative control.
      const source = yield* fs.readFileString(fileURLToPath(verifierUrl));
      const footerOffset = source.lastIndexOf('if (import.meta.main) {');
      expect(footerOffset).toBeGreaterThan(0);
      const runnerSource = `
        import { NodeRuntime, NodeServices } from '@effect/platform-node';
        import { Effect, Exit } from 'effect';
        import { Reactivity } from 'effect/reactivity';
        import { verifyOwnerSchema } from ${encodeJson(verifierUrl.href)};
        const main = verifyOwnerSchema(${encodeJson(fixture.file)}).pipe(Effect.provide(NodeServices.layer));
        ${source.slice(footerOffset)}
      `;
      // Reap an orphan even when testing a broken footer that never interrupts its scope.
      yield* Effect.addFinalizer(() =>
        spawner
          .exitCode(
            ChildProcess.make(process.execPath, [
              '-e',
              `
              const { existsSync, readFileSync } = require('node:fs');
              if (existsSync(${encodeJson(readyPath)})) {
                const pid = Number(readFileSync(${encodeJson(readyPath)}, 'utf8'));
                try { process.kill(pid, 'SIGKILL'); }
                catch (error) { if (error.code !== 'ESRCH') throw error; }
              }
            `,
            ]),
          )
          .pipe(Effect.orDie),
      );
      const runner = yield* spawner.spawn(
        ChildProcess.make(process.execPath, ['--input-type=module', '-e', runnerSource], {
          stderr: 'inherit',
          stdout: 'inherit',
        }),
      );
      yield* fs
        .exists(readyPath)
        .pipe(
          Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: (ready) => ready }),
          Effect.timeout('5 seconds'),
        );
      const ownerPid = Number(yield* fs.readFileString(readyPath));

      yield* runner.kill({ killSignal: signal }).pipe(Effect.timeout('5 seconds'));

      expect(yield* runner.exitCode).not.toBe(0);
      expect(yield* fs.readFileString(path.join(fixture.directory, 'stopped'))).toBe('finalized');
      const ownerGone = yield* spawner.exitCode(
        ChildProcess.make(process.execPath, [
          '-e',
          `
            try { process.kill(${ownerPid}, 0); process.exitCode = 1; }
            catch (error) { if (error.code !== 'ESRCH') throw error; }
          `,
        ]),
      );
      expect(ownerGone).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
