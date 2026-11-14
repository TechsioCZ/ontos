import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import { hasCompleteGeneratedModuleRead } from '../generated-governed-http-boundary.mts';

const root = path.resolve(import.meta.dirname, '../..');
const owner = 'verticals/inventory';
const moduleId = 'commerce.inventory';
const sources = new Map<string, string>();
const excluded = new Set(['.git', '.modern', '.output', 'coverage', 'dist', 'node_modules']);
const collect = (directory: string): void => {
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !excluded.has(entry.name)) {
      collect(file);
    } else if (entry.isFile() && /\.(?:ts|mts|json)$/u.test(file)) {
      sources.set(file, readFileSync(path.join(root, file), 'utf-8'));
    }
  }
};
collect(owner);
sources.set(
  'packages/core-runtime/package.json',
  readFileSync(path.join(root, 'packages/core-runtime/package.json'), 'utf-8'),
);

const readFileFor = (read: string): string => `${owner}/src/api/${read}.read.ts`;
const accepts = (read: string, changed: ReadonlyMap<string, string> = sources): boolean =>
  hasCompleteGeneratedModuleRead(changed, readFileFor(read), owner, moduleId, read);
const mutate = (file: string, change: (source: string) => string): ReadonlyMap<string, string> => {
  const source = sources.get(file) ?? '';
  const next = change(source);
  expect(next, file).not.toBe(source);
  return new Map([...sources, [file, next]]);
};
const replace = (file: string, before: string, after: string): ReadonlyMap<string, string> =>
  mutate(file, (source) => source.replace(before, after));
const append = (file: string, statement: string): ReadonlyMap<string, string> =>
  mutate(file, (source) => `${source}\n${statement}`);

const backendRead = 'inventory-backend-configuration-current';
const conflictRead = 'inventory-source-conflict-detail';
const reconciliationRead = 'inventory-reconciliation-evidence';
const currentStockRead = 'current-stock-evidence-for-availability';
const stockSharingRead = 'stock-sharing-eligibility-resolution';
const catalogRead = 'catalog-to-stock-binding-resolution';
const commitmentRead = 'commitment-protection-verification';
const outcomeRead = 'inventory-effect-outcome';

/** Every bounded Inventory LOAD phase whose member, guard, fold and projection are proved. */
const acceptedReads = [
  backendRead,
  conflictRead,
  reconciliationRead,
  currentStockRead,
  stockSharingRead,
  catalogRead,
  commitmentRead,
  outcomeRead,
] as const;

it('proves the bounded Inventory LOAD phase of each accepted owner read', () => {
  for (const read of acceptedReads) {
    expect(accepts(read), read).toBe(true);
  }
});

const backendFind = 'context.services.findCurrent(input.customerConfigurationId)';
const backendSuccess =
  'onSome: (configuration) => Effect.succeed({ evidence: { resultCount: 1 }, result: { configuration } })';
const conflictFind = 'context.services.find(input.conflictRef)';
const conflictSuccess = 'onSome: (conflict) => Effect.succeed({ evidence: { resultCount: 1 }, result: { conflict } })';
const reconciliationGuard = 'ownerRefFor(input.query).tenantId !== context.scope.tenantId';
const reconciliationSuccess = 'onSome: (result) => Effect.succeed({ evidence: { resultCount: 1 }, result })';
const currentStockGuard = 'input.positionRef.tenantId !== context.scope.tenantId';
const currentStockBase = 'context.services.read(input.positionRef)';
const currentStockProjection = 'Effect.map((evidence) => ({ evidence: { resultCount: 1 }, result: { evidence } }))';
const stockSharingGuard = 'input.scope.positionRef.tenantId !== context.scope.tenantId';
const stockSharingContext = 'Schema.is(TrustedCurrentCommercePurchasingContextSchema)(input.commerceContextEvidence)';
const stockSharingProjection = 'Effect.map((decision) => ({ evidence: { resultCount: 1 }, result: { decision } }))';
const flatMapCall = 'Effect.flatMap(';
const optionMatchCall = 'Option.match({';
const foreignOptionMatch = 'ForeignOption.match({';
const foreignScope = 'foreignScope.tenantId';
const foreignReason = 'reason: foreignReason';
const countReplacement = 'resultCount: foreignCount';
const resultCountOne = 'resultCount: 1';
const optionMatchBracketCall = "Option['match']({";
const flatMapBypass = 'Effect.flatMap = bypass;';
const mapBypass = 'Effect.map = bypass;';
const catalogFind = 'context.services.findCurrentConfiguration(input.customerConfigurationId)';
const catalogResolve = 'context.services.resolve(input.demand)';
const evidenceCountOne = 'evidence: { resultCount: 1 },';
const evidenceCountForeign = 'evidence: { resultCount: foreignCount },';
const commitmentFind = 'context.services.findByRef(input.protectionRef)';
const outcomeReadBase = 'context.services.persistence.read(input.effectId)';

const readControls = [
  {
    changes: [
      [backendFind, 'context.services.forged(input.customerConfigurationId)'],
      [backendFind, 'foreign.services.findCurrent(input.customerConfigurationId)'],
      [backendFind, 'context.services.findCurrent(foreignConfigurationId)'],
      [flatMapCall, 'ForeignEffect.flatMap('],
      [flatMapCall, 'Effect.tap('],
      [flatMapCall, 'Effect.flatMap(fake), Effect.flatMap('],
      [optionMatchCall, foreignOptionMatch],
      [optionMatchCall, optionMatchBracketCall],
      [backendSuccess, backendSuccess.replace('{ configuration }', '{ unrelated: configuration }')],
      [backendSuccess, backendSuccess.replace('evidence: {', 'unrelated: {')],
      [
        backendSuccess,
        backendSuccess.replace(
          '{ evidence: { resultCount: 1 }, result: { configuration } }',
          '{ evidence: { resultCount: 1 }, ...configuration }',
        ),
      ],
      [resultCountOne, countReplacement],
      ["reason: 'No Inventory Backend is selected for this Customer Configuration'", foreignReason],
      [
        'context: ReadLoadContext<InventoryBackendConfigurationService>',
        'context: ReadLoadContext<ForeignConfigurationService>',
      ],
      [
        "from '../services/inventory-backend-configuration.service.ts'",
        "from '../services/foreign-configuration.service.ts'",
      ],
    ],
    file: backendRead,
    tails: [flatMapBypass, 'Option.match = bypass;', 'function shadow(Effect: unknown) {}'],
  },
  {
    changes: [
      [conflictFind, 'context.services.forged(input.conflictRef)'],
      [conflictFind, 'foreign.services.find(input.conflictRef)'],
      [conflictFind, 'context.services.find(foreignConflictRef)'],
      [optionMatchCall, foreignOptionMatch],
      [conflictSuccess, conflictSuccess.replace('{ conflict }', '[conflict]')],
      ["reason: 'Inventory Source Conflict was not found'", foreignReason],
      ['context: ReadLoadContext<InventorySourceConflictService>', 'context: ReadLoadContext<ForeignConflictService>'],
    ],
    file: conflictRead,
    tails: [flatMapBypass],
  },
  {
    changes: [
      [reconciliationGuard, 'ownerRefFor(input.query).tenantId === context.scope.tenantId'],
      [reconciliationGuard, 'ownerRefFor(input.query).tenantId !== foreignScope'],
      [
        `${reconciliationGuard} || context.scope.legalEntityId === undefined`,
        `${reconciliationGuard} || context.scope.legalEntityId !== undefined`,
      ],
      [`${reconciliationGuard} || context.scope.legalEntityId === undefined`, 'true'],
      [reconciliationGuard, 'foreignRefFor(input.query).tenantId !== context.scope.tenantId'],
      [
        '{ legalEntityId: context.scope.legalEntityId, tenantId: context.scope.tenantId }',
        `{ legalEntityId: context.scope.legalEntityId, tenantId: ${foreignScope} }`,
      ],
      ['.read(input.query, {', '.read(foreignQuery, {'],
      [optionMatchCall, foreignOptionMatch],
      [reconciliationSuccess, reconciliationSuccess.replace('result }', 'result: foreignResult }')],
      ["reason: 'Inventory reconciliation evidence was not found'", foreignReason],
      [
        'return context.services\n        .read(',
        'const observed = context.services.read(input.query);\n      return observed.pipe(',
      ],
    ],
    file: reconciliationRead,
    tails: ['notFound = fake;', '({ notFound } = attacker);', 'Option.match = bypass;'],
  },
  {
    changes: [
      [currentStockGuard, 'input.positionRef.tenantId === context.scope.tenantId'],
      [currentStockGuard, 'foreignRef.tenantId !== context.scope.tenantId'],
      [currentStockGuard, 'input.positionRef.tenantId !== foreignScope'],
      [currentStockGuard, 'true'],
      [currentStockGuard, `false && (${currentStockGuard})`],
      [currentStockGuard, `!(${currentStockGuard})`],
      [currentStockGuard, `(${currentStockGuard}) && input.positionRef.tenantId === 'untrusted'`],
      [currentStockBase, 'foreign.services.read(input.positionRef)'],
      [currentStockBase, 'context.services.forged(input.positionRef)'],
      [currentStockBase, 'context.services.read(foreignPositionRef)'],
      ['Effect.mapError(mapReadFailure)', 'ForeignEffect.mapError(mapReadFailure)'],
      ['Effect.mapError(mapReadFailure)', 'Effect.mapError(foreignMapper)'],
      ['Effect.mapError(mapReadFailure),', 'Effect.tap(mapReadFailure),'],
      [currentStockProjection, currentStockProjection.replace('{ evidence }', '{ unrelated: evidence }')],
      [currentStockProjection, currentStockProjection.replace(resultCountOne, countReplacement)],
    ],
    file: currentStockRead,
    tails: ['mapReadFailure = fake;', '({ mapReadFailure } = attacker);', mapBypass],
  },
  {
    changes: [
      [
        'input.commerceContextEvidence.sellingLegalEntityRef.resourceId !== context.scope.legalEntityId',
        'input.commerceContextEvidence.sellingLegalEntityRef.resourceId === context.scope.legalEntityId',
      ],
      [stockSharingContext, stockSharingContext.replace('Schema.is(', 'ForeignSchema.is(')],
      [stockSharingContext, 'Schema.is(UnknownCommerceContextSchema)(input.commerceContextEvidence)'],
      [stockSharingGuard, 'input.scope.positionRef.tenantId === context.scope.tenantId'],
      [stockSharingGuard, 'true'],
      ['return Effect.fail(scopeMismatch());', 'return Effect.fail(foreignFailure());'],
      ['context.services\n        .evaluate(', 'foreign.services\n        .evaluate('],
      [
        '.evaluate({ context: input.commerceContextEvidence, scope: input.scope })',
        '.evaluate({ context: foreignContext, scope: input.scope })',
      ],
      [stockSharingProjection, stockSharingProjection.replace('{ decision }', '{ unrelated: decision }')],
      [stockSharingProjection, stockSharingProjection.replace(resultCountOne, countReplacement)],
      ["reason: 'POSITION_SCOPE_MISMATCH'", foreignReason],
    ],
    file: stockSharingRead,
    tails: ['scopeMismatch = fake;', '({ scopeMismatch } = attacker);', mapBypass],
  },
  {
    changes: [
      [catalogFind, 'foreign.services.findCurrentConfiguration(input.customerConfigurationId)'],
      [catalogFind, 'context.services.forgeCurrentConfiguration(input.customerConfigurationId)'],
      [catalogFind, 'context.services.findCurrentConfiguration(foreignConfigurationId)'],
      [
        'input.demand.catalogSelection.productRef.tenantId !== context.scope.tenantId',
        'input.demand.catalogSelection.productRef.tenantId === context.scope.tenantId',
      ],
      ['configuration.tenantId !== context.scope.tenantId', 'configuration.tenantId === context.scope.tenantId'],
      [
        'configuration.customerConfigurationId !== input.customerConfigurationId',
        'configuration.customerConfigurationId !== configuration.customerConfigurationId',
      ],
      [
        'configuration.tenantId !== context.scope.tenantId ||\n              configuration.customerConfigurationId !== input.customerConfigurationId',
        'true',
      ],
      [catalogResolve, 'foreign.services.resolve(input.demand)'],
      [catalogResolve, 'context.services.forgeResolution(input.demand)'],
      [catalogResolve, 'context.services.resolve(foreignDemand)'],
      [
        "Effect.catchTag('CatalogToStockBindingRejected', failCatalogToStockBindingResolution)",
        "Effect.catchTag('CatalogToStockBindingRejected', foreignMapper)",
      ],
      [
        "Effect.catchTag('CatalogToStockBindingRejected', failCatalogToStockBindingResolution)",
        "Effect.catchTag('CatalogToStockBindingRejected', () => Effect.succeed(foreignEvidence))",
      ],
      ['Effect.mapError(mapResolutionError)', 'Effect.mapError(foreignMapper)'],
      ['Effect.map((resolution) => ({', 'Effect.tap((resolution) => ({'],
      [evidenceCountOne, evidenceCountForeign],
      ['                        resolution,\n', '                        resolution: foreignEvidence,\n'],
      ['Effect.flatMap(\n          Option.match({', 'ForeignEffect.flatMap(\n          Option.match({'],
      [optionMatchCall, optionMatchBracketCall],
    ],
    file: catalogRead,
    tails: [
      'notFound = fake;',
      'failCatalogToStockBindingResolution = () => Effect.succeed(foreignEvidence);',
      'Effect.catchTag = bypass;',
    ],
  },
  {
    changes: [
      [
        'input.protectionRef.tenantId !== context.scope.tenantId',
        'input.protectionRef.tenantId === context.scope.tenantId',
      ],
      [
        'input.reservationRef.tenantId !== context.scope.tenantId',
        'input.reservationRef.tenantId === context.scope.tenantId',
      ],
      [
        '!sameResourceRef(protection.confirmation.reservation.ref, input.reservationRef)',
        'sameResourceRef(protection.confirmation.reservation.ref, input.reservationRef)',
      ],
      [
        'protection.confirmation.reservation.origin.attemptId !== input.attemptId',
        'protection.confirmation.reservation.origin.attemptId !== protection.confirmation.reservation.origin.attemptId',
      ],
      [commitmentFind, 'foreign.services.findByRef(input.protectionRef)'],
      [commitmentFind, 'context.services.findForged(input.protectionRef)'],
      [commitmentFind, 'context.services.findByRef(foreignProtectionRef)'],
      ['onSome: Effect.succeed,', 'onSome: Effect.succeedForeign,'],
      ['new CommitmentProtectionRejected({', 'new ForeignRejection({'],
      [
        "? { _tag: 'PROTECTED', nextStep: 'CONTINUE', protection }",
        "? { _tag: 'PROTECTED', nextStep: 'CONTINUE', protection: foreignProtection }",
      ],
      [
        'return Effect.succeed({ evidence: { resultCount: 1 }, result });',
        'return Effect.succeed({ evidence: { resultCount: 1 }, result: foreignResult });',
      ],
      [evidenceCountOne, evidenceCountForeign],
      ['Effect.flatMap(\n          Option.match({', 'ForeignEffect.flatMap(\n          Option.match({'],
      [optionMatchCall, optionMatchBracketCall],
      [
        'if (\n            protection.confirmation.reservation.origin.attemptId !== input.attemptId ||\n            !sameResourceRef(protection.confirmation.reservation.ref, input.reservationRef)\n          ) {',
        'if (false) {',
      ],
    ],
    file: commitmentRead,
    tails: ['sameResourceRef = () => true;', '({ sameResourceRef } = attacker);', flatMapBypass],
  },
  {
    changes: [
      ['const resource = intentResource(input);', 'const resource = foreignResource;'],
      ['resource.tenantId !== context.scope.tenantId', 'resource.tenantId === context.scope.tenantId'],
      [
        'intentLegalEntityId(input) !== context.scope.legalEntityId',
        'intentLegalEntityId(input) === context.scope.legalEntityId',
      ],
      ['intentLegalEntityId(input)', 'foreignLegalEntityId(input)'],
      [outcomeReadBase, 'foreign.services.persistence.read(input.effectId)'],
      [outcomeReadBase, 'context.services.persistence.forge(input.effectId)'],
      [outcomeReadBase, 'context.services.persistence.read(foreignEffectId)'],
      ['context.services.ledger\n            .recover(', 'context.services.ledger\n            .forgeRecover('],
      [
        '.recover(context.scope.tenantId, input.effectId, input.intent)',
        '.recover(context.scope.tenantId, input.effectId, foreignIntent)',
      ],
      ["_tag: 'UNRESOLVED' as const,", '_tag: foreignTag as const,'],
      ['effectId: record.effectId,', 'effectId: foreignEffectId,'],
      [
        'Effect.map((result) => ({ evidence: { resultCount: 1 }, result }))',
        'Effect.map((result) => ({ evidence: { resultCount: 1 }, result: foreignResult }))',
      ],
      [evidenceCountOne, evidenceCountForeign],
      ['.pipe(Effect.flatMap(({ record }) => outcomeForRecord(record)))', '.pipe(Effect.map(() => foreignEvidence))'],
      ['Match.value(input.intent).pipe(', 'ForeignMatch.value(input.intent).pipe('],
    ],
    file: outcomeRead,
    tails: [
      'intentResource = () => foreignResource;',
      mapBypass,
      'outcomeForRecord = () => Effect.succeed(foreignEvidence);',
    ],
  },
] as const;

for (const control of readControls) {
  it(`rejects a forged ${control.file} load phase`, () => {
    const file = readFileFor(control.file);
    expect(accepts(control.file), control.file).toBe(true);
    for (const [before, after] of control.changes) {
      expect(accepts(control.file, replace(file, before, after)), `${control.file}: ${before}`).toBe(false);
    }
    for (const tail of control.tails) {
      expect(accepts(control.file, append(file, tail)), `${control.file}: ${tail}`).toBe(false);
    }
  });
}

const backendService = `${owner}/src/services/inventory-backend-configuration.service.ts`;
const backendPersistence = `${owner}/src/persistence/inventory-backend-configuration-repository.ts`;
const currentStockService = `${owner}/src/services/current-stock-evidence-for-availability.service.ts`;
const stockSharingService = `${owner}/src/services/stock-sharing-eligibility-service.ts`;
const backendMember = "readonly findCurrent: InventoryBackendConfigurationPersistence['findCurrent'];";
const currentStockMember = "read: Effect.fn('CurrentStockEvidenceForAvailability.read')(";
const stockSharingMember = "evaluate: Effect.fn('StockSharingEligibilityService.evaluate')(";

it('rejects a local error recovery that replaces the scoped service result', () => {
  const file = readFileFor(currentStockRead);
  const changed = mutate(
    file,
    (source) =>
      `${source.replace('Effect.mapError(mapReadFailure),', "Effect.catchTag('Unavailable', forgedRecovery),")}\nconst forgedRecovery = () => Effect.succeed(foreignEvidence);\n`,
  );
  expect(accepts(currentStockRead, changed)).toBe(false);
});

it('resolves the declared owner service contract instead of trusting its annotation', () => {
  for (const [before, after] of [
    ['export interface InventoryBackendConfigurationService {', 'interface InventoryBackendConfigurationService {'],
    [backendMember, 'readonly findCurrent: unknown;'],
    [backendMember, 'readonly findCurrent: () => Effect.succeed(null);'],
  ] as const) {
    expect(accepts(backendRead, replace(backendService, before, after)), before).toBe(false);
  }
  expect(
    accepts(
      backendRead,
      replace(
        backendPersistence,
        'export interface InventoryBackendConfigurationPersistence {',
        'interface InventoryBackendConfigurationPersistence {',
      ),
    ),
  ).toBe(false);
  expect(
    accepts(
      currentStockRead,
      replace(currentStockService, currentStockMember, currentStockMember.replace('Effect.fn(', 'foreignRead(')),
    ),
  ).toBe(false);
  expect(
    accepts(
      stockSharingRead,
      replace(stockSharingService, stockSharingMember, stockSharingMember.replace('Effect.fn(', 'foreignRead(')),
    ),
  ).toBe(false);
});

const catalogBindingDomain = `${owner}/shared/domain/catalog-to-stock-binding.ts`;
const catalogResolutionDomain = `${owner}/shared/domain/catalog-to-stock-binding-resolution.ts`;

it('resolves a nested owner lookup through the factory contract instead of trusting its members', () => {
  // The nested `resolve` member must delegate to a native member of the factory's own injected port.
  expect(
    accepts(
      catalogRead,
      replace(
        catalogBindingDomain,
        '  resolve: (demand: CatalogStockDemand) =>\n    bindings\n      .findCurrentByExactSelectionMeaning(',
        '  resolve: (demand: CatalogStockDemand) =>\n    foreignBindings\n      .findCurrentByExactSelectionMeaning(',
      ),
    ),
  ).toBe(false);
  // The factory's declared return type still has to declare a native Effect member.
  expect(
    accepts(
      catalogRead,
      replace(
        backendPersistence,
        '  ) => Effect.Effect<Option.Option<InventoryBackendConfiguration>, InventoryBackendConfigurationPersistenceUnavailable>;',
        '  ) => unknown;',
      ),
    ),
  ).toBe(false);
  // A recovery mapper that can succeed would replace the resolution the nested pipeline selected.
  expect(
    accepts(
      catalogRead,
      replace(
        catalogResolutionDomain,
        '  return Effect.fail(new CatalogToStockBindingResolutionFailure(fields));',
        '  return Effect.succeed(foreignEvidence);',
      ),
    ),
  ).toBe(false);
});
