import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'effect-rstest';
import {
  hasCompleteGeneratedModuleRead,
  hasOriginalConditionalActionMount,
} from '../generated-governed-http-boundary.mts';

const root = path.resolve(import.meta.dirname, '../..');
const owner = 'verticals/commerce-customer-context';
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
for (const file of [
  'packages/shared-contracts/package.json',
  'packages/shared-contracts/src/external-identity-client.ts',
]) {
  sources.set(file, readFileSync(path.join(root, file), 'utf-8'));
}
const readFile = (name: string): string => `${owner}/src/api/${name}.read.ts`;
const disabledGuard = 'if (false)';
const missingCompanyGuard = 'if (scope.legalEntityId === undefined)';
const nativeEffectImport = "from 'effect'";
const foreignEffectImport = "from './foreign-effect.ts'";
const accepts = (name: string, input: ReadonlyMap<string, string>, diagnostics?: string[]): boolean =>
  hasCompleteGeneratedModuleRead(input, readFile(name), owner, 'commerce.customer-context', name, diagnostics);
const names = [...sources.keys()]
  .filter((file) => file.startsWith(`${owner}/src/api/`) && file.endsWith('.read.ts'))
  .map((file) => path.posix.basename(file, '.read.ts'));

for (const name of names) {
  it(`proves the actual CCC ${name} original phases and scoped factory`, () => {
    const diagnostics: string[] = [];
    expect(accepts(name, sources, diagnostics), diagnostics.join('\n')).toBe(true);
  });
}

const rootFile = `${owner}/api/index.ts`;
const conditionalActionFile = `${owner}/src/actions/bind-retail-portal-profile.action.ts`;
const conditionalActionLayer = 'bindRetailPortalProfileActionApiLive';
const acceptsConditionalMount = (input: ReadonlyMap<string, string>, diagnostics?: string[]) =>
  hasOriginalConditionalActionMount(
    { ownerPath: owner, rootFile, sources: input },
    conditionalActionLayer,
    conditionalActionFile,
    diagnostics,
  );
it('proves the actual conditional Action mount with original owner identity and injected native layers', () => {
  const diagnostics: string[] = [];
  expect(acceptsConditionalMount(sources, diagnostics), diagnostics.join('\n')).toBe(true);
  expect(diagnostics).toEqual([]);
});

for (const file of [
  'packages/shared-contracts/package.json',
  'packages/shared-contracts/src/external-identity-client.ts',
]) {
  it(`requires the original published dependency ${file} for the actual conditional Action mount`, () => {
    const incomplete = new Map(sources);
    expect(incomplete.delete(file)).toBe(true);
    const diagnostics: string[] = [];
    expect(acceptsConditionalMount(incomplete, diagnostics)).toBe(false);
    expect(diagnostics).toContain('conditional owner output: dependencies');
    expect(diagnostics).toContain('conditional Action mount: output');
  });
}

const identityProviderFile = `${owner}/src/integrations/retail-enrollment-binding-live.ts`;
const identityContractFile = `${owner}/src/integrations/retail-enrollment-binding.ts`;
const identityConfigurationFile = `${owner}/api/portal-auth/provider/core-identity-client-config.ts`;
const ownerIdentityProvision =
  'deploymentRetailEnrollmentTargetIdentityLive.pipe(Layer.provide(databaseConfiguration))';
for (const [file, defect, before, after] of [
  [rootFile, 'counterfeit additional service', ownerIdentityProvision, 'Layer.succeed(ActionRuntime, foreign)'],
  [
    rootFile,
    'foreign database configuration',
    ownerIdentityProvision,
    'deploymentRetailEnrollmentTargetIdentityLive.pipe(Layer.provide(foreignConfiguration))',
  ],
  [
    rootFile,
    'duplicate database provision',
    ownerIdentityProvision,
    'deploymentRetailEnrollmentTargetIdentityLive.pipe(Layer.provide(databaseConfiguration), Layer.provide(databaseConfiguration))',
  ],
  [
    rootFile,
    'foreign Action runtime',
    'bindRetailPortalProfileActionApiLive.pipe(\n      GovernedReadLayer.provide(governedActionRuntimeLive)',
    'bindRetailPortalProfileActionApiLive.pipe(\n      GovernedReadLayer.provide(foreignRuntime)',
  ],
  [rootFile, 'inverted availability conjunction', 'core && realm\n        ?', 'core || realm\n        ?'],
  [
    rootFile,
    'duplicate original configuration',
    'core: coreIdentityTransportConfigured, realm: portalAuthRealmConfigured',
    'core: portalAuthRealmConfigured, realm: portalAuthRealmConfigured',
  ],
  [
    rootFile,
    'foreign conditional branch',
    ': Layer.empty,\n    ),\n  ),\n);\nconst commerceEnrollmentPreparationSubjectRealmLive',
    ': foreignLayer,\n    ),\n  ),\n);\nconst commerceEnrollmentPreparationSubjectRealmLive',
  ],
  [
    rootFile,
    'shadowed native Layer',
    'const deploymentRetailEnrollmentTargetIdentityLive',
    'const Layer = foreign;\nconst deploymentRetailEnrollmentTargetIdentityLive',
  ],
  [
    rootFile,
    'shadowed native Effect',
    'const deploymentRetailEnrollmentTargetIdentityLive',
    'const Effect = foreign;\nconst deploymentRetailEnrollmentTargetIdentityLive',
  ],
  [
    rootFile,
    'replaced original service provider',
    'retailEnrollmentTargetIdentityLive.pipe(',
    'foreignIdentityLive.pipe(',
  ],
  [
    identityProviderFile,
    'substituted output tag',
    'Layer.effect(\n  RetailEnrollmentTargetIdentity,',
    'Layer.effect(\n  ActionRuntime,',
  ],
  [identityProviderFile, 'non-effect identity provider', 'Layer.effect(', 'Layer.succeed('],
  [
    identityProviderFile,
    'foreign identity effect constructor',
    'Effect.gen(function* targetIdentity()',
    'ForeignEffect.gen(function* targetIdentity()',
  ],
  [
    identityProviderFile,
    'opaque identity effect wrapper',
    'Effect.gen(function* targetIdentity()',
    'foreign(function* targetIdentity()',
  ],
  [
    identityProviderFile,
    'shadowed identity Effect',
    'export const retailEnrollmentTargetIdentityLive',
    'const Effect = foreign;\nexport const retailEnrollmentTargetIdentityLive',
  ],
  [
    identityProviderFile,
    'shadowed identity generator parameter',
    'function* targetIdentity()',
    'function* targetIdentity(Effect)',
  ],
  [
    identityProviderFile,
    'mutated original identity provider',
    'export const retailEnrollmentTargetIdentityLive',
    'retailEnrollmentTargetIdentityLive.pipe = foreign;\nexport const retailEnrollmentTargetIdentityLive',
  ],
  [
    identityProviderFile,
    'extra native identity layer argument',
    'RetailEnrollmentTargetIdentity,\n  Effect.gen',
    'RetailEnrollmentTargetIdentity, foreign,\n  Effect.gen',
  ],
  [
    rootFile,
    'opaque conditional identity wrapper',
    ownerIdentityProvision,
    'foreign(deploymentRetailEnrollmentTargetIdentityLive).pipe(Layer.provide(databaseConfiguration))',
  ],
  [
    rootFile,
    'extra overriding native service',
    ownerIdentityProvision,
    'deploymentRetailEnrollmentTargetIdentityLive.pipe(Layer.provide(databaseConfiguration), Layer.provide(Layer.succeed(ActionRuntime, foreign)))',
  ],
  [
    identityContractFile,
    'counterfeit native service class',
    'extends Context.Service<',
    'extends ForeignContext.Service<',
  ],
  [identityConfigurationFile, 'availability fail-open', 'Effect.as(false)', 'Effect.as(true)'],
  [identityConfigurationFile, 'counterfeit boolean reader', 'Effect.map(Option.isSome)', 'Effect.map(() => true)'],
  [
    identityContractFile,
    'substituted required preflight service',
    'Effect.serviceOption(RetailEnrollmentTargetIdentity)',
    'Effect.serviceOption(ForeignIdentity)',
  ],
] as const) {
  it(`rejects ${defect} in the actual conditional Action mount`, () => {
    const original = sources.get(file) ?? '';
    const invalid = original.replaceAll(before, after);
    expect(invalid).not.toBe(original);
    expect(acceptsConditionalMount(new Map([...sources, [file, invalid]]))).toBe(false);
  });
}

for (const [name, binding] of [
  ['delivery-destination-resolution', 'handleDeliveryDestinationResolution'],
  ['invoice-recipient-resolution', 'handleInvoiceRecipientResolution'],
] as const) {
  const file = readFile(name);
  const phases = `{ load: ${binding} }`;
  for (const [defect, replacement] of [
    ['unproved inline load without native Effect', '{ load: () => foreign.succeed(undefined) }'],
    ['unproved additional native phase', `{ load: ${binding}, finish: () => Effect.succeed(undefined) }`],
    ['a substituted configured phase', '{ load: foreignConfiguredRead }'],
  ] as const) {
    it(`rejects ${defect} at the complete ${name} pipeline boundary`, () => {
      const original = sources.get(file) ?? '';
      const invalid = original.replace(phases, replacement);
      expect(invalid).not.toBe(original);
      expect(accepts(name, new Map([...sources, [file, invalid]]))).toBe(false);
    });
  }
}

const addressList = 'saved-address-list';
const addressFile = readFile(addressList);
const persistenceFile = `${owner}/src/persistence/address-persistence.ts`;
const scopedConstructor = 'addressReadServicesForTransaction(transaction, scope)';
const invokeList = 'invokeList(transaction, scope, input.profile)';
for (const [file, defect, before, after] of [
  [
    addressFile,
    'reordered scoped constructor arguments',
    scopedConstructor,
    'addressReadServicesForTransaction(scope, transaction)',
  ],
  [addressFile, 'missing original scope', scopedConstructor, 'addressReadServicesForTransaction(transaction)'],
  [
    addressFile,
    'an additional scope',
    scopedConstructor,
    'addressReadServicesForTransaction(transaction, scope, scope)',
  ],
  [addressFile, 'caller tenant at load', 'context.scope.tenantId', 'input.tenantId'],
  [addressFile, 'a substituted method', '.list(input,', '.foreignMethod(input,'],
  [
    addressFile,
    'a duplicate method argument',
    '.list(input, context.scope.tenantId)',
    '.list(input, context.scope.tenantId, context.scope.tenantId)',
  ],
  [persistenceFile, 'foreign native capability types', "from '@app/core-runtime'", "from './foreign-core.ts'"],
  [
    persistenceFile,
    'an expanded routine capability',
    "RowSchema['Type'][], ScopedRoutineInvocationError>;",
    "RowSchema['Type'][], ScopedRoutineInvocationError>; readonly raw: unknown;",
  ],
  [persistenceFile, 'a replaced invoker receiver', 'transaction.invoke(', 'foreign.invoke('],
  [
    persistenceFile,
    'an inverted original tenant guard',
    'profile.profileRef.tenantId === scope.tenantId',
    'profile.profileRef.tenantId !== scope.tenantId',
  ],
  [
    persistenceFile,
    'foreign reference guard data',
    'profile.counterpartyRef.tenantId === scope.tenantId',
    'foreign.counterpartyRef.tenantId === scope.tenantId',
  ],
  [persistenceFile, 'a removed routine scope argument', invokeList, 'invokeList(transaction, input.profile)'],
  [persistenceFile, 'reordered routine scope arguments', invokeList, 'invokeList(scope, transaction, input.profile)'],
  [persistenceFile, 'an extra routine argument', invokeList, 'invokeList(transaction, scope, input.profile, scope)'],
  [persistenceFile, 'a shadowed scoped invoker', 'list: (\n    input:', 'list: (\n    transaction:'],
] as const) {
  it(`rejects ${defect} in the actual scoped address Read`, () => {
    const original = sources.get(file) ?? '';
    const invalid = original.replaceAll(before, after);
    expect(invalid).not.toBe(original);
    expect(accepts(addressList, new Map([...sources, [file, invalid]]))).toBe(false);
  });
}

const approvalRead = 'order-service-approval-evidence';
const approvalFile = readFile(approvalRead);
const approvalServiceFile = `${owner}/src/services/order-approval-finalization.service.ts`;
const snapshotLoad = 'loadOrderFinalizationReadSnapshot(transaction, scope, input)';
for (const [file, defect, before, after] of [
  [
    approvalFile,
    'foreign prepare context',
    'prepareOrderFinalizationRead(input, context)',
    'prepareOrderFinalizationRead(input, input.context)',
  ],
  [
    approvalFile,
    'foreign finish context',
    'finishOrderFinalizationRead(input, context)',
    'finishOrderFinalizationRead(input, input.context)',
  ],
  [
    approvalServiceFile,
    'foreign authorization Context service',
    'const access = yield* ContextAccess;',
    'const access = yield* ForeignAccess;',
  ],
  [
    approvalServiceFile,
    'foreign composition service',
    'const composition = yield* ActiveApplicationCompositionService;',
    'const composition = yield* ForeignComposition;',
  ],
  [
    approvalServiceFile,
    'inverted exact actor company',
    'grant.legalEntityId === scope.legalEntityId',
    'grant.legalEntityId !== scope.legalEntityId',
  ],
  [
    approvalServiceFile,
    'foreign current snapshot scope',
    snapshotLoad,
    'loadOrderFinalizationReadSnapshot(transaction, input.scope, input)',
  ],
  [
    approvalServiceFile,
    'reordered current snapshot inputs',
    snapshotLoad,
    'loadOrderFinalizationReadSnapshot(transaction, input, scope)',
  ],
  [approvalServiceFile, 'foreign transaction receiver', 'context.transaction(', 'foreign.transaction('],
  [
    approvalServiceFile,
    'foreign before-snapshot',
    'loaded.snapshot,\n          current.snapshot,',
    'input.snapshot,\n          current.snapshot,',
  ],
  [approvalServiceFile, 'inverted currentness deadline', 'now < validUntil', 'now > validUntil'],
  [
    approvalServiceFile,
    'inverted retained owner company',
    'proposal.context.sellingLegalEntityId === scope.legalEntityId',
    'proposal.context.sellingLegalEntityId !== scope.legalEntityId',
  ],
  [
    approvalServiceFile,
    'foreign native snapshot invoker',
    '.invoke(readCurrentPurchaseApprovalRevalidationRoutine,',
    '.foreign(readCurrentPurchaseApprovalRevalidationRoutine,',
  ],
  [
    approvalServiceFile,
    'shadowed real read context',
    'const { loaded, prepared, scope } = context;',
    'const context = foreign; const { loaded, prepared, scope } = context;',
  ],
  [
    approvalServiceFile,
    'hidden service provision in finish',
    'const deadline = DateTime.toEpochMillis(prepared.observedAt)',
    'yield* Effect.provideService(foreign, foreign); const deadline = DateTime.toEpochMillis(prepared.observedAt)',
  ],
] as const) {
  it(`rejects ${defect} in the original prepare/load/finish approval Read`, () => {
    const original = sources.get(file) ?? '';
    const invalid = original.replaceAll(before, after);
    expect(invalid).not.toBe(original);
    expect(accepts(approvalRead, new Map([...sources, [file, invalid]]))).toBe(false);
  });
}

const basisRead = 'purchase-proposal-basis';
const basisFile = readFile(basisRead);
const basisServiceFile = `${owner}/src/services/purchase-proposal-basis.service.ts`;
const basisErrorFile = `${owner}/shared/domain/purchasing-approval.ts`;
const basisHashFile = `${owner}/src/stable-revision.ts`;
const basisLoad = 'loadRead(input, at).pipe(Effect.provideContext(services))';
const basisSnapshot = 'purchaseProposalBasisReadSnapshotMatches(context.loaded, current)';
const basisUnavailableReason = "reason: 'Verified preproposal operation scope is required',";
const freshRejection =
  "rejection('CURRENT_STATE_INDETERMINATE', 'The exact owner preproposal basis cannot currently be established')";
for (const [file, defect, before, after] of [
  [
    basisFile,
    'foreign prepared load request',
    'context.services.loadRead(input)',
    'context.services.loadRead(input.foreign)',
  ],
  [basisFile, 'foreign revalidation transaction', 'context.transaction(', 'foreign.transaction('],
  [
    basisFile,
    'foreign retained snapshot',
    basisSnapshot,
    'purchaseProposalBasisReadSnapshotMatches(input.loaded, current)',
  ],
  [basisFile, 'inverted retained snapshot equality', basisSnapshot, `!${basisSnapshot}`],
  [basisFile, 'foreign retained operation time', 'context.loaded.operationTime', 'input.operationTime'],
  [basisFile, 'missing revalidation continuation', 'context.loaded,\n        revalidate,', 'context.loaded,'],
  [basisServiceFile, 'missing verified native company', 'scope.legalEntityId === undefined ||', 'false ||'],
  [
    basisServiceFile,
    'foreign native transaction scope',
    'transaction.scope.tenantId !== scope.tenantId',
    'foreign.scope.tenantId !== scope.tenantId',
  ],
  [
    basisServiceFile,
    'inverted native buyer tenant',
    'basis.basisRef.tenantId !== scope.tenantId',
    'basis.basisRef.tenantId === scope.tenantId',
  ],
  [
    basisServiceFile,
    'foreign native snapshot scope',
    'loadPurchasePricingContextSnapshot(\n          transaction,\n          scope,',
    'loadPurchasePricingContextSnapshot(\n          transaction,\n          input.scope,',
  ],
  [
    basisServiceFile,
    'replaced native captured context',
    basisLoad,
    'loadRead(input, at).pipe(Effect.provideContext(foreign))',
  ],
  [
    basisServiceFile,
    'outer factory provider override',
    basisUnavailableReason,
    `${basisUnavailableReason}\n          ignored: Effect.provideService(foreign, foreign),`,
  ],
  [
    basisServiceFile,
    'appended outer provider transform',
    '    }).pipe(\n      Effect.mapError',
    '    }).pipe(\n      Effect.provideService(foreign, foreign),\n      Effect.mapError',
  ],
  [basisServiceFile, 'skipped native revalidation', 'yield* revalidate;', 'yield* Effect.void;'],
  [
    basisServiceFile,
    'expired evidence accepted',
    '!DateTime.isGreaterThan(validUntil, now)',
    'DateTime.isGreaterThan(validUntil, now)',
  ],
  [
    basisServiceFile,
    'foreign finish snapshot',
    'loaded.snapshot,\n  ).pipe(Effect.mapError(unavailable))',
    'input.snapshot,\n  ).pipe(Effect.mapError(unavailable))',
  ],
  [
    basisServiceFile,
    'foreign finish dependency',
    'const cart = yield* cartObservation(basis.proposal);',
    'const cart = yield* foreign(basis.proposal);',
  ],
  [
    basisServiceFile,
    'shadowed global String conversion',
    'revision: String(observed.profileRevision)',
    'revision: String(observed.profileRevision)',
  ],
  [
    basisHashFile,
    'changed snapshot digest',
    'sha256(utf8ToBytes(canonical(value)))',
    'sha256(utf8ToBytes(canonical(foreign)))',
  ],
  [
    basisHashFile,
    'noncanonical snapshot key order',
    '.toSorted(([left], [right]) => left.localeCompare(right))',
    '.toSorted(([left], [right]) => right.localeCompare(left))',
  ],
  [
    basisHashFile,
    'shadowed original digest import',
    '(value: Document) => Hex.encode',
    '(value: Document, sha256: unknown) => Hex.encode',
  ],
  [
    basisHashFile,
    'rebound original digest import',
    'export const stableRevision',
    'sha256.foreign = true;\nexport const stableRevision',
  ],
  [
    basisHashFile,
    'missing original canonical value',
    '<Document>(value: Document): string =>',
    '<Document>(foreign: Document): string =>',
  ],
  [basisServiceFile, 'mutated error factory itself', freshRejection, 'rejection'],
  [basisServiceFile, 'error result constructor mutation', freshRejection, `${freshRejection}.constructor`],
  [basisServiceFile, 'error result prototype mutation', freshRejection, `${freshRejection}.prototype`],
  [
    basisServiceFile,
    'nonfresh rejection result',
    'new PurchasingApprovalRejected({',
    'existingRejection ?? new PurchasingApprovalRejected({',
  ],
  [
    basisServiceFile,
    'shadowed Object mutator',
    'const unavailable = (cause?: unknown) =>',
    'const Object = foreign;\nconst unavailable = (cause?: unknown) =>',
  ],
  [
    basisServiceFile,
    'substituted tagged error source',
    "from '../../shared/domain/purchasing-approval.ts'",
    "from './foreign-error.ts'",
  ],
  [
    basisErrorFile,
    'foreign tagged error constructor',
    'extends Schema.TaggedError<PurchasingApprovalRejected>',
    'extends ForeignSchema.TaggedError<PurchasingApprovalRejected>',
  ],
  [
    basisErrorFile,
    'mutated tagged error class',
    'export class PurchasingApprovalRejected',
    'PurchasingApprovalRejected.prototype.foreign = true;\nexport class PurchasingApprovalRejected',
  ],
  [
    basisErrorFile,
    'custom tagged error constructor',
    'retryable: Schema.Boolean,\n  },\n) {}',
    'retryable: Schema.Boolean,\n  },\n) { constructor() { return existingRejection; } }',
  ],
] as const) {
  it(`rejects ${defect} in the original prepared snapshot Read`, () => {
    const original = sources.get(file) ?? '';
    const invalid =
      defect === 'shadowed global String conversion'
        ? `const String = foreign;\n${original}`
        : original.replaceAll(before, after);
    expect(invalid).not.toBe(original);
    expect(accepts(basisRead, new Map([...sources, [file, invalid]]))).toBe(false);
  });
}

const restrictionsRead = 'market-subject-restrictions-current';
const restrictionsFile = readFile(restrictionsRead);
const restrictionServiceCall = 'services.readRestrictionProfile(input)';
for (const [defect, before, after] of [
  ['foreign native scope', 'input, context.scope, context.services', 'input, input.scope, context.services'],
  [
    'inverted picked tenant guard',
    'input.subject.profileRef.tenantId !== scope.tenantId',
    'input.subject.profileRef.tenantId === scope.tenantId',
  ],
  ['foreign picked service receiver', restrictionServiceCall, 'foreign.readRestrictionProfile(input)'],
  ['wrong picked service request', restrictionServiceCall, 'services.readRestrictionProfile(input.subject)'],
  [
    'replaced subject observation tenant',
    'subject.profileRef.tenantId !== observation.profileRef.tenantId',
    'subject.profileRef.tenantId !== foreign.tenantId',
  ],
  [
    'foreign current observation',
    'currentRestrictions(input.subject, result.observation, observedAt)',
    'currentRestrictions(input.subject, input.observation, observedAt)',
  ],
  ['non-native projection method', "].join(':')", "].foreign(':')"],
  ['replaced native Clock source', nativeEffectImport, foreignEffectImport],
] as const) {
  it(`rejects ${defect} in the original picked-scope Read`, () => {
    const original = sources.get(restrictionsFile) ?? '';
    const invalid = original.replaceAll(before, after);
    expect(invalid).not.toBe(original);
    expect(accepts(restrictionsRead, new Map([...sources, [restrictionsFile, invalid]]))).toBe(false);
  });
}

const policyRead = 'purchase-limit-policy-read';
const policyFile = readFile(policyRead);
const policyDomainFile = `${owner}/shared/domain/purchase-limit-policy.ts`;
const nativePolicyFactory = 'factory.make(transaction, scope)';
for (const [file, defect, before, after] of [
  [policyFile, 'reordered native service arguments', nativePolicyFactory, 'factory.make(scope, transaction)'],
  [policyFile, 'omitted native service scope', nativePolicyFactory, 'factory.make(transaction)'],
  [policyFile, 'duplicated native service scope', nativePolicyFactory, 'factory.make(transaction, scope, scope)'],
  [policyFile, 'foreign native service receiver', nativePolicyFactory, 'foreign.make(transaction, scope)'],
  [policyFile, 'substituted native factory method', nativePolicyFactory, 'factory.foreign(transaction, scope)'],
  [policyFile, 'foreign projected native service', '({ policy })', '({ policy: foreign.policy })'],
  [
    policyFile,
    'foreign request reference',
    'counterpartyRef: input.counterpartyRef',
    'counterpartyRef: foreign.counterpartyRef',
  ],
  [
    policyFile,
    'replaced failure wrapper',
    "Object.defineProperty(failure, 'cause', { configurable: true, value: cause });",
    "Object.defineProperty(failure, 'cause', { configurable: true, value: input });",
  ],
  [
    policyDomainFile,
    'foreign service class namespace',
    "'@app/commerce-customer-context/shared/domain/purchase-limit-policy/PurchaseLimitPolicyServiceFactory'",
    "'@app/foreign/PurchaseLimitPolicyServiceFactory'",
  ],
  [policyDomainFile, 'foreign service class source', nativeEffectImport, foreignEffectImport],
] as const) {
  it(`rejects ${defect} in the original Context-service Read factory`, () => {
    const original = sources.get(file) ?? '';
    const invalid = original.replaceAll(before, after);
    expect(invalid).not.toBe(original);
    expect(accepts(policyRead, new Map([...sources, [file, invalid]]))).toBe(false);
  });
}

const accessRead = 'counterparty-commerce-access-list';
const accessFile = readFile(accessRead);
const accessFactoryFile = `${owner}/src/access-services.ts`;
const accessPersistenceFile = `${owner}/src/persistence/access-persistence.ts`;
const accessConstructor = 'counterpartyAccessServicesForTransaction(transaction, scope)';
const accessPortConstructor = 'counterpartyAccessPortForScopedTransaction(transaction, trustedScope)';
for (const [file, defect, before, after] of [
  [
    accessFile,
    'reordered access constructor arguments',
    accessConstructor,
    'counterpartyAccessServicesForTransaction(scope, transaction)',
  ],
  [
    accessFile,
    'missing access constructor argument',
    accessConstructor,
    'counterpartyAccessServicesForTransaction(transaction)',
  ],
  [
    accessFile,
    'additional access constructor argument',
    accessConstructor,
    'counterpartyAccessServicesForTransaction(transaction, scope, scope)',
  ],
  [accessFile, 'substituted projected port method', 'list: port.list', 'list: port.check'],
  [accessFile, 'foreign access service receiver', ': services\n        .list(', ': foreign\n        .list('],
  [
    accessFile,
    'inverted access reference guard',
    'input.counterpartyRef.tenantId !== tenantId',
    'input.counterpartyRef.tenantId === tenantId',
  ],
  [
    accessFile,
    'caller tenant in access request',
    'principalId,\n            tenantId,',
    'principalId,\n            tenantId: input.tenantId,',
  ],
  [
    accessFile,
    'caller company in access request',
    'legalEntityId,\n          recipient:',
    'legalEntityId: input.legalEntityId,\n          recipient:',
  ],
  [accessFile, 'missing load company guard', 'if (legalEntityId === undefined)', disabledGuard],
  [accessFactoryFile, 'missing factory company guard', missingCompanyGuard, disabledGuard],
  [
    accessFactoryFile,
    'foreign scoped access port',
    accessPortConstructor,
    'counterpartyAccessPortForScopedTransaction(transaction, input.scope)',
  ],
  [
    accessFactoryFile,
    'wrong native portal type source',
    "from '@app/core-runtime/access/portal'",
    "from '@app/core-runtime/foreign-portal'",
  ],
  [
    accessPersistenceFile,
    'foreign portal dependency',
    'accessPortalWritesForTransaction(transaction, scope)',
    'accessPortalWritesForTransaction(transaction, input.scope)',
  ],
  [
    `${owner}/shared/domain/access-contract.ts`,
    'inverted original storefront containment',
    'grantScope.storefrontKey === requestedScope.storefrontKey',
    'grantScope.storefrontKey !== requestedScope.storefrontKey',
  ],
] as const) {
  it(`rejects ${defect} in the actual scoped access-port Read`, () => {
    const original = sources.get(file) ?? '';
    const invalid = original.replaceAll(before, after);
    expect(invalid).not.toBe(original);
    expect(accepts(accessRead, new Map([...sources, [file, invalid]]))).toBe(false);
  });
}

const subjectRead = 'customer-profile-read';
const subjectFile = readFile(subjectRead);
const readProfileCall = 'services.readProfile(input, tenantId)';
for (const [file, defect, before, after] of [
  [subjectFile, 'foreign subject service', readProfileCall, 'foreign.readProfile(input, tenantId)'],
  [subjectFile, 'reordered subject arguments', readProfileCall, 'services.readProfile(tenantId, input)'],
  [
    subjectFile,
    'inverted subject tenant guard',
    'input.profileRef.tenantId !== tenantId',
    'input.profileRef.tenantId === tenantId',
  ],
  [
    subjectFile,
    'foreign subject company',
    'input.authorizationSubject.sellingLegalEntityRef.resourceId !== legalEntityId',
    'input.authorizationSubject.sellingLegalEntityRef.resourceId !== input.legalEntityId',
  ],
  [
    subjectFile,
    'request used as durable subject',
    'sameCommerceCustomerProfileSubject(durableSubject, input.authorizationSubject)',
    'sameCommerceCustomerProfileSubject(input.authorizationSubject, input.authorizationSubject)',
  ],
  [subjectFile, 'shadowed subject result', 'Effect.flatMap((result) => {', 'Effect.flatMap((services) => {'],
  [
    `${owner}/src/api/customer-profile-read-support.ts`,
    'inverted durable subject equality',
    'durable.partyRef.tenantId === requested.partyRef.tenantId',
    'durable.partyRef.tenantId !== requested.partyRef.tenantId',
  ],
  [
    `${owner}/src/api/customer-profile-read-support.ts`,
    'foreign durable subject tenant',
    'durable.counterpartyRef.tenantId === requested.counterpartyRef.tenantId',
    'durable.counterpartyRef.tenantId === foreign.tenantId',
  ],
] as const) {
  it(`rejects ${defect} in the durable selected subject Read`, () => {
    const original = sources.get(file) ?? '';
    const invalid = original.replaceAll(before, after);
    expect(invalid).not.toBe(original);
    expect(accepts(subjectRead, new Map([...sources, [file, invalid]]))).toBe(false);
  });
}

const verificationRead = 'pricing-purchase-context-verification';
const verificationFile = readFile(verificationRead);
const verificationLoad = 'loadVerificationSnapshot(transaction, scope, revision, input)';
const loadInput = '.load(input)';
for (const [defect, before, after] of [
  ['omitted revision', verificationLoad, 'loadVerificationSnapshot(transaction, scope, input)'],
  ['reordered revision', verificationLoad, 'loadVerificationSnapshot(transaction, revision, scope, input)'],
  ['duplicated revision', verificationLoad, 'loadVerificationSnapshot(transaction, scope, revision, revision, input)'],
  ['foreign revision', verificationLoad, 'loadVerificationSnapshot(transaction, scope, foreign.revision, input)'],
  ['foreign load request', loadInput, '.load(foreign.input)'],
  ['substituted load method', loadInput, '.foreign(input)'],
] as const) {
  it(`rejects ${defect} in the original revision-bound closure`, () => {
    const original = sources.get(verificationFile) ?? '';
    const invalid = original.replaceAll(before, after);
    expect(invalid).not.toBe(original);
    expect(accepts(verificationRead, new Map([...sources, [verificationFile, invalid]]))).toBe(false);
  });
}

const receiptRead = 'privacy-measure-execution';
const receiptFile = readFile(receiptRead);
const receiptServiceFile = `${owner}/src/services/privacy-measure-execution.service.ts`;
const receiptInvocation = 'transaction.invoke(loadReceiptRoutine, [idempotencyKey])';
for (const [file, defect, before, after] of [
  [
    receiptFile,
    'foreign receipt input',
    'context.services.load(input.idempotencyKey)',
    'context.services.load(foreign.idempotencyKey)',
  ],
  [
    receiptFile,
    'wrong receipt method',
    'context.services.load(input.idempotencyKey)',
    'context.services.execute(input.idempotencyKey)',
  ],
  [
    receiptServiceFile,
    'foreign routine receiver',
    receiptInvocation,
    'foreign.invoke(loadReceiptRoutine, [idempotencyKey])',
  ],
  [
    receiptServiceFile,
    'duplicated routine arguments',
    receiptInvocation,
    'transaction.invoke(loadReceiptRoutine, [idempotencyKey, idempotencyKey])',
  ],
  [receiptServiceFile, 'missing company guard', missingCompanyGuard, disabledGuard],
  [receiptServiceFile, 'shadowed receipt transaction', '(idempotencyKey) =>', '(transaction) =>'],
  [
    receiptServiceFile,
    'foreign service result',
    'return PrivacyMeasureExecution.of({ execute, load });',
    'return ForeignExecution.of({ execute, load });',
  ],
  [
    receiptServiceFile,
    'rebound output method',
    'return PrivacyMeasureExecution.of({ execute, load });',
    'return PrivacyMeasureExecution.of({ execute, load: foreign.load });',
  ],
] as const) {
  it(`rejects ${defect} in the captured scoped receipt Read`, () => {
    const original = sources.get(file) ?? '';
    const invalid = original.replaceAll(before, after);
    expect(invalid).not.toBe(original);
    expect(accepts(receiptRead, new Map([...sources, [file, invalid]]))).toBe(false);
  });
}

const associationRead = 'counterparty-order-history';
const associationFile = readFile(associationRead);
const historyFactoryFile = `${owner}/src/api/history-read-support.ts`;
const historyServicesFile = `${owner}/src/history-production-services.ts`;
const associationConstructor =
  'counterpartyAssociationReader(transaction, { ...scope, legalEntityId: scope.legalEntityId })';
for (const [file, defect, before, after] of [
  [
    associationFile,
    'foreign association services',
    'context.services.counterpartyAssociation(refs)',
    'foreign.services.counterpartyAssociation(refs)',
  ],
  [
    associationFile,
    'substituted association method',
    'context.services.counterpartyAssociation(refs)',
    'context.services.foreign(refs)',
  ],
  [associationFile, 'foreign retained association scope', 'refs, scope: context.scope', 'refs, scope: input.scope'],
  [
    associationFile,
    'foreign retained references',
    'refs, scope: context.scope',
    'refs: foreign.refs, scope: context.scope',
  ],
  [
    associationFile,
    'caller-provided reference scope',
    'profileRef: input.profileRef',
    'profileRef: foreign.profileRef',
  ],
  [historyFactoryFile, 'missing company guard', 'scope.legalEntityId === undefined', 'false'],
  [
    historyFactoryFile,
    'foreign association transaction',
    associationConstructor,
    'counterpartyAssociationReader(foreign.transaction, { ...scope, legalEntityId: scope.legalEntityId })',
  ],
  [
    historyFactoryFile,
    'foreign association company',
    associationConstructor,
    'counterpartyAssociationReader(transaction, { ...scope, legalEntityId: foreign.legalEntityId })',
  ],
  [
    historyServicesFile,
    'inverted association tenant guard',
    'input.counterpartyRef.tenantId !== scope.tenantId',
    'input.counterpartyRef.tenantId === scope.tenantId',
  ],
  [historyServicesFile, 'changed association loader', '.readProfile(', '.foreign('],
  [historyServicesFile, 'missing association tenant argument', 'scope.tenantId,\n      )', 'input.tenantId,\n      )'],
  [
    historyServicesFile,
    'inverted exact reference comparison',
    'left.tenantId === right.tenantId',
    'left.tenantId !== right.tenantId',
  ],
] as const) {
  it(`rejects ${defect} in the original association snapshot Read`, () => {
    const original = sources.get(file) ?? '';
    const invalid = original.replaceAll(before, after);
    expect(invalid).not.toBe(original);
    expect(accepts(associationRead, new Map([...sources, [file, invalid]]))).toBe(false);
  });
}

const history = 'retail-order-history';
for (const [before, after] of [
  ['Effect.succeedNone', 'foreign.succeedNone'],
  ['Effect.succeedNone', 'Effect.succeed(input)'],
  [nativeEffectImport, foreignEffectImport],
] as const) {
  it(`rejects a foreign or data-bearing replacement of the original empty history load: ${after}`, () => {
    const file = readFile(history);
    const original = sources.get(file) ?? '';
    const invalid = original.replace(before, after);
    expect(invalid).not.toBe(original);
    expect(accepts(history, new Map([...sources, [file, invalid]]))).toBe(false);
  });
}

const selectedRead = 'guest-attribution-status';
const selectedFactoryFile = `${owner}/src/profile-service-factory.ts`;
const selectedServiceFile = `${owner}/src/integrations/party-registry-guest-resolver.ts`;
for (const [file, defect, before, after] of [
  [
    readFile(selectedRead),
    'reordered original scalar scope',
    'context.scope.tenantId,\n        context.scope.legalEntityId,',
    'context.scope.legalEntityId,\n        context.scope.tenantId,',
  ],
  [readFile(selectedRead), 'foreign injected services', 'context.services,', 'foreign.services,'],
  [
    readFile(selectedRead),
    'inverted selected reference guard',
    'input.sellingLegalEntityRef.tenantId === tenantId',
    'input.sellingLegalEntityRef.tenantId !== tenantId',
  ],
  [
    readFile(selectedRead),
    'foreign selected service method',
    'services.readStatus(input, tenantId)',
    'services.foreign(input, tenantId)',
  ],
  [
    selectedFactoryFile,
    'foreign captured factory',
    'yield* PartyRegistryGuestResolverFactory;',
    'yield* foreign.services;',
  ],
  [
    selectedFactoryFile,
    'duplicate captured factory binding',
    'const crypto = yield* Crypto.Crypto;',
    'const guestResolverFactory = yield* Crypto.Crypto;',
  ],
  [
    selectedFactoryFile,
    'foreign factory transaction',
    'transaction,\n      verifiedScope,',
    'foreign,\n      verifiedScope,',
  ],
  [
    selectedFactoryFile,
    'foreign factory company',
    'legalEntityId: scope.legalEntityId,',
    'legalEntityId: input.legalEntityId,',
  ],
  [selectedFactoryFile, 'missing required company guard', missingCompanyGuard, disabledGuard],
  [selectedServiceFile, 'foreign service class origin', nativeEffectImport, foreignEffectImport],
  [
    selectedServiceFile,
    'foreign owner service key',
    "'@app/commerce-customer-context/integrations/party-registry-guest-resolver/PartyRegistryGuestResolverFactory'",
    "'@app/foreign/PartyRegistryGuestResolverFactory'",
  ],
] as const) {
  it(`rejects ${defect} in the original selected-service factory`, () => {
    const original = sources.get(file) ?? '';
    const invalid = original.replaceAll(before, after);
    expect(invalid).not.toBe(original);
    expect(accepts(selectedRead, new Map([...sources, [file, invalid]]))).toBe(false);
  });
}
