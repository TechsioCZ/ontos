import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { hasCompleteGeneratedModuleApiSeam, readSdkFormViolations } from '../generated-governed-http-boundary.mts';
import { PRICING_SHARED_API_PATH, readPricingSourceTree } from './module-entrypoint-boundaries.fixture.mts';

/* A synthetic owner: one read of `demo.module`, one provider contract package of `provider.module`. */

const ownerPath = 'verticals/demo';
const readFile = `${ownerPath}/src/api/demo-lookup.read.ts`;
const readName = 'demoLookupRead';
const entrypointKey = 'demo.module.api.demo-lookup';
const SDK_DECLARED_CALL_IMPORT = "import { declaredCall } from '@app/core-runtime/sdk';";
const PROVIDER_PACKAGE_FILE = 'packages/provider-contracts/package.json';
const CALLS_ONLY_BESIDE_RUN = 'calls stand only beside { run }';
const providerRequirement = 'demo.module.requirement.demo-lookup-provider';
const coreRequirement = 'demo.module.requirement.demo-lookup-assignees';

const providerPackage = JSON.stringify({
  exports: {
    '.': './src/index.ts',
    './provider-facts': './src/apis/provider-facts.ts',
    './provider-facts/client': './src/api/provider-facts-client.ts',
  },
  name: '@app/provider-contracts',
  ontosContractOwner: {
    appId: 'provider',
    moduleApis: ['provider-facts'],
    moduleId: 'provider.module',
    packageName: '@app/provider',
  },
});
const otherPackage = JSON.stringify({
  exports: { './other-facts': './src/apis/other-facts.ts' },
  name: '@app/other-contracts',
  ontosContractOwner: {
    appId: 'other',
    moduleApis: ['other-facts'],
    moduleId: 'other.module',
    packageName: '@app/other',
  },
});

const readImports = [
  "import { defineRead } from '@app/core-runtime';",
  SDK_DECLARED_CALL_IMPORT,
  "import { coreOperations } from '@app/core-runtime/sdk/core';",
  "import { canList, canRun, canSeeFields } from '@app/core-runtime/sdk/read';",
  "import { providerFactsOperation } from '@app/provider-contracts/provider-facts';",
  "import { otherFactsOperation } from '@app/other-contracts/other-facts';",
  "import { applyRecordsAction, recordsRead } from './records-registrations.ts';",
  "import { Effect } from 'effect';",
].join('\n');

const RUN_HANDLER =
  "{ run: Effect.fn('DemoLookupRead.run')(function* run(input, context) { return yield* context.call('provider', input); }) }";
const LOAD_HANDLER = '{ load: (input, context) => Effect.succeed({ evidence: { resultCount: 1 }, result: input }) }';
const BARE_HANDLER = '(input, context) => Effect.succeed({ evidence: { resultCount: 1 }, result: input })';
const PROVIDER_CALL = `declaredCall(providerFactsOperation, '${providerRequirement}')`;
const CORE_CALL = `declaredCall(coreOperations.legalEntityDetail, '${coreRequirement}')`;
const ACCESS_QUESTIONS =
  "{ write: canRun(applyRecordsAction), rows: canList(recordsRead), restricted: canSeeFields(recordsRead, 'demo.records.restricted') }";

interface ReadFixture {
  readonly accessQuestions?: string;
  readonly calls?: string;
  readonly definition: string;
  readonly extraImports?: string;
  readonly preamble?: string;
}

const readSource = (fixture: ReadFixture): string =>
  [
    readImports,
    fixture.extraImports ?? '',
    fixture.preamble ?? '',
    `export const ${readName} = defineRead(`,
    '  {',
    ...(fixture.accessQuestions === undefined ? [] : [`    accessQuestions: ${fixture.accessQuestions},`]),
    ...(fixture.calls === undefined ? [] : [`    calls: ${fixture.calls},`]),
    '    entrypoint: demoLookupEntrypoint,',
    `    readKey: '${entrypointKey}',`,
    '  },',
    `  ${fixture.definition},`,
    '  servicesForScope,',
    ');',
    '',
  ].join('\n');

// Whether the manifest covers each call is Core's registration check (`declaredCallsIssues`), so the
// gate reads no manifest: it judges the read file and the contract packages its calls import from.
const violations = (fixture: ReadFixture): readonly string[] =>
  readSdkFormViolations({
    readFile,
    readName,
    sources: new Map([
      [readFile, readSource(fixture)],
      [PROVIDER_PACKAGE_FILE, providerPackage],
      ['packages/other-contracts/package.json', otherPackage],
    ]),
  });

const BOTH_CALLS = `{ provider: ${PROVIDER_CALL}, assignees: ${CORE_CALL} }`;

/* A module package that publishes its generated module-api contract under its own subpath. */
const MODULE_PACKAGE_FILE = 'verticals/provider/package.json';
const PROVIDER_MODULE_SUBPATH = '@app/provider/api/provider-facts';
const NO_SUBPATH = 'is no public subpath of one contract package or module-api contract of one module';
const modulePackage = (exports: Readonly<Record<string, string>>): string =>
  JSON.stringify({ exports, name: '@app/provider' });
const moduleCall = (specifier: string, packages: readonly (readonly [string, string])[]): readonly string[] =>
  readSdkFormViolations({
    readFile,
    readName,
    sources: new Map([
      [
        readFile,
        readSource({
          calls: `{ provider: declaredCall(providerFactsModuleOperation, '${providerRequirement}') }`,
          definition: RUN_HANDLER,
          extraImports: `import { providerFactsOperation as providerFactsModuleOperation } from '${specifier}';`,
        }),
      ],
      [PROVIDER_PACKAGE_FILE, providerPackage],
      ...packages,
    ]),
  });

describe('the read SDK form gate', () => {
  it('accepts a bare handler', () => {
    expect(violations({ definition: BARE_HANDLER })).toEqual([]);
  });
  it('accepts { load }', () => {
    expect(violations({ definition: LOAD_HANDLER })).toEqual([]);
  });
  it('accepts { load } with accessQuestions', () => {
    expect(violations({ accessQuestions: ACCESS_QUESTIONS, definition: LOAD_HANDLER })).toEqual([]);
  });
  it('accepts { run } with a vertical call', () => {
    expect(violations({ calls: `{ provider: ${PROVIDER_CALL} }`, definition: RUN_HANDLER })).toEqual([]);
  });
  it('accepts { run } with a coreOperations call', () => {
    expect(violations({ calls: `{ assignees: ${CORE_CALL} }`, definition: RUN_HANDLER })).toEqual([]);
  });
  it('accepts { run } with both calls bound to a const and accessQuestions', () => {
    expect(
      violations({
        accessQuestions: ACCESS_QUESTIONS,
        calls: 'calls',
        definition: RUN_HANDLER,
        preamble: `const calls = ${BOTH_CALLS} as const;`,
      }),
    ).toEqual([]);
  });

  const refused: readonly (readonly [string, () => readonly string[], string])[] = [
    [
      'coreOperations imported from @app/core-runtime/sdk',
      () =>
        violations({
          calls: `{ assignees: declaredCall(sdkCoreOperations.legalEntityDetail, '${coreRequirement}') }`,
          definition: RUN_HANDLER,
          extraImports: "import { coreOperations as sdkCoreOperations } from '@app/core-runtime/sdk';",
        }),
      'must be coreOperations.<name> imported from @app/core-runtime/sdk/core',
    ],
    [
      'an operation imported from a /client subpath',
      () =>
        violations({
          calls: `{ provider: declaredCall(providerFactsClient, '${providerRequirement}') }`,
          definition: RUN_HANDLER,
          extraImports: "import { providerFactsClient } from '@app/provider-contracts/provider-facts/client';",
        }),
      'must not come from a /client subpath',
    ],
    ['calls on { load }', () => violations({ calls: BOTH_CALLS, definition: LOAD_HANDLER }), CALLS_ONLY_BESIDE_RUN],
    [
      'calls on a bare handler',
      () => violations({ calls: BOTH_CALLS, definition: BARE_HANDLER }),
      CALLS_ONLY_BESIDE_RUN,
    ],
    [
      'accessQuestions on a bare handler',
      () => violations({ accessQuestions: ACCESS_QUESTIONS, definition: BARE_HANDLER }),
      'accessQuestions stand only beside { load } or { run }',
    ],
    [
      'an access question that is no canRun/canList/canSeeFields call',
      () =>
        violations({
          accessQuestions: '{ write: { kind: "can_run", target: recordsRead } }',
          definition: LOAD_HANDLER,
        }),
      'accessQuestions.write must be',
    ],
    [
      'canSeeFields with a non-literal group',
      () =>
        violations({
          accessQuestions: '{ restricted: canSeeFields(recordsRead, groupKey) }',
          definition: LOAD_HANDLER,
        }),
      'accessQuestions.restricted must be',
    ],
    [
      'an extra key beside run',
      () =>
        violations({
          calls: BOTH_CALLS,
          definition: RUN_HANDLER.replace('{ run:', '{ finish: Effect.void, run:'),
        }),
      '{ run } must hold exactly the one run entry',
    ],
    [
      'a gateway import in a run read',
      () =>
        violations({
          calls: BOTH_CALLS,
          definition: RUN_HANDLER,
          extraImports:
            "import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';",
        }),
      'imports nothing from @app/shared-contracts/gateway-context-server',
    ],
    [
      'a contract client import in a run read',
      () =>
        violations({
          calls: BOTH_CALLS,
          definition: RUN_HANDLER,
          extraImports: "import { loadProviderFacts } from '@app/provider-contracts/provider-facts/client';",
        }),
      'imports no contract client',
    ],
    [
      'requireModuleOperation in a run read',
      () =>
        violations({
          calls: BOTH_CALLS,
          definition: RUN_HANDLER,
          preamble: "const lookup = requireModuleOperation('x');",
        }),
      'instead of using requireModuleOperation',
    ],
    [
      'a spread in calls',
      () => violations({ calls: `{ ...${BOTH_CALLS} }`, definition: RUN_HANDLER }),
      'calls must be an object literal of named entries',
    ],
  ];

  for (const [name, run, expected] of refused) {
    it(`refuses ${name}`, () => {
      const found = run();
      expect(
        found.some((violation) => violation.includes(expected)),
        found.join('\n'),
      ).toBe(true);
    });
  }

  describe('an operation reference a module package publishes', () => {
    const published = { './api/provider-facts': './shared/apis/provider-facts.ts' };

    it('accepts its generated module-api contract subpath', () => {
      expect(moduleCall(PROVIDER_MODULE_SUBPATH, [[MODULE_PACKAGE_FILE, modulePackage(published)]])).toEqual([]);
    });
    it('refuses a subpath that is not its generated module-api contract', () => {
      const found = moduleCall(PROVIDER_MODULE_SUBPATH, [
        [MODULE_PACKAGE_FILE, modulePackage({ './api/provider-facts': './src/api/provider-facts.read.ts' })],
      ]);
      expect(found.some((violation) => violation.includes(NO_SUBPATH))).toBe(true);
    });
    it('refuses a module-api contract published under a subpath other than its own name', () => {
      for (const [subpath, target] of [
        ['./api/provider-facts', './shared/apis/other-facts.ts'],
        ['./apis/provider-facts', './shared/apis/provider-facts.ts'],
      ] as const) {
        const found = moduleCall(`@app/provider${subpath.slice(1)}`, [
          [MODULE_PACKAGE_FILE, modulePackage({ [subpath]: target })],
        ]);
        expect(found.some((violation) => violation.includes(NO_SUBPATH))).toBe(true);
      }
    });
    it('refuses a subpath the module package does not export', () => {
      const found = moduleCall('@app/provider/api/other-facts', [[MODULE_PACKAGE_FILE, modulePackage(published)]]);
      expect(found.some((violation) => violation.includes(NO_SUBPATH))).toBe(true);
    });
    it('refuses a package name two module packages claim', () => {
      const found = moduleCall(PROVIDER_MODULE_SUBPATH, [
        [MODULE_PACKAGE_FILE, modulePackage(published)],
        ['verticals/provider-copy/package.json', modulePackage(published)],
      ]);
      expect(found.some((violation) => violation.includes(NO_SUBPATH))).toBe(true);
    });
  });

  it('refuses a declaredCall imported from elsewhere', () => {
    const source = readSource({ calls: BOTH_CALLS, definition: RUN_HANDLER }).replace(
      SDK_DECLARED_CALL_IMPORT,
      "import { declaredCall } from './local-sdk.ts';",
    );
    const found = readSdkFormViolations({
      readFile,
      readName,
      source,
      sources: new Map([[PROVIDER_PACKAGE_FILE, providerPackage]]),
    });
    expect(
      found.some((violation) => violation.includes('must be declaredCall(')),
      found.join('\n'),
    ).toBe(true);
  });
});

const seam = (candidate: ReadonlyMap<string, string>) => {
  const diagnostics: string[] = [];
  const valid = hasCompleteGeneratedModuleApiSeam(candidate, PRICING_SHARED_API_PATH, 'pricing', diagnostics);
  return { diagnostics: diagnostics.join('\n'), valid };
};

/* The same rules through the real generated seam of Pricing's current-supported-currencies read, written `{ load }`. */

describe('the read SDK form inside the generated module API seam', () => {
  const pricingRead = 'verticals/pricing/src/api/current-supported-currencies.read.ts';
  const retirementPackage = 'packages/customer-market-retirement-contracts/package.json';
  const requirementKey = 'commerce.pricing.requirement.quotation-verify-purchase-context';
  const loadHandler = '  { load: handleCurrentSupportedCurrencies },\n  currentSupportedCurrenciesPersistenceForScope,';
  const descriptorEnd = "    schemaVersion: '1',\n  },\n  { load: handleCurrentSupportedCurrencies },";
  const sdkImports = [
    SDK_DECLARED_CALL_IMPORT,
    "import { marketSubjectRestrictionsCurrentOperation } from '@app/customer-market-retirement-contracts/market-subject-restrictions-current';",
  ].join('\n');

  const pricingSources = Effect.gen(function* loadPricingSources() {
    const root = path.resolve(import.meta.dirname, '../..');
    const trees = yield* Effect.all(
      ['verticals/pricing', 'packages/pricing-contracts'].map((folder) => readPricingSourceTree(root, folder)),
    );
    return new Map([...trees.flat(), [retirementPackage, readFileSync(path.join(root, retirementPackage), 'utf-8')]]);
  });

  const withRunForm = (
    sources: ReadonlyMap<string, string>,
    readEdits: (read: string) => string,
  ): ReadonlyMap<string, string> => new Map([...sources, [pricingRead, readEdits(sources.get(pricingRead) ?? '')]]);

  const runRead = (read: string): string =>
    `${sdkImports}\n${read}`
      .replace(
        descriptorEnd,
        `    schemaVersion: '1',\n    calls: { subjectRestrictions: declaredCall(marketSubjectRestrictionsCurrentOperation, '${requirementKey}') },\n  },\n  { load: handleCurrentSupportedCurrencies },`,
      )
      .replace(
        loadHandler,
        '  { run: handleCurrentSupportedCurrencies },\n  currentSupportedCurrenciesPersistenceForScope,',
      );

  it.live('accepts a { run } read with a declared call and refuses its nearby controls', () =>
    Effect.gen(function* runFormSeam() {
      const sources = yield* pricingSources;
      const read = sources.get(pricingRead) ?? '';
      expect(read).toContain(loadHandler);
      expect(read).toContain(descriptorEnd);
      const why = (candidate: ReadonlyMap<string, string>) =>
        readSdkFormViolations({
          readFile: pricingRead,
          readName: 'currentSupportedCurrenciesRead',
          sources: candidate,
        }).join('\n');
      const accepted = seam(withRunForm(sources, runRead));
      expect(why(withRunForm(sources, runRead))).toBe('');
      expect(accepted.valid, accepted.diagnostics).toBe(true);
      // `{ run }` is judged by the bare handler rule, exactly as `{ load }` is.
      const notAHandler = seam(
        withRunForm(sources, (source) =>
          runRead(source).replace('{ run: handleCurrentSupportedCurrencies }', '{ run: undefined }'),
        ),
      );
      expect(notAHandler.valid).toBe(false);
      // Calls are refused beside `{ load }`.
      const callsOnLoad = withRunForm(sources, (source) =>
        runRead(source).replace(
          '{ run: handleCurrentSupportedCurrencies }',
          '{ load: handleCurrentSupportedCurrencies }',
        ),
      );
      expect(seam(callsOnLoad).valid).toBe(false);
      expect(why(callsOnLoad)).toContain(CALLS_ONLY_BESIDE_RUN);
      // A `{ run }` read builds no gateway call by hand.
      const handBuilt = withRunForm(
        sources,
        (source) =>
          `import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';\n${runRead(source)}`,
      );
      expect(seam(handBuilt).valid).toBe(false);
      expect(why(handBuilt)).toContain('imports nothing from @app/shared-contracts/gateway-context-server');
    }),
  );
});
