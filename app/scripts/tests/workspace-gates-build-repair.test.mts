import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

const appRoot = path.resolve(import.meta.dirname, '../..');
const mfConfigSchema = Schema.fromJsonString(
  Schema.Struct({
    extends: Schema.String,
    include: Schema.Array(Schema.String),
  }),
);

it.each([
  ['facility-operations', 'src/ui/pdf-worker.d.ts'],
  ['property-leasing', 'src/pdfjs-worker.d.ts'],
  ['legal-agreements', 'src/pdfjs-worker.d.ts'],
])('includes %s ambient PDF worker types in the native MF declaration project', (owner, declaration) => {
  const directory = path.join(appRoot, 'verticals', owner);
  const config = Schema.decodeUnknownSync(mfConfigSchema)(
    readFileSync(path.join(directory, 'tsconfig.mf-types.json'), 'utf-8'),
  );
  expect(config.extends).toBe('../../tsconfig.base.json');
  expect(config.include).toContain(declaration);
  expect(readFileSync(path.join(directory, declaration), 'utf-8')).toContain(
    "declare module 'pdfjs-dist/build/pdf.worker.mjs';",
  );
});
