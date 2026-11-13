import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path } from 'effect';
import { expect, it } from 'effect-rstest';

/*
 * The one SpiceDB schema is `ONTOS_SPICEDB_SCHEMA` (packages/core-runtime/src/permissions/schema.ts). Authorization v2
 * is its half after the `// Authorization v2 engine` marker; the legacy half before it is no longer written for any
 * tenant, and `scoped_role` / `action_grant` are defined nowhere. A product read, check, lookup or write that names a
 * type outside the v2 half answers 503 on a v2 stage (an unknown type) or reads nothing (a legacy type no tenant still
 * carries). This test fails when product code names such a type in a SpiceDB-shaped position.
 *
 * The call sites that still exist are listed below with the lane that removes them. The list may only shrink: a new
 * site anywhere else fails, and an entry whose file no longer names its types fails until it is deleted from the list.
 */

const ROOT = new URL('../../', import.meta.url);
const SCHEMA_SOURCE = 'packages/core-runtime/src/permissions/schema.ts';
const V2_MARKER = '// Authorization v2 engine';

/** Product source: apps, packages and verticals, never tests or test support. */
const PRODUCT_DIRECTORIES: readonly (readonly [string, readonly string[]])[] = [
  ['apps', ['src', 'api', 'shared']],
  ['packages', ['src']],
  ['verticals', ['src', 'api', 'shared']],
];
const NOT_PRODUCT = /(?:^|\/)(?:tests?|testing)\/|\.test\.|\.spec\./u;
const SOURCE_FILE = /\.(?:m?ts|tsx)$/u;

/** A file that talks to SpiceDB: the client, a relationship builder, a check or a lookup. */
const TALKS_TO_SPICEDB =
  /@authzed\/authzed-node|\b(?:readRelationships|writeRelationships|deleteRelationships|checkPermission|checkBulkPermissions|lookupResources|lookupSubjects|ObjectReference|SubjectReference|RelationshipFilter)\b/u;
/** An object type literal where a relationship, check or lookup names one. */
const TYPE_LITERAL = /\b(?:objectType|resourceType|subjectType)\s*:\s*'(?<type>[a-z_]+)'/gu;

interface AllowedSite {
  /** The lane that removes these names from the file. */
  readonly owner: string;
  readonly types: readonly string[];
}

const AGENTS_ON_V2 = 'agents on Authorization v2 (feat/agent-authority-v2-20261113): agent roles and connections';
const LEGACY_GATE = 'legacy ContextAccess gate: the non-protected entrypoint kinds still answered by it';
const LEGACY_GATE_SEEDING =
  'legacy ContextAccess gate: the context_permission tuple writer 20 vertical integration suites still seed it with';

/** Every legacy name product code still uses today, by file. Shrink only. */
const ALLOWED: ReadonlyMap<string, AllowedSite> = new Map([
  [
    'packages/core-runtime/src/permissions/context-access.ts',
    {
      owner: LEGACY_GATE,
      types: [
        'business_permission',
        'context_permission',
        'identity_namespace',
        'legal_entity',
        'module_access',
        'principal',
        'resource',
        'tenant',
        'tenant_resource',
      ],
    },
  ],
  ['packages/core-runtime/src/permissions/principal-operators.ts', { owner: AGENTS_ON_V2, types: ['principal'] }],
  [
    'packages/core-runtime/src/install/demo-account-administration.ts',
    { owner: AGENTS_ON_V2, types: ['legal_entity', 'principal'] },
  ],
  [
    'packages/core-runtime/src/install/agent-entity-grants.ts',
    { owner: AGENTS_ON_V2, types: ['principal', 'scoped_role', 'tenant'] },
  ],
  [
    'packages/core-runtime/src/permissions/scoped-role.ts',
    { owner: AGENTS_ON_V2, types: ['principal', 'scoped_role', 'tenant'] },
  ],
  [
    'packages/core-runtime/src/permissions/context-permission-mutation.ts',
    { owner: LEGACY_GATE_SEEDING, types: ['context_permission', 'tenant'] },
  ],
  [
    'packages/core-runtime/src/permissions/permission-relationship-mutation.ts',
    { owner: LEGACY_GATE_SEEDING, types: ['principal'] },
  ],
]);

const v2DefinitionsOf = (schemaSource: string): ReadonlySet<string> => {
  const marker = schemaSource.indexOf(V2_MARKER);
  return new Set(
    marker === -1
      ? []
      : [...schemaSource.slice(marker).matchAll(/^definition (?<name>[a-z_]+)/gmu)].flatMap(
          (match) => match.groups?.name ?? [],
        ),
  );
};

const productFiles = Effect.gen(function* productFiles() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(ROOT);
  const files: string[] = [];
  for (const [top, inner] of PRODUCT_DIRECTORIES) {
    for (const owner of yield* fileSystem.readDirectory(path.join(root, top))) {
      for (const directory of inner) {
        const start = path.join(root, top, owner, directory);
        if (!(yield* fileSystem.exists(start))) {
          continue;
        }
        const entries = yield* fileSystem.readDirectory(start, { recursive: true });
        for (const entry of entries) {
          const relative = `${top}/${owner}/${directory}/${entry}`;
          if (SOURCE_FILE.test(entry) && !NOT_PRODUCT.test(relative) && !relative.includes('node_modules')) {
            files.push(relative);
          }
        }
      }
    }
  }
  return { files: files.toSorted(), root };
});

/** Every legacy type each SpiceDB-shaped product file names, by file. */
const legacyNamesByFile = Effect.gen(function* legacyNamesByFile() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { files, root } = yield* productFiles;
  const v2 = v2DefinitionsOf(yield* fileSystem.readFileString(path.join(root, SCHEMA_SOURCE)));
  const found = new Map<string, readonly string[]>();
  for (const file of files) {
    const source = yield* fileSystem.readFileString(path.join(root, file));
    if (!TALKS_TO_SPICEDB.test(source)) {
      continue;
    }
    const legacy = [...source.matchAll(TYPE_LITERAL)].flatMap((match) => {
      const type = match.groups?.type;
      return type === undefined || v2.has(type) ? [] : [type];
    });
    if (legacy.length > 0) {
      found.set(file, [...new Set(legacy)].toSorted());
    }
  }
  return { found, v2 };
});

it.layer(NodeServices.layer)('SpiceDB object types in product code', (suite) => {
  suite.effect('the v2 half of the one schema defines the access types and the agent, and no legacy type', () =>
    Effect.gen(function* v2Half() {
      const { v2 } = yield* legacyNamesByFile;
      expect(v2.has('access_scope') && v2.has('access_human') && v2.has('agent')).toBe(true);
      for (const legacy of ['principal', 'tenant', 'legal_entity', 'module_access', 'context_permission', 'action']) {
        expect({ legacy, v2: v2.has(legacy) }).toEqual({ legacy, v2: false });
      }
    }),
  );

  suite.effect('no product file names a type outside the v2 schema, except the listed sites their lanes remove', () =>
    Effect.gen(function* noNewLegacyNames() {
      const { found } = yield* legacyNamesByFile;
      const unexpected = [...found].flatMap(([file, types]) => {
        const allowed = new Set(ALLOWED.get(file)?.types);
        return types.filter((type) => !allowed.has(type)).map((type) => `${file}: ${type}`);
      });
      expect(unexpected).toEqual([]);
    }),
  );

  suite.effect('every listed site still names exactly its types: a removed one leaves the list', () =>
    Effect.gen(function* listOnlyShrinks() {
      const { found } = yield* legacyNamesByFile;
      const stale = [...ALLOWED].flatMap(([file, { types }]) => {
        const named = new Set(found.get(file));
        return types.filter((type) => !named.has(type)).map((type) => `${file}: ${type}`);
      });
      expect(stale).toEqual([]);
    }),
  );
});
