import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'effect-rstest';
import { provesDataFactoryImport } from '../../anti-slop/effect/rules/data-factory-proof.ts';
import { appRoot, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const fixtureDirectory = path.join(appRoot, 'tools/oxlint/anti-slop/tests/fixtures/no-service-constructor-imports');
const consumerFilename = 'branded-constructor-consumer.ts';
const validFilename = 'branded-string-constructor.ts';
const invalidFilenames = ['unknown', 'executable-check', 'context', 'fake-make', 'executable-input', 'unchecked'].map(
  (name) => `branded-constructor-${name}.ts`,
);

it('proves the frozen owner branded scalar constructor while retaining dependency and executable controls', () => {
  const consumer = path.join(fixtureDirectory, consumerFilename);
  expect(provesDataFactoryImport(consumer, `./${validFilename}`, 'makeEntityId')).toBe(true);
  for (const filename of invalidFilenames) {
    expect(provesDataFactoryImport(consumer, `./${filename}`, 'makeEntityId'), filename).toBe(false);
  }
});

it('applies the native schema maker proof to direct and aliased imports without exempting other make methods', () => {
  withTemporaryWorkspace((directory) => {
    for (const filename of [consumerFilename, validFilename, ...invalidFilenames]) {
      copyFileSync(path.join(fixtureDirectory, filename), path.join(directory, filename));
    }
    const run = runOxlint(path.join(appRoot, 'oxlint.config.ts'), [path.join(directory, consumerFilename)], directory);
    expect(run.numberOfFiles).toBe(1);
    const reports = run.diagnostics.filter(({ code }) => code === 'anti-slop-effect(no-service-constructor-imports)');
    expect(reports).toHaveLength(invalidFilenames.length);
    expect(reports.every(({ message }) => message.includes('"makeEntityId"'))).toBe(true);
    expect(
      reports.flatMap(({ labels }) => labels.map(({ span }) => span.line)).toSorted((left, right) => left - right),
    ).toEqual(invalidFilenames.map((_filename, index) => index + 2));
  });
});
