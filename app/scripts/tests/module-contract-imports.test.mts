import { Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';

import { checkModuleContractSourceImports, OntosModuleContractCheckError } from '../check-ontos-module-contracts.mts';

const SHARED_FILE = '/workspace/packages/core-runtime/tests/no-vertical-knowledge.test.ts';
const OWNER_ROOT = '/workspace/verticals/crm';
const OWNER_FILE = `${OWNER_ROOT}/src/feature.ts`;
const PRIVATE_MANIFEST = 'imports a private deployment manifest or registration';
const PRIVATE_SOURCE = 'imports production vertical private source';
const FOREIGN_OWNER = "imports another deployment's private owner file";
const PARSE_FAILURE = 'could not be parsed for module-boundary import checks';

for (const source of [
  `const fixture = "import { manifest } from '../../verticals/crm/vertical.manifest.ts';";`,
  `const fixture = 'require("@app/crm/src/private.ts")';`,
  'const fixture = `import("../../verticals/crm/vertical.registration.ts")`;',
  `// import { registration } from '../../verticals/crm/vertical.registration.ts';\nexport const value = 1;`,
  `/* require('@app/crm/repositories/private'); export * from '../../verticals/crm/vertical.manifest.ts'; */`,
  `const fixture = { source: "from '@app/crm/handlers/private'" };`,
  `const fixture = "import('./vertical.manifest.ts')"; import { value } from '@app/core-runtime/src/public';`,
  `import { value } from '../../verticals/crm/shared/contracts.ts';`,
  `export type { Contract } from '@app/crm/shared/contracts';`,
  `const value = import('@app/core-runtime/src/public');`,
  `const value = require('@app/crm/shared/contracts');`,
]) {
  it.effect(`ignores fixture text and permits public contracts: ${source}`, () =>
    checkModuleContractSourceImports(SHARED_FILE, source),
  );
}

interface ForbiddenImportExample {
  readonly reason: string;
  readonly source: string;
}
const forbiddenImports: readonly ForbiddenImportExample[] = [
  { reason: PRIVATE_MANIFEST, source: `import { manifest } from '../../verticals/crm/vertical.manifest.ts';` },
  { reason: PRIVATE_MANIFEST, source: `import '../../verticals/crm/vertical.manifest.ts';` },
  { reason: PRIVATE_MANIFEST, source: `import type { Owner } from '../../verticals/crm/vertical.registration';` },
  { reason: PRIVATE_MANIFEST, source: `import {\n manifest,\n} from\n '../../verticals/crm/vertical.manifest.ts';` },
  {
    reason: PRIVATE_MANIFEST,
    source: `const fixture = "from '@app/core-runtime/public'"; import { owner } from '../../verticals/crm/vertical.manifest.ts';`,
  },
  {
    reason: PRIVATE_MANIFEST,
    source: `// harmless fixture\nimport { owner } from '../../verticals/crm/vertical.registration.ts';`,
  },
  { reason: PRIVATE_MANIFEST, source: `export { manifest } from '../../verticals/crm/vertical.manifest.ts';` },
  { reason: PRIVATE_MANIFEST, source: `export * from '../../verticals/crm/vertical.registration.ts';` },
  { reason: PRIVATE_MANIFEST, source: `export * as owner from '../../verticals/crm/vertical.manifest.ts';` },
  { reason: PRIVATE_MANIFEST, source: `export type { Owner } from '../../verticals/crm/vertical.manifest.ts';` },
  {
    reason: PRIVATE_MANIFEST,
    source: `const value = import(\n/* actual source */ '../../verticals/crm/vertical.manifest.ts'\n);`,
  },
  { reason: PRIVATE_MANIFEST, source: 'const value = import(`../../verticals/crm/vertical.registration.ts`);' },
  {
    reason: PRIVATE_MANIFEST,
    source: `function load() { return require(/* actual source */ '../../verticals/crm/vertical.registration.ts'); }`,
  },
  { reason: PRIVATE_MANIFEST, source: `const value = module.require('../../verticals/crm/vertical.manifest.ts');` },
  { reason: PRIVATE_MANIFEST, source: `const value = module['require']('../../verticals/crm/vertical.manifest.ts');` },
  { reason: PRIVATE_MANIFEST, source: `import owner = require('../../verticals/crm/vertical.manifest.ts');` },
  { reason: PRIVATE_MANIFEST, source: `type Owner = import('../../verticals/crm/vertical.registration.ts').Owner;` },
  { reason: PRIVATE_MANIFEST, source: `const value = import('./vertical.' + 'manifest.ts');` },
  { reason: PRIVATE_MANIFEST, source: `const value = import('./vertical.manifest.ts' + suffix);` },
  { reason: PRIVATE_MANIFEST, source: `const value = import(flag ? './vertical.manifest.ts' : './shared/public.ts');` },
  { reason: PRIVATE_MANIFEST, source: `const value = import(('./vertical.manifest.ts' as string));` },
  { reason: PRIVATE_SOURCE, source: `import { secret } from '../../verticals/crm/src/private.ts';` },
  { reason: PRIVATE_SOURCE, source: `import { secret } from '@app/crm/routes/private';` },
  { reason: PRIVATE_SOURCE, source: `export { secret } from '@app/crm/providers/private';` },
  { reason: PRIVATE_SOURCE, source: `export * from '@app/crm/handlers/private';` },
  { reason: PRIVATE_SOURCE, source: `const value = import('@app/crm/repositories/private');` },
  { reason: PRIVATE_SOURCE, source: `const value = require('@app/crm/db/private');` },
  { reason: PRIVATE_SOURCE, source: `const value = require('../verticals/crm/src/' + name);` },
  { reason: PRIVATE_SOURCE, source: `export * from '@app/crm/vertical.registration/actions';` },
  { reason: PRIVATE_SOURCE, source: `import { secret } from '@app/core-runtime-other/src/private';` },
];
for (const example of forbiddenImports) {
  it.effect(`blocks actual private syntax without scanning fixtures: ${example.source}`, () =>
    Effect.gen(function* blocksPrivateImport() {
      const error = yield* checkModuleContractSourceImports(SHARED_FILE, example.source).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OntosModuleContractCheckError);
      expect(error.message).toBe(`${SHARED_FILE} ${example.reason}`);
    }),
  );
}

for (const source of [
  `import { owner } from '../vertical.manifest.ts';`,
  `export { owner } from '../vertical.registration.ts';`,
  `const owner = import('../vertical.manifest.ts');`,
  `const owner = import('../' + 'vertical.manifest.ts');`,
  `import owner = require('../vertical.registration.ts');`,
  `const fixture = "import { owner } from '../../pricing/vertical.manifest.ts';";`,
  `/* require('@app/pricing/vertical.registration.ts'); */`,
]) {
  it.effect(`permits owner-local private files and harmless owner fixture text: ${source}`, () =>
    checkModuleContractSourceImports(OWNER_FILE, source, OWNER_ROOT),
  );
}

for (const source of [
  `import { owner } from '../../pricing/vertical.manifest.ts';`,
  `export * from '../../pricing/vertical.registration.ts';`,
  `const owner = import('../../pricing/vertical.manifest.ts');`,
  `const owner = import('../../pricing/' + 'vertical.manifest.ts');`,
  `const owner = require('../../pricing/vertical.registration.ts');`,
  `import owner = require('../../pricing/vertical.manifest.ts');`,
  `type Owner = import('../../pricing/vertical.registration.ts').Owner;`,
  `import { owner } from '../../crm-other/vertical.manifest.ts';`,
  `import { owner } from '@app/crm/vertical.manifest.ts';`,
]) {
  it.effect(`retains cross-owner manifest/registration enforcement: ${source}`, () =>
    Effect.gen(function* blocksForeignOwnerImport() {
      const error = yield* checkModuleContractSourceImports(OWNER_FILE, source, OWNER_ROOT).pipe(Effect.flip);
      expect(error.message).toBe(`${OWNER_FILE} ${FOREIGN_OWNER}`);
    }),
  );
}

for (const source of [
  `const fixture = "from '@app/crm/src/private'"; const broken = ;`,
  `import { owner from '../../verticals/crm/vertical.manifest.ts';`,
  `import { value } from '@app/core-runtime/public'; function broken( {`,
]) {
  it.effect(`fails closed on malformed source instead of trusting a partial AST: ${source}`, () =>
    Effect.gen(function* rejectsMalformedImportSource() {
      for (const ownerRoot of [undefined, OWNER_ROOT]) {
        const result = yield* checkModuleContractSourceImports(SHARED_FILE, source, ownerRoot).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        const error = yield* checkModuleContractSourceImports(SHARED_FILE, source, ownerRoot).pipe(Effect.flip);
        expect(error).toBeInstanceOf(OntosModuleContractCheckError);
        expect(error.message).toBe(`${SHARED_FILE} ${PARSE_FAILURE}`);
      }
    }),
  );
}

for (const extension of ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx']) {
  it.effect(`uses the actual parser language for supported .${extension} files`, () =>
    Effect.gen(function* checksSupportedImportSyntax() {
      const file = `/workspace/packages/core-runtime/tests/fixture.${extension}`;
      yield* checkModuleContractSourceImports(file, `const fixture = "require('@app/crm/db/private')";`);
      const error = yield* checkModuleContractSourceImports(file, `require('@app/crm/db/private');`).pipe(Effect.flip);
      expect(error.message).toBe(`${file} ${PRIVATE_SOURCE}`);
    }),
  );
}

for (const extension of ['jsx', 'tsx']) {
  it.effect(`does not confuse JSX fixture attributes with imports in .${extension}`, () =>
    checkModuleContractSourceImports(
      `/workspace/packages/core-runtime/tests/fixture.${extension}`,
      `const view = <div title="from '@app/crm/src/private'" />;`,
    ),
  );
}
