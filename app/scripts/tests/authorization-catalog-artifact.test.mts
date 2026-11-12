import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { compileFullAccessRole } from '@app/core-runtime/access/bootstrap';
import { buildAccessCatalogRelease } from '@app/core-runtime/access/catalog';
import { ModuleKeySchema } from '@app/core-runtime/access/ids';
import { WorkloadKeySchema } from '../../packages/core-runtime/src/authorization/access-declaration.ts';

import {
  ACCESS_CATALOG_ARTIFACT_SCHEMA_VERSION,
  AUTHORIZATION_CATALOG_ARTIFACT_PATH,
  AccessCatalogArtifactModulesSchema,
  AccessCatalogArtifactSchema,
  checkAccessCatalogArtifact,
  readAccessCatalogArtifact,
  readAccessCatalogArtifactDocument,
  renderAccessCatalogArtifact,
  sortAccessCatalogModules,
  writeAccessCatalogArtifact,
} from '../authorization-catalog-artifact.mts';
import { decodeTopologyCallerAppIds } from '../authorization-catalog.mts';
import { loadStageAccessModules, stageAccessModulesFromSources } from '../stage-access-catalog.mts';

const REPORT_SCRIPT = fileURLToPath(new URL('../authorization-catalog-report.mts', import.meta.url));
const CHECKOUT_TOPOLOGY = fileURLToPath(new URL('../../topology/reference-topology.json', import.meta.url));
/** The callers this checkout's topology declares, read the way the bootstrap reads them. */
const TOPOLOGY_CALLERS = Result.getOrThrow(decodeTopologyCallerAppIds(readFileSync(CHECKOUT_TOPOLOGY, 'utf-8')));

const ZETA_ACTION_FILE = 'verticals/zeta/src/actions/alpha.action.ts';
const ALPHA_ACTION_FILE = 'verticals/alpha/src/actions/beta.action.ts';

const actionSource = (moduleKey: string, key: string, slug: string) => `
const MODULE_KEY = '${moduleKey}' as const;
const ACTION_KEY = '${key}' as const;
export const ${slug}Action = defineAction(
  {
    accessDeclaration: {
      key: '${key}',
      kind: 'action',
      modes: ['run'],
      placement: { group: 'tooling', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
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

const ZETA_ACTION_SOURCE = actionSource('zeta.core', 'zeta.core.thing.do', 'alpha');
const ALPHA_CAPABILITY_KEY = 'alpha.core.thing.do';
const ALPHA_MODULE_ID = 'alpha.core';

const catalogOf = (sources: readonly { readonly file: string; readonly source: string }[]) =>
  Effect.gen(function* modulesOfEffect() {
    const catalog = yield* stageAccessModulesFromSources(sources, TOPOLOGY_CALLERS);
    // The scan hands the modules over as data; the same decode the artifact writes pins the type.
    const modules = yield* Schema.decodeUnknownEffect(AccessCatalogArtifactModulesSchema)(catalog.modules);
    return { ...catalog, modules };
  });
const modulesOf = (sources: readonly { readonly file: string; readonly source: string }[]) =>
  catalogOf(sources).pipe(Effect.map(({ modules }) => modules));
const renderSources = (sources: readonly { readonly file: string; readonly source: string }[]) =>
  catalogOf(sources).pipe(
    Effect.flatMap(({ declaredWorkloadKeys, modules }) => renderAccessCatalogArtifact(modules, declaredWorkloadKeys)),
  );

const ACTOR_ACTION_FILE = 'verticals/alpha/src/actions/actor.action.ts';
const actorActionSource = (callers: string, subjectWorkloads?: string) => `
const MODULE_KEY = 'alpha.core' as const;
const ACTION_KEY = 'alpha.core.thing.do' as const;
export const actorAction = defineAction(
  {
    accessActor: {
      callers: [${callers}],
      reason: 'the commerce module finalizes a buyer order through this action',
      subject: 'identity',${
        subjectWorkloads === undefined
          ? ''
          : `
      subjectWorkloads: [${subjectWorkloads}],`
      }
    },
    accessDeclaration: {
      key: 'alpha.core.thing.do',
      kind: 'action',
      modes: ['run'],
      placement: { group: 'tooling', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
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

const machineWorkloadKey = 'alpha.machine';
const intakeWorkloadKey = 'demo.crm.party-intake';
const workloadActorSource = (extraCarrier = '') => `
export const purposeAction = defineAction({
  accessActor: {
    callers: ['crm'],
    subject: 'workload',
    subjectWorkloads: [${JSON.stringify(intakeWorkloadKey)}],
    reason: 'Only the registered producer workload may invoke this Party purpose',
  },
  ${extraCarrier}
  actionKey: 'party.registry.create-crm-client-party',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'protected' },
    entrypointKey: 'party.registry.create-crm-client-party',
    moduleKey: 'party.registry',
    role: 'action',
  }),
}, handler);
`;
const PURPOSE_ACTION_FILE = 'verticals/party-registry/src/actions/create-crm-client-party.action.ts';
const workloadActionSource = (workloads: string) =>
  actionSource(ALPHA_MODULE_ID, ALPHA_CAPABILITY_KEY, 'machine').replace(
    /^ {4}accessDeclaration: \{[\s\S]*?^ {4}\},\n/mu,
    `    accessWorkload: { reason: 'Only the reviewed machine performs this purpose', workloads: [${workloads}] },\n`,
  );

/** A disposable workspace root; the bootstrap reads the root's own topology, so the checkout's is copied in. */
const makeTempRoot = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ontos-catalog-artifact-'));
  await mkdir(path.join(root, 'topology'), { recursive: true });
  await copyFile(CHECKOUT_TOPOLOGY, path.join(root, 'topology', 'reference-topology.json'));
  return root;
};

const withTempRoot = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(Effect.promise(makeTempRoot), use, (root) =>
    Effect.promise(() => rm(root, { force: true, recursive: true })),
  );

const ArtifactDocumentSchema = Schema.Struct({
  declaredWorkloadKeys: Schema.Array(WorkloadKeySchema),
  modules: Schema.Array(Schema.Unknown),
  schemaVersion: Schema.Number,
});

it.effect('orders modules and descriptors canonically regardless of scan order', () =>
  Effect.gen(function* ordersCanonically() {
    const alpha = ZETA_ACTION_SOURCE;
    const beta = actionSource(ALPHA_MODULE_ID, ALPHA_CAPABILITY_KEY, 'beta');
    const forward = yield* modulesOf([
      { file: ZETA_ACTION_FILE, source: alpha },
      { file: ALPHA_ACTION_FILE, source: beta },
    ]);
    const reversed = yield* modulesOf([
      { file: ALPHA_ACTION_FILE, source: beta },
      { file: ZETA_ACTION_FILE, source: alpha },
    ]);
    expect(sortAccessCatalogModules(forward).map((module) => module.moduleId)).toEqual([ALPHA_MODULE_ID, 'zeta.core']);
    expect(yield* renderAccessCatalogArtifact(forward, [])).toBe(yield* renderAccessCatalogArtifact(reversed, []));
  }),
);

it.effect('renders a canonical document with the schema version', () =>
  Effect.gen(function* rendersCanonicalDocument() {
    const rendered = yield* renderSources([{ file: ZETA_ACTION_FILE, source: ZETA_ACTION_SOURCE }]);
    expect(rendered.endsWith('\n')).toBe(true);
    const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(ArtifactDocumentSchema))(rendered);
    expect(parsed.schemaVersion).toBe(ACCESS_CATALOG_ARTIFACT_SCHEMA_VERSION);
    expect(parsed.modules).toHaveLength(1);
    expect(parsed.declaredWorkloadKeys).toEqual([]);
  }),
);

it.effect('writes, reads, and drift-checks the artifact', () =>
  Effect.gen(function* writesReadsChecks() {
    yield* withTempRoot((root) =>
      Effect.gen(function* writeReadCheck() {
        yield* writeAccessCatalogArtifact(root);
        // The committed document round-trips through the descriptor schema.
        expect(yield* readAccessCatalogArtifact(root)).toStrictEqual([]);
        const document = yield* readAccessCatalogArtifactDocument(root);
        expect(document.declaredWorkloadKeys).toEqual([]);
        expect(document.schemaVersion).toBe(2);
        yield* checkAccessCatalogArtifact(root);
        // A stale document (any different content) fails the drift check.
        yield* Effect.promise(() =>
          writeFile(
            path.join(root, AUTHORIZATION_CATALOG_ARTIFACT_PATH),
            `${JSON.stringify({ modules: [], schemaVersion: 1 })}\n`,
          ),
        );
        expect((yield* Effect.flip(checkAccessCatalogArtifact(root))).reason).toMatch(/stale/u);
        // A missing document is unreadable, not silently empty.
        yield* Effect.promise(() => rm(path.join(root, AUTHORIZATION_CATALOG_ARTIFACT_PATH)));
        expect((yield* Effect.flip(readAccessCatalogArtifact(root))).reason).toMatch(/missing/u);
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('collects sorted unique workload purposes before excluding machine carriers from the human catalog', () =>
  Effect.gen(function* machinePurposeInventory() {
    const sources = [
      { file: ZETA_ACTION_FILE, source: ZETA_ACTION_SOURCE },
      { file: ALPHA_ACTION_FILE, source: workloadActionSource(`'alpha.zulu', ${JSON.stringify(machineWorkloadKey)}`) },
      {
        file: 'verticals/alpha/src/actions/other.action.ts',
        source: workloadActionSource(JSON.stringify(machineWorkloadKey)),
      },
      { file: PURPOSE_ACTION_FILE, source: workloadActorSource() },
    ];
    const baseline = yield* catalogOf([{ file: ZETA_ACTION_FILE, source: ZETA_ACTION_SOURCE }]);
    const catalog = yield* catalogOf(sources);
    expect(catalog.modules).toEqual(baseline.modules);
    expect(catalog.declaredWorkloadKeys).toEqual([machineWorkloadKey, 'alpha.zulu', intakeWorkloadKey]);
    const artifact = yield* renderSources(sources);
    expect(artifact).toBe(yield* renderSources(sources.toReversed()));
    const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(AccessCatalogArtifactSchema))(artifact);
    expect(decoded.modules).toEqual(
      baseline.modules.map((module) => ({
        ...module,
        descriptors: module.descriptors.map((descriptor) => ({ ...descriptor, accessFieldGroups: [] })),
      })),
    );
    expect(decoded.declaredWorkloadKeys).toEqual(catalog.declaredWorkloadKeys);
  }),
);

it.effect('includes validated subject workloads on a human carrier without changing its human cell', () =>
  Effect.gen(function* humanAndMachineInventoriesRemainSeparate() {
    const plain = yield* catalogOf([{ file: ACTOR_ACTION_FILE, source: actorActionSource("'crm'") }]);
    const declared = yield* catalogOf([
      { file: ACTOR_ACTION_FILE, source: actorActionSource("'crm'", JSON.stringify(intakeWorkloadKey)) },
    ]);
    expect(declared.declaredWorkloadKeys).toEqual([intakeWorkloadKey]);
    expect(declared.modules[0]?.descriptors[0]?.accessDeclaration).toEqual(
      plain.modules[0]?.descriptors[0]?.accessDeclaration,
    );
  }),
);

it.effect(
  'refuses malformed and foreign workload declarations and unknown actor callers before inventory publication',
  () =>
    Effect.gen(function* invalidMachinePurposeInventory() {
      for (const source of [
        workloadActionSource(''),
        workloadActionSource(`${JSON.stringify(machineWorkloadKey)}, ${JSON.stringify(machineWorkloadKey)}`),
        workloadActionSource("'INVALID'"),
        workloadActionSource("'foreign.machine'"),
        workloadActorSource().replace("callers: ['crm']", "callers: ['unknown-caller']"),
        workloadActorSource().replace("subject: 'workload'", "subject: 'anyone'"),
        workloadActorSource().replace(JSON.stringify(intakeWorkloadKey), "'INVALID'"),
      ]) {
        const failure = yield* stageAccessModulesFromSources(
          [{ file: PURPOSE_ACTION_FILE, source }],
          TOPOLOGY_CALLERS,
        ).pipe(Effect.flip);
        expect(failure.code).toBe('stage_access_catalog_scan_refused');
      }
    }),
);

it.effect('requires the v2 workload inventory and rejects missing, malformed or duplicate keys without fallback', () =>
  Effect.gen(function* requiredV2PurposeInventory() {
    for (const data of [
      { modules: [], schemaVersion: 1 },
      { modules: [], schemaVersion: 2 },
      { declaredWorkloadKeys: null, modules: [], schemaVersion: 2 },
      { declaredWorkloadKeys: ['INVALID'], modules: [], schemaVersion: 2 },
      { declaredWorkloadKeys: [machineWorkloadKey, machineWorkloadKey], modules: [], schemaVersion: 2 },
    ]) {
      yield* withTempRoot((root) =>
        Effect.gen(function* refuseMalformedInventory() {
          yield* Effect.promise(() =>
            writeFile(path.join(root, AUTHORIZATION_CATALOG_ARTIFACT_PATH), JSON.stringify(data)),
          );
          expect((yield* readAccessCatalogArtifactDocument(root).pipe(Effect.flip)).code).toBe('artifact_unreadable');
          expect((yield* readAccessCatalogArtifact(root).pipe(Effect.flip)).code).toBe('artifact_unreadable');
        }),
      );
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('detects a syntactically valid workload with no source declaration as artifact drift', () =>
  withTempRoot((root) =>
    Effect.gen(function* unknownPurposeHasNoSourceEvidence() {
      yield* writeAccessCatalogArtifact(root);
      yield* Effect.promise(() =>
        writeFile(
          path.join(root, AUTHORIZATION_CATALOG_ARTIFACT_PATH),
          `${JSON.stringify({ declaredWorkloadKeys: ['unknown.workload'], modules: [], schemaVersion: 2 })}\n`,
        ),
      );
      const failure = yield* checkAccessCatalogArtifact(root).pipe(Effect.flip);
      expect(failure._tag).toBe('AccessCatalogArtifactError');
      expect(failure._tag === 'AccessCatalogArtifactError' && failure.code).toBe('artifact_stale');
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('refuses an artifact whose schema version is unknown', () =>
  Effect.gen(function* refusesUnknownSchemaVersion() {
    yield* withTempRoot((root) =>
      Effect.gen(function* refuseUnknownVersion() {
        const artifactPath = path.join(root, AUTHORIZATION_CATALOG_ARTIFACT_PATH);
        yield* Effect.promise(() => mkdir(path.dirname(artifactPath), { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(artifactPath, `${JSON.stringify({ declaredWorkloadKeys: [], modules: [], schemaVersion: 3 })}\n`),
        );
        expect((yield* Effect.flip(readAccessCatalogArtifact(root))).reason).toMatch(/descriptor contract/u);
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('pins the module callers of a declared carrier with sorted callers', () =>
  Effect.gen(function* pinsCallers() {
    const rendered = yield* renderSources([
      { file: ACTOR_ACTION_FILE, source: actorActionSource("'commerce-order', 'catalog'") },
    ]);
    const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(AccessCatalogArtifactSchema))(rendered);
    expect(parsed.modules[0]?.descriptors[0]?.actor).toStrictEqual({
      callers: ['catalog', 'commerce-order'],
      subject: 'identity',
    });
    // The reason is prose for reviewers, so the artifact pins the callers and the subject only.
    expect(Object.keys(parsed.modules[0]?.descriptors[0]?.actor ?? {})).toStrictEqual(['callers', 'subject']);
    expect(rendered).not.toContain('the commerce module finalizes a buyer order');
  }),
);

it.effect('pins declared subject workloads in canonical order and omits them when undeclared', () =>
  Effect.gen(function* pinsSubjectWorkloads() {
    const declared = yield* renderSources([
      {
        file: ACTOR_ACTION_FILE,
        source: actorActionSource(
          "'commerce-order'",
          "'commerce.storefront-client', 'commerce.order-approval-consumer'",
        ),
      },
    ]);
    const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(AccessCatalogArtifactSchema))(declared);
    expect(parsed.modules[0]?.descriptors[0]?.actor).toStrictEqual({
      callers: ['commerce-order'],
      subject: 'identity',
      subjectWorkloads: ['commerce.order-approval-consumer', 'commerce.storefront-client'],
    });
    const undeclared = yield* renderSources([
      { file: ACTOR_ACTION_FILE, source: actorActionSource("'commerce-order'") },
    ]);
    expect(undeclared).not.toContain('subjectWorkloads');
  }),
);

it.effect('accepts an exclusive workload actor without publishing a human or full-owner cell', () =>
  Effect.gen(function* excludesWorkloadActorFromRoles() {
    const catalog = yield* catalogOf([
      { file: ZETA_ACTION_FILE, source: ZETA_ACTION_SOURCE },
      { file: PURPOSE_ACTION_FILE, source: workloadActorSource() },
    ]);
    const { modules } = catalog;
    expect(modules.map(({ moduleId }) => moduleId)).toEqual(['zeta.core']);
    const artifact = yield* renderAccessCatalogArtifact(modules, catalog.declaredWorkloadKeys);
    expect(artifact).not.toContain('create-crm-client-party');
    expect(catalog.declaredWorkloadKeys).toEqual([intakeWorkloadKey]);
    const document = Schema.decodeUnknownSync(Schema.fromJsonString(AccessCatalogArtifactSchema))(artifact);
    expect(document.declaredWorkloadKeys).toEqual([intakeWorkloadKey]);
    expect(JSON.stringify(document.modules)).not.toContain('party-intake');
    const release = yield* Effect.fromResult(
      buildAccessCatalogRelease({
        installedModuleKeys: [ModuleKeySchema.make('zeta.core'), ModuleKeySchema.make('party.registry')],
        modules,
        publishedAt: new Date(0),
      }),
    );
    const fullOwner = yield* Effect.fromResult(compileFullAccessRole(release));
    expect(fullOwner.cells.map(({ capabilityKey }) => capabilityKey)).toEqual(['zeta.core.thing.do']);
  }),
);

it.effect(
  'refuses a protected carrier with no authority and a workload actor mixed with a declaration or workload',
  () =>
    Effect.gen(function* refusesInvalidActorOnlyCarrier() {
      const humanDeclaration = `accessDeclaration: {
      key: 'party.registry.crm-client-party.create', kind: 'action', modes: ['run', 'propose'],
      placement: { group: 'intake', level: 'basic' }, risk: 'sensitive', selectors: [],
    },`;
      for (const source of [
        workloadActorSource().replace('subjectWorkloads:', 'missingWorkloads:'),
        workloadActorSource(humanDeclaration),
        workloadActorSource("accessWorkload: { reason: 'Invalid mixed carrier', workloads: ['party.intake'] },"),
        workloadActorSource().replace(/accessActor: \{[\s\S]*?\},/u, ''),
      ]) {
        const refused = yield* stageAccessModulesFromSources(
          [{ file: PURPOSE_ACTION_FILE, source }],
          TOPOLOGY_CALLERS,
        ).pipe(Effect.flip);
        expect(refused.code).toBe('stage_access_catalog_scan_refused');
      }
    }),
);

it.effect('refuses a hand-edited artifact whose module callers are empty or repeated', () =>
  Effect.gen(function* refusesMalformedCallers() {
    const rendered = yield* renderSources([
      { file: ACTOR_ACTION_FILE, source: actorActionSource("'commerce-order', 'catalog'") },
    ]);
    for (const callers of ['[]', '["catalog", "catalog"]']) {
      yield* withTempRoot((root) =>
        Effect.gen(function* refuseMalformedCallers() {
          const artifactPath = path.join(root, AUTHORIZATION_CATALOG_ARTIFACT_PATH);
          yield* Effect.promise(() => mkdir(path.dirname(artifactPath), { recursive: true }));
          const edited = rendered.replace(/"callers": \[[^\]]*\]/u, `"callers": ${callers}`);
          expect(edited).not.toBe(rendered);
          yield* Effect.promise(() => writeFile(artifactPath, edited));
          expect((yield* Effect.flip(readAccessCatalogArtifact(root))).reason).toMatch(/descriptor contract/u);
        }),
      );
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('omits the actor field from descriptors that declare no module caller', () =>
  Effect.gen(function* omitsActor() {
    const rendered = yield* renderSources([{ file: ZETA_ACTION_FILE, source: ZETA_ACTION_SOURCE }]);
    expect(rendered).not.toContain('"actor"');
  }),
);

it.effect('refuses a stage scan whose module caller is not a topology vertical', () =>
  Effect.gen(function* refusesUnknownCaller() {
    const refused = yield* Effect.flip(
      stageAccessModulesFromSources(
        [{ file: ACTOR_ACTION_FILE, source: actorActionSource("'not-a-vertical'") }],
        TOPOLOGY_CALLERS,
      ),
    );
    expect(refused.code).toBe('stage_access_catalog_scan_refused');
    expect(refused.reason).toContain('unknown caller "not-a-vertical"');
  }),
);

it.effect('keeps distinct navigation and page declarations that share the same entrypoint', () =>
  Effect.gen(function* navigationAndPageCells() {
    const first = actionSource(ALPHA_MODULE_ID, 'alpha.core.navigation-thing.read', 'alpha');
    const second = actionSource(ALPHA_MODULE_ID, 'alpha.core.page-thing.read', 'alpha');
    const modules = yield* modulesOf([
      { file: 'verticals/alpha/vertical.manifest.ts', source: first },
      { file: 'verticals/alpha/src/routes/thing/route.meta.ts', source: second },
    ]);
    expect(
      modules
        .flatMap(({ descriptors }) => descriptors.map(({ accessDeclaration }) => accessDeclaration.key))
        .toSorted(),
    ).toEqual(['alpha.core.navigation-thing.read', 'alpha.core.page-thing.read']);
  }),
);

it.effect('retains mutation-only owner files as imported declaration custody evidence', () =>
  withTempRoot((root) =>
    Effect.gen(function* verifiesDeclarationCustody() {
      const supportDirectory = path.join(root, 'verticals/zeta/shared');
      const actionDirectory = path.join(root, 'verticals/zeta/src/actions');
      const serviceDirectory = path.join(root, 'verticals/zeta/src/services');
      yield* Effect.promise(async () => {
        await mkdir(supportDirectory, { recursive: true });
        await mkdir(actionDirectory, { recursive: true });
        await mkdir(serviceDirectory, { recursive: true });
        await writeFile(
          path.join(supportDirectory, 'access.ts'),
          `export const ACCESS = {
        key:'zeta.core.thing.do', kind:'action', modes:['run'],
        placement:{group:'tooling',level:'basic'},risk:'routine',selectors:[],
      } as const;`,
        );
        await writeFile(
          path.join(actionDirectory, 'alpha.action.ts'),
          `
        import {defineAction} from '@app/core-runtime';
        import {ACCESS} from '../../shared/access.ts';
        ${ZETA_ACTION_SOURCE.replace(/accessDeclaration: \{[\s\S]+?\n {4}\},/u, 'accessDeclaration: ACCESS,')}`,
        );
      });
      expect((yield* loadStageAccessModules(root)).modules).toHaveLength(1);
      yield* Effect.promise(() =>
        writeFile(
          path.join(serviceDirectory, 'mutation.ts'),
          `
      import {ACCESS as A} from '../../shared/access.ts';
      const alias=A; alias.risk='sensitive';
    `,
        ),
      );
      const error = yield* Effect.flip(loadStageAccessModules(root));
      expect(error.code).toBe('stage_access_catalog_scan_refused');
      expect(error.reason).toContain('accessDeclaration must be a static object literal');
      // Native Node 26 CJS/ESM loaders can mutate `as const`; all executable owner files are custody evidence.
      yield* Effect.promise(() => rm(path.join(serviceDirectory, 'mutation.ts')));
      for (const [name, source] of [
        ['mutation.cjs', "const contract=require('../../shared/access.ts'); contract.ACCESS.risk='sensitive';"],
        ['mutation.cts', "const contract=require('../../shared/access.ts'); contract.ACCESS.risk='sensitive';"],
        [
          'mutation.mjs',
          "import {createRequire} from 'node:module'; const load=createRequire(import.meta.url); const contract=load('../../shared/access.ts'); contract.ACCESS.risk='sensitive';",
        ],
        [
          'changed-base.mjs',
          "import {createRequire} from 'node:module'; const load=createRequire(new URL('../../shared/base.mjs',import.meta.url)); const contract=load('./access.ts'); contract.ACCESS.risk='sensitive';",
        ],
        [
          'configured-base.mjs',
          "import {createRequire} from 'node:module'; const configuredBase=new URL('../../shared/base.mjs',import.meta.url); const load=createRequire(configuredBase); const contract=load('./access.ts'); contract.ACCESS.risk='sensitive';",
        ],
      ] as const) {
        const filename = path.join(serviceDirectory, name);
        yield* Effect.promise(() => writeFile(filename, source));
        const refused = yield* Effect.flip(loadStageAccessModules(root));
        expect(refused.reason).toContain('accessDeclaration must be a static object literal');
        const report = spawnSync(process.execPath, [REPORT_SCRIPT, '--root', root, '--quiet'], { encoding: 'utf-8' });
        expect(report.status).toBe(1);
        expect(report.stderr).toContain('invalid declaration');

        // Actual native process confirms the fixture is a real mutation, not just an invented parser shape.
        const witness = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
            import {createRequire} from 'node:module';
            const load=createRequire(import.meta.url);
            load(${JSON.stringify(filename)});
            process.stdout.write(load(${JSON.stringify(path.join(supportDirectory, 'access.ts'))}).ACCESS.risk);
          `,
          ],
          { encoding: 'utf-8' },
        );
        expect(witness.status).toBe(0);
        expect(witness.stdout).toBe('sensitive');
        yield* Effect.promise(() => rm(filename));
      }
      expect((yield* loadStageAccessModules(root)).modules).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
