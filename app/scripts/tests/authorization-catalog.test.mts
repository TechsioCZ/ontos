import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Result } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  accessCatalogGapReason,
  buildAccessCatalogDiff,
  buildAccessCatalogReport,
  buildAccessCatalogSnapshot,
  decodeTopologyCallerAppIds,
  isAccessCatalogSourcePath,
  ownerLocalImportTargets,
  renderAccessCatalogDiffText,
  renderAccessCatalogReportText,
  scanAccessCatalogSource,
} from '../authorization-catalog.mts';
import type {
  AccessCatalogDiffInput,
  AccessCatalogDiffSource,
  AccessCatalogSource,
} from '../authorization-catalog.mts';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const topologyText = readFileSync(path.join(appRoot, 'topology', 'reference-topology.json'), 'utf-8');
/** The callers this checkout's topology declares; every scan in this file names its revision's callers. */
const TOPOLOGY_CALLERS = Result.getOrThrow(decodeTopologyCallerAppIds(topologyText));
const buildSnapshot = (sources: readonly AccessCatalogSource[]) =>
  buildAccessCatalogSnapshot(sources, TOPOLOGY_CALLERS);

const createKey = 'projects.core.project.create';
const createEntrypointKey = 'projects.core.create-project';
const actionFile = 'verticals/projects/src/actions/x.action.ts';
const manifestFile = 'verticals/party-registry/vertical.manifest.ts';
const contactsKey = 'party.registry.contacts-page.open';
const diffModuleId = 'module.core';
const consentReadKey = 'privacy.core.consent.read';
const consentGroupKey = 'privacy.core.consent.margins';
const consentMarginsFields = ['consent.margins.amount', 'consent.margins.currencyCode'] as const;
const privacyReadFile = 'verticals/privacy/src/api/consent.read.ts';
const privacyModuleId = 'privacy.core';
const projectsModuleId = 'projects.core';
const workloadReason = 'identity namespace provisioning only';
const workloadFile = 'verticals/projects/src/actions/provision-binding.action.ts';
const workloadEntrypointKey = 'projects.core.provision-binding';
const staticGroupsProblem = 'accessFieldGroups must be a static array of group object literals';

const actionSource = (declaration: string, slug = 'create-project') => `
const MODULE_KEY = 'projects.core' as const;
const ACTION_KEY = 'projects.core.${slug}' as const;
export const ${slug}Action = defineAction(
  {
${declaration}
    actionKey: ACTION_KEY,
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'protected' },
      entrypointKey: ACTION_KEY,
      moduleKey: MODULE_KEY,
      role: 'action',
    }),
  },
  handler,
);
`;

const declaredAction = (key = createKey) => `    accessDeclaration: {
      key: '${key}',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'projects', level: 'extended' },
      risk: 'sensitive',
      selectors: [],
    },`;

const readSource = (declaration: string) => `
const moduleKey = 'privacy.core' as const;
const currentConsentEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'privacy.core.api.current-consent',
  moduleKey,
  role: 'api',
});
export const currentConsentRead = defineRead(
  {
${declaration}
    accessKind: 'detail',
    entrypoint: currentConsentEntrypoint,
    readKey: 'privacy.core.api.current-consent',
  },
  handler,
);
`;

const declaredRead = `    accessDeclaration: {
      key: '${consentReadKey}',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'consent', level: 'basic' },
      risk: 'sensitive',
      selectors: [],
    },`;

const pageContributionSource = (declaration?: string) => `
manifest = defineOntosModuleManifest({
  shellContributions: {
    pages: [
      pageContribution({
${declaration ?? ''}
        componentKey: 'party.registry.page-contacts',
        contributionKey: 'party.registry.page.contacts',
        entrypoint: {
          access: 'read',
          authorization: { kind: 'protected' },
          entrypointKey: 'party.registry.page.contacts',
          moduleKey: 'party.registry',
          role: 'page',
          scope: 'tenant',
        },
        expose: './PageContacts',
        routePath: '/contacts',
      }),
    ],
  },
});
`;

const routeMetadataSource = `
const routeMeta = {
  accessDeclaration: {
    key: 'commerce.market-catalog.home.read',
    kind: 'read',
    modes: ['run'],
    placement: { group: 'markets', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  canonicalPath: '/',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'commerce.market-catalog.page.home',
    moduleKey: 'commerce.market-catalog',
    role: 'page',
  }),
};
`;

const diffSource = (key: string, overrides: Partial<AccessCatalogDiffSource> = {}): AccessCatalogDiffSource => ({
  entrypointKey: `module.api.${key}`,
  file: `verticals/module/src/api/${key}.read.ts`,
  key,
  kind: 'read',
  moduleId: diffModuleId,
  renamedFrom: [],
  risk: 'routine',
  splitFrom: null,
  ...overrides,
});

const diffOf = (entries: readonly AccessCatalogDiffSource[]): AccessCatalogDiffInput => ({ entries });

const declaredFieldGroup = (key: string = consentGroupKey) => `      {
        fieldClass: 'margins',
        fields: ['${consentMarginsFields[0]}', '${consentMarginsFields[1]}'],
        key: '${key}',
        kind: 'field_read',
        modes: ['run'],
        placement: { group: 'consent', level: 'extended' },
        risk: 'sensitive',
        selectors: [],
      },`;

const readWithFieldGroups = (groups: string) => `
const moduleKey = '${privacyModuleId}' as const;
export const currentConsentRead = defineRead(
  {
    accessFieldGroups: [
${groups}
    ],
    accessDeclaration: {
      key: '${consentReadKey}',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'consent', level: 'basic' },
      risk: 'sensitive',
      selectors: [],
    },
    accessKind: 'detail',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: 'privacy.core.api.current-consent',
      moduleKey,
      role: 'api',
    }),
    readKey: 'privacy.core.api.current-consent',
  },
  handler,
);
`;

const workloadSource = (workload: string) => `
const ACTION_KEY = '${workloadEntrypointKey}' as const;
export const provisionBindingAction = defineAction(
  {
${workload}
    actionKey: ACTION_KEY,
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'protected' },
      entrypointKey: ACTION_KEY,
      moduleKey: '${projectsModuleId}',
      role: 'action',
    }),
  },
  handler,
);
`;

const workloadKey = 'projects.machine-provisioner';

const declaredWorkload = `    accessWorkload: {
      reason: '${workloadReason}',
      workloads: ['${workloadKey}'],
    },`;

const workloadOnlyMarker = `    accessWorkload: { reason: 'machine only', workloads: ['privacy.machine-provisioner'] },`;
const currentConsentEntrypointKey = 'privacy.core.api.current-consent';

const diffInputOf = (snapshot: ReturnType<typeof buildSnapshot>): AccessCatalogDiffInput => ({
  entries: snapshot.entries.map((entry) => ({
    entrypointKey: entry.entrypointKey,
    file: entry.file,
    key: entry.key,
    kind: entry.kind,
    moduleId: entry.moduleId,
    renamedFrom: entry.renamedFrom,
    risk: entry.risk,
    splitFrom: entry.splitFrom,
  })),
});

const spreadActionSource = (spread: string) => `export const archivePersonAction = defineAction(
  {
    accessDeclaration: {
      key: 'party.registry.person-engagement.archive',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'engagements', level: 'manage' },
      risk: 'sensitive',
      selectors: ['all'],
    },
    ${spread}
  },
  handler,
);`;
const spreadFile = 'verticals/party-registry/src/actions/archive-person-engagement.action.ts';
const spreadProblem = 'the entrypoint of this declaration comes from a spread and is not visible here';

describe('access catalog source scan', () => {
  it('reads a declared Action with its entrypoint and implied scope', () => {
    const scanned = scanAccessCatalogSource(actionSource(declaredAction()), actionFile);
    const [carrier] = scanned.carriers;
    expect(scanned.problems).toStrictEqual([]);
    expect(carrier?.carrier).toBe('action');
    expect(carrier?.entrypoint.moduleKey).toBe(projectsModuleId);
    expect(carrier?.entrypoint.entrypointKey).toBe(createEntrypointKey);
    expect(carrier?.entrypoint.authorization.kind).toBe('protected');
    expect(carrier?.entrypoint.scope).toBe('tenant');
    expect(carrier?.accessDeclaration?.key).toBe(createKey);
  });

  it('reads a governed read through a same-file entrypoint constant and shorthand module key', () => {
    const scanned = scanAccessCatalogSource(readSource(declaredRead), privacyReadFile);
    const [carrier] = scanned.carriers;
    expect(scanned.problems).toStrictEqual([]);
    expect(carrier?.carrier).toBe('read');
    expect(carrier?.entrypoint.moduleKey).toBe(privacyModuleId);
    expect(carrier?.entrypoint.authorization).toStrictEqual({ kind: 'protected' });
  });

  it('reads a Shell page contribution and its protected entrypoint', () => {
    const scanned = scanAccessCatalogSource(pageContributionSource(declaredAction(contactsKey)), manifestFile);
    const [carrier] = scanned.carriers;
    expect(carrier?.carrier).toBe('contribution');
    expect(carrier?.entrypoint.authorization.kind).toBe('protected');
    expect(carrier?.accessDeclaration?.key).toBe(contactsKey);
  });

  it('reads route metadata that carries the page declaration', () => {
    const scanned = scanAccessCatalogSource(
      routeMetadataSource,
      'verticals/commerce-market-catalog/src/routes/[lang]/route.meta.ts',
    );
    const [carrier] = scanned.carriers;
    expect(scanned.problems).toStrictEqual([]);
    expect(carrier?.carrier).toBe('page');
    expect(carrier?.accessDeclaration?.key).toBe('commerce.market-catalog.home.read');
  });

  it('reads the v2 protected classification and calls it missing without a declaration', () => {
    const scanned = scanAccessCatalogSource(readSource(declaredRead), privacyReadFile);
    expect(scanned.problems).toStrictEqual([]);
    expect(scanned.carriers[0]?.entrypoint.authorization).toStrictEqual({ kind: 'protected' });
    expect(scanned.carriers[0]?.accessDeclaration?.key).toBe(consentReadKey);

    const undeclared = buildSnapshot([{ file: privacyReadFile, source: readSource('') }]);
    expect(undeclared.invalid).toStrictEqual([]);
    expect(undeclared.missing.map((problem) => problem.entrypointKey)).toStrictEqual([currentConsentEntrypointKey]);
    expect(undeclared.missing[0]?.authorizationKind).toBe('protected');
  });

  it('resolves the entrypoint of the governed engagement registration from its exact key', () => {
    const scanned = scanAccessCatalogSource(
      spreadActionSource(
        `...engagementLifecycleRegistration<PersonEngagementLifecyclePayload>(
      'party.registry.archive-person-engagement',
    ),`,
      ),
      spreadFile,
    );
    expect(scanned.problems).toStrictEqual([]);
    expect(scanned.carriers.map(({ carrier, entrypoint }) => [carrier, entrypoint])).toStrictEqual([
      [
        'action',
        {
          access: 'write',
          authorization: { kind: 'protected' },
          entrypointKey: 'party.registry.archive-person-engagement',
          moduleKey: 'party.registry',
          role: 'action',
          scope: 'tenant',
        },
      ],
    ]);
  });

  it('reports any other spread entrypoint instead of guessing it', () => {
    for (const spread of [
      "...otherRegistration('party.registry.archive-person-engagement'),",
      "...engagementLifecycleRegistration('party.registry.delete-person'),",
      '...engagementLifecycleRegistration(ACTION_KEY),',
    ]) {
      const scanned = scanAccessCatalogSource(spreadActionSource(spread), spreadFile);
      expect(scanned.carriers).toStrictEqual([]);
      expect(scanned.problems.map((problem) => problem.reason)).toStrictEqual([spreadProblem]);
    }
  });

  it('reports a computed declaration instead of inferring its value', () => {
    const scanned = scanAccessCatalogSource(actionSource('    accessDeclaration: sharedDeclaration,'), actionFile);
    expect(scanned.carriers).toStrictEqual([]);
    expect(scanned.problems.map((problem) => problem.reason)).toStrictEqual([
      'accessDeclaration must be a static object literal',
    ]);
  });

  it('reads a generic descriptor factory that declares type parameters before its input', () => {
    const scanned = scanAccessCatalogSource(
      `${readSource(declaredRead)}
export const listManagedRead = defineReadConditionalPermission<
  typeof Request,
  'core.identity',
  Services
>(
  {
    accessDeclaration: {
      key: 'core.identity.managed.list',
      kind: 'admin',
      modes: ['run'],
      placement: { group: 'identity', level: 'manage' },
      risk: 'sensitive',
      selectors: [],
    },
    entrypoint: currentConsentEntrypoint,
    readKey: 'core.identity.managed',
  },
  handler,
);`,
      'packages/core-runtime/src/auth/principal-administration-reads.ts',
    );
    expect(scanned.carriers.map((carrier) => carrier.accessDeclaration?.key)).toStrictEqual([
      consentReadKey,
      'core.identity.managed.list',
    ]);
  });

  it('ignores descriptors copied inside library code instead of declared', () => {
    const scanned = scanAccessCatalogSource(
      `export const copy = (descriptor) => ({ accessDeclaration: descriptor.accessDeclaration, entrypoint: descriptor.entrypoint });`,
      'packages/core-runtime/src/modules/manifest.ts',
    );
    expect(scanned.carriers).toStrictEqual([]);
    expect(scanned.problems).toStrictEqual([]);
  });
});

const importedMarketFile = 'verticals/commerce-market-catalog/src/actions/retire-market.action.ts';
const importedSupportFile = 'verticals/commerce-market-catalog/src/actions/market-action-support.ts';
const importedSupport = "export const MODULE_KEY = 'commerce.market-catalog' as const;\n";
const importedModuleKey = 'commerce.market-catalog';
const importedRetireKey = 'commerce.market-catalog.retire-market';
const supportImport = "import { MODULE_KEY } from './market-action-support.ts';";
const missingModuleKey = 'entrypoint is missing moduleKey';

/** An Action whose module key comes from an import the caller supplies, not from a local constant. */
const importingActionSource = (importLine: string, moduleKeyRef = 'MODULE_KEY') => `${importLine}
const ACTION_KEY = '${importedRetireKey}' as const;
export const retireMarketAction = defineAction(
  {
${declaredAction(importedRetireKey)}
    actionKey: ACTION_KEY,
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'protected' },
      entrypointKey: ACTION_KEY,
      moduleKey: ${moduleKeyRef},
      role: 'action',
    }),
  },
  handler,
);
`;

describe('access catalog same-module imported constants', () => {
  it('resolves an owner-local imported constant, plain or aliased, from its exported string value', () => {
    const sources = new Map([[importedSupportFile, importedSupport]]);
    expect(ownerLocalImportTargets(importingActionSource(supportImport), importedMarketFile)).toStrictEqual([
      importedSupportFile,
    ]);
    const scanned = scanAccessCatalogSource(importingActionSource(supportImport), importedMarketFile, sources);
    expect(scanned.problems).toStrictEqual([]);
    expect(scanned.carriers.map(({ entrypoint }) => entrypoint.moduleKey)).toStrictEqual([importedModuleKey]);
    const aliased = scanAccessCatalogSource(
      importingActionSource("import { MODULE_KEY as KEY } from './market-action-support.ts';", 'KEY'),
      importedMarketFile,
      sources,
    );
    expect(aliased.problems).toStrictEqual([]);
    expect(aliased.carriers.map(({ entrypoint }) => entrypoint.moduleKey)).toStrictEqual([importedModuleKey]);
  });

  it('refuses an import that leaves the module, a package import or a re-export chain', () => {
    const sources = new Map([
      ['verticals/party-registry/src/market-action-support.ts', importedSupport],
      [
        'verticals/commerce-market-catalog/src/actions/index.ts',
        "export { MODULE_KEY } from './market-action-support.ts';\n",
      ],
      [importedSupportFile, importedSupport],
    ]);
    const outsideImport = "import { MODULE_KEY } from '../../../party-registry/src/market-action-support.ts';";
    for (const importLine of [
      outsideImport,
      "import { MODULE_KEY } from '@app/commerce-market-catalog/market-action-support.ts';",
      "import { MODULE_KEY } from './index.ts';",
    ]) {
      const scanned = scanAccessCatalogSource(importingActionSource(importLine), importedMarketFile, sources);
      expect(scanned.carriers).toStrictEqual([]);
      expect(scanned.problems.map((problem) => problem.reason)).toStrictEqual([missingModuleKey]);
    }
    expect(ownerLocalImportTargets(importingActionSource(outsideImport), importedMarketFile)).toStrictEqual([]);
  });

  it('refuses a non-string, unexported, type-only or unknown imported name instead of guessing it', () => {
    for (const [importLine, moduleKeyRef, support] of [
      [supportImport, 'MODULE_KEY', 'export const MODULE_KEY = commerceModuleKey();\n'],
      [supportImport, 'MODULE_KEY', 'export const MODULE_KEY = 42;\n'],
      [supportImport, 'MODULE_KEY', "const MODULE_KEY = 'commerce.market-catalog' as const;\n"],
      ["import { MARKET_KEY } from './market-action-support.ts';", 'MARKET_KEY', importedSupport],
      ["import type { MODULE_KEY } from './market-action-support.ts';", 'MODULE_KEY', importedSupport],
    ] as const) {
      const scanned = scanAccessCatalogSource(
        importingActionSource(importLine, moduleKeyRef),
        importedMarketFile,
        new Map([[importedSupportFile, support]]),
      );
      expect(scanned.carriers).toStrictEqual([]);
      expect(scanned.problems.map((problem) => problem.reason)).toStrictEqual([missingModuleKey]);
    }
  });
});

describe('access catalog snapshot', () => {
  it('lists a protected entrypoint that declares nothing', () => {
    const snapshot = buildSnapshot([{ file: actionFile, source: actionSource('') }]);
    expect(snapshot.entries).toStrictEqual([]);
    expect(snapshot.missing).toHaveLength(1);
    expect(snapshot.missing[0]?.entrypointKey).toBe(createEntrypointKey);
    expect(snapshot.missing[0]?.authorizationKind).toBe('protected');
  });

  it('declares a page once even when its navigation entry carries the same entrypoint', () => {
    const declaration = `        accessDeclaration: {
          key: '${contactsKey}',
          kind: 'read',
          modes: ['run'],
          placement: { group: 'parties', level: 'basic' },
          risk: 'routine',
          selectors: [],
        },`;
    const source = `${pageContributionSource(declaration)}
navigation = navigationContribution({
  contributionKey: 'party.registry.navigation.contacts',
  entrypoint: {
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: 'party.registry.page.contacts',
    moduleKey: 'party.registry',
    role: 'page',
    scope: 'tenant',
  },
});`;
    const snapshot = buildSnapshot([{ file: manifestFile, source }]);
    expect(snapshot.missing).toStrictEqual([]);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.key).toBe(contactsKey);
    const navigationFirst = buildSnapshot([
      { file: 'verticals/party-registry/a-navigation.ts', source: source.slice(source.indexOf('navigation =')) },
      { file: manifestFile, source: pageContributionSource(declaration) },
    ]);
    expect(navigationFirst.missing).toStrictEqual([]);
    expect(navigationFirst.entries).toHaveLength(1);
    const neither = buildSnapshot([
      { file: 'verticals/party-registry/a-navigation.ts', source: source.slice(source.indexOf('navigation =')) },
      { file: manifestFile, source: pageContributionSource() },
    ]);
    expect(neither.missing.map((entry) => entry.entrypointKey)).toStrictEqual(['party.registry.page.contacts']);
  });

  it('rejects a routine dangerous verb and never treats it as declared', () => {
    const snapshot = buildSnapshot([
      {
        file: 'verticals/projects/src/actions/delete.action.ts',
        source: actionSource(
          `    accessDeclaration: {
      key: 'projects.core.project.delete',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'projects', level: 'manage' },
      risk: 'routine',
      selectors: [],
    },`,
        ),
      },
    ]);
    expect(snapshot.entries).toStrictEqual([]);
    expect(snapshot.invalid.map((problem) => problem.reason)).toStrictEqual([
      'accessDeclaration is invalid: dangerous verb in projects.core.project.delete cannot have routine risk',
    ]);
  });

  it('reports a duplicate key inside one module through the Core catalog', () => {
    const snapshot = buildSnapshot([
      {
        file: 'verticals/projects/src/actions/a.action.ts',
        source: actionSource(declaredAction(createKey), 'create-project'),
      },
      {
        file: 'verticals/projects/src/actions/b.action.ts',
        source: actionSource(declaredAction(createKey), 'add-project'),
      },
    ]);
    expect(snapshot.invalid.map((problem) => problem.reason)).toContain(
      `access_catalog_duplicate_key: access key ${createKey} is declared twice`,
    );
  });

  it('does not require a declaration on an unclassified public carrier', () => {
    const snapshot = buildSnapshot([
      {
        file: 'verticals/privacy/vertical.manifest.ts',
        source: `publicComponentContribution({
  componentKey: 'privacy.core.widget',
  contributionKey: 'privacy.core.component.widget',
  entrypoint: {
    access: 'read',
    authorization: { kind: 'authenticated_principal' },
    entrypointKey: 'privacy.core.component.widget',
    moduleKey: privacyModuleId,
    role: 'public_component',
    scope: 'tenant',
  },
  expose: './Widget',
});`,
      },
    ]);
    expect(snapshot.missing).toStrictEqual([]);
    expect(snapshot.entries).toStrictEqual([]);
  });
});

describe('access catalog report', () => {
  it('counts declarations by module, kind and risk', () => {
    const report = buildAccessCatalogReport(
      buildSnapshot([
        { file: actionFile, source: actionSource(declaredAction()) },
        { file: privacyReadFile, source: readSource(declaredRead) },
        { file: 'verticals/projects/src/actions/y.action.ts', source: actionSource('', 'archive-project') },
      ]),
    );
    expect(report.totals.declarations).toBe(2);
    expect(report.totals.missing).toBe(1);
    expect(report.byKind).toStrictEqual([
      { count: 1, value: 'action' },
      { count: 1, value: 'read' },
      { count: 0, value: 'field_read' },
      { count: 0, value: 'field_write' },
      { count: 0, value: 'export' },
      { count: 0, value: 'admin' },
    ]);
    expect(report.byRisk).toStrictEqual([
      { count: 0, value: 'routine' },
      { count: 2, value: 'sensitive' },
      { count: 0, value: 'critical' },
    ]);
    expect(report.modules.map((module) => module.moduleId)).toStrictEqual([privacyModuleId, projectsModuleId]);
    expect(report.modules[1]?.missingDeclarations).toBe(1);
  });

  it('surfaces an unlisted field class and a dangerous verb as review findings', () => {
    const report = buildAccessCatalogReport(
      buildSnapshot([
        {
          file: 'verticals/pricing/src/api/margins.read.ts',
          source: readSource(`    accessDeclaration: {
      key: 'privacy.core.commercial-activity.read',
      fieldClass: 'commercial_activity',
      kind: 'field_read',
      modes: ['run'],
      placement: { group: 'pricing', level: 'extended' },
      risk: 'sensitive',
      selectors: [],
    },`),
        },
        {
          file: 'verticals/pricing/src/actions/retire.action.ts',
          source: actionSource(declaredAction('projects.core.project.retire')),
        },
      ]),
    );
    expect(report.findings.map((finding) => finding.code)).toStrictEqual(['unlisted_field_class', 'dangerous_verb']);
    expect(report.findings[1]?.reason).toBe('dangerous verb declared as sensitive');
  });

  it('renders a deterministic text view with gaps and findings', () => {
    const report = buildAccessCatalogReport(buildSnapshot([{ file: actionFile, source: actionSource('') }]));
    const text = renderAccessCatalogReportText(report);
    expect(text).toContain('Authorization v2 access catalog (report only; no decision changes)');
    expect(text).toContain('Missing declarations: 1');
    expect(text).toContain('projects.core.create-project');
  });
});

describe('access catalog diff', () => {
  it('lists additions, removals and risk changes', () => {
    const before = diffOf([diffSource('a.read'), diffSource('b.read', { risk: 'routine' })]);
    const after = diffOf([diffSource('b.read', { risk: 'critical' }), diffSource('c.read', { risk: 'sensitive' })]);
    const diff = buildAccessCatalogDiff(before, after, { baseRef: 'base', headRef: 'HEAD' });
    expect(diff.added.map((entry) => entry.key)).toStrictEqual(['c.read']);
    expect(diff.removed.map((entry) => entry.key)).toStrictEqual(['a.read']);
    expect(diff.riskChanged).toStrictEqual([
      { fromRisk: 'routine', key: 'b.read', moduleId: diffModuleId, toRisk: 'critical' },
    ]);
    expect(renderAccessCatalogDiffText(diff)).toContain('risk b.read: routine -> critical');
  });

  it('treats a rename as continuity instead of a removal plus an addition', () => {
    const before = diffOf([diffSource('a.read')]);
    const after = diffOf([diffSource('a.view', { renamedFrom: ['a.read'] })]);
    const diff = buildAccessCatalogDiff(before, after, { baseRef: 'base', headRef: 'HEAD' });
    expect(diff.removed).toStrictEqual([]);
    expect(diff.added.map((entry) => entry.key)).toStrictEqual(['a.view']);
    expect(diff.renamed.map((entry) => [entry.fromKey, entry.key])).toStrictEqual([['a.read', 'a.view']]);
  });

  it('groups both halves of a split under one predecessor', () => {
    const before = diffOf([diffSource('a.read')]);
    const after = diffOf([
      diffSource('a.read.visible', { splitFrom: 'a.read' }),
      diffSource('a.read.margins', { splitFrom: 'a.read' }),
    ]);
    const diff = buildAccessCatalogDiff(before, after, { baseRef: 'base', headRef: 'HEAD' });
    expect(diff.removed).toStrictEqual([]);
    expect(diff.split).toStrictEqual([
      { fromKey: 'a.read', keys: ['a.read.margins', 'a.read.visible'], moduleId: diffModuleId },
    ]);
  });

  it('ignores source files that cannot declare an entrypoint', () => {
    expect(isAccessCatalogSourcePath(actionFile)).toBe(true);
    expect(isAccessCatalogSourcePath('verticals/projects/tests/unit/x.test.ts')).toBe(false);
    expect(isAccessCatalogSourcePath('verticals/projects/dist/x.js')).toBe(false);
    expect(isAccessCatalogSourcePath('verticals/projects/src/actions/x.json')).toBe(false);
  });
});

describe('access catalog field groups and workload markers', () => {
  it('reads a field-group list beside its declaration and lists each group as its own entry', () => {
    const source = readWithFieldGroups(declaredFieldGroup());
    const scanned = scanAccessCatalogSource(source, privacyReadFile);
    expect(scanned.problems).toStrictEqual([]);
    expect(scanned.carriers).toHaveLength(1);
    expect(scanned.carriers[0]?.accessFieldGroups).toStrictEqual([
      {
        fieldClass: 'margins',
        fields: [...consentMarginsFields],
        key: consentGroupKey,
        kind: 'field_read',
        modes: ['run'],
        placement: { group: 'consent', level: 'extended' },
        risk: 'sensitive',
        selectors: [],
      },
    ]);
    expect(scanned.carriers[0]?.accessWorkload).toBeNull();

    const snapshot = buildSnapshot([{ file: privacyReadFile, source }]);
    expect(snapshot.invalid).toStrictEqual([]);
    expect(snapshot.missing).toStrictEqual([]);
    expect(
      snapshot.entries.map(({ fields, key, kind, parentKey }) => ({ fields, key, kind, parentKey })),
    ).toStrictEqual([
      { fields: [...consentMarginsFields], key: consentGroupKey, kind: 'field_read', parentKey: consentReadKey },
      { fields: [], key: consentReadKey, kind: 'read', parentKey: null },
    ]);

    const report = buildAccessCatalogReport(snapshot);
    expect(report.totals.fieldGroups).toBe(1);
    expect(report.totals.declarations).toBe(2);
    expect(report.totals.protectedEntrypoints).toBe(1);
    expect(report.declared[0]).toStrictEqual({
      agentPolicy: 'never',
      carrier: 'read',
      entrypointKey: currentConsentEntrypointKey,
      fieldClass: 'margins',
      fields: [...consentMarginsFields],
      file: privacyReadFile,
      key: consentGroupKey,
      kind: 'field_read',
      moduleId: privacyModuleId,
      parentKey: consentReadKey,
      risk: 'sensitive',
    });
    expect(renderAccessCatalogReportText(report)).toContain('Field groups: 1');
  });

  it('reports a computed field-group list instead of inferring its value', () => {
    const scanned = scanAccessCatalogSource(
      readWithFieldGroups(declaredFieldGroup()).replace(
        '    accessFieldGroups: [',
        '    accessFieldGroups: sharedGroups ?? [',
      ),
      privacyReadFile,
    );
    expect(scanned.carriers).toStrictEqual([]);
    expect(scanned.problems.map((problem) => problem.reason)).toStrictEqual([staticGroupsProblem]);
  });

  it('rejects a field group whose kind, key or field class breaks the carrier rules', () => {
    const cases = [
      [
        declaredFieldGroup().replace("kind: 'field_read'", "kind: 'field_write'"),
        'must declare field groups as field_read',
      ],
      [declaredFieldGroup(consentReadKey), 'must declare its own key, not the key of its parent declaration'],
      [declaredFieldGroup('other.module.consent.margins'), 'must be privacy.core.<resource>.<verb>'],
      [declaredFieldGroup().replace("risk: 'sensitive'", "risk: 'routine'"), 'requires at least sensitive risk'],
    ] as const;
    for (const [group, expected] of cases) {
      const snapshot = buildSnapshot([{ file: privacyReadFile, source: readWithFieldGroups(group) }]);
      expect(snapshot.entries).toStrictEqual([]);
      expect(snapshot.invalid).toHaveLength(1);
      expect(snapshot.invalid[0]?.reason).toContain(expected);
    }
  });

  it('rejects field groups on a descriptor that declares no declaration of its own', () => {
    const source = readWithFieldGroups(declaredFieldGroup()).replace(
      / {4}accessDeclaration: \{[\s\S]*?\n {4}\},\n/u,
      '',
    );
    expect(source).not.toContain('accessDeclaration');
    const snapshot = buildSnapshot([{ file: privacyReadFile, source }]);
    expect(snapshot.entries).toStrictEqual([]);
    expect(snapshot.invalid.map((problem) => problem.reason)).toStrictEqual([
      'accessFieldGroups require the descriptor to declare its own accessDeclaration (O58)',
    ]);
  });

  it('reads a workload named by a same-file string constant and still refuses a computed one', () => {
    const named = workloadSource(declaredWorkload.replace(`['${workloadKey}']`, '[MACHINE_PROVISIONER]'));
    const constant = `const MACHINE_PROVISIONER = '${workloadKey}';\n${named}`;
    const scanned = scanAccessCatalogSource(constant, workloadFile);
    expect(scanned.problems).toStrictEqual([]);
    expect(scanned.carriers[0]?.accessWorkload).toStrictEqual({ reason: workloadReason, workloads: [workloadKey] });
    // Without the constant the identifier names nothing static, so the carrier is reported.
    expect(scanAccessCatalogSource(named, workloadFile).problems.map(({ reason }) => reason)).toStrictEqual([
      'accessWorkload must be a static object literal',
    ]);
  });

  it('settles a workload carrier without a catalog entry and reports it as its own section', () => {
    const source = workloadSource(declaredWorkload);
    const scanned = scanAccessCatalogSource(source, workloadFile);
    expect(scanned.problems).toStrictEqual([]);
    expect(scanned.carriers[0]?.accessWorkload).toStrictEqual({ reason: workloadReason, workloads: [workloadKey] });
    expect(scanned.carriers[0]?.accessDeclaration).toBeNull();

    const snapshot = buildSnapshot([{ file: workloadFile, source }]);
    expect(snapshot.entries).toStrictEqual([]);
    expect(snapshot.missing).toStrictEqual([]);
    expect(snapshot.invalid).toStrictEqual([]);
    expect(snapshot.workloads).toStrictEqual([
      {
        carrier: 'action',
        entrypointKey: workloadEntrypointKey,
        file: workloadFile,
        moduleId: projectsModuleId,
        reason: workloadReason,
        workloads: [workloadKey],
      },
    ]);

    const report = buildAccessCatalogReport(snapshot);
    expect(report.totals.workloads).toBe(1);
    expect(report.totals.missing).toBe(0);
    expect(report.totals.protectedEntrypoints).toBe(1);
    expect(report.modules.map((module) => [module.moduleId, module.workloadActions])).toStrictEqual([
      [projectsModuleId, 1],
    ]);
    const rendered = renderAccessCatalogReportText(report);
    expect(rendered).toContain('Workload Actions: 1 (machine-only, never granted to humans or agents)');
    expect(rendered).toContain(workloadEntrypointKey);
  });

  it('accepts a workload beside the declaration of an Action (O67-Q4) and lists both', () => {
    const dual = buildSnapshot([
      { file: workloadFile, source: workloadSource(`${declaredWorkload}\n${declaredAction()}`) },
    ]);
    expect(dual.invalid).toStrictEqual([]);
    expect(dual.missing).toStrictEqual([]);
    expect(dual.workloads.map((workload) => workload.entrypointKey)).toStrictEqual([workloadEntrypointKey]);
    expect(dual.entries.map((entry) => entry.key)).toStrictEqual([createKey]);
  });

  it('accepts a workload on a governed read (O72), alone and beside its declaration', () => {
    const machineOnly = buildSnapshot([{ file: privacyReadFile, source: readSource(workloadOnlyMarker) }]);
    expect(machineOnly.invalid).toStrictEqual([]);
    expect(machineOnly.missing).toStrictEqual([]);
    expect(machineOnly.workloads.map((workload) => workload.entrypointKey)).toStrictEqual([
      currentConsentEntrypointKey,
    ]);

    const dual = buildSnapshot([
      {
        file: privacyReadFile,
        source: readSource(`${workloadOnlyMarker}\n${declaredRead}`),
      },
    ]);
    expect(dual.invalid).toStrictEqual([]);
    expect(dual.workloads.map((workload) => workload.entrypointKey)).toStrictEqual([currentConsentEntrypointKey]);
    expect(dual.entries.map((entry) => entry.key)).toStrictEqual([consentReadKey]);
  });

  it('rejects a workload beside field groups, on an unprotected read, or left unexplained', () => {
    const withFieldGroups = buildSnapshot([
      {
        file: privacyReadFile,
        source: readWithFieldGroups(declaredFieldGroup()).replace(
          '    accessFieldGroups: [',
          `${workloadOnlyMarker}\n    accessFieldGroups: [`,
        ),
      },
    ]);
    expect(withFieldGroups.workloads).toStrictEqual([]);
    expect(withFieldGroups.invalid.map((problem) => problem.reason)).toContain(
      'accessWorkload sits beside accessDeclaration only on an Action or a governed read, and never beside accessFieldGroups (O59, O67-Q4, O72)',
    );

    const unexplained = buildSnapshot([
      {
        file: workloadFile,
        source: workloadSource("    accessWorkload: { reason: '   ', workloads: ['projects.machine-provisioner'] },"),
      },
    ]);
    expect(unexplained.workloads).toStrictEqual([]);
    expect(unexplained.invalid[0]?.reason.startsWith('accessWorkload is invalid:')).toBe(true);

    // O72: only an Action or a governed read carries a workload; an unprotected read never does.
    const readWorkload = buildSnapshot([
      {
        file: privacyReadFile,
        source: readSource(workloadOnlyMarker).replace(
          "authorization: { kind: 'protected' }",
          "authorization: { kind: 'authenticated_principal' }",
        ),
      },
    ]);
    expect(readWorkload.workloads).toStrictEqual([]);
    expect(readWorkload.missing).toStrictEqual([]);
    expect(readWorkload.invalid.map((problem) => problem.reason)).toStrictEqual([
      'accessWorkload is invalid: authenticated_principal api entrypoints cannot carry accessWorkload: only an Action or a governed read can be a workload',
    ]);
  });

  it('keeps workload carriers out of the catalog diff', () => {
    const before = buildSnapshot([{ file: workloadFile, source: workloadSource(declaredWorkload) }]);
    const after = buildSnapshot([
      { file: workloadFile, source: workloadSource(declaredWorkload) },
      { file: actionFile, source: actionSource(declaredAction()) },
    ]);
    const diff = buildAccessCatalogDiff(diffInputOf(before), diffInputOf(after), { baseRef: 'base', headRef: 'HEAD' });
    expect(before.entries).toStrictEqual([]);
    expect(diff.added.map((entry) => entry.key)).toStrictEqual([createKey]);
    expect(diff.removed).toStrictEqual([]);
    expect(diff.renamed).toStrictEqual([]);
  });
});

const reportScript = path.join(appRoot, 'scripts', 'authorization-catalog-report.mts');

const bareProtectedAction = `
export const bareAction = defineAction(
  {
    actionKey: 'demo.core.thing.do',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'protected' },
      entrypointKey: 'demo.core.thing.do',
      moduleKey: 'demo.core',
      role: 'action',
    }),
  },
  handler,
);
`;

const routineDangerousAction = bareProtectedAction.replace(
  "    actionKey: 'demo.core.thing.do',",
  `    accessDeclaration: {
      key: 'demo.core.thing.delete',
      kind: 'action',
      modes: ['run'],
      placement: { group: 'things', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
    actionKey: 'demo.core.thing.do',`,
);

/** Runs the real catalog CLI against a disposable workspace root, so the exit code is under test. */
const runCatalogReport = (files: readonly (readonly [string, string])[]) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ontos-access-catalog-'));
  try {
    // The report reads the topology of the root it scans, so the disposable root carries this checkout's.
    mkdirSync(path.join(root, 'topology'), { recursive: true });
    writeFileSync(path.join(root, 'topology', 'reference-topology.json'), topologyText, 'utf-8');
    for (const [relative, source] of files) {
      const absolute = path.join(root, relative);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, source, 'utf-8');
    }
    const result = spawnSync(process.execPath, [reportScript, '--root', root, '--quiet'], {
      cwd: appRoot,
      encoding: 'utf-8',
    });
    return { status: result.status, stderr: result.stderr, stdout: result.stdout };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

describe('access catalog gap check (O62)', () => {
  it('reports the remaining gaps as one actionable reason and nothing when the catalog is complete', () => {
    const complete = buildAccessCatalogReport(buildSnapshot([]));
    expect(accessCatalogGapReason(complete)).toBeNull();
    const missing = buildAccessCatalogReport(buildSnapshot([{ file: actionFile, source: actionSource('') }]));
    expect(accessCatalogGapReason(missing)).toContain('1 protected entrypoints declare no access');
    expect(accessCatalogGapReason(missing)).toContain(createEntrypointKey);
    const invalid = buildAccessCatalogReport(
      buildSnapshot([
        {
          file: 'verticals/projects/src/actions/delete.action.ts',
          source: actionSource(
            `    accessDeclaration: {
      key: 'projects.core.project.delete',
      kind: 'action',
      modes: ['run'],
      placement: { group: 'projects', level: 'manage' },
      risk: 'routine',
      selectors: [],
    },`,
          ),
        },
      ]),
    );
    expect(accessCatalogGapReason(invalid)).toContain('1 invalid declarations');
    expect(accessCatalogGapReason(invalid)).toContain('dangerous verb');
  });

  it('fails the real report command on a missing or invalid declaration and passes on a clean tree', () => {
    const clean = runCatalogReport([]);
    expect(clean.status).toBe(0);
    expect(clean.stderr).toStrictEqual('');

    const missing = runCatalogReport([['packages/demo/src/actions/bare.action.ts', bareProtectedAction]]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('1 protected entrypoints declare no access: demo.core.thing.do');

    const invalid = runCatalogReport([['packages/demo/src/actions/delete.action.ts', routineDangerousAction]]);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('1 invalid declarations');
  });
});

describe('access catalog module callers (accessActor)', () => {
  const callerReason = 'order finalization reads the buyer through the commerce module';
  const moduleActor = (callers: string, subject: 'identity' | 'rights') => `    accessActor: {
      callers: [${callers}],
      reason: '${callerReason}',
      subject: '${subject}',
    },`;
  const callerActionSlug = 'read-buyer';

  it('parses an accessActor beside its declaration and settles nothing extra', () => {
    const source = actionSource(`${declaredAction()}\n${moduleActor("'commerce-order'", 'rights')}`, callerActionSlug);
    const scanned = scanAccessCatalogSource(source, actionFile);
    expect(scanned.problems).toStrictEqual([]);
    expect(scanned.carriers[0]?.accessActor).toStrictEqual({
      callers: ['commerce-order'],
      reason: callerReason,
      subject: 'rights',
    });

    const snapshot = buildSnapshot([{ file: actionFile, source }]);
    expect(snapshot.invalid).toStrictEqual([]);
    expect(snapshot.entries.map((entry) => entry.key)).toStrictEqual([createKey]);
  });

  it('settles an identity caller without a declaration: no missing entry and no catalog entry', () => {
    const source = actionSource(moduleActor("'commerce-order', 'catalog'", 'identity'), callerActionSlug);
    const snapshot = buildSnapshot([{ file: actionFile, source }]);
    expect(snapshot.invalid).toStrictEqual([]);
    expect(snapshot.missing).toStrictEqual([]);
    expect(snapshot.entries).toStrictEqual([]);
    expect(snapshot.workloads).toStrictEqual([]);
  });

  it('refuses a caller that is not a topology vertical', () => {
    const source = actionSource(moduleActor("'not-a-vertical'", 'identity'), callerActionSlug);
    const snapshot = buildSnapshot([{ file: actionFile, source }]);
    expect(snapshot.invalid.map((problem) => problem.reason)).toStrictEqual([
      'accessActor is invalid: accessActor names an unknown caller "not-a-vertical": not a topology vertical',
    ]);
    expect(snapshot.missing).toStrictEqual([]);
  });

  it('refuses the rights subject without an accessDeclaration on the same carrier', () => {
    const source = actionSource(moduleActor("'commerce-order'", 'rights'), callerActionSlug);
    const snapshot = buildSnapshot([{ file: actionFile, source }]);
    expect(snapshot.invalid.map((problem) => problem.reason)).toStrictEqual([
      'accessActor is invalid: accessActor subject "rights" requires accessDeclaration on the same carrier (D5)',
    ]);
  });

  it('refuses a caller the scanned revision does not declare, whatever this checkout declares', () => {
    const source = actionSource(moduleActor("'catalog'", 'identity'), callerActionSlug);
    const snapshot = buildAccessCatalogSnapshot([{ file: actionFile, source }], new Set(['commerce-order']));
    expect(snapshot.invalid.map((problem) => problem.reason)).toStrictEqual([
      'accessActor is invalid: accessActor names an unknown caller "catalog": not a topology vertical',
    ]);
  });

  it('reads the caller set only from a valid topology document', () => {
    const verticals = Result.getOrThrow(decodeTopologyCallerAppIds('{"verticals":[{"id":"catalog","kind":"x"}]}'));
    expect([...verticals]).toStrictEqual(['catalog']);
    expect(Result.isFailure(decodeTopologyCallerAppIds('{"verticals":"catalog"}'))).toBe(true);
    expect(Result.isFailure(decodeTopologyCallerAppIds('not json'))).toBe(true);
  });

  it('refuses an accessActor that is not a static object literal', () => {
    const scanned = scanAccessCatalogSource(
      actionSource(
        "    accessActor: sharedActor ?? { callers: [], reason: 'x', subject: 'identity' },",
        callerActionSlug,
      ),
      actionFile,
    );
    expect(scanned.carriers).toStrictEqual([]);
    expect(scanned.problems.map((problem) => problem.reason)).toStrictEqual([
      'accessActor must be a static object literal',
    ]);
  });
});
