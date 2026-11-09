import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'effect-rstest';

import {
  isAccessCatalogContextSourcePath,
  isAccessCatalogSourcePath,
  scanAccessCatalogSource,
} from '../authorization-catalog.mts';

const consumerFile = 'verticals/privacy/src/api/consent.read.ts';
const producerFile = 'verticals/privacy/shared/api/consent-access.ts';
const mutatorFile = 'verticals/privacy/src/services/mutate.ts';
const relativeImport = '../../shared/api/consent-access.ts';
const declaration = `{
  key: 'privacy.core.consent.read', kind: 'read', modes: ['run'],
  placement: { group: 'consent', level: 'basic' }, risk: 'sensitive', selectors: [],
}`;
const keyProperty = "key: 'privacy.core.consent.read'";
const producer = `export const ACCESS = ${declaration} as const;`;
const consumer = (preamble = `import { ACCESS } from '${relativeImport}';`, reference = 'ACCESS') => `
import { defineRead, defineTenantModuleEntrypoint } from '@app/core-runtime';
${preamble}
const entrypoint = defineTenantModuleEntrypoint({
  access: 'read', authorization: {kind:'protected'},
  entrypointKey: 'privacy.core.api.current-consent', moduleKey:'privacy.core', role:'api',
});
export const currentConsentRead = defineRead({
  accessDeclaration: ${reference}, accessKind:'detail', entrypoint,
  readKey:'privacy.core.api.current-consent',
}, handler);
`;
const scan = (source = consumer(), support = producer, extra: readonly (readonly [string, string])[] = []) =>
  scanAccessCatalogSource(source, consumerFile, new Map([[producerFile, support], ...extra]));
const expectRefused = (source: string, support = producer, extra: readonly (readonly [string, string])[] = []) => {
  const result = scan(source, support, extra);
  expect(result.carriers, JSON.stringify({ extra, source, support })).toStrictEqual([]);
  expect(result.problems.map((problem) => problem.reason)).toContain(
    'accessDeclaration must be a static object literal',
  );
};

describe('closed owner-local access declaration literals', () => {
  it('resolves native receiving declarations from immutable local and direct named imports', () => {
    for (const source of [
      consumer(),
      consumer(`import { ACCESS as LOCAL } from '${relativeImport}';`, 'LOCAL'),
      consumer(`const ACCESS = ${declaration} as const;`),
    ]) {
      const result = scan(source);
      expect(result.problems).toStrictEqual([]);
      expect(result.carriers).toHaveLength(1);
      expect(result.carriers[0]?.accessDeclaration).toMatchObject({ key: 'privacy.core.consent.read', kind: 'read' });
    }
    expect(scan(consumer(), `// České 🧪\n${producer}`).problems).toStrictEqual([]);
  });

  it('resolves the actual immutable Symmy shared contract without rewriting its owner', () => {
    const file = 'verticals/symmy-integration/src/api/symmy-source-organization-facts.read.ts';
    const support = 'verticals/symmy-integration/shared/apis/symmy-source-organization-facts.ts';
    const root = new URL('../../', import.meta.url);
    const result = scanAccessCatalogSource(
      readFileSync(fileURLToPath(new URL(file, root)), 'utf-8'),
      file,
      new Map([[support, readFileSync(fileURLToPath(new URL(support, root)), 'utf-8')]]),
    );
    expect(result.problems).toStrictEqual([]);
    expect(result.carriers.map((carrier) => carrier.accessDeclaration)).toContainEqual(
      expect.objectContaining({ key: 'integration.symmy.symmy-source-organization-facts.read' }),
    );
  });

  it('rejects dynamic and nonliteral producers, including getters, spreads, computed and duplicate properties', () => {
    const invalidObjects = [
      declaration.replace(keyProperty, "get key() {return 'privacy.core.consent.read';}"),
      declaration.replace(keyProperty, "key() {return 'privacy.core.consent.read';}"),
      declaration.replace(keyProperty, "['key']: 'privacy.core.consent.read'"),
      declaration.replace(keyProperty, "...base, key: 'privacy.core.consent.read'"),
      declaration.replace(keyProperty, "key: 'privacy.core.consent.read', key: 'other'"),
      declaration.replace("risk: 'sensitive'", 'risk: currentRisk'),
      declaration.replace("risk: 'sensitive'", "__proto__: {risk: 'routine'}, risk: 'sensitive'"),
      declaration.replace("modes: ['run']", 'modes: [...modes]'),
    ];
    for (const object of invalidObjects) {
      expectRefused(consumer(), `export const ACCESS = ${object} as const;`);
    }
    for (const support of [
      producer.replace('const', 'let'),
      producer.replace('export ', ''),
      'export const ACCESS = makeDeclaration();',
      `const BASE=${declaration}; export const ACCESS=BASE;`,
    ]) {
      expectRefused(consumer(), support);
    }
  });

  it('rejects direct, nested, alias, destructured, call, reflection and export escapes in the producer', () => {
    for (const escapedUse of [
      "ACCESS.risk='routine';",
      "ACCESS.placement.level='extended';",
      "const alias=ACCESS; alias.risk='routine';",
      "const {placement}=ACCESS; placement.level='extended';",
      'mutate(ACCESS);',
      'new Wrapper(ACCESS);',
      'export {ACCESS as other};',
      'export default ACCESS;',
      "Reflect.set(ACCESS,'risk','routine');",
      "eval('ACCESS.risk=1');",
    ]) {
      expectRefused(consumer(), `${producer}\n${escapedUse}`);
    }
  });

  it('rejects nonnative or shadowed receivers and references escaping at the receiver', () => {
    for (const escapedUse of [
      "ACCESS.risk='routine';",
      'const alias=ACCESS;',
      'mutate(ACCESS);',
      'export {ACCESS};',
      'function elsewhere(ACCESS) {return ACCESS;}',
      'const defineRead=otherFactory;',
    ]) {
      expectRefused(`${consumer()}\n${escapedUse}`);
    }
    for (const replacement of [
      'accessDeclaration: ACCESS, ...overrides,',
      'accessDeclaration: ACCESS, [dynamicKey]: replacement,',
      'accessDeclaration: ACCESS, get other() {mutate(ACCESS); return 1;},',
    ]) {
      expectRefused(consumer().replace('accessDeclaration: ACCESS,', replacement));
    }
    expectRefused(consumer().replace("from '@app/core-runtime'", "from './fake-core.ts'"));
    expectRefused(consumer().replace('import { defineRead,', 'import type { defineRead,'));
  });

  it('rejects foreign, package, namespace, type-only, unknown and reexport-chain imports', () => {
    for (const importLine of [
      "import {ACCESS} from '@app/privacy/consent-access';",
      "import {ACCESS} from '../../../another/shared/api/consent-access.ts';",
      `import * as ACCESS from '${relativeImport}';`,
      `import ACCESS from '${relativeImport}';`,
      `import type {ACCESS} from '${relativeImport}';`,
      `import {UNKNOWN as ACCESS} from '${relativeImport}';`,
      "import {ACCESS} from '../../shared/api/index.ts';",
    ]) {
      expectRefused(consumer(importLine), producer, [
        ['verticals/privacy/shared/api/index.ts', "export {ACCESS} from './consent-access.ts';"],
      ]);
    }
  });

  it('rejects mutation-only, reexport, namespace, own-package and dynamic importer escapes elsewhere in the owner', () => {
    for (const source of [
      "import {ACCESS as A} from '../../shared/api/consent-access.ts'; const alias=A; alias.risk='routine';",
      `import {"ACCESS" as A} from '../../shared/api/consent-access.ts'; A.risk='routine';`,
      "import {ACCESS as A} from '../../shared/api/consent-access.js'; A.risk='routine';",
      "import {ACCESS as A} from '../../shared/api/consent-%61ccess.ts'; A.risk='routine';",
      "import {ACCESS as A} from '../../shared/api/consent-access.ts?copy'; A.risk='routine';",
      "import * as contract from '../../shared/api/consent-access.ts';",
      "export {ACCESS} from '../../shared/api/consent-access.ts';",
      "export * from '../../shared/api/consent-access.ts';",
      "const x=await import('../../shared/api/consent-access.ts');",
      "const x=await import('../../shared/api/'+modulePath);",
      "import {ACCESS as A} from '@app/privacy/consent-access'; A.risk='routine';",
      "import * as x from '@app/privacy/consent-access';",
      `eval("import('../../shared/api/consent-access.ts').then(x=>x.ACCESS.risk='routine')");`,
      `globalThis.eval("import('../../shared/api/consent-access.ts')");`,
      `const run=Function("return import('../../shared/api/consent-access.ts')"); run();`,
    ]) {
      expectRefused(consumer(), producer, [[mutatorFile, source]]);
    }
    expectRefused(consumer(`export const ACCESS=${declaration};`), producer, [
      [mutatorFile, "import {ACCESS} from '../api/consent.read.ts'; mutate(ACCESS);"],
    ]);
  });
});

describe('native module loader declaration custody', () => {
  it('rejects actual native loaders and finite aliases, templates, concatenation and directory prefixes', () => {
    const nativeLoader = "import {createRequire} from 'node:module'; const load=createRequire(import.meta.url);";
    for (const source of [
      "const contract=require('../../shared/api/consent-access.ts'); contract.ACCESS.risk='routine';",
      "const contract=module.require('../../shared/api/consent-access.ts'); contract.ACCESS.risk='routine';",
      `${nativeLoader} const contract=load('../../shared/api/consent-access.ts'); contract.ACCESS.risk='routine';`,
      `${nativeLoader} const alias=load; const contract=alias('../../shared/api/consent-access.ts'); contract.ACCESS.risk='routine';`,
      `${nativeLoader} const path='../../shared/api/consent-access.ts'; const contract=load(path); contract.ACCESS.risk='routine';`,
      `${nativeLoader} const prefix='../../shared/api/'; const contract=load(prefix+'consent-access.ts'); contract.ACCESS.risk='routine';`,
      `${nativeLoader} const suffix='consent-access.ts'; const contract=load(\`../../shared/api/\${suffix}\`); contract.ACCESS.risk='routine';`,
      `${nativeLoader} const contract=load(\`../../shared/api/\${unknownName}.ts\`); contract.ACCESS.risk='routine';`,
      "import * as Module from 'node:module'; const factory=Module.createRequire; const load=factory(import.meta.url); load('../../shared/api/consent-access.ts');",
      "import Module from 'node:module'; const {createRequire:factory}=Module; const load=factory(import.meta.url); load('../../shared/api/consent-access.ts');",
      "import * as Module from 'node:module'; const {createRequire:factory}=Module; const load=factory(import.meta.url); load('../../shared/api/consent-access.ts');",
      "const {createRequire:factory}=require('node:module'); const load=factory(import.meta.url); load('../../shared/api/consent-access.ts');",
      "const load=require('node:module').createRequire(import.meta.url); load('../../shared/api/consent-access.ts');",
      "const path='../../shared/api/consent-access.ts'; await import(path);",
      "import Contract=require('../../shared/api/consent-access.ts'); Contract.ACCESS.risk='routine';",
      "const path='../../shared/api/'+dynamicName; await import(path);",
      'const modulePath=externalValue; await import(modulePath);',
      `${nativeLoader} load(modulePath);`,
      `${nativeLoader} load(\`\${modulePath}\`);`,
      `${nativeLoader} load('@app/pri'+suffix);`,
      `${nativeLoader} load('../../unrelated/'+suffix);`,
      `${nativeLoader} const name=externalValue; await import(\`../../unrelated/\${name}\`);`,
      `${nativeLoader} export const version=(specifier)=>load(specifier).version; version('effect/package.json');`,
      `${nativeLoader} const version=(specifier)=>load(specifier).version; const alias=version; alias('effect/package.json');`,
      `${nativeLoader} const version=(specifier)=>load(specifier).version; version(externalPath);`,
      `${nativeLoader} const version=(specifier)=>load(specifier).version; version('effect/package.json'); eval("version('../../shared/api/consent-access.ts')");`,
      `${nativeLoader} const version=(specifier)=>load(specifier).version; version('../../shared/api/consent-access.ts');`,
      `${nativeLoader} load('../../shared/api/consent-access');`,
      `${nativeLoader} load('@app/privacy/consent-access');`,
      "import {createRequire} from 'node:module'; const load=createRequire(new URL('../../shared/api/base.mjs',import.meta.url)); load('./consent-access.ts');",
      "import {createRequire} from 'node:module'; const load=createRequire(configuredBase); load('./consent-access.ts');",
    ]) {
      expectRefused(consumer(), producer, [[mutatorFile, source]]);
    }
  });

  it('preserves unrelated package-version reads, foreign factories and locally shadowed loaders', () => {
    for (const source of [
      "import {createRequire} from 'node:module'; const load=createRequire(import.meta.url); const version=(specifier)=>load(specifier).version; const v=version('effect/package.json');",
      "import {createRequire} from 'foreign-module'; const load=createRequire(import.meta.url); load('../../shared/api/consent-access.ts');",
      "import * as Module from 'foreign-module'; const load=Module.createRequire(import.meta.url); load('../../shared/api/consent-access.ts');",
      "function require(path){return {}}; const contract=require('../../shared/api/consent-access.ts');",
      "import buildArtifact=require('../../shared/api/build.json');",
      "globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode('value'));",
      "import {createRequire} from 'node:module'; const load=createRequire(import.meta.url); load('../../shared/api/unrelated.json');",
      "function receive(module){module.require('../../shared/api/consent-access.ts');}",
      "import {createRequire} from 'node:module'; function receive(createRequire){const load=createRequire(import.meta.url); load('../../shared/api/consent-access.ts');}",
    ]) {
      expect(scan(consumer(), producer, [[mutatorFile, source]]).problems).toStrictEqual([]);
    }
  });

  it('keeps JavaScript and CommonJS mutation context separate from typed business carriers', () => {
    for (const extension of ['.js', '.jsx', '.mjs', '.cjs', '.cts']) {
      const file = `verticals/privacy/src/services/mutation${extension}`;
      expect(isAccessCatalogContextSourcePath(file)).toBe(true);
      expect(isAccessCatalogSourcePath(file)).toBe(false);
      expect(scanAccessCatalogSource(consumer(), file).carriers).toStrictEqual([]);
      expectRefused(consumer(), producer, [
        [file, "const contract=require('../../shared/api/consent-access.ts'); contract.ACCESS.risk='routine';"],
      ]);
    }
    expectRefused(consumer(), producer, [
      [
        'verticals/privacy/src/services/mutation.jsx',
        "import {ACCESS} from '../../shared/api/consent-access.ts'; const view=<ACCESS/>;",
      ],
    ]);
    expect(isAccessCatalogContextSourcePath('verticals/privacy/dist/mutation.cjs')).toBe(false);
    expect(isAccessCatalogContextSourcePath('verticals/privacy/tests/mutation.cjs')).toBe(false);
  });
});
