import type { ESTree } from '@oxlint/plugins';

import { collectEffectBindings, type EffectBindings } from './effect-imports.ts';
import { matchesGlobs } from './paths.ts';

export function importedName(specifier: ESTree.ImportSpecifier): string {
  return specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
}

export interface ImportPolicy {
  /** Older syntax-only collectors include type imports; runtime collectors explicitly opt out. */
  readonly valueOnly?: boolean;
  /** Runtime construction tracks inline type-only locals separately. */
  readonly excludedLocals?: ReadonlySet<string>;
}

/** Import filtering is caller-selected: exact modules, globs and submodule regexes are not equivalent. */
export function importDeclarations(
  program: ESTree.Program,
  accepts: (source: string) => boolean,
  policy: ImportPolicy = {},
): ESTree.ImportDeclaration[] {
  return program.body.filter(
    (statement): statement is ESTree.ImportDeclaration =>
      statement.type === 'ImportDeclaration' &&
      !(policy.valueOnly && statement.importKind === 'type') &&
      accepts(statement.source.value),
  );
}

function allowedSpecifier(specifier: ESTree.ImportDeclaration['specifiers'][number], policy: ImportPolicy): boolean {
  if (policy.excludedLocals?.has(specifier.local.name)) return false;
  return !(policy.valueOnly && specifier.type === 'ImportSpecifier' && specifier.importKind === 'type');
}

/** Namespace locals for caller-selected root sources; no default imports or automatic submodule matching. */
export function collectRootNamespaces(
  program: ESTree.Program,
  accepts: (source: string) => boolean = (source) => source === 'effect',
  policy: ImportPolicy = {},
): Set<string> {
  const locals = new Set<string>();
  for (const declaration of importDeclarations(program, accepts, policy)) {
    for (const specifier of declaration.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier' && allowedSpecifier(specifier, policy))
        locals.add(specifier.local.name);
    }
  }
  return locals;
}

/** Named import map with caller-selected source and exported-member filters. */
export function collectNamedImports(
  program: ESTree.Program,
  accepts: (source: string) => boolean,
  members?: ReadonlySet<string>,
  policy: ImportPolicy = {},
): Map<string, string> {
  const locals = new Map<string, string>();
  for (const declaration of importDeclarations(program, accepts, policy)) {
    for (const specifier of declaration.specifiers) {
      if (specifier.type !== 'ImportSpecifier' || !allowedSpecifier(specifier, policy)) continue;
      const name = importedName(specifier);
      if (!members || members.has(name)) locals.set(specifier.local.name, name);
    }
  }
  return locals;
}

export interface NamespaceMember {
  readonly namespace: string;
  readonly member: string;
}

/** Returns the trailing Effect submodule identifier, including unstable nested submodules. */
function effectSubmodule(source: string): string | null {
  return /^effect\/(?:.*\/)?([A-Za-z][A-Za-z0-9_]*)$/u.exec(source)?.[1] ?? null;
}

function addDirectMembers(
  locals: Map<string, NamespaceMember>,
  declaration: ESTree.ImportDeclaration,
  namespace: string,
  members: ReadonlySet<string> | undefined,
  policy: ImportPolicy,
): void {
  for (const specifier of declaration.specifiers) {
    if (specifier.type !== 'ImportSpecifier' || !allowedSpecifier(specifier, policy)) continue;
    const member = importedName(specifier);
    if (!members || members.has(member)) locals.set(specifier.local.name, { namespace, member });
  }
}

/** Typed member records; map values to `${namespace}.${member}`, member alone, or keys as needed.
 * Supplying byNamespace excludes unlisted namespaces. resolveNamespace preserves narrower regex copies.
 */
export function collectDirectMemberImports(
  program: ESTree.Program,
  byNamespace?: ReadonlyMap<string, ReadonlySet<string>>,
  policy: ImportPolicy = {},
  resolveNamespace = effectSubmodule,
): Map<string, NamespaceMember> {
  const locals = new Map<string, NamespaceMember>();
  for (const declaration of importDeclarations(program, () => true, policy)) {
    const namespace = resolveNamespace(declaration.source.value);
    if (namespace === null) continue;
    const members = byNamespace?.get(namespace);
    if (byNamespace && !members) continue;
    addDirectMembers(locals, declaration, namespace, members, policy);
  }
  return locals;
}

export function splitMembers(members: readonly string[]): {
  byNamespace: Map<string, Set<string>>;
  namespaces: Set<string>;
} {
  const byNamespace = new Map<string, Set<string>>();
  for (const entry of members) {
    const dot = entry.indexOf('.');
    if (dot <= 0 || dot === entry.length - 1) continue;
    const namespace = entry.slice(0, dot);
    const bucket = byNamespace.get(namespace) ?? new Set<string>();
    bucket.add(entry.slice(dot + 1));
    byNamespace.set(namespace, bucket);
  }
  return { byNamespace, namespaces: new Set(byNamespace.keys()) };
}

/** Existing Effect namespaces plus watched named exports and namespace imports of root/glob barrels. */
export function collectNamespaceLocals(
  program: ESTree.Program,
  bindings: EffectBindings,
  watched: ReadonlySet<string>,
  reexportModules: readonly string[],
  policy: ImportPolicy = {},
): { namespaced: Map<string, string>; barrel: Set<string> } {
  const namespaced = new Map([...bindings.namespaces].filter(([, namespace]) => watched.has(namespace)));
  const accepts = (source: string) => source === 'effect' || matchesGlobs(source, reexportModules);
  for (const [local, name] of collectNamedImports(program, accepts, watched, policy)) namespaced.set(local, name);
  return {
    namespaced,
    barrel: collectRootNamespaces(program, accepts, policy),
  };
}

/** Generator-family exact barrels add only named Effect exports; retains original type-import policy. */
export function bindingsWithExtraModules(program: ESTree.Program, modules: readonly string[]): EffectBindings {
  const base = collectEffectBindings(program);
  if (modules.length === 0) return base;
  const extra = collectNamedImports(program, (source) => modules.includes(source), new Set(['Effect']));
  return {
    namespaces: new Map([...base.namespaces, ...extra]),
    importsEffect: base.importsEffect || extra.size > 0,
  };
}

/** Schema locals for the literal-vocabulary/interface-codec family. Submodule imports take priority
 * over overlapping barrel globs; type imports remain enabled unless policy opts out.
 */
export function collectSchemaLocals(
  program: ESTree.Program,
  bindings: EffectBindings,
  reexportModules: readonly string[] = [],
  policy: ImportPolicy = {},
): { schema: Set<string>; barrel: Set<string>; direct: Map<string, string> } {
  const isSchema = (source: string) => /^effect\/(?:.*\/)?Schema$/u.test(source);
  const isRoot = (source: string) =>
    !isSchema(source) && (source === 'effect' || matchesGlobs(source, reexportModules));
  const schema = new Set(
    [...bindings.namespaces].filter(([, namespace]) => namespace === 'Schema').map(([local]) => local),
  );
  for (const local of collectRootNamespaces(program, isSchema, policy)) schema.add(local);
  for (const local of collectNamedImports(program, isRoot, new Set(['Schema']), policy).keys()) schema.add(local);
  return {
    schema,
    barrel: collectRootNamespaces(program, isRoot, policy),
    direct: collectNamedImports(program, isSchema, undefined, policy),
  };
}
