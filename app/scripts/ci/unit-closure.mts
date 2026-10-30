/// <reference lib="esnext" />
/// <reference types="node" />
// Reads one committed revision of the repository and derives the conservative input closures that the
// deploy plan hashes. Dependency-free on purpose: the plan job runs it before any workspace install.
// Every path here is repository-relative (`app/verticals/tax/...`), exactly as `git ls-tree` prints it.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** Text files scanned for references to other files and workspace packages. */
const SCANNED_FILE = /\.(?:[cm]?[jt]sx?|json|jsonc|css|scss|sh|ya?ml|html)$/u;
/** A path token starting with `./` or `../`, quoted or not (package.json scripts carry unquoted ones). */
const RELATIVE_TOKEN = /(?<![\w@$./-])(?<token>\.{1,2}\/[^\s'"`),;\]}>|&]*)/gu;
/** A scoped package specifier anywhere in the text, with an optional subpath. */
const SCOPED_TOKEN = /(?<![\w.@/-])(?<name>@[a-z0-9][\w.-]*\/[\w.-]+)(?<subpath>(?:\/[\w.@-]+)*)/gu;
/** A quoted unscoped package specifier or package-internal `#import`, with an optional subpath. */
const QUOTED_BARE_TOKEN = /(?<=['"`])(?<name>#[\w.-]+|[a-z][\w.-]*)(?<subpath>(?:\/[\w.@-]+)*)(?=['"`])/gu;
/** An import, export-from, dynamic import or require specifier. */
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"`](?<specifier>[^'"`\s]+)['"`]/gu;
/** A package specifier split into its package name and subpath. */
const PACKAGE_SPECIFIER = /^(?<name>@[^/]+\/[^/]+|[^@/][^/]*)(?<subpath>\/.*)?$/gu;
/** Test and drizzle-kit files: hashed with their package, never followed, because no build reads them. */
const NOT_BUILT_FILE =
  /(?:^|\/)(?:tests?|__tests__|e2e|fixtures)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:drizzle|rstest|vitest|playwright)\.config\.[cm]?[jt]s$/u;
/** Source extensions tried, in order, for a relative import written without its extension. */
const RESOLVED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.d.ts'];
/** TypeScript's `.js`-written imports of `.ts` sources. */
const EMITTED_EXTENSION_SOURCES: ReadonlyMap<string, readonly string[]> = new Map([
  ['.cjs', ['.cts']],
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
]);
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const GIT_BUFFER = 1024 * 1024 * 1024;
/** Directories whose files belong to a delivery unit itself rather than the shared root workspace. */
const OWNED_AREAS = /^(?:apps|packages|verticals|topology)\//u;
/** Unit files whose relative references a build follows into the root workspace. */
const UNIT_BUILD_CONFIGS = ['modern.config.ts', 'module-federation.config.ts', 'tsconfig.json'];
/** The package scripts a Zerops or Cloudflare deployment runs. */
const DEPLOYED_SCRIPTS = ['build', 'cloudflare:build', 'cloudflare:deploy', 'serve'];
/** The package scripts that produce a unit's build output; the upload recipe is a separate, global input. */
const BUILD_SCRIPTS = ['build', 'cloudflare:build'];
const PACKAGE_MANIFEST = '/package.json';

export class ClosureInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ClosureInputError';
  }
}

export type JsonObject = Readonly<Record<string, unknown>>;

/** Whether a parsed JSON value is a plain object. */
export const isJsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A property of a parsed JSON value that may not be an object at all. */
const propertyOf = (value: unknown, key: string): unknown => (isJsonObject(value) ? value[key] : undefined);

const git = (cwd: string, args: readonly string[], input?: string): Buffer => {
  const result = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    input,
    maxBuffer: GIT_BUFFER,
  });
  if (result.status !== 0) {
    throw new ClosureInputError(`git ${args[0] ?? ''} failed: ${result.stderr.toString('utf-8').trim()}`);
  }
  return result.stdout;
};

export interface RepositorySnapshot {
  /** Repository-relative workspace directory with a trailing slash (`app/`). */
  readonly appPrefix: string;
  /** Tracked file path to blob object id. */
  readonly blobs: ReadonlyMap<string, string>;
  /** Reads the given tracked files in one batch. */
  readonly load: (paths: Iterable<string>) => void;
  /** Every tracked file path, sorted. */
  readonly paths: readonly string[];
  /** Text of a tracked file, read on demand. */
  readonly read: (file: string) => string | undefined;
  /** Absolute repository root. */
  readonly repoRoot: string;
  /** Commit the snapshot reads. */
  readonly revision: string;
}

/**
 * The tracked files of one commit and their contents, read from git objects rather than the working tree, so the
 * digest is a function of the commit alone.
 */
export const readRepositorySnapshot = (workspaceRoot: string, revision = 'HEAD'): RepositorySnapshot => {
  const repoRoot = git(workspaceRoot, ['rev-parse', '--show-toplevel']).toString('utf-8').trim();
  const appPrefix = git(workspaceRoot, ['rev-parse', '--show-prefix']).toString('utf-8').trim();
  const commit = git(workspaceRoot, ['rev-parse', '--verify', `${revision}^{commit}`])
    .toString('utf-8')
    .trim();
  const blobs = new Map<string, string>();
  for (const entry of git(repoRoot, ['ls-tree', '-r', '-z', '--full-tree', commit]).toString('utf-8').split('\0')) {
    const match = /^\d+ blob (?<oid>[\da-f]+)\t(?<file>.+)$/u.exec(entry)?.groups;
    if (match?.oid !== undefined && match.file !== undefined) {
      blobs.set(match.file, match.oid);
    }
  }
  const contents = new Map<string, string>();
  const load = (files: Iterable<string>) => {
    const pending = [...new Set(files)].filter((file) => blobs.has(file) && !contents.has(file));
    if (pending.length === 0) {
      return;
    }
    const output = git(repoRoot, ['cat-file', '--batch'], `${pending.map((file) => blobs.get(file)).join('\n')}\n`);
    let offset = 0;
    for (const file of pending) {
      const headerEnd = output.indexOf(10, offset);
      const size = Number(output.toString('utf-8', offset, headerEnd).split(' ')[2]);
      if (!Number.isSafeInteger(size)) {
        throw new ClosureInputError(`git cat-file returned no object for ${file}`);
      }
      contents.set(file, output.toString('utf-8', headerEnd + 1, headerEnd + 1 + size));
      offset = headerEnd + 1 + size + 1;
    }
  };
  return {
    appPrefix,
    blobs,
    load,
    paths: [...blobs.keys()].toSorted(),
    read: (file) => {
      load([file]);
      return contents.get(file);
    },
    repoRoot,
    revision: commit,
  };
};

/** Unanchored regular expression source of a glob over `/`-separated paths: `**`, `*`, `?` and `{a,b}`. */
const globSource = (glob: string): string => {
  const parts: string[] = [];
  let index = 0;
  while (index < glob.length) {
    const character = glob.charAt(index);
    if (character === '*' && glob.charAt(index + 1) === '*') {
      const directories = glob.charAt(index + 2) === '/';
      parts.push(directories ? '(?:[^/]*/)*' : '.*');
      index += directories ? 3 : 2;
    } else if (character === '{' && glob.includes('}', index)) {
      const close = glob.indexOf('}', index);
      const alternatives = glob
        .slice(index + 1, close)
        .split(',')
        .map((alternative) => globSource(alternative));
      parts.push(`(?:${alternatives.join('|')})`);
      index = close + 1;
    } else if (character === '*') {
      parts.push('[^/]*');
      index += 1;
    } else if (character === '?') {
      parts.push('[^/]');
      index += 1;
    } else {
      parts.push(character.replace(/[$()*+.?[\\\]^{|}]/u, String.raw`\$&`));
      index += 1;
    }
  }
  return parts.join('');
};

/** Anchored matcher of a glob over `/`-separated paths. */
export const globMatcher = (glob: string): RegExp => new RegExp(`^${globSource(glob)}$`, 'u');

/**
 * Tracked files matching the globs, relative to `base` (a repository-relative directory with a trailing slash, or
 * empty); a `!`-prefixed glob excludes what earlier ones matched.
 */
export const matchTrackedFiles = (snapshot: RepositorySnapshot, base: string, globs: readonly string[]): string[] => {
  const include = globs.filter((glob) => !glob.startsWith('!')).map((glob) => globMatcher(`${base}${glob}`));
  const exclude = globs.filter((glob) => glob.startsWith('!')).map((glob) => globMatcher(`${base}${glob.slice(1)}`));
  return snapshot.paths.filter(
    (file) => include.some((matcher) => matcher.test(file)) && !exclude.some((matcher) => matcher.test(file)),
  );
};

export interface WorkspacePackage {
  /** Repository-relative package directory without a trailing slash. */
  readonly dir: string;
  /** Parsed package.json. */
  readonly manifest: JsonObject;
  readonly name: string;
}

/** The `packages:` globs of pnpm-workspace.yaml. */
const workspaceGlobs = (text: string): string[] => {
  const globs: string[] = [];
  let inPackages = false;
  for (const line of text.split('\n')) {
    if (/^\S/u.test(line)) {
      inPackages = /^packages:\s*$/u.test(line);
    } else if (inPackages) {
      const item = /^\s+-\s+['"]?(?<glob>[^'"#\s]+)['"]?\s*$/u.exec(line)?.groups?.glob;
      if (item !== undefined) {
        globs.push(item);
      }
    }
  }
  return globs;
};

/** A tracked JSON file's object. */
export const parseJsonObject = (file: string, text: string | undefined): JsonObject => {
  if (text === undefined) {
    throw new ClosureInputError(`${file} is not tracked`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ClosureInputError(`${file} is not valid JSON`);
  }
  if (!isJsonObject(value)) {
    throw new ClosureInputError(`${file} is not a JSON object`);
  }
  return value;
};

/** The workspace packages pnpm-workspace.yaml declares, by name. */
export const readWorkspacePackages = (snapshot: RepositorySnapshot): Map<string, WorkspacePackage> => {
  const manifestFile = `${snapshot.appPrefix}pnpm-workspace.yaml`;
  const text = snapshot.read(manifestFile);
  if (text === undefined) {
    throw new ClosureInputError(`${manifestFile} is not tracked`);
  }
  const directories = workspaceGlobs(text).map((glob) => globMatcher(`${snapshot.appPrefix}${glob}`));
  const manifests = snapshot.paths.filter(
    (file) =>
      file.endsWith(PACKAGE_MANIFEST) &&
      directories.some((matcher) => matcher.test(file.slice(0, -PACKAGE_MANIFEST.length))),
  );
  snapshot.load(manifests);
  const packages = new Map<string, WorkspacePackage>();
  for (const file of manifests) {
    const manifest = parseJsonObject(file, snapshot.read(file));
    const { name } = manifest;
    if (typeof name !== 'string') {
      throw new ClosureInputError(`${file} has no package name`);
    }
    packages.set(name, { dir: file.slice(0, -PACKAGE_MANIFEST.length), manifest, name });
  }
  return packages;
};

export type ClosureNode =
  | { readonly kind: 'dir'; readonly path: string }
  | { readonly kind: 'file'; readonly path: string };

export interface PackageRequest {
  /** Workspace package name. */
  readonly name: string;
  /** `.`, `./subpath` or `#name`. */
  readonly request: string;
}

export interface FileReferences {
  /** Workspace package requests in import, export and require specifiers. */
  readonly imports: PackageRequest[];
  /** Workspace packages named anywhere in the file (package-level closures). */
  readonly mentions: PackageRequest[];
  /** Files and project directories named by relative path tokens. */
  readonly relative: ClosureNode[];
}

export interface ClosureGraph {
  /** Tracked files under a directory. */
  readonly filesUnder: (dir: string) => readonly string[];
  /** Workspace package rooted exactly at `dir`. */
  readonly packageAt: (dir: string) => WorkspacePackage | undefined;
  /** Innermost workspace package containing `file`. */
  readonly packageOf: (file: string) => WorkspacePackage | undefined;
  /** Workspace packages by name. */
  readonly packages: ReadonlyMap<string, WorkspacePackage>;
  /** Memoized references of each scanned file. */
  readonly references: Map<string, FileReferences>;
  readonly snapshot: RepositorySnapshot;
}

/** Graph helpers shared by every closure of one snapshot. */
export const createClosureGraph = (snapshot: RepositorySnapshot): ClosureGraph => {
  // One batch read of every scannable file is far cheaper than one git process per file reached.
  snapshot.load(snapshot.paths.filter((file) => SCANNED_FILE.test(file)));
  const packages = readWorkspacePackages(snapshot);
  const byDir = new Map([...packages.values()].map((workspacePackage) => [workspacePackage.dir, workspacePackage]));
  const filesUnderCache = new Map<string, readonly string[]>();
  // The innermost workspace package whose directory contains `dir`; the repository root (`.`) holds none.
  const ownerOf = (dir: string): WorkspacePackage | undefined => {
    const owner = byDir.get(dir);
    const parent = path.posix.dirname(dir);
    return owner ?? (parent === dir ? owner : ownerOf(parent));
  };
  return {
    filesUnder: (dir) => {
      const cached = filesUnderCache.get(dir);
      if (cached !== undefined) {
        return cached;
      }
      const prefix = `${dir}/`;
      const files = snapshot.paths.filter((file) => file.startsWith(prefix));
      filesUnderCache.set(dir, files);
      return files;
    },
    packageAt: (dir) => byDir.get(dir),
    packageOf: (file) => ownerOf(path.posix.dirname(file)),
    packages,
    references: new Map(),
    snapshot,
  };
};

/** The tracked file a relative or package-relative path names, trying TypeScript's extension and index rules. */
const resolveTrackedFile = (graph: ClosureGraph, target: string): string | undefined => {
  const { blobs } = graph.snapshot;
  if (blobs.has(target)) {
    return target;
  }
  const extension = path.posix.extname(target);
  const emitted = (EMITTED_EXTENSION_SOURCES.get(extension) ?? []).map(
    (source) => `${target.slice(0, -extension.length)}${source}`,
  );
  return [
    ...emitted,
    ...RESOLVED_EXTENSIONS.map((suffix) => `${target}${suffix}`),
    ...RESOLVED_EXTENSIONS.map((suffix) => `${target}/index${suffix}`),
  ].find((candidate) => blobs.has(candidate));
};

/** What a relative path token in `from` names: files, a directory, or nothing. */
const relativeTargets = (graph: ClosureGraph, from: string, token: string): ClosureNode[] => {
  const cleaned = token.replace(/[?#].*$/u, '').replace(/[.:]+$/u, '');
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), cleaned)).replace(/\/$/u, '');
  if (target === '.' || target.startsWith('../')) {
    return [];
  }
  if (target.includes('*')) {
    return matchTrackedFiles(graph.snapshot, '', [target]).map((file) => ({ kind: 'file', path: file }));
  }
  const file = resolveTrackedFile(graph, target);
  if (file !== undefined) {
    return [{ kind: 'file', path: file }];
  }
  // Only a project directory (a package or a tsconfig project such as `database`) is an input as a whole; any other
  // directory token is a path anchor like `new URL('../', import.meta.url)`, and the workspace root is never one.
  const appRoot = graph.snapshot.appPrefix.replace(/\/$/u, '');
  const { blobs } = graph.snapshot;
  return target !== appRoot && (blobs.has(`${target}${PACKAGE_MANIFEST}`) || blobs.has(`${target}/tsconfig.json`))
    ? [{ kind: 'dir', path: target }]
    : [];
};

/** Every string-valued leaf of a package.json `exports`/`imports` target, across all conditions. */
const targetLeaves = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown) => targetLeaves(item));
  }
  return isJsonObject(value) ? Object.values(value).flatMap((item) => targetLeaves(item)) : [];
};

/**
 * The package-relative files an `exports` or `imports` map (or a bare `exports` target) sends one request (`.`,
 * `./subpath` or `#name`) to, under every condition; undefined when the map does not answer.
 */
const mappedTargets = (map: unknown, request: string): string[] | undefined => {
  if (map === undefined || map === null) {
    return undefined;
  }
  if (!isJsonObject(map) || !Object.keys(map).some((key) => key.startsWith('.') || key.startsWith('#'))) {
    return request === '.' ? targetLeaves(map) : undefined;
  }
  const entries = Object.entries(map);
  const exact = entries.find(([key]) => key === request);
  if (exact !== undefined) {
    return targetLeaves(exact[1]);
  }
  for (const [key, value] of entries) {
    const star = key.indexOf('*');
    if (star !== -1 && request.startsWith(key.slice(0, star)) && request.endsWith(key.slice(star + 1))) {
      const middle = request.slice(star, request.length - (key.length - star - 1));
      return targetLeaves(value).map((leaf) => leaf.replaceAll('*', middle));
    }
  }
  return undefined;
};

/** Files one package-level request resolves to, or undefined when only the whole package is a safe answer. */
export const resolvePackageRequest = (
  graph: ClosureGraph,
  workspacePackage: WorkspacePackage,
  request: string,
): string[] | undefined => {
  const field = request.startsWith('#') ? 'imports' : 'exports';
  const targets = mappedTargets(workspacePackage.manifest[field], request);
  if (targets === undefined || targets.length === 0) {
    return undefined;
  }
  const files = targets.map((target) =>
    resolveTrackedFile(graph, path.posix.normalize(path.posix.join(workspacePackage.dir, target))),
  );
  return files.every((file): file is string => file !== undefined) ? files : undefined;
};

/** The workspace request a package name or `#import` with its `/subpath` (or empty) names in `file`, if any. */
const packageRequest = (
  graph: ClosureGraph,
  file: string,
  name: string,
  subpath: string,
): PackageRequest | undefined => {
  if (name.startsWith('#')) {
    const owner = graph.packageOf(file);
    return owner === undefined ? undefined : { name: owner.name, request: `${name}${subpath}` };
  }
  return graph.packages.has(name) ? { name, request: subpath === '' ? '.' : `.${subpath}` } : undefined;
};

/** The part of a file whose references a build follows: a package.json contributes only its build scripts. */
const buildRelevantText = (file: string, text: string): string => {
  if (path.posix.basename(file) !== 'package.json') {
    return text;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return text;
  }
  const scripts = propertyOf(manifest, 'scripts');
  return BUILD_SCRIPTS.map((name) => {
    const script = propertyOf(scripts, name);
    return typeof script === 'string' ? script : '';
  }).join('\n');
};

/** The workspace requests a pattern's `name` and `subpath` groups name in `file`. */
const mentionedRequests = (graph: ClosureGraph, file: string, text: string, pattern: RegExp): PackageRequest[] =>
  [...text.matchAll(pattern)].flatMap(({ groups }) => {
    const request = packageRequest(graph, file, groups?.name ?? '', groups?.subpath ?? '');
    return request === undefined ? [] : [request];
  });

/** The workspace requests of a file's import, export and require specifiers. */
const importedRequests = (graph: ClosureGraph, file: string, text: string): PackageRequest[] =>
  [...text.matchAll(IMPORT_SPECIFIER)].flatMap(({ groups }) =>
    mentionedRequests(graph, file, groups?.specifier ?? '', PACKAGE_SPECIFIER),
  );

/**
 * What one file refers to. Test-only files and non-deployed package scripts are hashed with their package but
 * never followed: no build reads what they point at.
 */
const fileReferences = (graph: ClosureGraph, file: string): FileReferences => {
  const cached = graph.references.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const text =
    SCANNED_FILE.test(file) && !NOT_BUILT_FILE.test(file)
      ? buildRelevantText(file, graph.snapshot.read(file) ?? '')
      : '';
  const references: FileReferences = {
    imports: importedRequests(graph, file, text),
    mentions: [SCOPED_TOKEN, QUOTED_BARE_TOKEN].flatMap((pattern) => mentionedRequests(graph, file, text, pattern)),
    relative: [...text.matchAll(RELATIVE_TOKEN)].flatMap(({ groups }) =>
      relativeTargets(graph, file, groups?.token ?? ''),
    ),
  };
  graph.references.set(file, references);
  return references;
};

/** Names of the workspace packages a package depends on through the `workspace:` protocol. */
const workspaceDependencies = (
  workspacePackage: WorkspacePackage,
  packages: ReadonlyMap<string, WorkspacePackage>,
): string[] =>
  DEPENDENCY_FIELDS.flatMap((field) => {
    const dependencies = workspacePackage.manifest[field];
    return isJsonObject(dependencies)
      ? Object.entries(dependencies).flatMap(([name, specifier]) =>
          typeof specifier === 'string' && specifier.startsWith('workspace:') && packages.has(name) ? [name] : [],
        )
      : [];
  });

export interface Closure {
  /** Whole directories included (package roots and referenced directories). */
  readonly directories: Set<string>;
  /** Repository-relative tracked files. */
  readonly files: Set<string>;
}

/**
 * Package-level closure: whole package directories plus their `workspace:` dependencies, every workspace package a
 * package file names, every project directory (package or tsconfig project such as `database`) a relative path
 * names, and every single file a relative path leaves its directory for — transitively. Such a single file (a root
 * script the build runs, a JSON another package generated) is followed through its own relative paths and import
 * specifiers.
 */
export const packageClosure = (graph: ClosureGraph, roots: readonly ClosureNode[]): Closure => {
  const closure: Closure = { directories: new Set(), files: new Set() };
  const pending: ClosureNode[] = [...roots];
  const scanned = new Set<string>();
  const pushPackage = (name: string) => {
    const dir = graph.packages.get(name)?.dir;
    if (dir !== undefined && !closure.directories.has(dir)) {
      pending.push({ kind: 'dir', path: dir });
    }
  };
  const visitDirectory = (dir: string) => {
    closure.directories.add(dir);
    const owner = graph.packageAt(dir);
    for (const name of owner === undefined ? [] : workspaceDependencies(owner, graph.packages)) {
      pushPackage(name);
    }
    for (const file of graph.filesUnder(dir)) {
      closure.files.add(file);
      if (!scanned.has(file)) {
        scanned.add(file);
        const references = fileReferences(graph, file);
        pending.push(...references.relative.filter((target) => !target.path.startsWith(`${dir}/`)));
        for (const { name } of references.mentions) {
          pushPackage(name);
        }
      }
    }
  };
  const visitFile = (file: string) => {
    scanned.add(file);
    closure.files.add(file);
    const references = fileReferences(graph, file);
    pending.push(...references.relative);
    for (const { name } of references.imports) {
      pushPackage(name);
    }
  };
  let node = pending.pop();
  while (node !== undefined) {
    if (node.kind === 'dir' && !closure.directories.has(node.path)) {
      visitDirectory(node.path);
    } else if (node.kind === 'file' && !scanned.has(node.path)) {
      visitFile(node.path);
    }
    node = pending.pop();
  }
  return closure;
};

/**
 * File-level import closure: follows relative paths and resolves workspace package requests through their
 * `exports`/`imports` maps to single files; a request the map does not answer pulls in that whole package
 * (package-level). Used for script entry points such as the release recipe, where one deep import must not drag
 * in a whole package.
 */
export const importClosure = (graph: ClosureGraph, seeds: readonly string[]): Closure => {
  const files = new Set<string>();
  const packageRoots: ClosureNode[] = [];
  let wave = seeds.filter((seed) => graph.snapshot.blobs.has(seed));
  while (wave.length > 0) {
    const next: string[] = [];
    for (const file of wave) {
      if (files.has(file)) {
        continue;
      }
      files.add(file);
      const references = fileReferences(graph, file);
      for (const target of references.relative) {
        if (target.kind === 'file') {
          next.push(target.path);
        } else if (graph.packageAt(target.path) === undefined) {
          next.push(...graph.filesUnder(target.path));
        } else {
          packageRoots.push(target);
        }
      }
      for (const { name, request } of references.imports) {
        const workspacePackage = graph.packages.get(name);
        const resolved =
          workspacePackage === undefined ? undefined : resolvePackageRequest(graph, workspacePackage, request);
        if (resolved !== undefined && workspacePackage !== undefined) {
          next.push(...resolved, `${workspacePackage.dir}${PACKAGE_MANIFEST}`);
        } else if (workspacePackage !== undefined) {
          packageRoots.push({ kind: 'dir', path: workspacePackage.dir });
        }
      }
    }
    wave = next.filter((file) => !files.has(file));
  }
  const whole = packageClosure(graph, packageRoots);
  return { directories: whole.directories, files: new Set([...files, ...whole.files]) };
};

/**
 * Root-level workspace files (outside apps, packages, verticals and topology) that any unit build reads through its
 * build configs or deployed package scripts, following each root file's own references transitively. Returns
 * repository-relative files, sorted.
 */
export const rootBuildInputs = (graph: ClosureGraph, unitDirs: readonly string[]): string[] => {
  const { appPrefix } = graph.snapshot;
  const pending: ClosureNode[] = [];
  for (const unitDir of unitDirs) {
    for (const config of UNIT_BUILD_CONFIGS) {
      const file = `${unitDir}/${config}`;
      if (graph.snapshot.blobs.has(file)) {
        pending.push(...fileReferences(graph, file).relative);
      }
    }
    const manifestFile = `${unitDir}${PACKAGE_MANIFEST}`;
    const { scripts } = parseJsonObject(manifestFile, graph.snapshot.read(manifestFile));
    for (const name of DEPLOYED_SCRIPTS) {
      const script = propertyOf(scripts, name);
      for (const match of (typeof script === 'string' ? script : '').matchAll(RELATIVE_TOKEN)) {
        pending.push(...relativeTargets(graph, manifestFile, match.groups?.token ?? ''));
      }
    }
  }
  const inputs = new Set<string>();
  let node = pending.pop();
  while (node !== undefined) {
    const relative = node.path.slice(appPrefix.length);
    if (
      node.kind === 'file' &&
      node.path.startsWith(appPrefix) &&
      !OWNED_AREAS.test(relative) &&
      !inputs.has(node.path)
    ) {
      inputs.add(node.path);
      pending.push(...fileReferences(graph, node.path).relative);
    }
    node = pending.pop();
  }
  return [...inputs].toSorted();
};
