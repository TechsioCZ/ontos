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
import type { ImportExpression } from 'oxc-parser';

/**
 * Executable audit for the lean-Core architecture decision (issue #337 /
 * M06): Core (`packages/core-runtime`) must stay provider-neutral and must
 * never depend on Commerce, Storefront or Better Auth vocabulary — as a
 * declared package.json dependency or as a source-level import anywhere
 * under `src/**`. Independently, the non-Commerce apps and verticals must
 * never take a *mandatory runtime* import of Commerce's private
 * implementation (`verticals/commerce-customer-context/{src,api}/**`); they
 * may only depend on its published `shared/` contracts, plus a small,
 * explicitly documented set of composition seams that already exist.
 */

export interface LeanCoreDependencyViolation {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

const sourceExtensions = new Set(['.ts', '.tsx', '.mts']);
const ignoredDirectories = new Set(['dist', 'node_modules', 'repos', '.output', '.codex']);
const isTestSource = (relative: string): boolean => /(?:^|\/)(?:tests?|__tests__)\//u.test(relative);

const collect = (root: string): Effect.Effect<readonly string[], PlatformError, FileSystem.FileSystem | Path.Path> =>
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
              return collect(candidate);
            }
            return Effect.succeed(sourceExtensions.has(path.extname(entry)) ? [candidate] : []);
          }),
        );
      }),
      { concurrency: 'unbounded' },
    );
    return EffectArray.sort(discovered.flat(), Order.String);
  });

const sourceLine = (source: string, index: number): number => source.slice(0, index).split('\n').length;

interface ImportOccurrence {
  readonly index: number;
  readonly isTypeOnly: boolean;
  readonly specifier: string;
}

const OccurrenceIndexOrder = Order.mapInput(Order.Number, (occurrence: ImportOccurrence) => occurrence.index);

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

/**
 * Syntax-aware import/export/dynamic-import collection via oxc-parser. This
 * covers every specifier-bearing form: `import ... from`, `export ... from`,
 * `export * from`, side-effect imports (`import '...'`, no bindings), and
 * dynamic `import('...')` with a string-literal source — including forms
 * spread across multiple lines, which a line-oriented regex cannot see.
 * `import type` / `export type` statements are still classified as
 * type-only so callers can keep allowing them.
 */
const importsIn = (file: string, source: string): readonly ImportOccurrence[] => {
  const parsed = parseSync(file, source, {
    astType: 'ts',
    lang: file.endsWith('.tsx') ? 'tsx' : 'ts',
    sourceType: 'module',
  });
  if (parsed.errors.length > 0) {
    return [];
  }
  const occurrences = parsed.program.body.flatMap((statement) => {
    const occurrence = occurrenceForStatement(statement);
    return occurrence === undefined ? [] : [occurrence];
  });
  const dynamicOccurrences: ImportOccurrence[] = [];
  const recordDynamicImportExpression = (node: ImportExpression): void => {
    if (node.source.type === 'Literal' && Predicate.isString(node.source.value)) {
      dynamicOccurrences.push({ index: node.start, isTypeOnly: false, specifier: node.source.value });
    }
  };
  new Visitor({ ImportExpression: recordDynamicImportExpression }).visit(parsed.program);
  return EffectArray.sort([...occurrences, ...dynamicOccurrences], OccurrenceIndexOrder);
};

// --- Core external-dependency positive pin -------------------------------

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

const recordCoreSourceViolations = (
  record: (violation: LeanCoreDependencyViolation) => void,
  relative: string,
  source: string,
): void => {
  if (!relative.startsWith(`${coreSourceRoot}/`)) {
    return;
  }
  for (const { index, specifier } of importsIn(relative, source)) {
    const isExempt = specifier.startsWith('.') || isAllowedCoreExternalSpecifier(specifier);
    if (isExempt) {
      continue;
    }
    record({ file: relative, line: sourceLine(source, index), reason: coreExternalDependencyReason(specifier) });
  }
};

const WorkspacePackageManifestSchema = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const WorkspacePackageManifestFromJson = Schema.fromJsonString(WorkspacePackageManifestSchema);

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
): Effect.Effect<void, PlatformError> =>
  Effect.gen(function* checkCorePackageJsonProgram() {
    const file = path.join(root, corePackageJsonRelative);
    const exists = yield* fileSystem.exists(file);
    if (!exists) {
      return;
    }
    const raw = yield* fileSystem.readFileString(file, 'utf-8');
    const parsed = yield* Schema.decodeUnknownEffect(WorkspacePackageManifestFromJson)(raw).pipe(Effect.orDie);
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
  });

// --- Non-Commerce -> Commerce private-implementation boundary -------------

const commerceVerticalRoot = 'verticals/commerce-customer-context';
const nonCommerceOwnerParents = ['apps', 'verticals'];
const commercePackageSpecifierPrefix = '@app/commerce-customer-context';
const commercePrivateImplementation = /(?:^|\/)verticals\/commerce-customer-context\/(?:src|api)\//u;

/**
 * Every directory under `apps/` and `verticals/` owns its own unit and is
 * subject to the private-implementation boundary — except Commerce's own
 * vertical, which is the thing being bounded. Deriving this from the
 * workspace layout (instead of a hard-coded list) means a newly added
 * app/vertical is covered automatically; the composition-seam allowlist
 * below stays explicit data since those exceptions must be reviewed one at
 * a time.
 */
const ownerRootUnderParent = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  parentPath: string,
  parent: string,
  entry: string,
): Effect.Effect<Option.Option<string>, PlatformError> =>
  Effect.gen(function* ownerRootUnderParentProgram() {
    const relative = `${parent}/${entry}`;
    if (relative === commerceVerticalRoot) {
      return Option.none();
    }
    const info = yield* fileSystem.stat(path.join(parentPath, entry));
    return info.type === 'Directory' ? Option.some(relative) : Option.none();
  });

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
      entries.map((entry) => ownerRootUnderParent(fileSystem, path, parentPath, parent, entry)),
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

/**
 * Composition seams the lean-Core decision has already accepted: a specific
 * (specifier, importer) pair that resolves into Commerce's private `src/**`
 * even though it is not published under `shared/**`. Each entry documents
 * why it is safe so a new seam cannot slip in silently — any pair not
 * listed here is a violation.
 */
interface AllowedCompositionSeam {
  readonly importer: string;
  readonly reason: string;
  readonly specifier: string;
}

const allowedCompositionSeams: readonly AllowedCompositionSeam[] = [
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

const compareViolations = (left: LeanCoreDependencyViolation, right: LeanCoreDependencyViolation): -1 | 0 | 1 => {
  const fileOrder = left.file.localeCompare(right.file);
  if (fileOrder !== 0) {
    return fileOrder < 0 ? -1 : 1;
  }
  const lineOrder = left.line - right.line;
  if (lineOrder !== 0) {
    return lineOrder < 0 ? -1 : 1;
  }
  const reasonOrder = left.reason.localeCompare(right.reason);
  if (reasonOrder !== 0) {
    return reasonOrder < 0 ? -1 : 1;
  }
  return 0;
};

const ViolationOrder = Order.make(compareViolations);

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

    const [files, commerceExports, nonCommerceOwnerRoots] = yield* Effect.all([
      collect(root),
      readCommerceExportsMap(fileSystem, root, path),
      discoverNonCommerceOwnerRoots(fileSystem, root, path),
    ]);
    const sourcePairs = yield* Effect.all(
      files.map((file) =>
        fileSystem.readFileString(file, 'utf-8').pipe(Effect.map((source) => [file, source] as const)),
      ),
      { concurrency: 32 },
    );

    for (const [file, source] of sourcePairs) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      recordCoreSourceViolations(record, relative, source);
      recordNonCommerceImportViolations(record, relative, source, commerceExports, nonCommerceOwnerRoots);
    }
    yield* checkCorePackageJson(fileSystem, root, path, record);

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
