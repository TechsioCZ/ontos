import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { isMap, isScalar, parseAllDocuments, parseDocument } from 'yaml';

// Every override, peer rule, package extension and patch in pnpm-workspace.yaml must still act on
// the resolved graph in pnpm-lock.yaml. Dead entries silently outlive the upgrade that fixed them.

const appRoot = path.resolve(import.meta.dirname, '../..');

type Manifests = Readonly<Record<string, Readonly<Record<string, string>>>>;

const Edges = Schema.optional(Schema.Record(Schema.String, Schema.Unknown));
const Ranges = Schema.optional(Schema.Record(Schema.String, Schema.String));
const EdgeSetSchema = Schema.Struct({ dependencies: Edges, devDependencies: Edges, optionalDependencies: Edges });
const LockDocumentSchema = Schema.Struct({
  importers: Schema.optional(Schema.Record(Schema.String, EdgeSetSchema)),
  packages: Schema.optional(Schema.Record(Schema.String, Schema.Struct({ peerDependencies: Ranges }))),
  snapshots: Schema.optional(Schema.Record(Schema.String, EdgeSetSchema)),
});
const WorkspaceSchema = Schema.Struct({
  overrides: Ranges,
  packageExtensions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  peerDependencyRules: Schema.optional(Schema.Struct({ allowedVersions: Ranges })),
});
const ManifestSchema = Schema.fromJsonString(
  Schema.Struct({ dependencies: Ranges, devDependencies: Ranges, optionalDependencies: Ranges }),
);

interface Lockfile {
  /** Dependency name -> `name@version` of the resolved packages that depend on it (transitive edges). */
  readonly dependents: ReadonlyMap<string, ReadonlySet<string>>;
  /** Importer path -> names it depends on directly. */
  readonly importerEdges: ReadonlyMap<string, ReadonlySet<string>>;
  /** Exact `name@version` identities (without peer suffixes). */
  readonly packageIds: ReadonlySet<string>;
  /** `name@version` -> peer name -> declared peer range. */
  readonly peerRanges: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** `name@version(peers)` or `name@range` -> `name`, keeping scoped names intact. */
const nameOf = (specifier: string): string => {
  const bare = specifier.split('(')[0] ?? specifier;
  const separator = bare.indexOf('@', 1);
  return separator === -1 ? bare : bare.slice(0, separator);
};
const idOf = (specifier: string): string => specifier.split('(')[0] ?? specifier;
const edgeNames = (entry: typeof EdgeSetSchema.Type): readonly string[] =>
  Object.keys({ ...entry.dependencies, ...entry.devDependencies, ...entry.optionalDependencies });

/** pnpm writes the lockfile as several YAML documents; merge the sections of all of them. */
const parseLockfile = (source: string): Lockfile => {
  const importerEdges = new Map<string, Set<string>>();
  const packageIds = new Set<string>();
  const peerRanges = new Map<string, Map<string, string>>();
  const dependents = new Map<string, Set<string>>();
  for (const document of parseAllDocuments(source)) {
    const lock = Schema.decodeUnknownSync(LockDocumentSchema)(document.toJS() ?? {});
    for (const [importer, entry] of Object.entries(lock.importers ?? {})) {
      importerEdges.set(importer, new Set([...(importerEdges.get(importer) ?? []), ...edgeNames(entry)]));
    }
    for (const [key, { peerDependencies }] of Object.entries(lock.packages ?? {})) {
      packageIds.add(idOf(key));
      peerRanges.set(idOf(key), new Map(Object.entries(peerDependencies ?? {})));
    }
    for (const [key, entry] of Object.entries(lock.snapshots ?? {})) {
      for (const name of edgeNames(entry)) {
        dependents.set(name, (dependents.get(name) ?? new Set()).add(idOf(key)));
      }
    }
  }
  return { dependents, importerEdges, packageIds, peerRanges };
};

/** patchedDependencies keys with the comment written above each (yaml attaches the first to the map). */
const patchEntries = (workspaceYaml: string): readonly { readonly comment: string; readonly key: string }[] => {
  const patches = parseDocument(workspaceYaml).get('patchedDependencies', true);
  if (!isMap(patches)) {
    return [];
  }
  return patches.items.flatMap(({ key }, index) =>
    isScalar(key)
      ? [{ comment: (index === 0 ? patches.commentBefore : key.commentBefore) ?? '', key: String(key.value) }]
      : [],
  );
};

interface SelectorPart {
  readonly name: string;
  /** Exact version the selector pins, or '' for a bare name. */
  readonly version: string;
}

const isExactVersion = (version: string): boolean => /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version);

/** `parent@1.2.3>child` -> its parts; `undefined` when a part uses a range this gate cannot evaluate. */
const selectorParts = (selector: string): readonly SelectorPart[] | undefined => {
  const parts = selector
    .split('>')
    .map((part) => ({ name: nameOf(part), version: part.slice(nameOf(part).length + 1) }));
  return parts.every(({ version }) => version === '' || isExactVersion(version)) ? parts : undefined;
};

/** A bare name matches every resolved version; `name@1.2.3` matches only that version. */
const matchesPackage = (part: SelectorPart, id: string): boolean =>
  part.version === '' ? nameOf(id) === part.name : id === `${part.name}@${part.version}`;

const rangeSelector = (section: string, key: string): string =>
  `${section}.${key} selects a version range this gate cannot evaluate; select an exact version or the bare name`;

const deadOverride = (key: string, value: string, lock: Lockfile, manifests: Manifests): readonly string[] => {
  const parts = selectorParts(key);
  if (parts === undefined) {
    return [rangeSelector('overrides', key)];
  }
  const target = parts.at(-1)?.name ?? key;
  const parent = parts.at(-2);
  const importers = [...lock.importerEdges].filter(([, edges]) => edges.has(target)).map(([importer]) => importer);
  const dependents = [...(lock.dependents.get(target) ?? [])];
  if (dependents.length === 0 && importers.length === 0) {
    return [`overrides.${key} matches nothing in pnpm-lock.yaml; delete it`];
  }
  if (parent !== undefined && !dependents.some((id) => matchesPackage(parent, id))) {
    return [`overrides.${key} names a parent that no longer depends on ${target} in pnpm-lock.yaml; delete it`];
  }
  if (dependents.length === 0 && importers.every((importer) => manifests[importer]?.[target] === value)) {
    return [`overrides.${key} only restates the range every importer declares; delete it`];
  }
  return [];
};

const deadPeerRule = (key: string, value: string, lock: Lockfile): readonly string[] => {
  const parts = selectorParts(key);
  if (parts === undefined) {
    return [rangeSelector('peerDependencyRules.allowedVersions', key)];
  }
  const peer = parts.at(-1)?.name ?? key;
  const parent = parts.at(-2);
  const ranges = [...lock.peerRanges]
    .filter(([id]) => parent === undefined || matchesPackage(parent, id))
    .flatMap(([, peers]) => peers.get(peer) ?? []);
  if (ranges.length === 0) {
    return [`peerDependencyRules.allowedVersions.${key} matches no peer in pnpm-lock.yaml; delete it`];
  }
  if (ranges.every((range) => range === value)) {
    return [`peerDependencyRules.allowedVersions.${key} only restates the declared peer range; delete it`];
  }
  return [];
};

const deadPackageExtension = (key: string, lock: Lockfile): readonly string[] => {
  const part = selectorParts(key)?.[0];
  if (part === undefined) {
    return [rangeSelector('packageExtensions', key)];
  }
  return [...lock.packageIds].some((id) => matchesPackage(part, id))
    ? []
    : [`packageExtensions.${key} matches nothing in pnpm-lock.yaml; delete it`];
};

const deadPatches = (workspaceYaml: string, lock: Lockfile): readonly string[] =>
  patchEntries(workspaceYaml).flatMap(({ comment, key }) => [
    ...(lock.packageIds.has(key)
      ? []
      : [`patchedDependencies.${key} matches nothing in pnpm-lock.yaml; delete the patch`]),
    ...(/https:\/\/\S+/u.test(comment)
      ? []
      : [`patchedDependencies.${key} has no upstream URL; add a "# upstream: https://..." comment above it`]),
  ]);

const findDeadDependencyPolicy = (
  workspaceYaml: string,
  lockSource: string,
  manifests: Manifests,
): readonly string[] => {
  const lock = parseLockfile(lockSource);
  const workspace = Schema.decodeUnknownSync(WorkspaceSchema)(parseDocument(workspaceYaml).toJS() ?? {});
  return [
    ...Object.entries(workspace.overrides ?? {}).flatMap(([key, value]) => deadOverride(key, value, lock, manifests)),
    ...Object.entries(workspace.peerDependencyRules?.allowedVersions ?? {}).flatMap(([key, value]) =>
      deadPeerRule(key, value, lock),
    ),
    ...Object.keys(workspace.packageExtensions ?? {}).flatMap((key) => deadPackageExtension(key, lock)),
    ...deadPatches(workspaceYaml, lock),
  ];
};

const readManifests = (lockSource: string): Manifests =>
  Object.fromEntries(
    [...parseLockfile(lockSource).importerEdges.keys()].map((importer) => {
      const manifest = Schema.decodeUnknownSync(ManifestSchema)(
        readFileSync(path.join(appRoot, importer, 'package.json'), 'utf-8'),
      );
      return [importer, { ...manifest.optionalDependencies, ...manifest.devDependencies, ...manifest.dependencies }];
    }),
  );

const lockFixture = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      zod:
        specifier: 4.6.5
        version: 4.6.5
      drizzle-orm:
        specifier: 1.0.0
        version: 1.0.0

packages:

  '@scope/host@1.0.0':
    resolution: {integrity: sha512-x}
    peerDependencies:
      react: ^18.0.0
      optional-peer: 0.1.0

  drizzle-orm@1.0.0:
    resolution: {integrity: sha512-x}

  react@19.2.8:
    resolution: {integrity: sha512-x}

  zod@4.6.5:
    resolution: {integrity: sha512-x}

snapshots:

  '@scope/host@1.0.0(react@19.2.8)':
    dependencies:
      react: 19.2.8
`;

const liveWorkspace = `overrides:
  react: 19.2.8
  '@scope/host@1.0.0>react': 19.2.8
packageExtensions:
  zod@4.6.5:
    dependencies:
      react: 19.2.8
  react:
    dependencies:
      zod: 4.6.5
peerDependencyRules:
  allowedVersions:
    react: '>=19.0.0'
    '@scope/host@1.0.0>react': '>=19.0.0'
patchedDependencies:
  # upstream: https://github.com/drizzle-team/drizzle-orm/pull/6380
  drizzle-orm@1.0.0: patches/drizzle-orm.patch
`;

it('pnpm-workspace.yaml carries no dead overrides, peer rules, extensions or unlinked patches', () => {
  const workspaceYaml = readFileSync(path.join(appRoot, 'pnpm-workspace.yaml'), 'utf-8');
  const lockSource = readFileSync(path.join(appRoot, 'pnpm-lock.yaml'), 'utf-8');
  expect(findDeadDependencyPolicy(workspaceYaml, lockSource, readManifests(lockSource))).toEqual([]);
});

it('accepts policy entries that still act on the resolved graph', () => {
  expect(findDeadDependencyPolicy(liveWorkspace, lockFixture, { '.': { zod: '4.6.5' } })).toEqual([]);
});

it('flags overrides that match nothing, name a parent without that edge, or restate every importer range', () => {
  const workspace = `overrides:
  optional-peer: 0.1.0
  '@missing/parent>react': 19.2.8
  drizzle-orm>react: 19.2.8
  zod: 4.6.5
`;
  expect(findDeadDependencyPolicy(workspace, lockFixture, { '.': { zod: '4.6.5' } })).toEqual([
    'overrides.optional-peer matches nothing in pnpm-lock.yaml; delete it',
    'overrides.@missing/parent>react names a parent that no longer depends on react in pnpm-lock.yaml; delete it',
    'overrides.drizzle-orm>react names a parent that no longer depends on react in pnpm-lock.yaml; delete it',
    'overrides.zod only restates the range every importer declares; delete it',
  ]);
});

it('flags peer rules for absent or unresolved parent versions, range selectors, and restated peer ranges', () => {
  const workspace = `peerDependencyRules:
  allowedVersions:
    '@effect/vitest>effect': 4.0.0
    optional-peer: 0.1.0
    '@scope/host@2.0.0>react': '>=19.0.0'
    '@scope/host@^1.0.0>react': '>=19.0.0'
`;
  expect(findDeadDependencyPolicy(workspace, lockFixture, {})).toEqual([
    'peerDependencyRules.allowedVersions.@effect/vitest>effect matches no peer in pnpm-lock.yaml; delete it',
    'peerDependencyRules.allowedVersions.optional-peer only restates the declared peer range; delete it',
    'peerDependencyRules.allowedVersions.@scope/host@2.0.0>react matches no peer in pnpm-lock.yaml; delete it',
    'peerDependencyRules.allowedVersions.@scope/host@^1.0.0>react selects a version range this gate cannot evaluate; select an exact version or the bare name',
  ]);
});

it('flags package extensions pinned to an unresolved version and patches without a resolved target or upstream URL', () => {
  const workspace = `patchedDependencies:
  # local fix
  drizzle-orm@1.0.0: patches/drizzle-orm.patch
  # upstream: https://github.com/better-auth/better-fetch/pull/1
  '@better-fetch/fetch@1.3.1': patches/better-fetch.patch
packageExtensions:
  eslint-plugin-perfectionist@5.10.1:
    dependencies:
      '@typescript-eslint/types': 8.69.0
  zod@4.6.4:
    dependencies:
      react: 19.2.8
`;
  expect(findDeadDependencyPolicy(workspace, lockFixture, {})).toEqual([
    'packageExtensions.eslint-plugin-perfectionist@5.10.1 matches nothing in pnpm-lock.yaml; delete it',
    'packageExtensions.zod@4.6.4 matches nothing in pnpm-lock.yaml; delete it',
    'patchedDependencies.drizzle-orm@1.0.0 has no upstream URL; add a "# upstream: https://..." comment above it',
    'patchedDependencies.@better-fetch/fetch@1.3.1 matches nothing in pnpm-lock.yaml; delete the patch',
  ]);
});
