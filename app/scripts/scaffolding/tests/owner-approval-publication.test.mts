import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  hasNativeActionPrincipalComposition,
  hasOwnerActionApprovalPublication,
  inspectOwnerActionApprovalMount,
  inspectOwnerApprovalApiType,
} from '../../generated-governed-http-boundary.mts';
import {
  OWNER_APPROVAL_AUTHENTICATION_SUPPORT_IMPORT,
  acceptOwnedRedemptionReexport,
  consolidateOwnerApprovalAuthenticationImport,
  hasOwnedRedemptionReexportTarget,
  parseOwnedRedemptionReexport,
  publishOwnerApprovalLoader,
  publishOwnerApprovalManifest,
  publishOwnerApprovalSharedApi,
} from '../microvertical-action-boundary/owner-approval-publication.mts';
import { planPublishedActionBoundaryScaffold } from '../microvertical-action-boundary/scaffold.mts';
import { discoverOntosModuleEffect } from '../shared.mts';
import { write } from './fixture-files.mts';
import { withCreatedFixture } from './fixture-ownership.mts';

const appRoot = path.resolve(import.meta.dirname, '../../..');
const customerContextOwner = 'commerce-customer-context';
const cartOwner = 'commerce-cart';
const financeOwner = 'finance-billing';
const partyOwner = 'party-registry';
const priceGroupOwner = 'price-group-catalog';
const redemptionFile = 'api/auth/gateway-assertion-redemption.ts';
const owners = [
  'assortment',
  'catalog',
  cartOwner,
  customerContextOwner,
  'commerce-market-catalog',
  'commerce-order',
  'crm',
  'crm-activities',
  'facility-operations',
  financeOwner,
  'inventory',
  'legal-agreements',
  'merchandise',
  partyOwner,
  'payment',
  'payment-term-catalog',
  priceGroupOwner,
  'pricing',
  'privacy',
  'projects',
  'promotion',
  'property-leasing',
  'property-portfolio',
  'sales-insights',
  'sales-pipeline',
  'storefront-registry',
  'tagging',
  'tax',
  'work-tasks',
  'workforce',
] as const;
const sources = new Map<string, string>();
const collect = (file: string): void => {
  if (sources.has(file)) {
    return;
  }
  const source = readFileSync(file, 'utf-8');
  sources.set(file, source);
  const owner = path.join(
    appRoot,
    'verticals',
    path.relative(path.join(appRoot, 'verticals'), file).split('/')[0] ?? '',
  );
  for (const entry of source.matchAll(/\bfrom\s*['"](?<file>\.\.?\/[^'"]+\.ts)['"]/gu)) {
    const imported = path.resolve(path.dirname(file), entry.groups?.['file'] ?? '');
    if (imported.startsWith(`${owner}/`)) {
      collect(imported);
    }
  }
};
for (const owner of owners) {
  const directory = path.join(appRoot, 'verticals', owner);
  collect(path.join(directory, 'api/index.ts'));
  for (const file of readdirSync(directory)) {
    if (/^vertical\.(?:manifest|registration|runtime-declaration)\.ts$/u.test(file)) {
      collect(path.join(directory, file));
    }
  }
}
const ownerFile = (owner: string, file: string): string => path.join(appRoot, 'verticals', owner, file);

it('covers every owner whose shared API publishes the owner Action approval API', () => {
  const verticals = path.join(appRoot, 'verticals');
  const published = readdirSync(verticals, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((owner) => {
      try {
        return readFileSync(path.join(verticals, owner, 'shared/api.ts'), 'utf-8').includes(
          '.addHttpApi(OwnerActionApprovalApi)',
        );
      } catch {
        return false;
      }
    });
  expect([...owners].toSorted()).toEqual(published.toSorted());
});
const sourceOf = (owner: string, file: string): string => sources.get(ownerFile(owner, file)) ?? '';
const redemptionContext = (owner: string, file: string) => ({
  ownerPath: path.join(appRoot, 'verticals', owner),
  rootFile: file,
  sources,
});
const rootFile = 'api/index.ts';
const sharedFile = 'shared/api.ts';
const httpImport =
  "import { makeOwnerActionApproveHandler, makeOwnerActionInspectHandler } from '@app/core-runtime/access/approvals/owner-http';";
const standaloneAuthImport =
  "import { authenticateOperationPrincipal as authenticateOwnerApprovalPrincipal } from './auth/action-principal.ts';";
const principalImport =
  "import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';";
const boundOwnerApprovalGroup = "HttpApiBuilder.group(crmApi, 'ownerActionApprovals', (handlers) =>";
const approveHandlerCall = "handle('approve', makeOwnerActionApproveHandler(authenticateOwnerApprovalPrincipal))";
const inspectHandlerCall = "handle('inspect', makeOwnerActionInspectHandler(authenticateOwnerApprovalPrincipal))";
const supportStart = '// <generated-governed-http-handler-support-imports>';
const supportEnd = '// </generated-governed-http-handler-support-imports>';
const authFixture = [
  httpImport,
  standaloneAuthImport,
  supportStart,
  principalImport,
  supportEnd,
  'const manual = original;',
].join('\n');

it('canonically combines the two original authentication bindings without changing manual root code', () => {
  const combined = consolidateOwnerApprovalAuthenticationImport(authFixture);
  expect(combined).toBe(
    [
      httpImport,
      supportStart,
      OWNER_APPROVAL_AUTHENTICATION_SUPPORT_IMPORT,
      supportEnd,
      'const manual = original;',
    ].join('\n'),
  );
  expect(consolidateOwnerApprovalAuthenticationImport(combined)).toBe(combined);
  expect(consolidateOwnerApprovalAuthenticationImport(`${httpImport}\n${standaloneAuthImport}`)).toBe(
    `${httpImport}\n${standaloneAuthImport}`,
  );
  const native = authFixture
    .replace(supportStart, '')
    .replace(supportEnd, '')
    .replace(' as GovernedActionPrincipalVerifierLive', '');
  const nativeCombined = consolidateOwnerApprovalAuthenticationImport(native);
  expect(nativeCombined).toContain(
    'ActionPrincipalVerifierLive, authenticateOperationPrincipal as authenticateOwnerApprovalPrincipal',
  );
  expect(consolidateOwnerApprovalAuthenticationImport(nativeCombined)).toBe(nativeCombined);
});

it('refuses duplicate, substituted and developer-authored authentication import claims', () => {
  for (const invalid of [
    `${authFixture}\n${standaloneAuthImport}`,
    authFixture.replace(
      'ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive',
      'ForeignVerifier as GovernedActionPrincipalVerifierLive',
    ),
    authFixture.replace(
      'ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive',
      'ActionPrincipalVerifierLive as OtherVerifier',
    ),
    authFixture.replace(principalImport, `${principalImport}\n${principalImport}`),
    authFixture.replace(principalImport, principalImport.replace(' }', ', unexpected }')),
  ]) {
    expect(invalid).not.toBe(authFixture);
    expect(() => consolidateOwnerApprovalAuthenticationImport(invalid)).toThrow();
  }
});

const inspect = (owner: string, root: string, inputs: ReadonlyMap<string, string> = sources) =>
  inspectOwnerActionApprovalMount(sourceOf(owner, sharedFile), root, owner, {
    ownerPath: path.dirname(ownerFile(owner, 'vertical.manifest.ts')),
    rootFile: ownerFile(owner, rootFile),
    sources: inputs,
  });

it('publishes the original platform API in both the native value and explicit owner group union', () => {
  for (const owner of ['catalog', 'inventory']) {
    const file = ownerFile(owner, sharedFile);
    const original = sourceOf(owner, sharedFile).replaceAll(/\s*\|\s*typeof OwnerActionApprovalApi\b/gu, '');
    const published = publishOwnerApprovalSharedApi(original);
    const apiType = inspectOwnerApprovalApiType(published);
    expect(apiType.kind).toBe('explicit');
    expect(apiType.kind === 'explicit' && apiType.members.includes('OwnerActionApprovalApi')).toBe(true);
    expect(published).toContain('.addHttpApi(OwnerActionApprovalApi)');
    expect(publishOwnerApprovalSharedApi(published)).toBe(published);
    expect(hasOwnerActionApprovalPublication(new Map([...sources, [file, published]]), file)).toBe(true);
    expect(hasOwnerActionApprovalPublication(new Map([...sources, [file, original]]), file)).toBe(false);
    for (const invalid of [
      original.replace('Groups : never', 'Groups : unknown'),
      original.replace('infer Groups', 'infer ForeignGroups'),
      original.replace('HttpApi.HttpApi<string, infer Groups>', 'Foreign.HttpApi<string, infer Groups>'),
      original.replace('type GroupsOf<Api>', 'type GroupsOf<Api> = unknown; type GroupsOf<Api>'),
    ]) {
      expect(invalid).not.toBe(original);
      expect(inspectOwnerApprovalApiType(invalid)).toEqual({ kind: 'invalid' });
      expect(() => publishOwnerApprovalSharedApi(invalid)).toThrow();
    }
    const duplicate = published.replace(
      'typeof OwnerActionApprovalApi',
      'typeof OwnerActionApprovalApi | typeof OwnerActionApprovalApi',
    );
    expect(inspectOwnerApprovalApiType(duplicate)).toEqual({ kind: 'invalid' });
    expect(() => publishOwnerApprovalSharedApi(duplicate)).toThrow();
  }
});

it('accepts actual native verifier/composition outputs independently of formatting, never an unused or foreign layer', () => {
  const authFile = 'api/auth/action-principal.ts';
  for (const owner of owners) {
    expect(hasNativeActionPrincipalComposition(sourceOf(owner, authFile)), owner).toBe(true);
  }
  const source = sourceOf(customerContextOwner, authFile);
  const merged = 'Layer.mergeAll(GatewayPrincipalVerifierLive, ActiveApplicationCompositionConfigLive)';
  expect(source).toContain(merged);
  for (const invalid of [
    source.replace(merged, 'Layer.mergeAll(GatewayPrincipalVerifierLive)'),
    source.replace(merged, 'Layer.mergeAll(GatewayPrincipalVerifierLive, foreignComposition)'),
    source.replace(
      merged,
      'ForeignLayer.mergeAll(GatewayPrincipalVerifierLive, ActiveApplicationCompositionConfigLive)',
    ),
    source.replace(
      merged,
      'Layer.mergeAll(GatewayPrincipalVerifierLive, ActiveApplicationCompositionConfigLive, ActiveApplicationCompositionConfigLive)',
    ),
    source.replace(merged, 'Layer.mergeAll(GatewayPrincipalVerifierLive, ...externalLayers)'),
    source.replace('modules/active-application-composition', 'modules/foreign-composition'),
    `${source}\nActiveApplicationCompositionConfigLive = foreign;\n`,
    `${source}\nfunction shadow(Layer) {}\n`,
    `${source.replace(merged, 'Layer.mergeAll(GatewayPrincipalVerifierLive)')}\nconst unused = ${merged};\n`,
  ]) {
    expect(invalid).not.toBe(source);
    expect(hasNativeActionPrincipalComposition(invalid)).toBe(false);
  }
});

it('preserves original owner technical redemption reexports without accepting aliases or foreign service factories', () => {
  for (const owner of [
    cartOwner,
    customerContextOwner,
    'commerce-order',
    'crm',
    financeOwner,
    'legal-agreements',
    partyOwner,
    priceGroupOwner,
    'property-leasing',
    'privacy',
  ]) {
    const file = ownerFile(owner, redemptionFile);
    const source = sources.get(file) ?? '';
    const reexported = parseOwnedRedemptionReexport(source);
    expect(reexported).toBeDefined();
    if (reexported === undefined) {
      return;
    }
    const targetFile = path.resolve(path.dirname(file), reexported.file);
    const target = sources.get(targetFile) ?? '';
    const context = redemptionContext(owner, targetFile);
    expect(hasOwnedRedemptionReexportTarget(source, target, owner, reexported.names, context), owner).toBe(true);
    for (const [index, changed] of [
      target.replace('GatewayAssertionRedemptionService,', 'ForeignRedemptionService,'),
      target.replaceAll("from 'effect'", "from './foreign-effect.ts'"),
      target.replace('export const GatewayAssertionRedemptionLive', 'const GatewayAssertionRedemptionLive'),
      `${target}\nGatewayAssertionRedemptionLive = foreign;\n`,
      `${target}\nfunction shadow(Layer) {}\n`,
      `${target}\n// @ontos-action-boundary-owner foreign-owner\n`,
    ].entries()) {
      expect(changed).not.toBe(target);
      expect(
        hasOwnedRedemptionReexportTarget(source, changed, owner, reexported.names, context),
        `${owner}/${index}`,
      ).toBe(false);
    }
    for (const changed of [
      source.replace('GatewayAssertionRedemptionLive', 'GatewayAssertionRedemptionLive as OtherLayer'),
      `${source}\nexport { unknown } from './foreign.ts';\n`,
      source.replace(
        'GatewayAssertionRedemptionLive',
        'GatewayAssertionRedemptionLive, GatewayAssertionRedemptionLive',
      ),
    ]) {
      expect(changed).not.toBe(source);
      expect(parseOwnedRedemptionReexport(changed)).toBeUndefined();
    }
  }
});

it('follows an owner database reexport only to its original immutable native Layer and service', () => {
  for (const [owner, relative] of [
    [partyOwner, 'src/db/client.ts'],
    [priceGroupOwner, 'src/database/client.ts'],
  ] as const) {
    const adapterFile = ownerFile(owner, redemptionFile);
    const adapter = sources.get(adapterFile) ?? '';
    const exported = parseOwnedRedemptionReexport(adapter);
    expect(exported).toBeDefined();
    if (exported === undefined) {
      return;
    }
    const targetFile = path.resolve(path.dirname(adapterFile), exported.file);
    const target = sources.get(targetFile) ?? '';
    const databaseFile = ownerFile(owner, relative);
    const database = sources.get(databaseFile) ?? '';
    for (const changed of [
      database.replace('Layer.effect(', 'foreign.effect('),
      database.replace('extends Context.Service<', 'extends Foreign.Service<'),
      `${database}\nfunction shadow(Layer) {}\n`,
      database.replace(`@app/${owner}/`, '@app/foreign/'),
    ]) {
      expect(changed).not.toBe(database);
      const context = {
        ...redemptionContext(owner, targetFile),
        sources: new Map([...sources, [databaseFile, changed]]),
      };
      expect(hasOwnedRedemptionReexportTarget(adapter, target, owner, exported.names, context)).toBe(false);
    }
  }
});

it('requires original native database pool and scoped redemption service constructors', () => {
  for (const [owner, changes] of [
    [
      'crm',
      [
        (source: string) => source.replace("from '@effect/sql-pg'", "from './foreign-client.ts'"),
        (source: string) => source.replace('PgClient.layerFrom(', 'foreignLayerFrom('),
        (source: string) => `${source}\nfunction shadow(PgClient) {}\n`,
      ],
    ],
    [
      cartOwner,
      [
        (source: string) => source.replace('Effect.map(({ executor })', 'foreign.map(({ executor })'),
        (source: string) => source.replace('extends Context.Service<', 'extends Foreign.Service<'),
        (source: string) =>
          source.replace('@app/commerce-cart/auth/gateway-assertion-redemption-runtime/', '@app/foreign/auth/'),
        (source: string) =>
          source.replace(
            'export const gatewayAssertionRedemptionPgClient = Effect.gen(',
            'export const gatewayAssertionRedemptionPgClient = foreign.gen(',
          ),
      ],
    ],
  ] as const) {
    const file = ownerFile(owner, redemptionFile);
    const source = sources.get(file) ?? '';
    const reexported = parseOwnedRedemptionReexport(source);
    expect(reexported).toBeDefined();
    if (reexported === undefined) {
      return;
    }
    const targetFile = path.resolve(path.dirname(file), reexported.file);
    const target = sources.get(targetFile) ?? '';
    for (const change of changes) {
      const changed = change(target);
      expect(changed).not.toBe(target);
      expect(
        hasOwnedRedemptionReexportTarget(
          source,
          changed,
          owner,
          reexported.names,
          redemptionContext(owner, targetFile),
        ),
      ).toBe(false);
    }
  }
});

it.effect('rejects a physical redemption target outside the original owner even with copied native provenance', () =>
  withCreatedFixture(Effect.promise(async () => await mkdtemp(path.join(tmpdir(), 'owner-redemption-'))))((root) =>
    Effect.gen(function* escapedOwnerRedemptionFixture() {
      const adapter = 'owner/api/auth/gateway-assertion-redemption.ts';
      yield* write(root, adapter, "export { GatewayAssertionRedemptionLive } from '../../../foreign.ts';");
      yield* write(root, 'foreign.ts', sourceOf(financeOwner, 'src/services/gateway-redemption.ts'));
      const failure = yield* acceptOwnedRedemptionReexport(
        { appId: financeOwner, directory: path.join(root, 'owner') },
        path.join(root, adapter),
      ).pipe(Effect.flip);
      expect(failure.message).toContain('failed to inspect original redemption adapter target');
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

for (const owner of owners) {
  it(`proves the actual executed ${owner} approval handler and original owner provider before publication`, () => {
    const original = sourceOf(owner, rootFile);
    const root = consolidateOwnerApprovalAuthenticationImport(original);
    expect(inspect(owner, root)).toEqual({ kind: 'mounted' });
    expect(consolidateOwnerApprovalAuthenticationImport(root)).toBe(root);
  });
}

it('does not publish an absent readonly handler or an unused platform factory', () => {
  expect(
    inspect('crm', sourceOf('crm', rootFile).replaceAll('makeOwnerActionApproveHandler', 'unusedPlatformFactory')).kind,
  ).toBe('invalid');
  expect(
    inspectOwnerActionApprovalMount('', '', 'availability', {
      ownerPath: '/workspace/availability',
      rootFile: '/workspace/availability/api/index.ts',
      sources: new Map(),
    }),
  ).toEqual({ kind: 'absent' });
});

it('rejects foreign, shadowed, replaced and duplicate approval authority in the actual ordinary root', () => {
  const owner = 'crm';
  const root = consolidateOwnerApprovalAuthenticationImport(sourceOf(owner, rootFile));
  for (const invalid of [
    root.replace('access/approvals/owner-http', 'access/approvals/foreign-http'),
    root.replace(boundOwnerApprovalGroup, "HttpApiBuilder.group(foreignApi, 'ownerActionApprovals', (handlers) =>"),
    root.replace(boundOwnerApprovalGroup, "HttpApiBuilder.group(crmApi, 'foreignApprovals', (handlers) =>"),
    root.replace(boundOwnerApprovalGroup, "ForeignBuilder.group(crmApi, 'ownerActionApprovals', (handlers) =>"),
    root.replace(
      approveHandlerCall,
      "handle('approve', makeOwnerActionInspectHandler(authenticateOwnerApprovalPrincipal))",
    ),
    root.replace(approveHandlerCall, "handle('approve', makeOwnerActionApproveHandler(foreignAuthentication))"),
    root.replace(approveHandlerCall, "handle('approve', makeOwnerActionApproveHandler())"),
    root.replace(`.${inspectHandlerCall}`, ''),
    `${root}\nconst extraApprove = makeOwnerActionApproveHandler(authenticateOwnerApprovalPrincipal);\n`,
    `${root}\nfunction shadow(HttpApiBuilder) {}\n`,
    root.replace(
      boundOwnerApprovalGroup,
      `HttpApiBuilder.group(crmApi, \`ownerActionApprovals\`, (handlers) => handlers),\n    ${boundOwnerApprovalGroup}`,
    ),
    `${root}\nconst second = HttpApiBuilder.group(crmApi, \`ownerActionApprovals\`, (handlers) => handlers);\n`,
    root.replace('access/approvals/owner-runtime', 'access/approvals/foreign-runtime'),
    root.replace(
      'authenticateOperationPrincipal as authenticateOwnerApprovalPrincipal',
      'foreignAuthentication as authenticateOwnerApprovalPrincipal',
    ),
    root.replace('../vertical.runtime-declaration.ts', '../foreign.runtime-declaration.ts'),
    root.replace('../shared/ultramodern-build.ts', '../shared/foreign-build.ts'),
    root.replace('GovernedReadLayer.provideMerge(ownerActionApprovalsLive),', ''),
    root.replace(
      'GovernedReadLayer.provideMerge(ownerActionApprovalsLive),',
      'GovernedReadLayer.provideMerge(ownerActionApprovalsLive), GovernedReadLayer.provideMerge(ownerActionApprovalsLive),',
    ),
    root.replace('GovernedReadLayer.provide(governedActionRuntimeLive),', 'GovernedReadLayer.provide(unboundRuntime),'),
    root.replace(
      'GovernedReadLayer.provide(OwnerActionApprovalSchemaErrorLive),',
      'GovernedReadLayer.provide(ForeignSchemaErrorLive),',
    ),
    root.replace('GovernedReadLayer.provide(OwnerActionApprovalSchemaErrorLive),', ''),
    `${root}\nownerActionApprovalsLive = foreignProvider;\n`,
    `${root}\nfunction shadow(authenticateOwnerApprovalPrincipal) {}\n`,
    `${root}\n({ ownerActionApprovalsLive } = foreignProvider);\n`,
    `${root}\nfunction shadow(GovernedReadLayer) {}\n`,
  ]) {
    expect(invalid).not.toBe(root);
    expect(inspect(owner, invalid).kind).toBe('invalid');
  }
});

it('retains the exact tuple position, original caller provider and disjoint merge in custom roots', () => {
  const owner = 'commerce-market-catalog';
  const root = consolidateOwnerApprovalAuthenticationImport(sourceOf(owner, rootFile));
  for (const invalid of [
    root.replace('ActionRuntime | OwnerActionApprovals', 'ActionRuntime | ForeignApprovals'),
    root.replace(
      'actionRuntime: Layer.Layer',
      'extraActionRuntime: Layer.Layer<ActionRuntime | OwnerActionApprovals>, actionRuntime: Layer.Layer',
    ),
    root.replace('productionActionRuntimeLive,\n', 'unboundActionRuntimeLive,\n'),
    root.replaceAll('Layer.provideMerge(ownerActionApprovalsLive),', 'Layer.provideMerge(foreignApprovalsLive),'),
    root.replace(
      '  const actionPrincipalVerifierLive =',
      '  function shadow(governedActionRuntimeLive) {}\n  const actionPrincipalVerifierLive =',
    ),
    `${root}\nproductionActionRuntimeLive = foreignProvider;\n`,
  ]) {
    expect(invalid).not.toBe(root);
    expect(inspect(owner, invalid).kind).toBe('invalid');
  }
  const party = partyOwner;
  const providerFile = ownerFile(party, 'api/party-registry-production-layers.ts');
  const original = sources.get(providerFile) ?? '';
  const changed = original.replace('makeOwnerActionApprovalsLive(', 'foreignOwnerApprovals(');
  expect(changed).not.toBe(original);
  const modified = new Map([...sources, [providerFile, changed]]);
  expect(inspect(party, consolidateOwnerApprovalAuthenticationImport(sourceOf(party, rootFile)), modified).kind).toBe(
    'invalid',
  );
});

it('distinguishes the actual native Service type annotation from a runtime write or a counterfeit tag', () => {
  const owner = customerContextOwner;
  const file = ownerFile(owner, 'src/enrollment/orchestration/prepared-owner-authority.ts');
  const original = sources.get(file) ?? '';
  const typeAnnotation = "const service: CommerceEnrollmentPreparedOwnerCapability['Service'] =";
  expect(original).toContain(typeAnnotation);
  const root = sourceOf(owner, rootFile);
  for (const changed of [
    original.replace(typeAnnotation, "const service = CommerceEnrollmentPreparedOwnerCapability['Service'] ="),
    `${original}\nCommerceEnrollmentPreparedOwnerCapability['Service'] = foreign;\n`,
    `${original}\nconst unrelated = { value: CommerceEnrollmentPreparedOwnerCapability['Service'] = foreign };\n`,
    original.replace(
      '@app/commerce-customer-context/enrollment/orchestration/prepared-owner-authority/CommerceEnrollmentPreparedOwnerCapability',
      '@app/core-runtime/access/approvals/owner-runtime/OwnerActionApprovals',
    ),
    original.replace("from 'effect'", "from './foreign-effect.ts'"),
  ]) {
    expect(changed).not.toBe(original);
    expect(inspect(owner, root, new Map([...sources, [file, changed]])).kind).toBe('invalid');
  }
});

it('rejects mutable native service keys and unproved or cyclic layer factories', () => {
  const owner = customerContextOwner;
  const file = ownerFile(owner, 'src/services/pricing-purchase-context-owner-authority.ts');
  const original = sources.get(file) ?? '';
  const keyDeclaration = 'const pricingPurchaseContextVerificationServiceKey =';
  expect(original).toContain(keyDeclaration);
  for (const changed of [
    original.replace(keyDeclaration, 'let pricingPurchaseContextVerificationServiceKey ='),
    `${original}\npricingPurchaseContextVerificationServiceKey = foreign;\n`,
    `${original}\nfunction shadow(Context) {}\n`,
  ]) {
    expect(changed).not.toBe(original);
    expect(inspect(owner, sourceOf(owner, rootFile), new Map([...sources, [file, changed]])).kind).toBe('invalid');
  }
  const pricing = 'pricing';
  const factoryFile = ownerFile(pricing, 'src/integrations/current-pricing-decision-owner-final-fence.ts');
  const factory = sources.get(factoryFile) ?? '';
  const call = 'makePricingCurrentDecisionOwnerFinalFenceGatewaysLive()';
  expect(factory).toContain(call);
  for (const changed of [
    factory.replace(call, 'makePricingCurrentDecisionOwnerFinalFenceGatewaysLive({})'),
    `${factory}\nmakePricingCurrentDecisionOwnerFinalFenceGatewaysLive = foreign;\n`,
    `${factory}\nfunction shadow(Layer) {}\n`,
  ]) {
    expect(changed).not.toBe(factory);
    expect(inspect(pricing, sourceOf(pricing, rootFile), new Map([...sources, [factoryFile, changed]])).kind).toBe(
      'invalid',
    );
  }
  const crm = 'crm';
  const root = sourceOf(crm, rootFile);
  const cyclic = `${root.replace(
    'GovernedReadLayer.provide(governedActionRuntimeLive),',
    'GovernedReadLayer.provide(cycleA),',
  )}
const cycleA = cycleB.pipe(GovernedReadLayer.provide(ownerActionApprovalsLive));
const cycleB = cycleA.pipe(GovernedReadLayer.provide(ownerActionApprovalsLive));
`;
  expect(cyclic).not.toBe(root);
  expect(inspect(crm, cyclic).kind).toBe('invalid');
});

for (const owner of owners) {
  it.effect(`plans ${owner} native API publication without a role capability`, () =>
    Effect.gen(function* actualOwnerApprovalPublicationPlan() {
      const metadata = yield* discoverOntosModuleEffect(appRoot, owner);
      const { mutations } = yield* planPublishedActionBoundaryScaffold(appRoot, { vertical: owner });
      const after = new Map(sources);
      for (const mutation of mutations) {
        expect(mutation.kind).toBe('update');
        if (mutation.kind !== 'delete') {
          after.set(mutation.path, mutation.content);
        }
      }
      const diagnostics: string[] = [];
      expect(
        hasOwnerActionApprovalPublication(after, ownerFile(owner, sharedFile), diagnostics),
        diagnostics.join('\n'),
      ).toBe(true);
      expect(mutations.length).toBeLessThanOrEqual(4);
      const api = after.get(ownerFile(owner, sharedFile)) ?? '';
      expect(publishOwnerApprovalSharedApi(api)).toBe(api);
      const declaration = metadata.runtimeDeclaration?.path ?? metadata.manifestPath;
      const manifest = after.get(declaration) ?? '';
      expect(publishOwnerApprovalManifest(manifest)).toBe(manifest);
      const registration = after.get(metadata.registrationPath) ?? '';
      expect(publishOwnerApprovalLoader(registration)).toBe(registration);
      expect(
        mutations.every((mutation) =>
          [ownerFile(owner, sharedFile), ownerFile(owner, rootFile), declaration, metadata.registrationPath].includes(
            mutation.path,
          ),
        ),
      ).toBe(true);
      const substituted = new Map([
        ...after,
        [
          metadata.registrationPath,
          registration.replace(
            '@app/core-runtime/access/approvals/owner-api',
            '@app/core-runtime/access/approvals/foreign-api',
          ),
        ],
      ]);
      expect(hasOwnerActionApprovalPublication(substituted, ownerFile(owner, sharedFile))).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}
