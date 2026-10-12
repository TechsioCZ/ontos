import posixPath from 'node:path/posix';

import { NodeServices } from '@effect/platform-node';
import {
  Array as EffectArray,
  Console,
  Effect,
  Exit,
  FileSystem,
  ManagedRuntime,
  Option,
  Order,
  Path,
  Predicate,
  Schema,
} from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { parseSync, Visitor } from 'oxc-parser';
import type { ImportExpression, MemberExpression } from 'oxc-parser';

/**
 * Lean-Core gate: `packages/core-runtime` must never depend on Commerce,
 * Storefront or Better Auth (package.json or source import). Non-Commerce
 * apps/verticals must never take a mandatory runtime import of Commerce's
 * private implementation, only its published `shared/` contracts or a
 * documented composition seam.
 */

export interface LeanCoreDependencyViolation {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

const sourceExtensions = new Set(['.ts', '.tsx', '.mts']);
const graphSourceExtensions = new Set([...sourceExtensions, '.js', '.mjs', '.cjs']);
const ignoredDirectories = new Set(['dist', 'dist-cloudflare', 'node_modules', 'repos', '.output', '.codex']);
const isTestSource = (relative: string): boolean => /(?:^|\/)(?:tests?|__tests__)\//u.test(relative);

const collect = (
  root: string,
  extensions: ReadonlySet<string> = sourceExtensions,
): Effect.Effect<readonly string[], PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* collectSourceFiles() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fileSystem.readDirectory(root);
    const discovered = yield* Effect.all(
      entries.map((entry) => {
        if (ignoredDirectories.has(entry)) {
          return Effect.succeed<readonly string[]>([]);
        }
        const candidate = path.join(root, entry);
        return fileSystem.stat(candidate).pipe(
          Effect.flatMap((info) => {
            if (info.type === 'Directory') {
              return collect(candidate, extensions);
            }
            return Effect.succeed(extensions.has(path.extname(entry)) ? [candidate] : []);
          }),
        );
      }),
      { concurrency: 32 },
    );
    return EffectArray.sort(discovered.flat(), Order.String);
  });

const sourceLine = (source: string, index: number): number => source.slice(0, index).split('\n').length;

interface ImportOccurrence {
  readonly index: number;
  readonly isTypeOnly: boolean;
  readonly specifier: string;
}

interface SourceImportAnalysis {
  readonly occurrences: readonly ImportOccurrence[];
  readonly unsupportedRuntimeImport: boolean;
}

type ProgramStatement = ReturnType<typeof parseSync>['program']['body'][number];

const occurrenceForStatement = (statement: ProgramStatement): ImportOccurrence | undefined => {
  if (statement.type === 'ImportDeclaration') {
    return {
      index: statement.start,
      isTypeOnly: statement.importKind === 'type',
      specifier: statement.source.value,
    };
  }
  if (statement.type === 'ExportNamedDeclaration' && statement.source !== null) {
    return {
      index: statement.start,
      isTypeOnly: statement.exportKind === 'type',
      specifier: statement.source.value,
    };
  }
  if (statement.type === 'ExportAllDeclaration') {
    return {
      index: statement.start,
      isTypeOnly: statement.exportKind === 'type',
      specifier: statement.source.value,
    };
  }
  return undefined;
};

const staticMemberName = (node: MemberExpression): string | undefined => {
  if (!node.computed && node.property.type === 'Identifier') {
    return node.property.name;
  }
  if (node.property.type === 'Literal' && Predicate.isString(node.property.value)) {
    return node.property.value;
  }
  if (node.property.type === 'TemplateLiteral' && node.property.expressions.length === 0) {
    return node.property.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
};

/** All specifier-bearing import/export forms, including multi-line and dynamic `import(...)`. */
const analyzeImports = (file: string, source: string): SourceImportAnalysis => {
  const typedLanguage = file.endsWith('.tsx') ? 'tsx' : 'ts';
  const parsed = parseSync(file, source, {
    astType: 'ts',
    lang: sourceExtensions.has(posixPath.extname(file)) ? typedLanguage : 'js',
    sourceType: file.endsWith('.cjs') ? 'script' : 'module',
  });
  if (parsed.errors.length > 0) {
    return { occurrences: [], unsupportedRuntimeImport: true };
  }
  const occurrences = parsed.program.body.flatMap((statement) => {
    const occurrence = occurrenceForStatement(statement);
    return occurrence === undefined ? [] : [occurrence];
  });
  const dynamicOccurrences: ImportOccurrence[] = [];
  let unsupportedRuntimeImport = parsed.program.body.some(
    (statement) => statement.type === 'TSImportEqualsDeclaration' && statement.importKind !== 'type',
  );
  const recordDynamicImportExpression = (node: ImportExpression): void => {
    if (node.source.type === 'Literal' && Predicate.isString(node.source.value)) {
      dynamicOccurrences.push({ index: node.start, isTypeOnly: false, specifier: node.source.value });
    } else if (node.source.type === 'TemplateLiteral' && node.source.expressions.length === 0) {
      const specifier = node.source.quasis[0]?.value.cooked;
      if (specifier !== undefined && specifier !== null) {
        dynamicOccurrences.push({ index: node.start, isTypeOnly: false, specifier });
      } else {
        unsupportedRuntimeImport = true;
      }
    } else {
      unsupportedRuntimeImport = true;
    }
  };
  new Visitor({
    CallExpression: (node) => {
      if (node.callee.type !== 'MemberExpression' || staticMemberName(node.callee) !== 'getBuiltinModule') {
        return;
      }
      const [target] = node.arguments;
      const nativeModule = target?.type === 'Literal' ? target.value : undefined;
      if (nativeModule === undefined || nativeModule === 'module' || nativeModule === 'node:module') {
        unsupportedRuntimeImport = true;
      }
    },
    Identifier: (node) => {
      if (node.name === 'require' || node.name === 'createRequire') {
        unsupportedRuntimeImport = true;
      }
    },
    ImportExpression: recordDynamicImportExpression,
    MemberExpression: (node) => {
      const name = staticMemberName(node);
      if (
        name === 'require' ||
        name === 'createRequire' ||
        (node.computed && node.object.type === 'Identifier' && node.object.name === 'module')
      ) {
        unsupportedRuntimeImport = true;
      }
    },
  }).visit(parsed.program);
  unsupportedRuntimeImport ||= occurrences.some(
    ({ specifier }) => specifier === 'module' || specifier === 'node:module',
  );
  return {
    occurrences: EffectArray.sort(
      [...occurrences, ...dynamicOccurrences],
      Order.mapInput(Order.Number, (occurrence: ImportOccurrence) => occurrence.index),
    ),
    unsupportedRuntimeImport,
  };
};

const importsIn = (file: string, source: string): readonly ImportOccurrence[] =>
  analyzeImports(file, source).occurrences;

// --- Core: package.json + source imports must stay provider-neutral ------

const coreSourceRoot = 'packages/core-runtime/src';
const corePackageJsonRelative = 'packages/core-runtime/package.json';
const commerceVocabulary = /commerce|storefront|better[-_]?auth/iu;

const allowedCoreExternalSpecifiers = new Set([
  '@authzed/authzed-node',
  '@effect/platform-node',
  '@effect/sql-pg',
  'drizzle-kit',
  'drizzle-orm',
  'drizzle-orm/effect-core',
  'drizzle-orm/effect-postgres',
  'drizzle-orm/pg-core',
  'cloudflare:workers',
  'effect',
  'node:crypto',
  'pg',
]);

const isAllowedCoreExternalSpecifier = (specifier: string): boolean =>
  allowedCoreExternalSpecifiers.has(specifier) || specifier.startsWith('effect/unstable/');

const coreExternalDependencyReason = (specifier: string): string =>
  commerceVocabulary.test(specifier)
    ? `Core runtime source imports Commerce/Storefront/Better Auth package "${specifier}"`
    : `Core runtime source imports a dependency outside the pinned external specifier set: "${specifier}"`;

/** Resolve a relative specifier against its importing file's directory, POSIX-style. */
const resolveRelativeSpecifier = (importer: string, specifier: string): string =>
  posixPath.normalize(posixPath.join(posixPath.dirname(importer), specifier));

const coreRelativeEscapeReason = (specifier: string, resolved: string): string =>
  commerceVocabulary.test(resolved)
    ? `Core runtime source imports Commerce/Storefront/Better Auth via relative specifier "${specifier}" (resolves to "${resolved}")`
    : `Core runtime source imports outside packages/core-runtime/src via relative specifier "${specifier}" (resolves to "${resolved}")`;

const isInsideCoreSource = (resolved: string): boolean =>
  resolved === coreSourceRoot || resolved.startsWith(`${coreSourceRoot}/`);

// These native dependencies are admitted only behind a proven Node condition, never in the shared set.
const nodeTransportSpecifiers = new Set(['node:stream', 'node:stream/web', '@effect/platform-node/Undici']);

const recordCoreSourceViolations = (
  record: (violation: LeanCoreDependencyViolation) => void,
  relative: string,
  source: string,
  corePackageImports: ReadonlySet<string>,
  nodeOnlyFiles: ReadonlySet<string>,
): void => {
  if (!relative.startsWith(`${coreSourceRoot}/`)) {
    return;
  }
  for (const { index, specifier } of importsIn(relative, source)) {
    const isRelative = specifier.startsWith('.');
    const resolved = isRelative ? resolveRelativeSpecifier(relative, specifier) : undefined;
    // A `#` specifier is Core's own package import; checkCorePackageJson admits only those whose
    // every condition target stays inside Core source.
    const isExempt = isRelative
      ? resolved !== undefined && isInsideCoreSource(resolved)
      : corePackageImports.has(specifier) ||
        isAllowedCoreExternalSpecifier(specifier) ||
        (nodeOnlyFiles.has(relative) && nodeTransportSpecifiers.has(specifier));
    if (isExempt) {
      continue;
    }
    record({
      file: relative,
      line: sourceLine(source, index),
      reason:
        isRelative && resolved !== undefined
          ? coreRelativeEscapeReason(specifier, resolved)
          : coreExternalDependencyReason(specifier),
    });
  }
};

const PackageImportTargetSchema = Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]);
const WorkspacePackageManifestSchema = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  exports: Schema.optional(Schema.Record(Schema.String, PackageImportTargetSchema)),
  imports: Schema.optional(Schema.Record(Schema.String, PackageImportTargetSchema)),
});

const packageImportTargets = (target: typeof PackageImportTargetSchema.Type): readonly string[] =>
  Predicate.isString(target) ? [target] : Object.values(target);
const WorkspacePackageManifestFromJson = Schema.fromJsonString(WorkspacePackageManifestSchema);

type PackageImportTarget = typeof PackageImportTargetSchema.Type;
interface CorePackageBoundary {
  readonly exports: ReadonlyMap<string, PackageImportTarget>;
  readonly imports: ReadonlyMap<string, PackageImportTarget>;
  readonly nodeDriverDeclared: boolean;
}

const SourceHostSchema = Schema.Literals(['node', 'workerd', 'browser']);
type SourceHost = typeof SourceHostSchema.Type;

const hasSupportedConditions = (target: PackageImportTarget): boolean =>
  Predicate.isString(target) ||
  Object.keys(target).every(
    (condition) =>
      Schema.is(SourceHostSchema)(condition) ||
      condition === 'types' ||
      condition === 'import' ||
      condition === 'default',
  );

/** Native runtime maps skip TypeScript's types condition and select the first matching runtime property. */
const selectHostTarget = (target: PackageImportTarget, host: SourceHost): string | undefined => {
  if (Predicate.isString(target)) {
    return target;
  }
  return Object.entries(target).find(
    ([condition]) => condition === host || condition === 'import' || condition === 'default',
  )?.[1];
};

const resolveCoreTarget = (target: string): string =>
  posixPath.normalize(posixPath.join(posixPath.dirname(corePackageJsonRelative), target));

/** Resolve actual indexed files; an ambiguous extensionless import supplies no isolation evidence. */
const resolveIndexedSource = (
  target: string,
  sources: ReadonlyMap<string, SourceImportAnalysis>,
): string | undefined => {
  if (sources.has(target)) {
    return target;
  }
  const extension = posixPath.extname(target);
  const candidates =
    extension === ''
      ? [...sourceExtensions]
          .map((sourceExtension) => `${target}${sourceExtension}`)
          .filter((file) => sources.has(file))
      : [];
  return candidates.length === 1 ? candidates[0] : undefined;
};

const resolveManifestSource = (
  target: string,
  sources: ReadonlyMap<string, SourceImportAnalysis>,
): string | undefined => {
  const file = resolveCoreTarget(target);
  return sources.has(file) ? file : undefined;
};

interface HostEdges {
  readonly files: readonly string[];
  readonly unsupported: boolean;
}

const sourceHostEdges = (
  file: string,
  host: SourceHost,
  sources: ReadonlyMap<string, SourceImportAnalysis>,
  boundary: CorePackageBoundary,
): HostEdges => {
  const source = sources.get(file);
  if (source === undefined) {
    return { files: [], unsupported: true };
  }
  const edges = source.occurrences
    .filter(({ isTypeOnly }) => !isTypeOnly)
    .map((occurrence): HostEdges => {
      let target: string | undefined;
      if (occurrence.specifier.startsWith('.')) {
        target = resolveRelativeSpecifier(file, occurrence.specifier);
      } else if (occurrence.specifier.startsWith('#')) {
        const condition = boundary.imports.get(occurrence.specifier);
        if (condition === undefined || !hasSupportedConditions(condition)) {
          return { files: [], unsupported: true };
        }
        const selected = selectHostTarget(condition, host);
        if (selected === undefined) {
          return { files: [], unsupported: false };
        }
        const resolvedManifestFile = resolveManifestSource(selected, sources);
        return resolvedManifestFile === undefined
          ? { files: [], unsupported: true }
          : { files: [resolvedManifestFile], unsupported: false };
      } else {
        return { files: [], unsupported: false };
      }
      if (target === undefined) {
        return { files: [], unsupported: false };
      }
      const resolved = resolveIndexedSource(target, sources);
      if (resolved === undefined || !isInsideCoreSource(resolved)) {
        return { files: [], unsupported: true };
      }
      return { files: [resolved], unsupported: false };
    });
  return {
    files: edges.flatMap(({ files }) => files),
    unsupported: source.unsupportedRuntimeImport || edges.some(({ unsupported }) => unsupported),
  };
};

interface HostClosure {
  readonly files: ReadonlySet<string>;
  readonly unsupported: boolean;
}

const hostClosure = (
  roots: readonly string[],
  host: SourceHost,
  sources: ReadonlyMap<string, SourceImportAnalysis>,
  boundary: CorePackageBoundary,
): HostClosure => {
  const files = new Set<string>();
  const pending = [...roots];
  let unsupported = false;
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || files.has(file)) {
      continue;
    }
    files.add(file);
    const edges = sourceHostEdges(file, host, sources, boundary);
    unsupported ||= edges.unsupported;
    pending.push(...edges.files);
  }
  return { files, unsupported };
};

/** Host isolation comes from consumed native conditions and runtime edges, never a filename suffix. */
const nodeOnlyCoreSources = (
  sources: ReadonlyMap<string, SourceImportAnalysis>,
  boundary: CorePackageBoundary,
): ReadonlySet<string> => {
  if (!boundary.nodeDriverDeclared) {
    return new Set();
  }
  const consumedImports = new Set(
    [...sources.values()].flatMap(({ occurrences }) =>
      occurrences.filter(({ isTypeOnly }) => !isTypeOnly).map(({ specifier }) => specifier),
    ),
  );
  const conditions = [
    ...boundary.exports.values(),
    ...[...boundary.imports].filter(([name]) => consumedImports.has(name)).map(([, target]) => target),
  ];
  const nodeRoots = conditions.flatMap((target) => {
    if (
      Predicate.isString(target) ||
      !hasSupportedConditions(target) ||
      target.node === undefined ||
      selectHostTarget(target, 'node') !== target.node
    ) {
      return [];
    }
    const file = resolveManifestSource(target.node, sources);
    return file === undefined ? [] : [file];
  });
  const node = hostClosure(nodeRoots, 'node', sources, boundary);
  if (node.unsupported) {
    return new Set();
  }
  const sharedRoots = [...sources.keys()].filter((file) => !node.files.has(file));
  const allConditions = [...boundary.exports.values(), ...boundary.imports.values()];
  const nonNode = new Set<string>();
  for (const host of ['workerd', 'browser'] satisfies readonly SourceHost[]) {
    let unsupportedTarget = false;
    const roots = allConditions.flatMap((target) => {
      const targets = hasSupportedConditions(target) ? [selectHostTarget(target, host)] : packageImportTargets(target);
      return targets.flatMap((selected) => {
        if (selected === undefined) {
          return [];
        }
        const file = resolveManifestSource(selected, sources);
        if (file === undefined) {
          unsupportedTarget = true;
          return [];
        }
        return [file];
      });
    });
    if (unsupportedTarget) {
      return new Set();
    }
    const closure = hostClosure([...sharedRoots, ...roots], host, sources, boundary);
    if (closure.unsupported) {
      return new Set();
    }
    for (const file of closure.files) {
      nonNode.add(file);
    }
  }
  return new Set([...node.files].filter((file) => !nonNode.has(file)));
};

const allowedCorePackageDependencies = new Set([
  '@authzed/authzed-node',
  '@effect/platform-node',
  '@effect/sql-pg',
  'drizzle-kit',
  'drizzle-orm',
  'effect',
  'pg',
]);

const checkCorePackageJson = (
  fileSystem: FileSystem.FileSystem,
  root: string,
  path: Path.Path,
  record: (violation: LeanCoreDependencyViolation) => void,
): Effect.Effect<CorePackageBoundary, PlatformError> =>
  Effect.gen(function* checkCorePackageJsonProgram() {
    const file = path.join(root, corePackageJsonRelative);
    const exists = yield* fileSystem.exists(file);
    if (!exists) {
      return { exports: new Map(), imports: new Map(), nodeDriverDeclared: false };
    }
    const raw = yield* fileSystem.readFileString(file, 'utf-8');
    const parsed = yield* Schema.decodeUnknownEffect(WorkspacePackageManifestFromJson)(raw).pipe(Effect.orDie);
    const corePackageImports = new Map<string, PackageImportTarget>();
    for (const [name, target] of Object.entries(parsed.imports ?? {})) {
      const escaping = packageImportTargets(target).filter(
        (targetPath) =>
          !isInsideCoreSource(
            posixPath.normalize(posixPath.join(posixPath.dirname(corePackageJsonRelative), targetPath)),
          ),
      );
      if (escaping.length === 0) {
        corePackageImports.set(name, target);
        continue;
      }
      record({
        file: corePackageJsonRelative,
        line: 1,
        reason: `Core runtime package.json maps package import "${name}" outside packages/core-runtime/src: "${escaping.join('", "')}"`,
      });
    }
    for (const [name] of Object.entries(parsed.dependencies ?? {})) {
      if (!allowedCorePackageDependencies.has(name)) {
        record({
          file: corePackageJsonRelative,
          line: 1,
          reason: commerceVocabulary.test(name)
            ? `Core runtime package.json declares a Commerce/Storefront/Better Auth dependency "${name}"`
            : `Core runtime package.json declares a dependency outside the pinned external specifier set: "${name}"`,
        });
      }
    }
    for (const [name] of Object.entries(parsed.devDependencies ?? {})) {
      if (commerceVocabulary.test(name)) {
        record({
          file: corePackageJsonRelative,
          line: 1,
          reason: `Core runtime package.json declares a Commerce/Storefront/Better Auth devDependency "${name}"`,
        });
      }
    }
    return {
      exports: new Map(Object.entries(parsed.exports ?? {})),
      imports: corePackageImports,
      nodeDriverDeclared: parsed.dependencies?.['@effect/platform-node'] !== undefined,
    };
  });

// --- Non-Commerce apps/verticals must not import Commerce private impl ---

const commerceVerticalRoot = 'verticals/commerce-customer-context';
const nonCommerceOwnerParents = ['apps', 'verticals'];
const commercePackageSpecifierPrefix = '@app/commerce-customer-context';
const commercePrivateImplementation = /(?:^|\/)verticals\/commerce-customer-context\/(?:src|api)\//u;

/** Every directory under `apps/` and `verticals/` owns a unit, except Commerce's own (the thing being bounded). */
const ownerRootsUnderParent = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  parent: string,
): Effect.Effect<readonly string[], PlatformError> =>
  Effect.gen(function* ownerRootsUnderParentProgram() {
    const parentPath = path.join(root, parent);
    const exists = yield* fileSystem.exists(parentPath);
    if (!exists) {
      return [];
    }
    const entries = yield* fileSystem.readDirectory(parentPath);
    const ownerRoots = yield* Effect.all(
      entries.map((entry) =>
        Effect.gen(function* ownerRootUnderParentProgram() {
          const relative = `${parent}/${entry}`;
          if (relative === commerceVerticalRoot) {
            return Option.none();
          }
          const info = yield* fileSystem.stat(path.join(parentPath, entry));
          return info.type === 'Directory' ? Option.some(relative) : Option.none();
        }),
      ),
      { concurrency: 32 },
    );
    return EffectArray.getSomes(ownerRoots);
  });

const discoverNonCommerceOwnerRoots = (
  fileSystem: FileSystem.FileSystem,
  root: string,
  path: Path.Path,
): Effect.Effect<readonly string[], PlatformError> =>
  Effect.gen(function* discoverNonCommerceOwnerRootsProgram() {
    const rootsByParent = yield* Effect.all(
      nonCommerceOwnerParents.map((parent) => ownerRootsUnderParent(fileSystem, path, root, parent)),
      { concurrency: 32 },
    );
    return EffectArray.sort(rootsByParent.flat(), Order.String);
  });

const CommercePackageExportsSchema = Schema.Struct({
  exports: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const CommercePackageExportsFromJson = Schema.fromJsonString(CommercePackageExportsSchema);

/** Commerce's package.json `exports` map: subpath -> published target file. */
const readCommerceExportsMap = (
  fileSystem: FileSystem.FileSystem,
  root: string,
  path: Path.Path,
): Effect.Effect<ReadonlyMap<string, string>, PlatformError> =>
  Effect.gen(function* readCommerceExportsMapProgram() {
    const file = path.join(root, 'verticals/commerce-customer-context/package.json');
    const exists = yield* fileSystem.exists(file);
    if (!exists) {
      return new Map<string, string>();
    }
    const raw = yield* fileSystem.readFileString(file, 'utf-8');
    const parsed = yield* Schema.decodeUnknownEffect(CommercePackageExportsFromJson)(raw).pipe(Effect.orDie);
    const exportsField = parsed.exports ?? {};
    return new Map(
      Object.entries(exportsField).map(([subpath, target]) => [
        subpath === '.'
          ? commercePackageSpecifierPrefix
          : `${commercePackageSpecifierPrefix}/${subpath.replace(/^\.\//u, '')}`,
        target.replace(/^\.\//u, 'verticals/commerce-customer-context/'),
      ]),
    );
  });

/** Explicitly accepted (specifier, importer) pairs into Commerce's private src; any other pair is a violation. */
interface AllowedCompositionSeam {
  readonly importer: string;
  readonly reason: string;
  readonly specifier: string;
}

const allowedCompositionSeams: readonly AllowedCompositionSeam[] = [
  {
    importer: 'verticals/commerce-market-catalog/src/integrations/market-subject-restrictions.ts',
    reason:
      'Market Catalog composes the narrow Customer Context current subject-restrictions owner client for eligibility resolution.',
    specifier: `${commercePackageSpecifierPrefix}/api/market-subject-restrictions-current/client`,
  },
  {
    importer: 'verticals/pricing/src/integrations/commerce-price-group-resolution.ts',
    reason:
      'Pricing composes the narrow Customer Context price-group resolution owner client at its explicit integration boundary.',
    specifier: `${commercePackageSpecifierPrefix}/api/customer-price-group-resolution/client`,
  },
  {
    importer: 'verticals/pricing/src/integrations/current-pricing-decision-external-owner-evidence-live.ts',
    reason:
      'Pricing composes the narrow Customer Context price-group resolution owner client for external-owner evidence validation.',
    specifier: `${commercePackageSpecifierPrefix}/api/customer-price-group-resolution/client`,
  },
  {
    importer: 'verticals/pricing/src/integrations/current-pricing-decision-owner-final-fence.ts',
    reason:
      'Pricing composes the narrow Customer Context price-group resolution owner client for the final owner-authority fence.',
    specifier: `${commercePackageSpecifierPrefix}/api/customer-price-group-resolution/client`,
  },
  {
    importer: 'verticals/pricing/src/integrations/customer-context-subject-authority.ts',
    reason:
      'Pricing composes the narrow Customer Context purchase-context verification owner client at its subject-authority integration boundary.',
    specifier: `${commercePackageSpecifierPrefix}/api/pricing-purchase-context-verification/client`,
  },
  {
    importer: 'apps/shell-super-app/src/api/vertical-clients.ts',
    reason: 'Commerce publishes this as its sanctioned read-only API client for Shell composition.',
    specifier: `${commercePackageSpecifierPrefix}/api/client`,
  },
  {
    importer: 'apps/shell-super-app/api/auth/commerce-external-identity.ts',
    reason:
      'Shell composition seam for Commerce portal-auth verification during external-identity admission; scoped to the verification client only.',
    specifier: `${commercePackageSpecifierPrefix}/portal-auth/verification/client`,
  },
  {
    importer: 'apps/shell-super-app/api/auth/external-identity/commerce-admission-observation.ts',
    reason:
      'Shell composition seam for Commerce portal-auth verification during external-identity admission; scoped to the verification client only.',
    specifier: `${commercePackageSpecifierPrefix}/portal-auth/verification/client`,
  },
];

const isAllowedCompositionSeam = (importer: string, specifier: string): boolean =>
  allowedCompositionSeams.some((seam) => seam.importer === importer && seam.specifier === specifier);

const recordNonCommerceImportViolations = (
  record: (violation: LeanCoreDependencyViolation) => void,
  relative: string,
  source: string,
  commerceExports: ReadonlyMap<string, string>,
  nonCommerceOwnerRoots: readonly string[],
): void => {
  const isOwnedByNonCommerceUnit = nonCommerceOwnerRoots.some((ownerRoot) => relative.startsWith(`${ownerRoot}/`));
  if (!isOwnedByNonCommerceUnit || isTestSource(relative)) {
    return;
  }
  const underSrcOrApi = /(?:^|\/)(?:src|api)\//u.test(relative);
  if (!underSrcOrApi) {
    return;
  }
  for (const { index, isTypeOnly, specifier } of importsIn(relative, source)) {
    const resolvedTarget = commerceExports.get(specifier);
    const resolvedRelativeSpecifier = specifier.startsWith('.')
      ? posixPath.normalize(posixPath.join(posixPath.dirname(relative), specifier))
      : undefined;
    const isCommercePackageSpecifier =
      specifier === commercePackageSpecifierPrefix || specifier.startsWith(`${commercePackageSpecifierPrefix}/`);
    const targetsCommercePrivateImplementation = isCommercePackageSpecifier
      ? resolvedTarget !== undefined && commercePrivateImplementation.test(resolvedTarget)
      : commercePrivateImplementation.test(resolvedRelativeSpecifier ?? specifier);
    const isViolation =
      !isTypeOnly && targetsCommercePrivateImplementation && !isAllowedCompositionSeam(relative, specifier);
    if (!isViolation) {
      continue;
    }
    record({
      file: relative,
      line: sourceLine(source, index),
      reason: `Non-Commerce unit takes a mandatory runtime import of Commerce's private implementation "${specifier}" (only published shared/ contracts and documented composition seams are allowed)`,
    });
  }
};

const byField = <K extends keyof LeanCoreDependencyViolation>(
  key: K,
  order: Order.Order<LeanCoreDependencyViolation[K]>,
) => Order.mapInput(order, (violation: LeanCoreDependencyViolation) => violation[key]);

const ViolationOrder = Order.combine(
  byField('file', Order.String),
  Order.combine(byField('line', Order.Number), byField('reason', Order.String)),
);

export const checkLeanCoreDependencies = (
  root: string,
): Effect.Effect<readonly LeanCoreDependencyViolation[], PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* checkLeanCoreDependenciesProgram() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const violations: LeanCoreDependencyViolation[] = [];
    const recorded = new Set<string>();
    const record = (violation: LeanCoreDependencyViolation): void => {
      const key = `${violation.file}:${violation.line}:${violation.reason}`;
      if (recorded.has(key)) {
        return;
      }
      recorded.add(key);
      violations.push(violation);
    };

    const [files, commerceExports, nonCommerceOwnerRoots, coreBoundary] = yield* Effect.all([
      collect(root),
      readCommerceExportsMap(fileSystem, root, path),
      discoverNonCommerceOwnerRoots(fileSystem, root, path),
      checkCorePackageJson(fileSystem, root, path, record),
    ]);
    const sourcePairs = yield* Effect.all(
      files.map((file) =>
        fileSystem.readFileString(file, 'utf-8').pipe(Effect.map((source) => [file, source] as const)),
      ),
      { concurrency: 32 },
    );

    // Source policy retains its original TS inventory. Native JS/CJS is indexed only to prove graph edges.
    const coreRoot = path.join(root, coreSourceRoot);
    const coreRootExists = yield* fileSystem.exists(coreRoot);
    const coreGraphFiles = coreRootExists ? yield* collect(coreRoot, graphSourceExtensions) : [];
    const sourceFiles = new Set(files);
    const additionalGraphSources = yield* Effect.all(
      coreGraphFiles
        .filter((file) => !sourceFiles.has(file))
        .map((file) => fileSystem.readFileString(file, 'utf-8').pipe(Effect.map((source) => [file, source] as const))),
      { concurrency: 32 },
    );

    const coreSources = new Map(
      [...sourcePairs, ...additionalGraphSources].flatMap(([file, source]) => {
        const relative = path.relative(root, file).split(path.sep).join('/');
        return isInsideCoreSource(relative) ? [[relative, analyzeImports(relative, source)] as const] : [];
      }),
    );
    const nodeOnlyFiles = nodeOnlyCoreSources(coreSources, coreBoundary);
    const corePackageImports = new Set(coreBoundary.imports.keys());

    for (const [file, source] of sourcePairs) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      recordCoreSourceViolations(record, relative, source, corePackageImports, nodeOnlyFiles);
      recordNonCommerceImportViolations(record, relative, source, commerceExports, nonCommerceOwnerRoots);
    }

    return EffectArray.sort(violations, ViolationOrder);
  });

class LeanCoreDependencyCheckFailed extends Schema.TaggedError<LeanCoreDependencyCheckFailed>()(
  'LeanCoreDependencyCheckFailed',
  { violationCount: Schema.Number },
) {}

const main = Effect.gen(function* leanCoreDependencyMain() {
  const path = yield* Path.Path;
  const violations = yield* checkLeanCoreDependencies(path.resolve(process.cwd()));
  if (violations.length > 0) {
    yield* Effect.all(
      violations.map((violation) => Console.error(`${violation.file}:${violation.line}: ${violation.reason}`)),
      { concurrency: 1, discard: true },
    );
    return yield* Effect.fail(new LeanCoreDependencyCheckFailed({ violationCount: violations.length }));
  }
  return yield* Console.log('Lean-Core dependency boundaries verified');
});

const [, invokedPath] = process.argv;
if (invokedPath === import.meta.filename) {
  const leanCoreDependencyRuntime = ManagedRuntime.make(NodeServices.layer);
  const exit = await leanCoreDependencyRuntime.runPromiseExit(main);
  process.exitCode = Exit.isSuccess(exit) ? 0 : 1;
}
