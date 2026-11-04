import { ChildProcess } from 'effect/process';
import { Config, Effect, FileSystem, Path, Stream } from 'effect';
import { expect } from 'effect-rstest';

/**
 * The official STORMWARE POHODA XML dataPack 2.0 schemas live outside the repository, so these
 * tests validate against a provisioned copy instead of a redistributed one. `POHODA_XSD_DIR`
 * overrides the location; without it the tests read the workspace cache that
 * `scripts/provision-pohoda-xsd.sh` fills. Provision it once with
 * `mise exec -- pnpm provision:pohoda-xsd`. A missing directory fails the test; it never skips
 * validation.
 */
const workspaceSchemaDirectory = new URL('../../../../node_modules/.cache/pohoda-xsd/version_2/', import.meta.url)
  .pathname;

/** Validate a POHODA XML document against the official STORMWARE `data.xsd` with `xmllint`. */
export const validatePohodaXml = Effect.fn('FinanceTest.validatePohodaXsd')(function* validatePohodaXml(xml: string) {
  const directory = yield* Config.NonEmptyString('POHODA_XSD_DIR').pipe(Config.withDefault(workspaceSchemaDirectory));
  const path = yield* Path.Path;
  const xsd = path.join(directory, 'data.xsd');
  const fs = yield* FileSystem.FileSystem;
  expect(
    yield* fs.exists(xsd),
    `POHODA_XSD_DIR must contain data.xsd and its imported schemas: ${xsd}. ` +
      'Provision the pinned STORMWARE dataPack 2.0 schemas with `mise exec -- pnpm provision:pohoda-xsd`.',
  ).toBe(true);
  const validation = yield* ChildProcess.make('xmllint', ['--noout', '--schema', xsd, '-'], {
    stderr: 'inherit',
    stdin: Stream.make(new TextEncoder().encode(xml)),
    stdout: 'ignore',
  });
  expect(yield* validation.exitCode).toBe(0);
});
