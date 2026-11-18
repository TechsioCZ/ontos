import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { hasCompleteGeneratedModuleApiSeam, readSdkFormViolations } from '../generated-governed-http-boundary.mts';
import { PRICING_SHARED_API_PATH, readPricingSourceTree } from './module-entrypoint-boundary-fixtures.mts';

/* A synthetic owner: one read of `demo.module`, one provider contract package of `provider.module`. */

const ownerPath = 'verticals/demo';
const readFile = `${ownerPath}/src/api/demo-lookup.read.ts`;
const readName = 'demoLookupRead';
const entrypointKey = 'demo.module.api.demo-lookup';
const SDK_DECLARED_CALL_IMPORT = "import { declaredCall } from '@app/core-runtime/sdk';";
const PROVIDER_PACKAGE_FILE = 'packages/provider-contracts/package.json';
const MISSING_CALLERS = 'must list its permitted callers';
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

const PERSON_CALLER = "callers: [{ kind: 'person', legalEntityScope: 'subject' }],";

interface RequirementOverrides {
  readonly callers?: string;
  readonly entrypoint?: string;
  readonly key?: string;
  readonly providerModuleId?: string;
}

const requirementSource = (fixture: RequirementOverrides, fallbackKey: string, fallbackProvider: string): string =>
  [
    '      {',
    ...(fixture.callers === undefined || fixture.callers === '' ? [] : [`        ${fixture.callers}`]),
    "        condition: 'demo.module.condition.lookup',",
    `        entrypointKey: ${fixture.entrypoint ?? 'demoLookupRead.descriptor.entrypoint.entrypointKey'},`,
    "        evidence: ['demo.module.evidence.lookup'],",
    `        key: '${fixture.key ?? fallbackKey}',`,
    '        provider: {',
    "          entrypointKey: 'provider.module.api.provider-facts',",
    `          moduleId: ${fixture.providerModuleId ?? fallbackProvider},`,
    "          schemaVersion: '1',",
    '        },',
    '      },',
  ].join('\n');

const requirementsBlock = (provider: RequirementOverrides, core: RequirementOverrides): string =>
  [
    '  requirements: {',
    '    coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],',
    '    intrinsic: [],',
    '    operations: [',
    requirementSource({ callers: PERSON_CALLER, ...provider }, providerRequirement, 'providerModuleId'),
    requirementSource(core, coreRequirement, "'core.identity'"),
    '    ],',
    "    schemaVersion: '1',",
    '  },',
  ].join('\n');

const declarationHeader = [
  "import { defineOntosModuleManifest, ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY } from '@app/core-runtime';",
  "import { demoLookupRead } from './src/api/demo-lookup.read.ts';",
  '',
  "const providerModuleId = 'provider.module';",
  '',
].join('\n');

const RequirementsHomeSchema = Schema.Literals(['manifest', 'runtime-declaration']);
type RequirementsHome = typeof RequirementsHomeSchema.Type;

const declarationSources = (
  home: RequirementsHome,
  provider: RequirementOverrides = {},
  core: RequirementOverrides = {},
): readonly (readonly [string, string])[] => {
  const withRequirements = `${declarationHeader}export const demoManifest = defineOntosModuleManifest({\n  moduleId: 'demo.module',\n${requirementsBlock(provider, core)}\n});\n`;
  const withoutRequirements = `${declarationHeader}export const demoManifest = defineOntosModuleManifest({\n  moduleId: 'demo.module',\n});\n`;
  return home === 'manifest'
    ? [[`${ownerPath}/vertical.manifest.ts`, withRequirements]]
    : [
        [`${ownerPath}/vertical.manifest.ts`, withoutRequirements],
        [`${ownerPath}/vertical.runtime-declaration.ts`, withRequirements],
      ];
};

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
const CORE_CALL = `declaredCall(coreOperations.assignablePrincipals, '${coreRequirement}')`;
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

const violations = (
  fixture: ReadFixture,
  home: RequirementsHome = 'manifest',
  provider: RequirementOverrides = {},
  core: RequirementOverrides = {},
): readonly string[] =>
  readSdkFormViolations({
    entrypointKey,
    ownerPath,
    readFile,
    readName,
    sources: new Map([
      [readFile, readSource(fixture)],
      [PROVIDER_PACKAGE_FILE, providerPackage],
      ['packages/other-contracts/package.json', otherPackage],
      ...declarationSources(home, provider, core),
    ]),
  });

const BOTH_CALLS = `{ provider: ${PROVIDER_CALL}, assignees: ${CORE_CALL} }`;

describe('the read SDK form gate', () => {
  for (const home of RequirementsHomeSchema.literals) {
    describe(`with requirements in the ${home}`, () => {
      it('accepts a bare handler', () => {
        expect(violations({ definition: BARE_HANDLER }, home)).toEqual([]);
      });
      it('accepts { load }', () => {
        expect(violations({ definition: LOAD_HANDLER }, home)).toEqual([]);
      });
      it('accepts { load } with accessQuestions', () => {
        expect(violations({ accessQuestions: ACCESS_QUESTIONS, definition: LOAD_HANDLER }, home)).toEqual([]);
      });
      it('accepts { run } with a vertical call', () => {
        expect(violations({ calls: `{ provider: ${PROVIDER_CALL} }`, definition: RUN_HANDLER }, home)).toEqual([]);
      });
      it('accepts { run } with a coreOperations call', () => {
        expect(violations({ calls: `{ assignees: ${CORE_CALL} }`, definition: RUN_HANDLER }, home)).toEqual([]);
      });
      it('accepts { run } with both calls bound to a const and accessQuestions', () => {
        expect(
          violations(
            {
              accessQuestions: ACCESS_QUESTIONS,
              calls: 'calls',
              definition: RUN_HANDLER,
              preamble: `const calls = ${BOTH_CALLS} as const;`,
            },
            home,
          ),
        ).toEqual([]);
      });
    });
  }

  it('accepts a requirement entrypoint written as the literal key', () => {
    expect(
      violations({ calls: BOTH_CALLS, definition: RUN_HANDLER }, 'manifest', { entrypoint: `'${entrypointKey}'` }),
    ).toEqual([]);
  });

  const refused: readonly (readonly [string, () => readonly string[], string])[] = [
    [
      'an unknown requirement key',
      () =>
        violations({
          calls: `{ provider: declaredCall(providerFactsOperation, 'demo.module.requirement.unknown') }`,
          definition: RUN_HANDLER,
        }),
      'declares no single requirement demo.module.requirement.unknown',
    ],
    [
      'a requirement declared for another entrypoint',
      () =>
        violations({ calls: BOTH_CALLS, definition: RUN_HANDLER }, 'runtime-declaration', {
          entrypoint: "'demo.module.api.other-read'",
        }),
      `is not declared for ${entrypointKey}`,
    ],
    [
      'a vertical requirement without callers',
      () => violations({ calls: BOTH_CALLS, definition: RUN_HANDLER }, 'manifest', { callers: 'callers: [],' }),
      MISSING_CALLERS,
    ],
    [
      'a vertical requirement with no callers key',
      () =>
        violations({ calls: BOTH_CALLS, definition: RUN_HANDLER }, 'manifest', {
          callers: '',
        }),
      MISSING_CALLERS,
    ],
    [
      'callers on a core.* requirement',
      () => violations({ calls: BOTH_CALLS, definition: RUN_HANDLER }, 'manifest', {}, { callers: PERSON_CALLER }),
      'on a Core operation declares no callers',
    ],
    [
      'a Core operation covered by a vertical requirement',
      () =>
        violations(
          { calls: BOTH_CALLS, definition: RUN_HANDLER },
          'manifest',
          {},
          {
            providerModuleId: "'provider.module'",
          },
        ),
      'must name a core.* provider for a Core operation',
    ],
    [
      'a provider mismatch',
      () =>
        violations({
          calls: `{ provider: declaredCall(otherFactsOperation, '${providerRequirement}') }`,
          definition: RUN_HANDLER,
        }),
      'must name provider other.module',
    ],
    [
      'coreOperations imported from @app/core-runtime/sdk',
      () =>
        violations({
          calls: `{ assignees: declaredCall(sdkCoreOperations.assignablePrincipals, '${coreRequirement}') }`,
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
      'a non-literal requirement key',
      () =>
        violations({
          calls: '{ provider: declaredCall(providerFactsOperation, providerKey) }',
          definition: RUN_HANDLER,
          preamble: `const providerKey = '${providerRequirement}';`,
        }),
      'must name its requirement key as a string literal',
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

  it('refuses requirements declared in both the manifest and the runtime declaration', () => {
    const [[, declared] = ['', '']] = declarationSources('manifest');
    const found = readSdkFormViolations({
      entrypointKey,
      ownerPath,
      readFile,
      readName,
      sources: new Map([
        [readFile, readSource({ calls: BOTH_CALLS, definition: RUN_HANDLER })],
        [PROVIDER_PACKAGE_FILE, providerPackage],
        [`${ownerPath}/vertical.manifest.ts`, declared],
        [`${ownerPath}/vertical.runtime-declaration.ts`, declared],
      ]),
    });
    expect(
      found.some((violation) => violation.includes('exactly one of')),
      found.join('\n'),
    ).toBe(true);
  });

  it('refuses a declaredCall imported from elsewhere', () => {
    const source = readSource({ calls: BOTH_CALLS, definition: RUN_HANDLER }).replace(
      SDK_DECLARED_CALL_IMPORT,
      "import { declaredCall } from './local-sdk.ts';",
    );
    const found = readSdkFormViolations({
      entrypointKey,
      ownerPath,
      readFile,
      readName,
      source,
      sources: new Map([[PROVIDER_PACKAGE_FILE, providerPackage], ...declarationSources('manifest')]),
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

/* The same rules through the real generated seam of Pricing's quotation-verification read. */

describe('the read SDK form inside the generated module API seam', () => {
  const pricingRead = 'verticals/pricing/src/api/quotation-verification.read.ts';
  const pricingManifest = 'verticals/pricing/vertical.manifest.ts';
  const retirementPackage = 'packages/customer-market-retirement-contracts/package.json';
  const requirementKey = 'commerce.pricing.requirement.quotation-verify-purchase-context';
  const bareHandler = '  readVerification,\n  servicesForScope,';
  const descriptorEnd = "    schemaVersion: '1',\n  },\n  readVerification,";
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
    manifestEdits: (manifest: string) => string = (manifest) => manifest,
  ): ReadonlyMap<string, string> =>
    new Map([
      ...sources,
      [pricingRead, readEdits(sources.get(pricingRead) ?? '')],
      [pricingManifest, manifestEdits(sources.get(pricingManifest) ?? '')],
    ]);

  const runRead = (read: string): string =>
    `${sdkImports}\n${read}`
      .replace(
        descriptorEnd,
        `    schemaVersion: '1',\n    calls: { subjectRestrictions: declaredCall(marketSubjectRestrictionsCurrentOperation, '${requirementKey}') },\n  },\n  readVerification,`,
      )
      .replace(bareHandler, '  { run: readVerification },\n  servicesForScope,');
  const withCallers = (manifest: string): string =>
    manifest.replace(
      `        key: '${requirementKey}',`,
      `        callers: [{ kind: 'person', legalEntityScope: 'subject' }],\n        key: '${requirementKey}',`,
    );

  it.live('accepts a { run } read with a declared call and refuses its nearby controls', () =>
    Effect.gen(function* runFormSeam() {
      const sources = yield* pricingSources;
      const read = sources.get(pricingRead) ?? '';
      const manifest = sources.get(pricingManifest) ?? '';
      expect(read).toContain(bareHandler);
      expect(read).toContain(descriptorEnd);
      expect(withCallers(manifest)).not.toBe(manifest);
      const why = (candidate: ReadonlyMap<string, string>) =>
        readSdkFormViolations({
          entrypointKey: 'commerce.pricing.api.quotation-verification',
          ownerPath: 'verticals/pricing',
          readFile: pricingRead,
          readName: 'quotationVerificationRead',
          sources: candidate,
        }).join('\n');
      const accepted = seam(withRunForm(sources, runRead, withCallers));
      expect(why(withRunForm(sources, runRead, withCallers))).toBe('');
      expect(accepted.valid, accepted.diagnostics).toBe(true);
      // `{ run }` is judged by the bare handler rule, exactly as `{ load }` is.
      const notAHandler = seam(
        withRunForm(
          sources,
          (source) => runRead(source).replace('{ run: readVerification }', '{ run: undefined }'),
          withCallers,
        ),
      );
      expect(notAHandler.valid).toBe(false);
      // The manifest's real requirement lists no callers: the gate refuses the call until it does.
      expect(seam(withRunForm(sources, runRead)).valid).toBe(false);
      expect(why(withRunForm(sources, runRead))).toContain(MISSING_CALLERS);
      // Calls are refused beside `{ load }`.
      const callsOnLoad = withRunForm(
        sources,
        (source) => runRead(source).replace('{ run: readVerification }', '{ load: readVerification }'),
        withCallers,
      );
      expect(seam(callsOnLoad).valid).toBe(false);
      expect(why(callsOnLoad)).toContain(CALLS_ONLY_BESIDE_RUN);
      // A `{ run }` read builds no gateway call by hand.
      const handBuilt = withRunForm(
        sources,
        (source) =>
          `import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';\n${runRead(source)}`,
        withCallers,
      );
      expect(seam(handBuilt).valid).toBe(false);
      expect(why(handBuilt)).toContain('imports nothing from @app/shared-contracts/gateway-context-server');
    }),
  );
});
