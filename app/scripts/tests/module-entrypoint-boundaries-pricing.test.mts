import path from 'node:path';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  hasCompleteGeneratedModuleApiSeam,
  hasValidGovernedHttpCompositionRoot,
  hasOwnerLocalReadRequirementsStaged,
  hasPublishedGeneratedContractShim,
} from '../generated-governed-http-boundary.mts';
import {
  FAKE_HTTP_SOURCE_IMPORT,
  MODULE_API_HEADER,
  NATIVE_HTTP_SOURCE_IMPORT,
  NON_PROTECTED_READ_AUTHORIZATION,
  PRICING_HANDLER_PATH,
  PRICING_SHARED_API_PATH,
  PRIVACY_VERTICAL_PATH,
  PROTECTED_READ_AUTHORIZATION,
  carrierBlock,
  readPricingSourceTree,
} from './module-entrypoint-boundaries.fixture.mts';

it.live('counts the actual published Pricing read shim in exact owner inventory and rejects nearby escapes', () =>
  Effect.gen(function* actualPublishedPricingInventory() {
    const root = path.resolve(import.meta.dirname, '../..');
    const trees = yield* Effect.all(
      ['verticals/pricing', 'packages/pricing-contracts'].map((folder) => readPricingSourceTree(root, folder)),
    );
    const sources = new Map(trees.flat());
    const shared = PRICING_SHARED_API_PATH;
    const shimFile = 'verticals/pricing/shared/apis/quotation-verification.ts';
    const manifestFile = 'verticals/pricing/vertical.manifest.ts';
    const registrationFile = 'verticals/pricing/vertical.registration.ts';
    const packageFile = 'packages/pricing-contracts/package.json';
    const targetFile = 'packages/pricing-contracts/src/apis/quotation-verification.ts';
    const shim = sources.get(shimFile) ?? '';
    expect(shim.startsWith(MODULE_API_HEADER)).toBe(false);
    expect(hasPublishedGeneratedContractShim(sources, shimFile, shim)).toBe(true);
    const rootSource = sources.get(shared) ?? '';
    const handler = sources.get(PRICING_HANDLER_PATH) ?? '';
    const headerAnnotation = ".annotate(HttpApi.HeadersParseOptions, { onExcessProperty: 'ignore' })";
    expect(rootSource.includes(headerAnnotation)).toBe(true);
    expect(hasValidGovernedHttpCompositionRoot(rootSource, handler)).toBe(true);
    for (const invalid of [
      rootSource.replace('HttpApi.HeadersParseOptions', 'HttpApi.UnknownParseOptions'),
      rootSource.replace("from '@modern-js/bff-effect/effect-client'", "from './fake-http.ts'"),
      rootSource.replace(headerAnnotation, ".annotate(HttpApi.HeadersParseOptions, { onExcessProperty: 'error' })"),
      rootSource.replace(headerAnnotation, '.annotate(HttpApi.HeadersParseOptions, { ...untrusted })'),
      rootSource.replace(headerAnnotation, '.annotate(HttpApi.HeadersParseOptions, { onExcessProperty: configured })'),
      rootSource.replace(headerAnnotation, `${headerAnnotation}.pipe(unknownOperator)`),
      rootSource.replace("import { identity } from 'effect'", "import { identity } from './fake-effect.ts'"),
    ]) {
      expect(invalid).not.toBe(rootSource);
      expect(hasValidGovernedHttpCompositionRoot(invalid, handler)).toBe(false);
    }
    const diagnostics: string[] = [];
    expect(hasCompleteGeneratedModuleApiSeam(sources, shared, 'pricing', diagnostics), diagnostics.join('\n')).toBe(
      true,
    );
    // The transitional v2 shape (O62, O68): the same protected read with no legacy permission target
    // and no positional resolver still satisfies the seam, including the empty trailing slot the
    // removal leaves behind (a trailing comma) and the explicit `undefined` placeholder that keeps a
    // later executable-policy argument in position.
    const readPath = 'verticals/pricing/src/api/quotation-verification.read.ts';
    const read = sources.get(readPath) ?? '';
    const withoutResolver = read
      .replace("    permissionTarget: 'module',\n", '')
      .replace("  () => ({ kind: 'module', moduleId: MODULE_KEY }),\n", '');
    expect(withoutResolver).not.toContain('permissionTarget');
    expect(withoutResolver).toContain('  servicesForScope,\n);');
    const v2Diagnostics: string[] = [];
    expect(
      hasCompleteGeneratedModuleApiSeam(
        new Map([...sources, [readPath, withoutResolver]]),
        shared,
        'pricing',
        v2Diagnostics,
      ),
      v2Diagnostics.join('\n'),
    ).toBe(true);
    const withPlaceholders = withoutResolver.replace(
      '  servicesForScope,\n);',
      '  servicesForScope,\n  undefined,\n  undefined,\n  [],\n);',
    );
    expect(withPlaceholders).not.toBe(withoutResolver);
    expect(
      hasCompleteGeneratedModuleApiSeam(new Map([...sources, [readPath, withPlaceholders]]), shared, 'pricing'),
    ).toBe(true);
    // Negative control: a legacy classification still has to name the permission target it is decided by,
    // so the same removal on a non-`protected` entrypoint is refused.
    const legacyRead = withoutResolver.replace(PROTECTED_READ_AUTHORIZATION, NON_PROTECTED_READ_AUTHORIZATION);
    expect(legacyRead).not.toBe(withoutResolver);
    expect(hasCompleteGeneratedModuleApiSeam(new Map([...sources, [readPath, legacyRead]]), shared, 'pricing')).toBe(
      false,
    );
    // Module-to-module reads (DESIGN D5): a protected read whose only access carrier is `accessActor` decides
    // through the access gate like a declared read, so it needs no legacy target either. The pricing read
    // declares its module callers only, then the same carrier-free and non-protected variants must fail.
    const actorOnlyRead = withoutResolver.replace(carrierBlock('accessDeclaration'), '');
    expect(actorOnlyRead).not.toContain('accessDeclaration');
    expect(actorOnlyRead).toContain('accessActor: {');
    const actorDiagnostics: string[] = [];
    expect(
      hasCompleteGeneratedModuleApiSeam(
        new Map([...sources, [readPath, actorOnlyRead]]),
        shared,
        'pricing',
        actorDiagnostics,
      ),
      actorDiagnostics.join('\n'),
    ).toBe(true);
    const carrierless = actorOnlyRead.replace(carrierBlock('accessActor'), '');
    expect(carrierless).not.toContain('accessActor');
    expect(carrierless).not.toContain('accessDeclaration');
    expect(hasCompleteGeneratedModuleApiSeam(new Map([...sources, [readPath, carrierless]]), shared, 'pricing')).toBe(
      false,
    );
    const actorNonProtected = actorOnlyRead.replace(PROTECTED_READ_AUTHORIZATION, NON_PROTECTED_READ_AUTHORIZATION);
    expect(actorNonProtected).not.toBe(actorOnlyRead);
    expect(
      hasCompleteGeneratedModuleApiSeam(new Map([...sources, [readPath, actorNonProtected]]), shared, 'pricing'),
    ).toBe(false);
    const pricingReadFile = 'verticals/pricing/src/api/current-pricing-decision.read.ts';
    const requirementsFile = 'verticals/pricing/src/integrations/pricing-operation-requirements.ts';
    const pricingRead = sources.get(pricingReadFile) ?? '';
    const requirements = sources.get(requirementsFile) ?? '';
    // Exception 3: Current Pricing Decision is a staged Read without a service factory, so its phases bind the
    // owner requirements record directly instead of passing it as main's factory option.
    const requirementsBinding = 'currentPricingDecisionRequirements';
    const acceptsFactory = (changed: ReadonlyMap<string, string>) =>
      hasOwnerLocalReadRequirementsStaged(changed, pricingReadFile, 'verticals/pricing', requirementsBinding);
    expect(acceptsFactory(sources)).toBe(true);
    const invalidOptions: readonly (readonly [string, string])[] = [
      [pricingReadFile, `${pricingRead}\n${requirementsBinding} = suppliedRequirements;`],
      [pricingReadFile, `${pricingRead}\nconst { ${requirementsBinding} } = supplied;`],
      [
        pricingReadFile,
        pricingRead.replace(
          `  ${requirementsBinding},\n  requirePricingSubjectOperation,`,
          `  ${requirementsBinding} as requirements,\n  requirePricingSubjectOperation,`,
        ),
      ],
      [pricingReadFile, pricingRead.replace('  () => Effect.succeed({}),\n);', '  foreignServices,\n);')],
      [
        pricingReadFile,
        pricingRead.replace(
          "from '../integrations/pricing-operation-requirements.ts'",
          "from '../../../foreign/pricing-operation-requirements.ts'",
        ),
      ],
      [
        requirementsFile,
        requirements.replace(
          'export const currentPricingDecisionRequirements',
          'export let currentPricingDecisionRequirements',
        ),
      ],
      [requirementsFile, requirements.replace('assignedGroupCompatibility:', '[computedRequirement]:')],
      [
        requirementsFile,
        requirements.replace(
          "assignedGroupCompatibility: 'commerce.pricing.requirement.current-pricing-decision-assigned-group-compatibility'",
          'assignedGroupCompatibility: () => capability',
        ),
      ],
      [
        requirementsFile,
        requirements.replace(
          'export const currentPricingDecisionRequirements = {',
          'export const currentPricingDecisionRequirements = { ...unproven,',
        ),
      ],
      [requirementsFile, requirements.replace('} as const;', '};')],
      [requirementsFile, `${requirements}\nconst escaped = currentPricingDecisionRequirements;`],
      [requirementsFile, `${requirements}\ncapture(currentPricingDecisionRequirements);`],
    ];
    for (const [file, invalid] of invalidOptions) {
      expect(invalid).not.toBe(sources.get(file));
      expect(acceptsFactory(new Map([...sources, [file, invalid]])), invalid).toBe(false);
    }
    const invalidSources: readonly (readonly [string, string])[] = [
      [shimFile, `${shim}\nexport const runtime = true;`],
      [shimFile, shim.replace('@app/pricing-contracts/quotation-verification', '@app/pricing/src/private')],
      [
        manifestFile,
        (sources.get(manifestFile) ?? '').replace("'quotation-verification': QuotationVerificationApi,", ''),
      ],
      [
        registrationFile,
        (sources.get(registrationFile) ?? '').replace(
          "'quotation-verification': () => import('./src/api/quotation-verification-client.ts'),",
          '',
        ),
      ],
      [
        manifestFile,
        (sources.get(manifestFile) ?? '').replace(
          "'quotation-verification': QuotationVerificationApi,",
          "'quotation-verification': CurrentSupportedCurrenciesApi,",
        ),
      ],
      [
        packageFile,
        (sources.get(packageFile) ?? '').replace('"packageName": "@app/pricing"', '"packageName": "@app/wrong-owner"'),
      ],
      [targetFile, (sources.get(targetFile) ?? '').replace(NATIVE_HTTP_SOURCE_IMPORT, FAKE_HTTP_SOURCE_IMPORT)],
      [
        targetFile,
        (sources.get(targetFile) ?? '').replace('export const QuotationVerificationApi =', 'export const WrongApi ='),
      ],
    ];
    for (const [file, invalid] of invalidSources) {
      expect(invalid).not.toBe(sources.get(file));
      const changed = new Map([...sources, [file, invalid]]);
      expect(hasCompleteGeneratedModuleApiSeam(changed, shared, 'pricing')).toBe(false);
    }
  }),
);

it.live('accepts the reviewed Privacy notice-presentation GET companion only as its exact pinned text', () =>
  Effect.gen(function* actualPrivacyNoticePresentationCompanion() {
    const root = path.resolve(import.meta.dirname, '../..');
    const sources = new Map(yield* readPricingSourceTree(root, PRIVACY_VERTICAL_PATH));
    const shared = 'verticals/privacy/shared/api.ts';
    const contractFile = 'verticals/privacy/shared/apis/notice-presentation.ts';
    const serverFile = 'verticals/privacy/api/notice-presentation-read-server.ts';
    const diagnostics: string[] = [];
    expect(hasCompleteGeneratedModuleApiSeam(sources, shared, 'privacy', diagnostics), diagnostics.join('\n')).toBe(
      true,
    );
    const contract = sources.get(contractFile) ?? '';
    const server = sources.get(serverFile) ?? '';
    expect(contract).toContain("HttpApiEndpoint.get('present'");
    expect(server).toContain(".handle('present'");
    const invalidSources: readonly (readonly [string, string])[] = [
      [contractFile, contract.replace('/notices/:noticeVersionId/presentation', '/notices/:noticeVersionId/other')],
      [contractFile, contract.replace("HttpApiEndpoint.get('present'", "HttpApiEndpoint.get('presentAny'")],
      [serverFile, server.replace("x-correlation-id'", "x-other-id'")],
      [serverFile, server.replace('authenticateOperationPrincipal(', 'authenticateUnverifiedPrincipal(')],
      [serverFile, server.replace("'cache-control', 'no-store'", "'cache-control', 'public'")],
      [serverFile, `${server}\nexport const extraPresentationSurface = true;`],
    ];
    for (const [file, invalid] of invalidSources) {
      expect(invalid).not.toBe(sources.get(file));
      expect(hasCompleteGeneratedModuleApiSeam(new Map([...sources, [file, invalid]]), shared, 'privacy')).toBe(false);
    }
  }),
);
