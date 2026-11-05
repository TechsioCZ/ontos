import { readFileSync } from 'node:fs';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ACCESS_CATALOG_ARTIFACT_SCHEMA_VERSION,
  AUTHORIZATION_CATALOG_ARTIFACT_PATH,
  AccessCatalogArtifactModulesSchema,
  AccessCatalogArtifactSchema,
  checkAccessCatalogArtifact,
  readAccessCatalogArtifact,
  renderAccessCatalogArtifact,
  sortAccessCatalogModules,
  writeAccessCatalogArtifact,
} from '../authorization-catalog-artifact.mts';
import { decodeTopologyCallerAppIds } from '../authorization-catalog.mts';
import { stageAccessModulesFromSources } from '../stage-access-catalog.mts';

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

const modulesOf = (sources: readonly { readonly file: string; readonly source: string }[]) =>
  Effect.gen(function* modulesOfEffect() {
    const catalog = yield* stageAccessModulesFromSources(sources, TOPOLOGY_CALLERS);
    // The scan hands the modules over as data; the same decode the artifact writes pins the type.
    return yield* Schema.decodeUnknownEffect(AccessCatalogArtifactModulesSchema)(catalog.modules);
  });

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
  modules: Schema.Array(Schema.Unknown),
  schemaVersion: Schema.Number,
});

it.effect('orders modules and descriptors canonically regardless of scan order', () =>
  Effect.gen(function* ordersCanonically() {
    const alpha = ZETA_ACTION_SOURCE;
    const beta = actionSource('alpha.core', 'alpha.core.thing.do', 'beta');
    const forward = yield* modulesOf([
      { file: ZETA_ACTION_FILE, source: alpha },
      { file: ALPHA_ACTION_FILE, source: beta },
    ]);
    const reversed = yield* modulesOf([
      { file: ALPHA_ACTION_FILE, source: beta },
      { file: ZETA_ACTION_FILE, source: alpha },
    ]);
    expect(sortAccessCatalogModules(forward).map((module) => module.moduleId)).toEqual(['alpha.core', 'zeta.core']);
    expect(yield* renderAccessCatalogArtifact(forward)).toBe(yield* renderAccessCatalogArtifact(reversed));
  }),
);

it.effect('renders a canonical document with the schema version', () =>
  Effect.gen(function* rendersCanonicalDocument() {
    const rendered = yield* renderAccessCatalogArtifact(
      yield* modulesOf([{ file: ZETA_ACTION_FILE, source: ZETA_ACTION_SOURCE }]),
    );
    expect(rendered.endsWith('\n')).toBe(true);
    const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(ArtifactDocumentSchema))(rendered);
    expect(parsed.schemaVersion).toBe(ACCESS_CATALOG_ARTIFACT_SCHEMA_VERSION);
    expect(parsed.modules).toHaveLength(1);
  }),
);

it.effect('writes, reads, and drift-checks the artifact', () =>
  Effect.gen(function* writesReadsChecks() {
    yield* withTempRoot((root) =>
      Effect.gen(function* writeReadCheck() {
        yield* writeAccessCatalogArtifact(root);
        // The committed document round-trips through the descriptor schema.
        expect(yield* readAccessCatalogArtifact(root)).toStrictEqual([]);
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

it.effect('refuses an artifact whose schema version is unknown', () =>
  Effect.gen(function* refusesUnknownSchemaVersion() {
    yield* withTempRoot((root) =>
      Effect.gen(function* refuseUnknownVersion() {
        const artifactPath = path.join(root, AUTHORIZATION_CATALOG_ARTIFACT_PATH);
        yield* Effect.promise(() => mkdir(path.dirname(artifactPath), { recursive: true }));
        yield* Effect.promise(() => writeFile(artifactPath, `${JSON.stringify({ modules: [], schemaVersion: 2 })}\n`));
        expect((yield* Effect.flip(readAccessCatalogArtifact(root))).reason).toMatch(/descriptor contract/u);
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('pins the module callers of a declared carrier with sorted callers', () =>
  Effect.gen(function* pinsCallers() {
    const rendered = yield* renderAccessCatalogArtifact(
      yield* modulesOf([{ file: ACTOR_ACTION_FILE, source: actorActionSource("'commerce-order', 'catalog'") }]),
    );
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
    const declared = yield* renderAccessCatalogArtifact(
      yield* modulesOf([
        {
          file: ACTOR_ACTION_FILE,
          source: actorActionSource(
            "'commerce-order'",
            "'commerce.storefront-client', 'commerce.order-approval-consumer'",
          ),
        },
      ]),
    );
    const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(AccessCatalogArtifactSchema))(declared);
    expect(parsed.modules[0]?.descriptors[0]?.actor).toStrictEqual({
      callers: ['commerce-order'],
      subject: 'identity',
      subjectWorkloads: ['commerce.order-approval-consumer', 'commerce.storefront-client'],
    });
    const undeclared = yield* renderAccessCatalogArtifact(
      yield* modulesOf([{ file: ACTOR_ACTION_FILE, source: actorActionSource("'commerce-order'") }]),
    );
    expect(undeclared).not.toContain('subjectWorkloads');
  }),
);

it.effect('refuses a hand-edited artifact whose module callers are empty or repeated', () =>
  Effect.gen(function* refusesMalformedCallers() {
    const rendered = yield* renderAccessCatalogArtifact(
      yield* modulesOf([{ file: ACTOR_ACTION_FILE, source: actorActionSource("'commerce-order', 'catalog'") }]),
    );
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
    const rendered = yield* renderAccessCatalogArtifact(
      yield* modulesOf([{ file: ZETA_ACTION_FILE, source: ZETA_ACTION_SOURCE }]),
    );
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
