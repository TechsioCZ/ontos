import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import {
  hasCompleteGeneratedModuleRead,
  hasExistingOwnerReadHandlerMount,
} from '../generated-governed-http-boundary.mts';

const root = path.resolve(import.meta.dirname, '../..');
const owner = 'verticals/pricing';
const sources = new Map<string, string>();
const excluded = new Set(['node_modules', 'dist', '.output', '.modern', '.git', 'coverage', '.codex']);
const collect = (directory: string): void => {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !excluded.has(entry.name)) {
      collect(file);
    } else if (entry.isFile() && /\.(?:ts|json)$/u.test(file)) {
      sources.set(file, readFileSync(path.join(root, file), 'utf-8'));
    }
  }
};
collect(owner);
collect('packages/pricing-contracts');

const readFile = (name: string): string => `${owner}/src/api/${name}.read.ts`;
const accepts = (name: string, input: ReadonlyMap<string, string>, diagnostics?: string[]): boolean =>
  hasCompleteGeneratedModuleRead(input, readFile(name), owner, 'commerce.pricing', name, diagnostics);
const names = [...sources.keys()]
  .filter((file) => file.startsWith(`${owner}/src/api/`) && file.endsWith('.read.ts'))
  .map((file) => path.posix.basename(file, '.read.ts'));

for (const name of names) {
  it(`proves the actual Pricing ${name} original phased Read and factory`, () => {
    const diagnostics: string[] = [];
    expect(accepts(name, sources, diagnostics), diagnostics.join('\n')).toBe(true);
  });
}

const priceDefinition = 'price-definition';
const priceSchedule = 'price-schedule';
const priceResultLookup = 'price-result-lookup';
const exactPriceResolution = 'exact-price-resolution';
const quotationVerification = 'quotation-verification';

const mutations = [
  [
    priceDefinition,
    'a caller-authored company',
    'legalEntityId: context.scope.legalEntityId',
    'legalEntityId: input.legalEntityId',
  ],
  [
    priceDefinition,
    'the opposite tenant guard',
    'input.priceRef.tenantId !== trustedScope.tenantId',
    'input.priceRef.tenantId === trustedScope.tenantId',
  ],
  [
    priceDefinition,
    'a foreign lookup reference',
    'services.readCurrent(input.priceRef)',
    'services.readCurrent(foreign.priceRef)',
  ],
  [
    priceDefinition,
    'an additional foreign effect',
    'const result = yield* services.readCurrent',
    'yield* foreign.services.read(); const result = yield* services.readCurrent',
  ],
  [priceSchedule, 'a caller clock', 'DateTime.nowAsDate.pipe(', 'input.clock.pipe('],
  [priceSchedule, 'a different bound method', 'context.services.readSchedule,', 'context.services.foreignMethod,'],
  [
    priceSchedule,
    'a changed clock callback binding',
    'trustedOperationAt,\n',
    'trustedOperationAt: input.operationTime,\n',
  ],
  [
    'currency-support-result-lookup',
    'reordered original factory arguments',
    'ForScope(transaction, scope, compositionRevision)',
    'ForScope(scope, transaction, compositionRevision)',
  ],
  [
    'quantity-tier-result-lookup',
    'a substituted principal',
    'actingPrincipalId: trusted.principalId',
    'actingPrincipalId: input.principalId',
  ],
  [
    priceResultLookup,
    'a foreign prepare phase',
    'prepare: (input, context) => preparePriceResultCommit(input, context)',
    'prepare: (input, context) => foreignPrepare(input, context)',
  ],
  [
    priceResultLookup,
    'a foreign service factory',
    '  priceResultLookupServicesForScope,\n);',
    '  foreignServices,\n);',
  ],
  [
    exactPriceResolution,
    'caller scope instead of the admitted factory scope',
    'legalEntityId: context.services.legalEntityId',
    'legalEntityId: input.legalEntityId',
  ],
  [
    exactPriceResolution,
    'a scope replacement inside the native factory',
    'ForScope(transaction, scope, compositionRevision)',
    'ForScope(transaction, input.scope, compositionRevision)',
  ],
  [
    exactPriceResolution,
    'an unproved result evaluator',
    'Effect.map(evaluatePricingExplicitInput)',
    'Effect.map(foreignEvaluator)',
  ],
  [
    quotationVerification,
    'foreign scope during the original load',
    'loadVerification(input, context.services, context.scope)',
    'loadVerification(input, context.services, input.scope)',
  ],
  [
    quotationVerification,
    'a replaced transaction callback',
    'context.transaction((transaction)',
    'foreign.transaction((transaction)',
  ],
  [
    quotationVerification,
    'caller scope during the currentness recheck',
    'loadVerification(input, services, context.scope)',
    'loadVerification(input, services, input.scope)',
  ],
  [quotationVerification, 'different currentness evidence', '(context.loaded, current)', '(context.prepared, current)'],
] as const;

for (const [name, defect, before, after] of mutations) {
  it(`rejects ${defect} in the actual ${name} Read`, () => {
    const file = readFile(name);
    const original = sources.get(file) ?? '';
    const invalid = original.replace(before, after);
    expect(invalid).not.toBe(original);
    expect(accepts(name, new Map([...sources, [file, invalid]]))).toBe(false);
  });
}

const pureOwnerFile = `${owner}/src/services/broken-explicit-input.service.ts`;
const pureOwnerSource = sources.get(pureOwnerFile) ?? '';
const destructuredReason = 'const [subject, reason] =';
for (const [defect, before, after] of [
  ['a substituted pure helper', 'sourceInvalidReason(assessment)', 'foreignReason(assessment)'],
  ['a dynamic native value call', 'Schema.decodeOption(', 'Schema.foreignDecode('],
  ['a mutable destructured result', destructuredReason, 'let [subject, reason] ='],
  ['a spread destructuring claim', destructuredReason, 'const [subject, ...reason] ='],
  [
    'a reassigned tuple projection',
    'return checkedResult(knownInvalid(context, subject, reason,',
    'reason = input.reason; return checkedResult(knownInvalid(context, subject, reason,',
  ],
  ['a shadowed classifier input', destructuredReason, 'const assessment = foreign; const [subject, reason] ='],
  ['a substituted native namespace', "from 'effect'", "from './foreign-effect.ts'"],
] as const) {
  it(`rejects ${defect} in the original pure owner evaluator`, () => {
    const invalid = pureOwnerSource.replace(before, after);
    expect(invalid).not.toBe(pureOwnerSource);
    expect(accepts(exactPriceResolution, new Map([...sources, [pureOwnerFile, invalid]]))).toBe(false);
  });
}

const rootFile = `${owner}/api/index.ts`;
const rootSource = sources.get(rootFile) ?? '';
const supportBinding = 'pricingCommitmentConfirmationVerificationFactoryLive';
const supportFile = `${owner}/src/services/commitment-confirmation-verification.service.ts`;
const supportSource = sources.get(supportFile) ?? '';
const mountedRead = 'commitmentConfirmationVerificationReadApiLive';
const mount = `${mountedRead}.pipe(
  GovernedReadLayer.provide(governedReadRuntimeLive),
  Layer.provide(${supportBinding}),
),`;
const acceptsMount = (input: ReadonlyMap<string, string>, entry = mount): boolean =>
  hasExistingOwnerReadHandlerMount(entry, mountedRead, { ownerPath: owner, rootFile, sources: input });

it('proves the actual extra owner service Layer without replacing its factory or Core runtime', () => {
  expect(rootSource.replaceAll(/\s+/gu, '')).toContain(mount.replaceAll(/\s+/gu, ''));
  expect(acceptsMount(sources)).toBe(true);
});

for (const [file, before, after] of [
  [
    rootFile,
    "from '../src/services/commitment-confirmation-verification.service.ts'",
    "from '../../../foreign/service.ts'",
  ],
  [rootFile, "from '@modern-js/bff-effect/effect-edge'", "from './foreign-layer.ts'"],
  [supportFile, "from 'effect'", "from './foreign-effect.ts'"],
  [
    supportFile,
    'export const pricingCommitmentConfirmationVerificationFactoryLive',
    'export let pricingCommitmentConfirmationVerificationFactoryLive',
  ],
  [
    supportFile,
    '@app/pricing/services/commitment-confirmation-verification.service/PricingCommitmentConfirmationVerificationFactory',
    '@app/core-runtime/ReadRuntime',
  ],
  [
    supportFile,
    'Layer.succeed(\n  PricingCommitmentConfirmationVerificationFactory,',
    'Layer.succeed(\n  ReadRuntime,',
  ],
] as const) {
  it(`rejects a foreign or mutable owner dependency at ${file}: ${before}`, () => {
    const original = sources.get(file) ?? '';
    const invalid = original.replace(before, after);
    expect(invalid).not.toBe(original);
    expect(acceptsMount(new Map([...sources, [file, invalid]]))).toBe(false);
  });
}

it('rejects missing, duplicate and overriding native runtime provisions', () => {
  for (const invalid of [
    mount.replace(supportBinding, 'unboundSupport'),
    mount.replace('GovernedReadLayer.provide(governedReadRuntimeLive),', ''),
    mount.replace('governedReadRuntimeLive', supportBinding),
    mount.replace(
      `Layer.provide(${supportBinding}),`,
      `Layer.provide(${supportBinding}), Layer.provide(${supportBinding}),`,
    ),
    mount.replace(`Layer.provide(${supportBinding}),`, 'Layer.provide(governedReadRuntimeLive),'),
  ]) {
    expect(invalid).not.toBe(mount);
    expect(acceptsMount(sources, invalid)).toBe(false);
  }
  expect(acceptsMount(new Map([...sources, [supportFile, `${supportSource}\n${supportBinding} = replacement;`]]))).toBe(
    false,
  );
});
