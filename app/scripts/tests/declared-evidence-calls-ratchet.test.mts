// @effect-diagnostics nodeBuiltinImport:off -- Synchronous static scan of the workspace sources, like the transaction guard's boundary tests; remove-when: the declared evidence call inventory becomes an oxlint rule.
import { readFileSync, readdirSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

import { assortmentDeclaredEvidenceCalls } from '../../verticals/assortment/src/declared-evidence-calls.ts';
import { commerceCustomerContextDeclaredEvidenceCalls } from '../../verticals/commerce-customer-context/src/declared-evidence-calls.ts';
import { partyRegistryDeclaredEvidenceCalls } from '../../verticals/party-registry/src/declared-evidence-calls.ts';
import { privacyDeclaredEvidenceCalls } from '../../verticals/privacy/src/declared-evidence-calls.ts';
import { symmyIntegrationDeclaredEvidenceCalls } from '../../verticals/symmy-integration/src/declared-evidence-calls.ts';

/**
 * Declared in-transaction evidence calls (DEPLOYMENT.md, demo divergence): main's source-evidence proofs that the
 * trunk's transaction I/O guard admits at their call sites. The number may only go down. Removing a proof means
 * deleting its registry entry, its line here and its use lines below; adding a declaration or a use fails this test.
 */
const PINNED_DECLARATIONS = [
  'commerce.assortment assortment.symmy-rule-fixture-owner-currentness',
  'commerce.customer-context commerce.counterparty-migration-correlation',
  'commerce.customer-context commerce.counterparty-organization-ico-facts',
  'commerce.customer-context commerce.legacy-ico-inventory',
  'commerce.customer-context commerce.organization-business-eligibility',
  'commerce.customer-context commerce.organization-profile-ico-eligibility',
  'commerce.customer-context commerce.source-counterparty-admission',
  'commerce.customer-context commerce.source-person-admission',
  'commerce.customer-context commerce.source-processing-eligibility',
  'integration.symmy symmy.customer-intake-privacy',
  'integration.symmy symmy.retention-privacy-current',
  'party.registry party.client-source-organization-privacy',
  'party.registry party.client-source-privacy',
  'party.registry party.legacy-ico-privacy',
  'privacy.core privacy.customer-intake-owner-context',
  'privacy.core privacy.organization-business-owner-context',
  'privacy.core privacy.organization-business-owner-facts',
  'privacy.core privacy.organization-ico-owner-facts',
  'privacy.core privacy.organization-party-record-facts',
  'privacy.core privacy.organization-profile-ico-owner-facts',
  'privacy.core privacy.organization-profile-owner-facts',
  'privacy.core privacy.organization-source-owner-facts',
  'privacy.core privacy.source-person-party-owner',
];

/** Every file that uses a declaration, as `file combinator.key count`. Only these places may lift the guard. */
const PINNED_USES = [
  'verticals/assortment/src/adapters/assortment-fixture-owner-currentness.ts assortmentEvidenceCall.symmyRuleFixtureOwnerCurrentness 5',
  'verticals/commerce-customer-context/src/integrations/organization-business-eligibility.ts commerceCustomerContextEvidenceCall.organizationBusinessEligibility 2',
  'verticals/commerce-customer-context/src/integrations/organization-profile-ico-eligibility.ts commerceCustomerContextEvidenceCall.organizationProfileIcoEligibility 2',
  'verticals/commerce-customer-context/src/integrations/party-legacy-ico-inventory.ts commerceCustomerContextEvidenceCall.counterpartyOrganizationIcoFacts 2',
  'verticals/commerce-customer-context/src/integrations/party-legacy-ico-inventory.ts commerceCustomerContextEvidenceCall.legacyIcoInventory 1',
  'verticals/commerce-customer-context/src/integrations/party-legacy-ico-inventory.ts commerceCustomerContextEvidenceCall.migrationCorrelation 2',
  'verticals/commerce-customer-context/src/integrations/source-processing-eligibility.ts commerceCustomerContextEvidenceCall.sourceProcessingEligibility 1',
  'verticals/commerce-customer-context/src/integrations/source-profile-owner-proof.ts commerceCustomerContextEvidenceCall.sourceCounterpartyAdmission 2',
  'verticals/commerce-customer-context/src/integrations/source-profile-owner-proof.ts commerceCustomerContextEvidenceCall.sourcePersonAdmission 2',
  'verticals/commerce-customer-context/src/services/customer-profile-organization-ico-facts.service.ts commerceCustomerContextEvidenceCall.counterpartyOrganizationIcoFacts 2',
  'verticals/party-registry/src/services/legacy-ico-privacy.service.ts partyRegistryEvidenceCall.legacyIcoPrivacy 3',
  'verticals/party-registry/src/services/party-client-source-privacy.service.ts partyRegistryEvidenceCall.clientSourceOrganizationPrivacy 2',
  'verticals/party-registry/src/services/party-client-source-privacy.service.ts partyRegistryEvidenceCall.clientSourcePrivacy 2',
  'verticals/privacy/src/api/source-processing-eligibility.read.ts privacyEvidenceCall.sourcePersonPartyOwner 2',
  'verticals/privacy/src/services/customer-intake-organization-proof.ts privacyEvidenceCall.customerIntakeOwnerContext 1',
  'verticals/privacy/src/services/customer-intake-organization-proof.ts privacyEvidenceCall.organizationPartyRecordFacts 1',
  'verticals/privacy/src/services/organization-business-applicability.service.ts privacyEvidenceCall.organizationBusinessOwnerContext 1',
  'verticals/privacy/src/services/organization-business-applicability.service.ts privacyEvidenceCall.organizationBusinessOwnerFacts 1',
  'verticals/privacy/src/services/organization-business-applicability.service.ts privacyEvidenceCall.organizationPartyRecordFacts 1',
  'verticals/privacy/src/services/organization-business-applicability.service.ts privacyEvidenceCall.organizationProfileOwnerFacts 1',
  'verticals/privacy/src/services/organization-business-applicability.service.ts privacyEvidenceCall.organizationSourceOwnerFacts 1',
  'verticals/privacy/src/services/organization-ico-applicability.service.ts privacyEvidenceCall.organizationIcoOwnerFacts 3',
  'verticals/privacy/src/services/organization-profile-ico-applicability.service.ts privacyEvidenceCall.organizationProfileIcoOwnerFacts 3',
  'verticals/symmy-integration/src/services/symmy-customer-intake-privacy.ts symmyIntegrationEvidenceCall.customerIntakePrivacy 2',
  'verticals/symmy-integration/src/services/symmy-job-retention.service.ts symmyIntegrationEvidenceCall.retentionPrivacyCurrent 2',
];

interface Registry {
  readonly combinator: string;
  readonly declarations: Readonly<Record<string, { readonly evidence: string; readonly owner: string }>>;
  readonly declarationsName: string;
  readonly vertical: string;
}
const REGISTRY_FILE = 'src/declared-evidence-calls.ts';
const REGISTRIES: readonly Registry[] = [
  {
    combinator: 'assortmentEvidenceCall',
    declarations: assortmentDeclaredEvidenceCalls,
    declarationsName: 'assortmentDeclaredEvidenceCalls',
    vertical: 'verticals/assortment',
  },
  {
    combinator: 'commerceCustomerContextEvidenceCall',
    declarations: commerceCustomerContextDeclaredEvidenceCalls,
    declarationsName: 'commerceCustomerContextDeclaredEvidenceCalls',
    vertical: 'verticals/commerce-customer-context',
  },
  {
    combinator: 'partyRegistryEvidenceCall',
    declarations: partyRegistryDeclaredEvidenceCalls,
    declarationsName: 'partyRegistryDeclaredEvidenceCalls',
    vertical: 'verticals/party-registry',
  },
  {
    combinator: 'privacyEvidenceCall',
    declarations: privacyDeclaredEvidenceCalls,
    declarationsName: 'privacyDeclaredEvidenceCalls',
    vertical: 'verticals/privacy',
  },
  {
    combinator: 'symmyIntegrationEvidenceCall',
    declarations: symmyIntegrationDeclaredEvidenceCalls,
    declarationsName: 'symmyIntegrationDeclaredEvidenceCalls',
    vertical: 'verticals/symmy-integration',
  },
];
const registryFile = (registry: Registry) => `${registry.vertical}/${REGISTRY_FILE}`;
const COMBINATOR_HOMES = [
  'packages/core-runtime/src/db/transaction-io-guard.ts',
  'packages/core-runtime/src/index.ts',
  'packages/core-runtime/src/outbox/worker-entrypoint.ts',
  ...REGISTRIES.map(registryFile),
];

const appRoot = new URL('../../', import.meta.url).pathname;
const alwaysSkipped = new Set(['dist', 'node_modules', '.modern']);
/** Skipped elsewhere, but scanned under a vertical's `src/`, where shipped code may sit in such a directory. */
const skippedOutsideVerticalSource = new Set(['build', 'fixtures', 'test', 'tests']);
const VERTICAL_SOURCE = /\/verticals\/[^/]+\/src(?:\/|$)/u;
const skipsDirectory = (parent: string, name: string): boolean => {
  if (name.startsWith('.') || alwaysSkipped.has(name)) {
    return true;
  }
  return skippedOutsideVerticalSource.has(name) && !VERTICAL_SOURCE.test(`${parent}/`);
};
const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return skipsDirectory(directory, entry.name) ? [] : sourceFiles(nodePath.join(directory, entry.name));
    }
    return /\.(?:c|m)?tsx?$/u.test(entry.name) && !entry.name.endsWith('.d.ts')
      ? [nodePath.join(directory, entry.name)]
      : [];
  });
const workspaceFiles = ['packages', 'verticals', 'apps']
  .flatMap((root) => sourceFiles(nodePath.join(appRoot, root)))
  .map((file) => nodePath.relative(appRoot, file))
  .toSorted();
const read = (file: string) => readFileSync(nodePath.join(appRoot, file), 'utf-8');
const parsed = (file: string) => parseSync(file, read(file)).module;

const REGISTRY_BASENAME = 'declared-evidence-calls';
const registryOfSpecifier = (file: string, specifier: string): Registry | 'unresolved' | undefined => {
  if (!specifier.includes(REGISTRY_BASENAME)) {
    return undefined;
  }
  if (!specifier.startsWith('.')) {
    return 'unresolved';
  }
  const target = nodePath.relative(
    appRoot,
    nodePath.resolve(nodePath.dirname(nodePath.join(appRoot, file)), specifier),
  );
  return REGISTRIES.find((registry) => registryFile(registry) === target) ?? 'unresolved';
};

type ImportStatement = ReturnType<typeof parsed>['staticImports'][number];

/** Only `import { <combinator> } from '../declared-evidence-calls.ts'`, from inside the registry's own vertical. */
const importProblems = (file: string, statement: ImportStatement, registry: Registry | 'unresolved'): string[] => {
  if (registry === 'unresolved' || !file.startsWith(`${registry.vertical}/`)) {
    return [`${file} imports ${statement.moduleRequest.value} from outside its vertical`];
  }
  if (statement.entries.length === 0) {
    return [`${file} imports its registry for side effects`];
  }
  return statement.entries.flatMap((entry) => {
    // A default or namespace import has no name; only the named combinator import is allowed.
    if (entry.importName.name !== registry.combinator) {
      return [`${file} imports ${entry.importName.name ?? entry.importName.kind} from its registry`];
    }
    return entry.localName.value === registry.combinator ? [] : [`${file} renames ${registry.combinator}`];
  });
};

/** `file combinator.key count` lines, failing when the combinator record is used other than by one key. */
const keyedUses = (file: string, source: string, combinator: string): string[] => {
  const mentions = source.match(new RegExp(String.raw`\b${combinator}\b`, 'gu'))?.length ?? 0;
  const keyed = [...source.matchAll(new RegExp(String.raw`\b${combinator}\.(?<key>[A-Za-z]\w*)`, 'gu'))];
  const counts = new Map<string, number>();
  for (const match of keyed) {
    const key = match.groups?.key ?? '';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const lines = [...counts].map(([key, count]) => `${file} ${combinator}.${key} ${String(count)}`);
  return mentions === keyed.length + 1 ? lines : [`${file} uses ${combinator} other than as ${combinator}.<key>`];
};

/** The pinned use lines of one file, and a failure line for every way to reach a registry the pin cannot see. */
const usesOf = (file: string): string[] => {
  const module = parsed(file);
  const source = read(file);
  const imported = module.staticImports.flatMap((statement) => {
    const registry = registryOfSpecifier(file, statement.moduleRequest.value);
    if (registry === undefined) {
      return [];
    }
    const problems = importProblems(file, statement, registry);
    return problems.length > 0 || registry === 'unresolved' ? problems : keyedUses(file, source, registry.combinator);
  });
  const reExported = module.staticExports
    .flatMap((statement) => statement.entries)
    .filter(
      (entry) => entry.moduleRequest !== null && registryOfSpecifier(file, entry.moduleRequest.value) !== undefined,
    )
    .map(() => `${file} re-exports a registry`);
  const dynamic = module.dynamicImports
    .filter(({ moduleRequest }) => source.slice(moduleRequest.start, moduleRequest.end).includes(REGISTRY_BASENAME))
    .map(() => `${file} imports a registry dynamically`);
  return [...imported, ...reExported, ...dynamic];
};

it('pins every declared in-transaction evidence call by value', () => {
  const declared = REGISTRIES.flatMap(({ declarations }) =>
    Object.values(declarations).map(({ evidence, owner }) => `${owner} ${evidence}`),
  ).toSorted();
  expect(declared).toEqual(PINNED_DECLARATIONS);
});

it('imports every owner registry in the tree', () => {
  const inTree = workspaceFiles.filter((file) => file.endsWith(`/${REGISTRY_BASENAME}.ts`));
  expect(inTree).toEqual(REGISTRIES.map(registryFile).toSorted());
});

it('lets a registry export only its declarations and its combinator record', () => {
  for (const registry of REGISTRIES) {
    const exported = parsed(registryFile(registry)).staticExports.flatMap((statement) =>
      statement.entries.map((entry) => `${entry.exportName.kind} ${entry.exportName.name ?? ''}`),
    );
    expect(exported.toSorted(), registryFile(registry)).toEqual(
      [`Name ${registry.combinator}`, `Name ${registry.declarationsName}`].toSorted(),
    );
  }
});

it('pins every place that uses a declared evidence call', () => {
  const registries = new Set(REGISTRIES.map(registryFile));
  const uses = workspaceFiles
    .filter((file) => !registries.has(file) && read(file).includes(REGISTRY_BASENAME))
    .flatMap(usesOf);
  expect(uses.toSorted()).toEqual(PINNED_USES.toSorted());
});

it('names the combinator only in the guard, its two re-exports and the owner registries', () => {
  const users = workspaceFiles.filter((file) => read(file).includes('declaredEvidenceCallInsideTransaction'));
  expect(users).toEqual(COMBINATOR_HOMES.toSorted());
});
