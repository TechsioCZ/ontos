import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'effect-rstest';
import { provesDataFactoryImport } from '../../anti-slop/effect/rules/data-factory-proof.ts';
import { appRoot, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const fixtureDirectory = path.join(appRoot, 'tools/oxlint/anti-slop/tests/fixtures/no-service-constructor-imports');
const consumer = path.join(fixtureDirectory, 'temporal-decoder-consumer.ts');
const aresConsumerFilename = 'ares-snapshot-consumer.ts';
const aresConsumer = path.join(fixtureDirectory, aresConsumerFilename);

it('proves the frozen owner ARES evidence decoder through its native temporal codecs', () => {
  expect(provesDataFactoryImport(aresConsumer, './ares-snapshot-owner.ts', 'makeAresAppliedEvidence')).toBe(true);
  // Product lint excludes intentional fixture inputs. Copy this immutable graph
  // into the existing owned test workspace so the real import rule still runs.
  withTemporaryWorkspace((directory) => {
    for (const filename of [aresConsumerFilename, 'ares-snapshot-owner.ts', 'ares-snapshot-evidence.ts']) {
      copyFileSync(path.join(fixtureDirectory, filename), path.join(directory, filename));
    }
    const run = runOxlint(
      path.join(appRoot, 'oxlint.config.ts'),
      [path.join(directory, aresConsumerFilename)],
      directory,
    );
    expect(run.numberOfFiles).toBe(1);
    expect(run.diagnostics.filter(({ code }) => code === 'anti-slop-effect(no-service-constructor-imports)')).toEqual(
      [],
    );
  });
});

it('retains dependency, opaque, executable transform and shadowed intrinsic counterexamples', () => {
  expect(provesDataFactoryImport(consumer, './temporal-data-decoder.ts', 'makeDecodedEvidence')).toBe(true);
  for (const source of ['effect', 'unknown', 'effect-transform', 'executable-transform', 'fake-datetime']) {
    expect(provesDataFactoryImport(consumer, `./temporal-decoder-${source}.ts`, 'makeDecodedEvidence'), source).toBe(
      false,
    );
  }
});
