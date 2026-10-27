import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { Schema } from 'effect';
import { rules as nativeRules } from 'eslint-plugin-perfectionist';
import { expect, it } from 'effect-rstest';

import orderSensitiveObjects from '../../order-sensitive-objects.ts';
import { appRoot, oxlintEntryPoint, parseOxlintOutput, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const applicationRequire = createRequire(path.join(appRoot, 'package.json'));
const plugin = applicationRequire.resolve('eslint-plugin-perfectionist');
const adapter = path.join(appRoot, 'tools/oxlint/order-sensitive-objects.ts');
const adapterConfigFilename = 'adapter.config.ts';
const productionConfig = path.join(appRoot, 'oxlint.config.ts');
const rule = 'perfectionist/sort-objects';
const diagnosticCode = 'perfectionist(sort-objects)';
const coreImport = "import { defineRead } from '@app/core-runtime';";
const pipeline = '{ prepare: prepareRead, load: loadRead, finish: finishRead }';
const unordered = '{ zebra: 1, alpha: 2 }';
const columns = "{ zebra: uuid('zebra'), alpha: text('alpha') }";
const drizzleImport = "import { pgSchema, pgTable, text, uuid } from 'drizzle-orm/pg-core';";
const approvedReadFiles = [
  'commerce-customer-context/counterparty-commerce-access-check',
  'commerce-customer-context/retail-access-decision',
  'commerce-customer-context/retail-portal-profile-binding-read',
  'commerce-market-catalog/eligible-market-tuples',
  'commerce-market-catalog/resolve-commerce-market',
  'commerce-market-catalog/verify-market-eligibility-v1',
  'crm/agent-review',
  'crm-activities/records',
  'facility-operations/overview',
  'facility-operations/records',
  'finance-billing/records',
  'inventory/current-relevant-stock-position-set',
  'merchandise/agent-review',
  'merchandise/records',
  'pricing/current-pricing-decision',
  'property-leasing/agent-review',
  'property-leasing/records',
  'sales-insights/records',
  'sales-pipeline/records',
  'tagging/records',
  'work-tasks/agent-review',
  'work-tasks/records',
  'workforce/records',
].map((entry) => {
  const [owner, filename] = entry.split('/');
  return `verticals/${owner}/src/api/${filename}.read.ts`;
});
const verifiedDrizzleFiles = [
  'verticals/commerce-market-catalog/src/database/schema.ts',
  'verticals/inventory/src/persistence/binding-correction-impact-table.ts',
  'verticals/inventory/src/persistence/catalog-to-stock-binding-table.ts',
  'verticals/inventory/src/persistence/external-stock-correlation-table.ts',
  'verticals/inventory/src/persistence/inventory-effect-ledger-table.ts',
  'verticals/inventory/src/persistence/inventory-source-assertion-table.ts',
  'verticals/inventory/src/persistence/inventory-source-conflict-table.ts',
  'verticals/inventory/src/persistence/inventory-source-import-ledger-table.ts',
  'verticals/inventory/src/persistence/reservation-create-effect-table.ts',
  'verticals/inventory/src/persistence/reservation-shortage-impact-table.ts',
  'verticals/inventory/src/persistence/stock-correction-source-evidence-table.ts',
  'verticals/inventory/src/persistence/stock-correction-table.ts',
  'verticals/inventory/src/persistence/stock-location-table.ts',
  'verticals/inventory/src/persistence/stock-position-table.ts',
  'verticals/inventory/src/persistence/stock-sharing-eligibility-table.ts',
  'verticals/price-group-catalog/src/database/schema.ts',
  'verticals/pricing/src/database/schema.ts',
  'verticals/storefront-registry/src/database/schema.ts',
];

it('keeps the upstream sorting rule metadata and every other rule unchanged', () => {
  expect(orderSensitiveObjects.rules['sort-objects'].meta).toBe(nativeRules?.['sort-objects'].meta);
  for (const [ruleName, definition] of Object.entries(nativeRules ?? {})) {
    if (ruleName !== 'sort-objects') {
      expect(orderSensitiveObjects.rules[ruleName]).toBe(definition);
    }
  }
});

/** Exercise the actual production options through Oxlint, without unrelated rules or path overrides. */
const productionConfigSource = `
const { default: config } = await import(${JSON.stringify(productionConfig)});
export default {
  categories: { correctness: 'off' },
  jsPlugins: [{ name: 'perfectionist', specifier: ${JSON.stringify(plugin)} }],
  rules: { ${JSON.stringify(rule)}: config.rules[${JSON.stringify(rule)}] },
};
`;
const adapterConfigSource = productionConfigSource.replace(JSON.stringify(plugin), JSON.stringify(adapter));

it('preserves only import-bound top-level Core Read lifecycle arguments', () => {
  withTemporaryWorkspace((directory) => {
    const config = path.join(directory, 'production.config.ts');
    writeFileSync(config, productionConfigSource);
    const valid = {
      exported: `${coreImport} export const read = defineRead({}, ${pipeline}, services, target);`,
      finishOnly: `${coreImport} export const read = defineRead({}, { load: loadRead, finish: finishRead }, services, target);`,
      generic: `${coreImport} export const read = defineRead<Input, Result>({}, ${pipeline}, services, target);`,
      local: `${coreImport} const read = defineRead({}, ${pipeline}, services, target);`,
      partition: `const value = { zebra: 1,\n// Separate partition\nalpha: 2 };`,
      prepared: `${coreImport} export const read = defineRead({}, { prepare: prepareRead, load: loadRead }, services, target);`,
    };
    const invalid = {
      arbitraryHandlerKeys: `${coreImport} export const read = defineRead({}, ${unordered}, services, target);`,
      assignment: `${coreImport} let read; read = defineRead({}, ${pipeline}, services, target);`,
      blockShadow: `${coreImport} { const defineRead = localBuilder; const read = defineRead({}, ${pipeline}, services, target); }`,
      callbackShadow: `${coreImport} const make = (defineRead) => defineRead({}, ${pipeline}, services, target);`,
      classShadow: `${coreImport} class Builder { make(defineRead) { const read = defineRead({}, ${pipeline}, services, target); } }`,
      descriptor: `${coreImport} export const read = defineRead(${unordered}, ${pipeline}, services, target);`,
      destructuring: `${coreImport} const { prepare, load } = source;`,
      dynamicImport: `const { defineRead } = await import('@app/core-runtime'); const read = defineRead({}, ${pipeline}, services, target);`,
      extraKey: `${coreImport} export const read = defineRead({}, { prepare: prepareRead, load: loadRead, alpha: 1 }, services, target);`,
      importAlias: `import { defineRead as buildRead } from '@app/core-runtime'; const read = buildRead({}, ${pipeline}, services, target);`,
      localLookalike: `const defineRead = localBuilder; const read = defineRead({}, ${pipeline}, services, target);`,
      namedFunctionShadow: `${coreImport} const build = function defineRead() { const read = defineRead({}, ${pipeline}, services, target); };`,
      namespaceImport: `import * as Core from '@app/core-runtime'; const read = Core.defineRead({}, ${pipeline}, services, target);`,
      nestedData: `${coreImport} export const read = defineRead({}, { prepare: () => (${unordered}), load: loadRead }, services, target);`,
      nestedLifecycleData: `${coreImport} export const read = defineRead({}, { prepare: () => (${pipeline}), load: loadRead }, services, target);`,
      nestedUnshadowed: `${coreImport} function make() { const read = defineRead({}, ${pipeline}, services, target); }`,
      ordinaryObject: `${coreImport} const value = ${unordered};`,
      parameterShadow: `${coreImport} function make(defineRead) { const read = defineRead({}, ${pipeline}, services, target); }`,
      propertyCall: `${coreImport} const read = other.defineRead({}, ${pipeline}, services, target);`,
      servicesArgument: `${coreImport} export const read = defineRead({}, ${pipeline}, ${unordered}, target);`,
      typeImport: `import type { defineRead } from '@app/core-runtime'; const read = defineRead({}, ${pipeline}, services, target);`,
      typeSpecifier: `import { type defineRead } from '@app/core-runtime'; const read = defineRead({}, ${pipeline}, services, target);`,
      unrelatedCall: `${coreImport} const value = otherBuilder({}, ${pipeline});`,
      unusedAliasedImport: `import { defineRead as coreRead } from '@app/core-runtime'; const defineRead = localBuilder; const read = defineRead({}, ${pipeline}, services, target);`,
      wrongArgument: `${coreImport} export const read = defineRead(${pipeline}, {}, services, target);`,
      wrongImport: `import { defineRead } from 'unrelated'; const read = defineRead({}, ${pipeline}, services, target);`,
    };
    const files = Object.entries({ ...valid, ...invalid }).map(([name, source]) => {
      const file = `${name}.ts`;
      writeFileSync(path.join(directory, file), source);
      return file;
    });
    const run = runOxlint(config, files, directory);
    expect(run.exitCode).toBe(1);
    expect(run.numberOfFiles).toBe(files.length);
    expect(run.diagnostics.every(({ code }) => code === diagnosticCode)).toBe(true);
    const reported = new Set(run.diagnostics.map(({ filename }) => filename));
    for (const name of Object.keys(valid)) {
      expect(reported.has(`${name}.ts`), `must preserve ${name}`).toBe(false);
    }
    for (const name of Object.keys(invalid)) {
      expect(reported.has(`${name}.ts`), `must still sort ${name}`).toBe(true);
    }
  });
});

it('rejects a Drizzle name-and-import-presence exemption that cannot bind the table receiver', () => {
  withTemporaryWorkspace((directory) => {
    const config = path.join(directory, 'candidate.json');
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: 'off' },
        jsPlugins: [{ name: 'perfectionist', specifier: plugin }],
        rules: {
          [rule]: [
            'error',
            {
              type: 'unsorted',
              useConfigurationIf: {
                callingFunctionNamePattern: '^schema\\.table(?:\\.withRLS)?$',
                matchesAstSelector:
                  'Program:has(ImportDeclaration[source.value="drizzle-orm/pg-core"] > ImportSpecifier[imported.name="pgSchema"]) CallExpression > ObjectExpression.arguments:nth-child(2)',
              },
            },
            { partitionByComment: true },
          ],
        },
      }),
    );
    const sources = {
      genuine: `import { pgSchema, text, uuid } from 'drizzle-orm/pg-core'; const schema = pgSchema('owner'); const table = schema.table('record', { zebra: uuid('zebra'), alpha: text('alpha') });`,
      shadow: `import { pgSchema } from 'drizzle-orm/pg-core'; const schema = pgSchema('owner'); function make(schema) { const table = schema.table('record', ${unordered}); }`,
      unusedImport: `import { pgSchema } from 'drizzle-orm/pg-core'; const schema = arbitraryBuilder; const table = schema.table('record', ${unordered});`,
      withRls: `import { pgSchema } from 'drizzle-orm/pg-core'; const schema = arbitraryBuilder; const table = schema.table.withRLS('record', ${unordered});`,
    };
    const files = Object.entries(sources).map(([name, source]) => {
      const file = `${name}.ts`;
      writeFileSync(path.join(directory, file), source);
      return file;
    });
    // This tempting native candidate admits the real table AND all three counterexamples.
    const candidate = runOxlint(config, files, directory);
    expect(candidate.numberOfFiles).toBe(files.length);
    expect(candidate.exitCode).toBe(0);
    expect(candidate.diagnostics).toEqual([]);
    const production = path.join(directory, 'production.config.ts');
    writeFileSync(production, productionConfigSource);
    const run = runOxlint(production, files, directory);
    expect(run.numberOfFiles).toBe(files.length);
    expect(run.exitCode).toBe(1);
    expect(run.diagnostics.every(({ code }) => code === diagnosticCode)).toBe(true);
    expect(new Set(run.diagnostics.map(({ filename }) => filename))).toEqual(new Set(files));
  });
});

it('distinguishes identical consumers by imported origin where native selectors cannot', () => {
  withTemporaryWorkspace((directory) => {
    const config = path.join(directory, 'candidate.json');
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: 'off' },
        jsPlugins: [{ name: 'perfectionist', specifier: plugin }],
        rules: {
          [rule]: [
            'error',
            {
              type: 'unsorted',
              useConfigurationIf: {
                matchesAstSelector:
                  'Program:has(ImportDeclaration[source.value="./schema.ts"] > ImportSpecifier[imported.name="schema"][local.name="schema"]) > VariableDeclaration > VariableDeclarator > CallExpression[callee.object.name="schema"][callee.property.name="table"] > ObjectExpression.arguments:nth-child(2)',
              },
            },
            { partitionByComment: true },
          ],
        },
      }),
    );
    const file = 'consumer.ts';
    writeFileSync(
      path.join(directory, file),
      "import { schema } from './schema.ts'; import { text, uuid } from 'drizzle-orm/pg-core'; const table = schema.table('record', { zebra: uuid('zebra'), alpha: text('alpha') });",
    );
    const adapted = path.join(directory, adapterConfigFilename);
    writeFileSync(adapted, adapterConfigSource);
    for (const [schema, expectedErrors] of [
      ["import { pgSchema } from 'drizzle-orm/pg-core'; export const schema = pgSchema('owner');", 0],
      ['export const schema = { table: (_name, arbitraryOptions) => arbitraryOptions };', 1],
    ] as const) {
      // Changing only the imported module changes the semantic owner, not selector matching.
      writeFileSync(path.join(directory, 'schema.ts'), schema);
      const run = runOxlint(config, [file], directory);
      expect(run.numberOfFiles).toBe(1);
      expect(run.exitCode).toBe(0);
      expect(run.diagnostics).toEqual([]);
      const bindingAware = runOxlint(adapted, [file], directory);
      expect(bindingAware.diagnostics).toHaveLength(expectedErrors);
      expect(bindingAware.diagnostics.every(({ code }) => code === diagnosticCode)).toBe(true);
    }
  });
});

it('proves Drizzle columns through actual bindings and owner exports without exempting nearby objects', () => {
  withTemporaryWorkspace((directory) => {
    const config = path.join(directory, adapterConfigFilename);
    writeFileSync(config, adapterConfigSource);
    writeFileSync(path.join(directory, 'schema.ts'), `${drizzleImport} export const schema = pgSchema('owner');`);
    writeFileSync(path.join(directory, 'barrel.ts'), "export { schema as ownerSchema } from './schema.ts';");
    writeFileSync(path.join(directory, 'fake.ts'), 'export const schema = arbitraryBuilder;');
    writeFileSync(
      path.join(directory, 'mutated.ts'),
      `${drizzleImport} export const schema = pgSchema('owner'); schema.table = arbitraryBuilder;`,
    );
    writeFileSync(
      path.join(directory, 'escaped-owner.ts'),
      `${drizzleImport} export const schema = pgSchema('owner'); const holder = { schema }; holder.schema.table = arbitraryBuilder;`,
    );
    writeFileSync(path.join(directory, 'malformed.ts'), 'export const schema = ;');
    writeFileSync(path.join(directory, 'type-export.ts'), "export type { schema } from './schema.ts';");
    writeFileSync(path.join(directory, 'cycle-a.ts'), "export { schema } from './cycle-b.ts';");
    writeFileSync(path.join(directory, 'cycle-b.ts'), "export { schema } from './cycle-a.ts';");
    const valid = {
      direct: `${drizzleImport} const table = pgTable('record', ${columns});`,
      imported: `import { schema } from './schema.ts'; const table = schema.table('record', ${columns});`,
      importedAlias: `import { schema as owner } from './schema.ts'; const table = owner.table('record', ${columns});`,
      localAlias: `${drizzleImport} const schema = pgSchema('owner'); const owner = schema; const table = owner.table('record', ${columns});`,
      localSchema: `${drizzleImport} const schema = pgSchema('owner'); const table = schema.table('record', ${columns});`,
      namedAlias: `import { pgSchema as makeSchema } from 'drizzle-orm/pg-core'; const schema = makeSchema('owner'); const table = schema.table('record', ${columns});`,
      namespace: `import * as pg from 'drizzle-orm/pg-core'; const schema = pg.pgSchema('owner'); const table = schema.table('record', ${columns});`,
      reexport: `import { ownerSchema } from './barrel.ts'; const table = ownerSchema.table('record', ${columns});`,
      withRls: `${drizzleImport} const schema = pgSchema('owner'); const table = schema.table.withRLS('record', ${columns});`,
    };
    const invalid = {
      arbitraryObject: `${drizzleImport} const schema = pgSchema('owner'); const table = schema.table('record', ${columns}); const value = ${unordered};`,
      arbitraryReceiver: `${drizzleImport} const schema = arbitraryBuilder; const table = schema.table('record', ${columns});`,
      assignedAlias: `${drizzleImport} let schema = pgSchema('owner'); schema = arbitraryBuilder; const table = schema.table('record', ${columns});`,
      cycle: `import { schema } from './cycle-a.ts'; const table = schema.table('record', ${columns});`,
      destructuredMutation: `${drizzleImport} const schema = pgSchema('owner'); ({ table: schema.table } = replacement); const table = schema.table('record', ${columns});`,
      escaped: `${drizzleImport} const schema = pgSchema('owner'); mutate(schema); const table = schema.table('record', ${columns});`,
      escapedExport: `import { schema } from './escaped-owner.ts'; const table = schema.table('record', ${columns});`,
      escapedRecord: `${drizzleImport} const schema = pgSchema('owner'); const holder = { schema }; holder.schema.table = arbitraryBuilder; const table = schema.table('record', ${columns});`,
      factoryShadow: `${drizzleImport} function make(pgSchema) { const schema = pgSchema('owner'); const table = schema.table('record', ${columns}); }`,
      fakeExport: `import { schema } from './fake.ts'; const table = schema.table('record', ${columns});`,
      malformedModule: `import { schema } from './malformed.ts'; const table = schema.table('record', ${columns});`,
      memberMutation: `${drizzleImport} const schema = pgSchema('owner'); schema.table = arbitraryBuilder; const table = schema.table('record', ${columns});`,
      missingExport: `import { absent as schema } from './schema.ts'; const table = schema.table('record', ${columns});`,
      missingModule: `import { schema } from './missing.ts'; const table = schema.table('record', ${columns});`,
      mutable: `${drizzleImport} let schema = pgSchema('owner'); const table = schema.table('record', ${columns});`,
      mutatedAlias: `${drizzleImport} const schema = pgSchema('owner'); const alias = schema; alias.table = arbitraryBuilder; const table = schema.table('record', ${columns});`,
      mutatedExport: `import { schema } from './mutated.ts'; const table = schema.table('record', ${columns});`,
      nestedData: `${drizzleImport} const schema = pgSchema('owner'); const table = schema.table('record', { zebra: uuid('zebra'), alpha: text('alpha', ${unordered}) });`,
      optionalCall: `${drizzleImport} const schema = pgSchema('owner'); const table = schema.table?.('record', ${columns});`,
      optionsArgument: `${drizzleImport} const schema = pgSchema('owner'); const table = schema.table('record', ${columns}, ${unordered});`,
      parameterShadow: `${drizzleImport} const schema = pgSchema('owner'); function make(schema) { const table = schema.table('record', ${columns}); }`,
      typeExport: `import { schema } from './type-export.ts'; const table = schema.table('record', ${columns});`,
      typeImport: `import type { pgSchema } from 'drizzle-orm/pg-core'; const schema = pgSchema('owner'); const table = schema.table('record', ${columns});`,
      typeSpecifier: `import { type pgSchema } from 'drizzle-orm/pg-core'; const schema = pgSchema('owner'); const table = schema.table('record', ${columns});`,
      wrongImport: `import { pgSchema } from 'other'; const schema = pgSchema('owner'); const table = schema.table('record', ${columns});`,
    };
    const files = Object.entries({ ...valid, ...invalid }).map(([fixture, source]) => {
      const file = `${fixture}.ts`;
      writeFileSync(path.join(directory, file), source);
      return file;
    });
    const run = runOxlint(config, files, directory);
    expect(run.numberOfFiles).toBe(files.length);
    expect(run.exitCode).toBe(1);
    expect(run.diagnostics.every(({ code }) => code === diagnosticCode)).toBe(true);
    const reported = new Set(run.diagnostics.map(({ filename }) => filename));
    for (const fixture of Object.keys(valid)) {
      expect(reported.has(`${fixture}.ts`), `must preserve ${fixture}`).toBe(false);
    }
    for (const fixture of Object.keys(invalid)) {
      expect(reported.has(`${fixture}.ts`), `must still sort ${fixture}`).toBe(true);
    }
  });
});

it('preserves the upstream diagnostics and fixer for every non-exempt object', () => {
  withTemporaryWorkspace((directory) => {
    const source = `const plain = ${unordered};
const { zebra, alpha } = value;
const partition = { zebra: 1,
// Separate partition
alpha: 2 };
`;
    const results = [plugin, adapter].map((specifier) => {
      const config = path.join(directory, 'config.json');
      const file = path.join(directory, 'fixture.ts');
      writeFileSync(file, source);
      writeFileSync(
        config,
        JSON.stringify({
          categories: { correctness: 'off' },
          jsPlugins: [{ name: 'perfectionist', specifier }],
          rules: { [rule]: ['error', { partitionByComment: true }] },
        }),
      );
      const { diagnostics } = runOxlint(config, [file], directory);
      const result = spawnSync(process.execPath, [oxlintEntryPoint, '-c', config, '--fix', file], {
        cwd: directory,
        encoding: 'utf-8',
        timeout: 120_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      return { diagnostics, fixed: readFileSync(file, 'utf-8') };
    });
    expect(results[0]?.diagnostics.length).toBe(2);
    expect(results[1]).toEqual(results[0]);
  });
});

it('fixes a neighboring object without changing physical column order', () => {
  withTemporaryWorkspace((directory) => {
    const config = path.join(directory, adapterConfigFilename);
    const file = path.join(directory, 'fixture.ts');
    writeFileSync(config, adapterConfigSource);
    writeFileSync(
      file,
      `${drizzleImport} const schema = pgSchema('owner'); const table = schema.table('record', ${columns}); const control = ${unordered};`,
    );
    const result = spawnSync(process.execPath, [oxlintEntryPoint, '-c', config, '--fix', file], {
      cwd: directory,
      encoding: 'utf-8',
      timeout: 120_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const fixed = readFileSync(file, 'utf-8');
    expect(fixed).toContain(`schema.table('record', ${columns})`);
    expect(fixed).toContain('const control = { alpha: 2, zebra: 1 }');
  });
});

it('the full production CLI executes the upstream rule and the approved unwaived Reads', () => {
  withTemporaryWorkspace((directory) => {
    const control = path.join(directory, 'production-control.ts');
    writeFileSync(
      control,
      `${coreImport} export const read = defineRead({}, ${pipeline}, services, target);
${drizzleImport}
const ownerSchema = pgSchema('owner');
const physical = ownerSchema.table('record', ${columns});
const rls = ownerSchema.table.withRLS('secured', ${columns});
const control = ${unordered};
const fake = arbitraryBuilder;
const table = fake.table('record', ${columns});
`,
    );
    const log = path.join(directory, 'identity.jsonl');
    const hook = path.join(directory, 'identity.mjs');
    writeFileSync(
      hook,
      `import { registerHooks } from 'node:module';
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.endsWith('/eslint-plugin-perfectionist/dist/rules/sort-objects.js')) {
      result.source = String(result.source) + ${JSON.stringify(`
import { appendFileSync as proofAppend } from 'node:fs';
const proofCreate = sort_objects_default.create;
sort_objects_default.create = context => {
  proofAppend(${JSON.stringify(log)}, JSON.stringify({ id: context.id, file: context.filename, options: context.options }) + '\\n');
  return proofCreate(context);
};
`)};
    }
    return result;
  },
});
`,
    );
    const result = spawnSync(
      process.execPath,
      [oxlintEntryPoint, '--threads=2', '-c', productionConfig, '--format=json', ...approvedReadFiles, control],
      {
        cwd: appRoot,
        encoding: 'utf-8',
        env: { ...process.env, NODE_OPTIONS: `--import=${hook}` },
        maxBuffer: 20 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    expect(result.error).toBeUndefined();
    const report = parseOxlintOutput(result.stdout, result.stderr, result.status);
    expect(report.numberOfFiles).toBe(24);
    const sorting = report.diagnostics.filter(({ code }) => code === diagnosticCode);
    expect(sorting).toHaveLength(2);
    expect(sorting.every(({ filename }) => filename.endsWith('/production-control.ts'))).toBe(true);
    expect(report.diagnostics.filter(({ code }) => code.includes('unused-disable'))).toEqual([]);
    const decodeIdentity = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          id: Schema.String,
          options: Schema.Array(
            Schema.Struct({
              useConfigurationIf: Schema.optional(Schema.Struct({ matchesAstSelector: Schema.String })),
            }),
          ),
        }),
      ),
    );
    const identities = readFileSync(log, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => decodeIdentity(line));
    expect(identities).toHaveLength(24);
    expect(
      identities.every(
        (identity) => identity.id === rule && identity.options[0]?.useConfigurationIf?.matchesAstSelector !== undefined,
      ),
    ).toBe(true);
    for (const file of approvedReadFiles) {
      expect(readFileSync(path.join(appRoot, file), 'utf-8')).not.toMatch(
        /oxlint-(?:disable[^ ]*|enable) perfectionist\/sort-objects/u,
      );
    }
  }, appRoot);
});

it('the full production CLI preserves first-party Drizzle columns without source waivers', () => {
  const report = runOxlint(productionConfig, verifiedDrizzleFiles, appRoot);
  expect(report.numberOfFiles).toBe(verifiedDrizzleFiles.length);
  expect(report.diagnostics.filter(({ code }) => code === diagnosticCode)).toEqual([]);
  for (const file of verifiedDrizzleFiles) {
    expect(readFileSync(path.join(appRoot, file), 'utf-8')).not.toMatch(
      /oxlint-(?:disable[^ ]*|enable) perfectionist\/sort-objects/u,
    );
  }
});
