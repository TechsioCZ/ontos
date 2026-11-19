import { Config, Effect, FileSystem, Path } from 'effect';
import { expect } from 'effect-rstest';
import { validateXML } from 'xmllint-wasm';

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

/**
 * A provisioned schema as UTF-8 text. The STORMWARE files declare windows-1250 and the WebAssembly libxml2 is built
 * without iconv, so each is decoded with the encoding its own XML declaration names and handed over re-declared as
 * UTF-8: the same characters, so the same schema. The pins of scripts/provision-pohoda-xsd.sh still check the bytes.
 */
const XML_DECLARATION = /^<\?xml[^>]*\?>/u;
const DECLARED_ENCODING = /(?<before>\sencoding=)(?<quote>["'])(?<encoding>[^"']+)\k<quote>/u;

const asUtf8Schema = (bytes: Uint8Array) => {
  // Only the leading XML declaration names the encoding; it is ASCII, after an optional UTF-8 byte-order mark.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200)).replace(/^\u00EF\u00BB\u00BF/u, '');
  const declared = DECLARED_ENCODING.exec(XML_DECLARATION.exec(head)?.[0] ?? '')?.groups?.['encoding'];
  return new TextDecoder(declared ?? 'utf-8', { fatal: true })
    .decode(bytes)
    .replace(XML_DECLARATION, (declaration) => declaration.replace(DECLARED_ENCODING, '$<before>"UTF-8"'));
};

/**
 * Validate a POHODA XML document against the official STORMWARE `data.xsd` with libxml2's `xmllint`, the
 * WebAssembly build the lockfile pins (`xmllint-wasm`), so no runner needs a system package. It runs
 * `xmllint --schema data.xsd --noout` with every provisioned schema beside `data.xsd` for its imports.
 */
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
  const imported = (yield* fs.readDirectory(directory)).filter((name) => name.endsWith('.xsd') && name !== 'data.xsd');
  const preload = yield* Effect.forEach(imported.toSorted(), (fileName) =>
    fs
      .readFile(path.join(directory, fileName))
      .pipe(Effect.map((bytes) => ({ contents: asUtf8Schema(bytes), fileName }))),
  );
  const schema = { contents: asUtf8Schema(yield* fs.readFile(xsd)), fileName: 'data.xsd' };
  const validation = yield* Effect.promise(() =>
    validateXML({
      preload,
      schema,
      xml: { contents: xml, fileName: 'pohoda-export.xml' },
    }),
  );
  expect(validation.valid, validation.rawOutput).toBe(true);
});
