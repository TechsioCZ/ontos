import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createModuleGraph } from '@modern-js/code-tools/microvertical-api-boundary';
import { hasPublishedUiSupport } from '../published-ui-support.mts';

import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { hasPublishedPublicComponent } from '../generated-public-component-boundary.mts';
import type { PublicComponentConsumerImport } from '../generated-public-component-boundary.mts';

/**
 * The consumer-side public-component proof against the real published artifacts and the real
 * cross-MicroVertical imports. The positives are the symbols other verticals actually import; the
 * negatives remove or foreign-ize one part of the publication at a time.
 */

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '../..');

const BULK_TAG_DIALOG = 'BulkTagDialog';
const TAG_CELL = 'TagCell';
const TAG_FILTER = 'TagFilter';
const USE_TAGS_FOR = 'useTagsFor';
const RECORD_DISCUSSION = 'RecordDiscussion';
const PARTY_DOCUMENTS = 'PartyDocuments';
const PROPERTY_EQUIPMENT = 'PropertyEquipment';

const TAGGING_OWNER = 'verticals/tagging';
const TAGGING_ARTIFACT = `${TAGGING_OWNER}/src/components/tag-controls.tsx`;
const TAGGING_PACKAGE = `${TAGGING_OWNER}/package.json`;
const TAGGING_MANIFEST = `${TAGGING_OWNER}/vertical.manifest.ts`;
const TAGGING_REGISTRATION = `${TAGGING_OWNER}/vertical.registration.ts`;
const TAGGING_RUNTIME_DECLARATION = `${TAGGING_OWNER}/vertical.runtime-declaration.ts`;
const TAGGING_FEDERATION = `${TAGGING_OWNER}/module-federation.config.ts`;
const TAGGING_SPECIFIER = '@app/tagging/components/tag-controls';

const FACILITY_OWNER = 'verticals/facility-operations';
const FACILITY_ARTIFACT = `${FACILITY_OWNER}/src/components/record-discussion.tsx`;
const FACILITY_PACKAGE = `${FACILITY_OWNER}/package.json`;
const FACILITY_PROPERTY_EQUIPMENT = `${FACILITY_OWNER}/src/ui/property-equipment.tsx`;
const FACILITY_MANIFEST = `${FACILITY_OWNER}/vertical.manifest.ts`;
const FACILITY_RUNTIME_DECLARATION = `${FACILITY_OWNER}/vertical.runtime-declaration.ts`;
const FACILITY_SPECIFIER = '@app/facility-operations/ui/record-discussion';

const TAGGING_PUBLICATION = [
  TAGGING_ARTIFACT,
  `${TAGGING_OWNER}/src/tags/tag-access.ts`,
  TAGGING_FEDERATION,
  TAGGING_MANIFEST,
  TAGGING_PACKAGE,
  TAGGING_REGISTRATION,
  TAGGING_RUNTIME_DECLARATION,
];

const FACILITY_PUBLICATION = [
  FACILITY_ARTIFACT,
  `${FACILITY_OWNER}/module-federation.config.ts`,
  FACILITY_MANIFEST,
  FACILITY_PACKAGE,
  `${FACILITY_OWNER}/vertical.registration.ts`,
  FACILITY_RUNTIME_DECLARATION,
  FACILITY_PROPERTY_EQUIPMENT,
];

const TAGGING_CONSUMERS = [
  'verticals/party-registry/src/routes/[lang]/prodej/zakaznici/page.tsx',
  'verticals/party-registry/src/routes/[lang]/prodej/zakaznici/use-customer-enrichment.ts',
  'verticals/sales-pipeline/src/routes/[lang]/prodej/prilezitosti/page.tsx',
  'verticals/sales-pipeline/src/routes/[lang]/prodej/prilezitosti/pipeline-bulk-by-tag.tsx',
  'verticals/sales-pipeline/src/routes/[lang]/prodej/prilezitosti/pipeline-dialog-host.tsx',
  'verticals/sales-pipeline/src/routes/[lang]/prodej/prilezitosti/pipeline-table.tsx',
];

const FACILITY_CONSUMERS = [
  'verticals/legal-agreements/src/routes/[lang]/smlouvy/page.tsx',
  'verticals/property-leasing/src/routes/[lang]/najmy/counterparty-dossier.tsx',
  'verticals/property-leasing/src/routes/[lang]/najmy/page.tsx',
  'verticals/property-portfolio/src/routes/[lang]/nemovitosti/page.tsx',
];

const WORKSPACE_FILES = [...TAGGING_PUBLICATION, ...FACILITY_PUBLICATION, ...TAGGING_CONSUMERS, ...FACILITY_CONSUMERS];

const PackageExportsSchema = Schema.Struct({
  exports: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const PackageExportsTextSchema = Schema.fromJsonString(PackageExportsSchema);

const workspaceSources = (files: readonly string[]) =>
  Effect.gen(function* loadWorkspaceSources() {
    const entries = yield* Effect.forEach(
      files,
      (file) =>
        Effect.promise(() => readFile(path.join(WORKSPACE_ROOT, file), 'utf-8')).pipe(
          Effect.map((source): readonly [string, string] => [file, source]),
        ),
      { concurrency: 'unbounded' },
    );
    return new Map(entries);
  });

const withSource = (sources: ReadonlyMap<string, string>, file: string, source: string) =>
  new Map([...sources, [file, source] as const]);

const withoutSource = (sources: ReadonlyMap<string, string>, file: string) =>
  new Map([...sources].filter(([candidate]) => candidate !== file));

const replaced = (source: string, search: string, replacement: string): string => {
  expect(source).toContain(search);
  return source.replace(search, replacement);
};

const packageExports = (sources: ReadonlyMap<string, string>, file: string): Readonly<Record<string, string>> =>
  Schema.decodeUnknownSync(PackageExportsTextSchema)(sources.get(file) ?? '{}').exports ?? {};

const taggingImport = (
  sources: ReadonlyMap<string, string>,
  selectedExportName: string,
  selectedModulePath: string,
): PublicComponentConsumerImport => ({
  appId: 'tagging',
  dependencyDeclared: true,
  exportKey: './components/tag-controls',
  moduleId: 'demo.tagging',
  owner: TAGGING_OWNER,
  ownerPackageExports: packageExports(sources, TAGGING_PACKAGE),
  selectedExportName,
  selectedModulePath,
  sources,
  target: TAGGING_ARTIFACT,
});

const facilityImport = (
  sources: ReadonlyMap<string, string>,
  selectedExportName: string,
  selectedModulePath: string,
): PublicComponentConsumerImport => ({
  appId: 'facility-operations',
  dependencyDeclared: true,
  exportKey: './ui/record-discussion',
  moduleId: 'facility.operations',
  owner: FACILITY_OWNER,
  ownerPackageExports: packageExports(sources, FACILITY_PACKAGE),
  selectedExportName,
  selectedModulePath,
  sources,
  target: FACILITY_ARTIFACT,
});

const approvedTaggingSymbols = (sources: ReadonlyMap<string, string>): readonly string[] =>
  [BULK_TAG_DIALOG, TAG_CELL, TAG_FILTER, USE_TAGS_FOR].filter((name) =>
    hasPublishedPublicComponent(taggingImport(sources, name, TAGGING_ARTIFACT)),
  );

const approvedFacilitySymbols = (sources: ReadonlyMap<string, string>): readonly string[] =>
  [
    { modulePath: FACILITY_ARTIFACT, name: PARTY_DOCUMENTS },
    { modulePath: FACILITY_ARTIFACT, name: RECORD_DISCUSSION },
    { modulePath: FACILITY_PROPERTY_EQUIPMENT, name: PROPERTY_EQUIPMENT },
  ]
    .filter(({ modulePath, name }) => hasPublishedPublicComponent(facilityImport(sources, name, modulePath)))
    .map(({ name }) => name);

const importedNames = (source: string, specifier: string): readonly string[] =>
  [...source.matchAll(/import\s+(?:type\s+)?\{(?<names>[^}]*)\}\s+from\s+'(?<target>[^']+)'/gu)]
    .filter((match) => match.groups?.target === specifier)
    .flatMap((match) => (match.groups?.names ?? '').split(','))
    .map(
      (name) =>
        name
          .replace(/^\s*type\s+/u, '')
          .trim()
          .split(/\s+as\s+/u)[0] ?? '',
    )
    .filter((name) => name.length > 0);

const consumedSymbols = (
  sources: ReadonlyMap<string, string>,
  specifier: string,
  files: readonly string[],
): readonly string[] => files.flatMap((file) => importedNames(sources.get(file) ?? '', specifier));

it.live('approves the real Tagging public component for every symbol another vertical imports', () =>
  Effect.gen(function* taggingPublicComponent() {
    const sources = yield* workspaceSources(WORKSPACE_FILES);
    expect(consumedSymbols(sources, TAGGING_SPECIFIER, TAGGING_CONSUMERS)).toEqual(
      expect.arrayContaining([BULK_TAG_DIALOG, TAG_CELL, TAG_FILTER, USE_TAGS_FOR]),
    );
    expect(approvedTaggingSymbols(sources)).toEqual([BULK_TAG_DIALOG, TAG_CELL, TAG_FILTER, USE_TAGS_FOR]);
  }),
);

it.live('approves only the actual published UI dependencies of the Tagging controls', () =>
  Effect.gen(function* taggingUiDependencies() {
    const sources = yield* workspaceSources(WORKSPACE_FILES);
    const graph = createModuleGraph();
    const artifact = graph.module(path.join(WORKSPACE_ROOT, TAGGING_ARTIFACT));
    for (const name of ['tagsReadable', 'tagsFailureStatus', 'isTagReadForbidden']) {
      const selected = graph.resolve(artifact, name, 'export');
      const base = taggingImport(sources, name, `${TAGGING_OWNER}/src/tags/tag-access.ts`);
      expect(hasPublishedPublicComponent(base)).toBe(false);
      expect(
        hasPublishedPublicComponent({
          ...base,
          selectedUiSupport: () =>
            selected?.kind === 'declaration' && hasPublishedUiSupport({ artifact, graph, selected }),
        }),
        name,
      ).toBe(true);
    }
  }),
);

it.live('approves the real Facility Operations public component, including its re-exported panel', () =>
  Effect.gen(function* facilityPublicComponent() {
    const sources = yield* workspaceSources(WORKSPACE_FILES);
    expect(consumedSymbols(sources, FACILITY_SPECIFIER, FACILITY_CONSUMERS)).toEqual(
      expect.arrayContaining([PARTY_DOCUMENTS, PROPERTY_EQUIPMENT, RECORD_DISCUSSION]),
    );
    expect(approvedFacilitySymbols(sources)).toEqual([PARTY_DOCUMENTS, RECORD_DISCUSSION, PROPERTY_EQUIPMENT]);
  }),
);

it.live('rejects an absent or foreign manifest factory, missing slots, exposure, header and dependency', () =>
  Effect.gen(function* publicationNegatives() {
    const sources = yield* workspaceSources(WORKSPACE_FILES);
    const manifest = sources.get(TAGGING_MANIFEST) ?? '';
    const artifact = sources.get(TAGGING_ARTIFACT) ?? '';
    const base = taggingImport(sources, TAG_CELL, TAGGING_ARTIFACT);

    expect(hasPublishedPublicComponent(base)).toBe(true);
    expect(
      hasPublishedPublicComponent(
        taggingImport(
          withSource(
            sources,
            TAGGING_MANIFEST,
            replaced(manifest, 'defineOntosModuleManifest(', 'createModuleManifest('),
          ),
          TAG_CELL,
          TAGGING_ARTIFACT,
        ),
      ),
    ).toBe(false);
    expect(
      hasPublishedPublicComponent(
        taggingImport(
          withSource(
            sources,
            TAGGING_MANIFEST,
            replaced(manifest, "from '@app/core-runtime';", "from './foreign-manifest.ts';"),
          ),
          TAG_CELL,
          TAGGING_ARTIFACT,
        ),
      ),
    ).toBe(false);
    expect(
      hasPublishedPublicComponent(
        taggingImport(
          withSource(
            sources,
            TAGGING_REGISTRATION,
            replaced(
              sources.get(TAGGING_REGISTRATION) ?? '',
              "'tag-controls': () => import('./src/components/tag-controls.tsx'),",
              '',
            ),
          ),
          TAG_CELL,
          TAGGING_ARTIFACT,
        ),
      ),
    ).toBe(false);
    expect(
      hasPublishedPublicComponent(
        taggingImport(
          withSource(
            sources,
            TAGGING_FEDERATION,
            replaced(
              sources.get(TAGGING_FEDERATION) ?? '',
              "'./TagControls': './src/components/tag-controls.tsx',",
              "'./TagControls': './src/components/other.tsx',",
            ),
          ),
          TAG_CELL,
          TAGGING_ARTIFACT,
        ),
      ),
    ).toBe(false);
    expect(
      hasPublishedPublicComponent(
        taggingImport(
          withSource(
            sources,
            TAGGING_ARTIFACT,
            replaced(artifact, '// @generated by OntOS Codesmith public-component v1\n', ''),
          ),
          TAG_CELL,
          TAGGING_ARTIFACT,
        ),
      ),
    ).toBe(false);
    expect(hasPublishedPublicComponent({ ...base, dependencyDeclared: false })).toBe(false);
    expect(hasPublishedPublicComponent({ ...base, exportKey: './components/other' })).toBe(false);
    expect(hasPublishedPublicComponent({ ...base, owner: 'verticals/foreign' })).toBe(false);
    expect(hasPublishedPublicComponent({ ...base, moduleId: 'demo.foreign' })).toBe(false);
    expect(hasPublishedPublicComponent({ ...base, selectedExportName: 'runTagEffect' })).toBe(false);
    expect(hasPublishedPublicComponent({ ...base, selectedExportName: 'notPublished' })).toBe(false);
    expect(
      hasPublishedPublicComponent({ ...base, selectedModulePath: `${TAGGING_OWNER}/src/handlers/private.ts` }),
    ).toBe(false);
    expect(hasPublishedPublicComponent({ ...base, selectedModulePath: 'verticals/merchandise/src/foreign.ts' })).toBe(
      false,
    );
    expect(
      hasPublishedPublicComponent({
        ...facilityImport(sources, RECORD_DISCUSSION, FACILITY_PROPERTY_EQUIPMENT),
      }),
    ).toBe(false);
  }),
);

const SHELL_COMPONENTS_OPEN = '// <generated-module-shell-components>';
const SHELL_COMPONENTS_CLOSE = '// </generated-module-shell-components>';

/** The reserved Shell component slot text, markers included, as the runtime declaration declares it. */
const shellComponentsSlot = (source: string): string => {
  const start = source.indexOf(SHELL_COMPONENTS_OPEN);
  const end = source.indexOf(SHELL_COMPONENTS_CLOSE);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + SHELL_COMPONENTS_CLOSE.length);
};

it.live('rejects a missing, foreign or mutated same-owner runtime declaration of a split owner', () =>
  Effect.gen(function* runtimeDeclarationNegatives() {
    const sources = yield* workspaceSources(WORKSPACE_FILES);
    const runtime = sources.get(TAGGING_RUNTIME_DECLARATION) ?? '';
    const tagging = (file: string, source: string) =>
      hasPublishedPublicComponent(taggingImport(withSource(sources, file, source), TAG_CELL, TAGGING_ARTIFACT));

    expect(hasPublishedPublicComponent(taggingImport(sources, TAG_CELL, TAGGING_ARTIFACT))).toBe(true);
    expect(
      hasPublishedPublicComponent(
        taggingImport(withoutSource(sources, TAGGING_RUNTIME_DECLARATION), TAG_CELL, TAGGING_ARTIFACT),
      ),
    ).toBe(false);
    expect(
      hasPublishedPublicComponent(
        facilityImport(withoutSource(sources, FACILITY_RUNTIME_DECLARATION), RECORD_DISCUSSION, FACILITY_ARTIFACT),
      ),
    ).toBe(false);
    // Foreign generated headers: the declaration names another module or deployment, or is not generated.
    expect(
      tagging(
        TAGGING_RUNTIME_DECLARATION,
        replaced(runtime, '// @ontos-module-id demo.tagging', '// @ontos-module-id demo.foreign'),
      ),
    ).toBe(false);
    expect(
      tagging(
        TAGGING_RUNTIME_DECLARATION,
        replaced(runtime, '// @ontos-deployment-app-id tagging', '// @ontos-deployment-app-id foreign'),
      ),
    ).toBe(false);
    expect(
      tagging(
        TAGGING_RUNTIME_DECLARATION,
        replaced(runtime, '// @generated by OntOS Codesmith Module Contract v1\n', ''),
      ),
    ).toBe(false);
    // Mutated identity and Shell contribution inside the declaration.
    expect(
      tagging(
        TAGGING_RUNTIME_DECLARATION,
        replaced(runtime, "const moduleKey = 'demo.tagging';", "const moduleKey = 'demo.foreign';"),
      ),
    ).toBe(false);
    expect(
      tagging(
        TAGGING_RUNTIME_DECLARATION,
        replaced(runtime, "componentKey: 'demo.tagging.tag-controls',", "componentKey: 'demo.tagging.other',"),
      ),
    ).toBe(false);
    expect(
      tagging(
        TAGGING_RUNTIME_DECLARATION,
        replaced(
          runtime,
          "role: 'public_component',\n            scope: 'tenant',",
          "role: 'public_component',\n            scope: 'platform',",
        ),
      ),
    ).toBe(false);
    expect(
      tagging(TAGGING_RUNTIME_DECLARATION, replaced(runtime, "expose: './TagControls',", "expose: './Other',")),
    ).toBe(false);
    // Mutated Core factories and shared views.
    expect(
      tagging(
        TAGGING_RUNTIME_DECLARATION,
        replaced(
          runtime,
          'defineVerticalRuntimeRegistration(taggingRuntimeDeclaration)',
          'createRuntimeRegistration(taggingRuntimeDeclaration)',
        ),
      ),
    ).toBe(false);
    expect(
      tagging(
        TAGGING_RUNTIME_DECLARATION,
        replaced(runtime, 'actions: taggingRuntimeManifest.publicSurface.actions,', 'actions: [],'),
      ),
    ).toBe(false);
  }),
);

it.live('rejects foreign imports, displaced slots and overwritten views around the runtime declaration', () =>
  Effect.gen(function* runtimeDeclarationProvenance() {
    const sources = yield* workspaceSources(WORKSPACE_FILES);
    const runtime = sources.get(TAGGING_RUNTIME_DECLARATION) ?? '';
    const manifest = sources.get(TAGGING_MANIFEST) ?? '';
    const registration = sources.get(TAGGING_REGISTRATION) ?? '';
    const tagging = (file: string, source: string) =>
      hasPublishedPublicComponent(taggingImport(withSource(sources, file, source), TAG_CELL, TAGGING_ARTIFACT));
    const runtimeImport = (statement: string) =>
      replaced(
        runtime,
        "import { Result, Schema } from 'effect';",
        `import { Result, Schema } from 'effect';\n${statement}`,
      );

    // Foreign imports: the backend view must not import UI, another vertical, or the owner views built from it.
    expect(
      tagging(
        TAGGING_RUNTIME_DECLARATION,
        runtimeImport("import { TagControls } from './src/components/tag-controls.tsx';"),
      ),
    ).toBe(false);
    expect(
      tagging(
        TAGGING_RUNTIME_DECLARATION,
        runtimeImport("import { foreignAction } from '../merchandise/src/foreign.ts';"),
      ),
    ).toBe(false);
    expect(
      tagging(TAGGING_RUNTIME_DECLARATION, runtimeImport("import { foreignAction } from '@app/merchandise/actions';")),
    ).toBe(false);
    expect(
      tagging(TAGGING_RUNTIME_DECLARATION, runtimeImport("import { taggingManifest } from './vertical.manifest.ts';")),
    ).toBe(false);
    expect(
      tagging(
        TAGGING_RUNTIME_DECLARATION,
        `${runtime}\nexport { TagControls } from './src/components/tag-controls.tsx';\n`,
      ),
    ).toBe(false);
    // Displaced slots: the Shell component slot belongs to the declaration, the components slot to the manifest.
    const slot = shellComponentsSlot(runtime);
    expect(tagging(TAGGING_RUNTIME_DECLARATION, replaced(runtime, slot, ''))).toBe(false);
    expect(
      hasPublishedPublicComponent(
        taggingImport(
          withSource(
            withSource(sources, TAGGING_RUNTIME_DECLARATION, replaced(runtime, slot, '')),
            TAGGING_MANIFEST,
            replaced(manifest, '    events: [],', `    events: [],\n    shellComponents: [\n${slot}\n    ],`),
          ),
          TAG_CELL,
          TAGGING_ARTIFACT,
        ),
      ),
    ).toBe(false);
    expect(
      tagging(
        TAGGING_RUNTIME_DECLARATION,
        replaced(
          runtime,
          '      mediaAttachments: [],',
          '      mediaAttachments: [],\n      // <generated-module-manifest-components>\n      // </generated-module-manifest-components>',
        ),
      ),
    ).toBe(false);
    // Overwritten views and inexact spread provenance in the manifest and registration.
    expect(
      tagging(
        TAGGING_MANIFEST,
        replaced(
          manifest,
          '  activation: {',
          "  module: { ...taggingRuntimeManifest.module, id: 'demo.foreign' },\n  activation: {",
        ),
      ),
    ).toBe(false);
    expect(
      tagging(
        TAGGING_MANIFEST,
        replaced(
          manifest,
          '    events: [],',
          '    events: [],\n    shellContributions: taggingRuntimeManifest.publicSurface.shellContributions,',
        ),
      ),
    ).toBe(false);
    expect(
      tagging(TAGGING_MANIFEST, replaced(manifest, '  ...taggingRuntimeManifest,\n', '  ...foreignRuntimeManifest,\n')),
    ).toBe(false);
    expect(
      tagging(
        TAGGING_MANIFEST,
        replaced(
          manifest,
          "import { taggingRuntimeManifest } from './vertical.runtime-declaration.ts';",
          "import { taggingRuntimeManifest } from '../merchandise/vertical.runtime-declaration.ts';",
        ),
      ),
    ).toBe(false);
    expect(
      tagging(
        TAGGING_REGISTRATION,
        replaced(registration, '  ...taggingRuntimeDeclaration,\n', '  ...taggingRuntimeDeclaration,\n  reads: [],\n'),
      ),
    ).toBe(false);
    // The Facility split keeps the same proof: its manifest cannot override the declared Shell surface.
    const facilityManifest = sources.get(FACILITY_MANIFEST) ?? '';
    expect(
      hasPublishedPublicComponent(
        facilityImport(
          withSource(
            sources,
            FACILITY_MANIFEST,
            replaced(
              facilityManifest,
              '  ...facilityOperationsRuntimeManifest,\n',
              '  ...facilityOperationsRuntimeManifest,\n  module: facilityOperationsRuntimeManifest.module,\n',
            ),
          ),
          RECORD_DISCUSSION,
          FACILITY_ARTIFACT,
        ),
      ),
    ).toBe(false);
  }),
);
