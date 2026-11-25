import nodePath from 'node:path';

import { Predicate, Schema } from 'effect';
import { parseSync, Visitor, visitorKeys } from 'oxc-parser';
import type { Node, Program } from 'oxc-parser';

/**
 * Module-scope bindings of one TypeScript source and what each reference resolves to, by scope: a name declared in
 * an inner scope (a parameter, a block, a type parameter, an `infer`) hides the module binding of that name in its
 * namespace, so a reference resolves to the declaration TypeScript binds it to, never to whatever shares its name.
 */

const BindingNamespaceSchema = Schema.Literals(['type', 'value']);
type BindingNamespace = typeof BindingNamespaceSchema.Type;

export interface ModuleBinding {
  readonly identifier: Node;
  /** For an import: the module specifier and the name it imports (`default`, or `*` for a namespace). */
  readonly imported?: { readonly name: string; readonly source: string };
  readonly name: string;
  readonly namespaces: readonly BindingNamespace[];
  /** The top-level statement that declares the binding. */
  readonly statement: Node;
}

export interface ModuleReference {
  /** The module bindings the reference resolves to; none for a name no scope of the file declares. */
  readonly bindings: readonly ModuleBinding[];
  readonly identifier: Node;
  readonly name: string;
}

export interface ModuleBindings {
  /** Every declaring identifier, of a module binding or a local one, that an assignment or update writes again. */
  readonly assigned: ReadonlySet<Node>;
  readonly bindings: readonly ModuleBinding[];
  /** Each reference an inner scope binds (a parameter, a local declaration), to the identifier that declares it. */
  readonly local: ReadonlyMap<Node, Node>;
  readonly parents: ReadonlyMap<Node, Node>;
  readonly program: Program;
  /** Every reference of the file that no inner scope binds, by its identifier. */
  readonly referenceOf: ReadonlyMap<Node, ModuleReference>;
  /** The same references, in source order. */
  readonly references: readonly ModuleReference[];
  readonly source: string;
}

type Lookup = 'namespace' | BindingNamespace;

interface ScopedDeclaration {
  readonly identifier: Node;
  readonly namespaces: readonly BindingNamespace[];
}

const BOTH: readonly BindingNamespace[] = ['type', 'value'];
const TYPE: readonly BindingNamespace[] = ['type'];
const VALUE: readonly BindingNamespace[] = ['value'];

/** TypeScript nodes that hold runtime code: an identifier under them, outside a type, names a value. */
const runtimeTypeScript = new Set([
  'TSAbstractAccessorProperty',
  'TSAbstractMethodDefinition',
  'TSAbstractPropertyDefinition',
  'TSAsExpression',
  'TSDeclareFunction',
  'TSEmptyBodyFunctionExpression',
  'TSEnumBody',
  'TSEnumDeclaration',
  'TSEnumMember',
  'TSExportAssignment',
  'TSExternalModuleReference',
  'TSInstantiationExpression',
  'TSModuleBlock',
  'TSModuleDeclaration',
  'TSNonNullExpression',
  'TSParameterProperty',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
]);

/** The identifiers a binding pattern declares. */
const patternIdentifiers = (pattern: Node | null | undefined): readonly Node[] => {
  if (pattern?.type === 'Identifier') {
    return [pattern];
  }
  if (pattern?.type === 'ArrayPattern') {
    return pattern.elements.flatMap((element) => patternIdentifiers(element));
  }
  if (pattern?.type === 'ObjectPattern') {
    return pattern.properties.flatMap((property) =>
      patternIdentifiers(property.type === 'RestElement' ? property.argument : property.value),
    );
  }
  if (pattern?.type === 'AssignmentPattern') {
    return patternIdentifiers(pattern.left);
  }
  if (pattern?.type === 'RestElement') {
    return patternIdentifiers(pattern.argument);
  }
  return pattern?.type === 'TSParameterProperty' ? patternIdentifiers(pattern.parameter) : [];
};

const ancestors = function* ancestors(parents: ReadonlyMap<Node, Node>, node: Node): Generator<Node> {
  for (let current = parents.get(node); current !== undefined; current = parents.get(current)) {
    yield current;
  }
};

/** The statement of the program that holds node, or node itself when it is one. */
export const topLevelStatement = (bindings: ModuleBindings, node: Node): Node | undefined => {
  let current: Node | undefined = node;
  while (current !== undefined && bindings.parents.get(current) !== bindings.program) {
    current = bindings.parents.get(current);
  }
  return current;
};

/** The line of a source position, from 1. */
export const lineOf = (source: string, index: number): number => source.slice(0, index).split('\n').length;

/** Whether inner lies inside outer (or is outer). */
export const isWithin = (inner: Node, outer: Node): boolean => inner.start >= outer.start && inner.end <= outer.end;

/** The scope a declaration of the block-level kind belongs to: the enclosing block, switch or program. */
const blockScope = (parents: ReadonlyMap<Node, Node>, declaration: Node): Node | undefined => {
  const parent = parents.get(declaration);
  const owner =
    parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportDefaultDeclaration'
      ? parents.get(parent)
      : parent;
  return owner?.type === 'SwitchCase' ? parents.get(owner) : owner;
};

/**
 * A `var` belongs to the body of the nearest function, whose parameters are evaluated before the body and do not see
 * it, to the nearest class static block or namespace, or to the program.
 */
const functionScope = (parents: ReadonlyMap<Node, Node>, declaration: Node): Node | undefined => {
  for (const ancestor of ancestors(parents, declaration)) {
    if (
      ancestor.type === 'ArrowFunctionExpression' ||
      ancestor.type === 'FunctionDeclaration' ||
      ancestor.type === 'FunctionExpression'
    ) {
      return ancestor.body ?? ancestor;
    }
    if (ancestor.type === 'StaticBlock' || ancestor.type === 'Program' || ancestor.type === 'TSModuleBlock') {
      return ancestor;
    }
  }
  return undefined;
};

/** An `infer` binds in the true branch of the conditional type whose extends clause holds it. */
const inferScope = (parents: ReadonlyMap<Node, Node>, infer: Node): Node | undefined => {
  let child = infer;
  for (const ancestor of ancestors(parents, infer)) {
    if (ancestor.type === 'TSConditionalType' && ancestor.extendsType === child) {
      return ancestor.trueType;
    }
    child = ancestor;
  }
  return undefined;
};

const functionDeclarations = (node: Node): readonly ScopedDeclaration[] => {
  if (
    node.type !== 'ArrowFunctionExpression' &&
    node.type !== 'FunctionDeclaration' &&
    node.type !== 'FunctionExpression' &&
    node.type !== 'TSDeclareFunction' &&
    node.type !== 'TSEmptyBodyFunctionExpression'
  ) {
    return [];
  }
  return [
    ...node.params.flatMap((parameter) => patternIdentifiers(parameter)),
    ...(node.type === 'FunctionExpression' && node.id !== null ? [node.id] : []),
  ].map((identifier) => ({ identifier, namespaces: VALUE }));
};

const signatureDeclarations = (node: Node): readonly ScopedDeclaration[] => {
  if (
    node.type === 'TSCallSignatureDeclaration' ||
    node.type === 'TSConstructSignatureDeclaration' ||
    node.type === 'TSConstructorType' ||
    node.type === 'TSFunctionType' ||
    node.type === 'TSMethodSignature'
  ) {
    return node.params
      .flatMap((parameter) => patternIdentifiers(parameter))
      .map((identifier) => ({
        identifier,
        namespaces: VALUE,
      }));
  }
  if (node.type === 'TSIndexSignature') {
    return node.parameters.map((identifier) => ({ identifier, namespaces: VALUE }));
  }
  return [];
};

type ScopedDeclarations = readonly (readonly [Node | undefined, readonly ScopedDeclaration[]])[];

const declaredIn = (scope: Node | undefined, identifier: Node | null, namespaces: readonly BindingNamespace[]) =>
  [[scope, identifier === null ? [] : [{ identifier, namespaces }]]] as const;

/** What a statement-level declaration declares in its block: a variable, function, class, type, enum or import. */
const statementDeclarations = (parents: ReadonlyMap<Node, Node>, node: Node): ScopedDeclarations | undefined => {
  if (node.type === 'VariableDeclaration') {
    const identifiers = node.declarations.flatMap((declarator) => patternIdentifiers(declarator.id));
    const scope = node.kind === 'var' ? functionScope(parents, node) : blockScope(parents, node);
    return [[scope, identifiers.map((identifier) => ({ identifier, namespaces: VALUE }))]];
  }
  if (node.type === 'FunctionDeclaration' || node.type === 'TSDeclareFunction') {
    return [...declaredIn(blockScope(parents, node), node.id, VALUE), [node, functionDeclarations(node)]];
  }
  if (node.type === 'ClassDeclaration') {
    return declaredIn(blockScope(parents, node), node.id, BOTH);
  }
  if (node.type === 'TSTypeAliasDeclaration' || node.type === 'TSInterfaceDeclaration') {
    return declaredIn(blockScope(parents, node), node.id, TYPE);
  }
  if (node.type === 'TSEnumDeclaration' || node.type === 'TSImportEqualsDeclaration') {
    return declaredIn(blockScope(parents, node), node.id, BOTH);
  }
  if (node.type === 'TSModuleDeclaration') {
    return node.id.type === 'Identifier' ? declaredIn(blockScope(parents, node), node.id, BOTH) : [];
  }
  if (node.type === 'ImportDeclaration') {
    return [
      [parents.get(node), node.specifiers.map((specifier) => ({ identifier: specifier.local, namespaces: BOTH }))],
    ];
  }
  return undefined;
};

/** What a node that opens a scope of its own declares there: parameters, a type parameter, a catch binding. */
const scopeDeclarations = (parents: ReadonlyMap<Node, Node>, node: Node): ScopedDeclarations => {
  if (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'TSEmptyBodyFunctionExpression'
  ) {
    return [[node, functionDeclarations(node)]];
  }
  if (node.type === 'ClassExpression') {
    return declaredIn(node, node.id, BOTH);
  }
  if (node.type === 'CatchClause') {
    return [[node, patternIdentifiers(node.param).map((identifier) => ({ identifier, namespaces: VALUE }))]];
  }
  if (node.type === 'TSTypeParameter') {
    const parent = parents.get(node);
    const scope = parent?.type === 'TSInferType' ? inferScope(parents, parent) : parent && parents.get(parent);
    return declaredIn(scope, node.name, TYPE);
  }
  if (node.type === 'TSMappedType') {
    return declaredIn(node, node.key, TYPE);
  }
  // An enum's members are names in its initializers: `enum E { A = 1, B = A }`.
  if (node.type === 'TSEnumBody') {
    return [
      [
        node,
        node.members.flatMap((member) =>
          member.id.type === 'Identifier' ? [{ identifier: member.id, namespaces: VALUE }] : [],
        ),
      ],
    ];
  }
  return [[node, signatureDeclarations(node)]];
};

/** Each declaration node gives: the scope node it declares in, and what it declares there. */
const declarationsOf = (parents: ReadonlyMap<Node, Node>, node: Node): ScopedDeclarations =>
  statementDeclarations(parents, node) ?? scopeDeclarations(parents, node);

const nameOnlyParents = new Set([
  'BreakStatement',
  'ContinueStatement',
  'ExportAllDeclaration',
  'ImportAttribute',
  'ImportDefaultSpecifier',
  'ImportNamespaceSpecifier',
  'ImportSpecifier',
  'LabeledStatement',
  'MetaProperty',
  'TSNamespaceExportDeclaration',
  'TSTypePredicate',
]);

const keyedMembers = new Set([
  'AccessorProperty',
  'MethodDefinition',
  'Property',
  'PropertyDefinition',
  'TSAbstractAccessorProperty',
  'TSAbstractMethodDefinition',
  'TSAbstractPropertyDefinition',
  'TSMethodSignature',
  'TSPropertySignature',
]);

/** A qualified name under the qualifier of `import('…').A.B` names members of that module. */
const isImportTypeQualifier = (parents: ReadonlyMap<Node, Node>, name: Node): boolean => {
  let child = name;
  for (const ancestor of ancestors(parents, name)) {
    if (ancestor.type === 'TSImportType') {
      return ancestor.qualifier === child;
    }
    if (ancestor.type !== 'TSQualifiedName') {
      return false;
    }
    child = ancestor;
  }
  return false;
};

/** An enum member, a member of an imported module type, a tuple label, or `const` of `as const`. */
const isTypeMemberName = (parent: Node, node: Node): boolean =>
  (parent.type === 'TSEnumMember' && parent.id === node) ||
  (parent.type === 'TSImportType' && parent.qualifier === node) ||
  (parent.type === 'TSNamedTupleMember' && parent.label === node) ||
  // `as const` parses as a reference to the type `const`, which no scope can declare.
  (parent.type === 'TSTypeReference' && node.type === 'Identifier' && node.name === 'const');

/** An identifier that names a property, a label, an import or export name or a member of a module, not a binding. */
const isNameOnly = (parents: ReadonlyMap<Node, Node>, node: Node): boolean => {
  const parent = parents.get(node);
  if (parent === undefined || nameOnlyParents.has(parent.type)) {
    return true;
  }
  if (keyedMembers.has(parent.type)) {
    return 'key' in parent && parent.key === node && 'computed' in parent && !parent.computed;
  }
  if (parent.type === 'MemberExpression') {
    return parent.property === node && !parent.computed;
  }
  if (parent.type === 'ExportSpecifier') {
    const statement = parents.get(parent);
    return parent.local !== node || (statement?.type === 'ExportNamedDeclaration' && statement.source !== null);
  }
  if (parent.type === 'TSQualifiedName') {
    return parent.right === node || isImportTypeQualifier(parents, parent);
  }
  return isTypeMemberName(parent, node);
};

/** An export of a name exports its value and its type. */
const exportsEveryMeaning = new Set(['ExportDefaultDeclaration', 'ExportSpecifier', 'TSExportAssignment']);

/** The namespace a reference looks its name up in. */
const lookupOf = (parents: ReadonlyMap<Node, Node>, identifier: Node): Lookup => {
  if (exportsEveryMeaning.has(parents.get(identifier)?.type ?? '')) {
    return 'namespace';
  }
  let qualified = false;
  let child = identifier;
  for (const ancestor of ancestors(parents, identifier)) {
    if (ancestor.type === 'TSQualifiedName') {
      qualified = true;
      child = ancestor;
      continue;
    }
    if (ancestor.type === 'TSTypeQuery' && ancestor.exprName === child) {
      return 'value';
    }
    if (ancestor.type === 'TSImportEqualsDeclaration') {
      return 'namespace';
    }
    if ((ancestor.type === 'TSPropertySignature' || ancestor.type === 'TSMethodSignature') && ancestor.key === child) {
      return 'value';
    }
    if (ancestor.type.startsWith('TS') && !runtimeTypeScript.has(ancestor.type)) {
      return qualified ? 'namespace' : 'type';
    }
    return 'value';
  }
  return 'value';
};

/** Whether a node stands in a type (an annotation, `typeof`, a type alias), where it composes no value. */
export const isInType = (bindings: ModuleBindings, node: Node): boolean =>
  [...ancestors(bindings.parents, node)].some(
    (ancestor) => ancestor.type.startsWith('TS') && !runtimeTypeScript.has(ancestor.type),
  );

const isIn = (lookup: Lookup, namespaces: readonly BindingNamespace[]): boolean =>
  lookup === 'namespace' || namespaces.includes(lookup);

const importedName = (specifier: Node): string => {
  if (specifier.type === 'ImportNamespaceSpecifier') {
    return '*';
  }
  if (specifier.type !== 'ImportSpecifier') {
    return 'default';
  }
  return specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
};

const moduleBinding = (
  parents: ReadonlyMap<Node, Node>,
  program: Program,
  declaration: ScopedDeclaration,
): ModuleBinding | undefined => {
  const { identifier } = declaration;
  if (identifier.type !== 'Identifier') {
    return undefined;
  }
  let statement: Node = identifier;
  for (const ancestor of ancestors(parents, identifier)) {
    if (ancestor === program) {
      break;
    }
    statement = ancestor;
  }
  const specifier = parents.get(identifier);
  const binding: ModuleBinding = { identifier, name: identifier.name, namespaces: declaration.namespaces, statement };
  return statement.type === 'ImportDeclaration' && specifier !== undefined
    ? { ...binding, imported: { name: importedName(specifier), source: statement.source.value } }
    : binding;
};

/** Whether a reference is written by an assignment, an update or the head of a `for … in` or `for … of` loop. */
const isAssignmentTarget = (parents: ReadonlyMap<Node, Node>, identifier: Node): boolean => {
  let child = identifier;
  for (const ancestor of ancestors(parents, identifier)) {
    if (
      ancestor.type === 'AssignmentExpression' ||
      ancestor.type === 'ForInStatement' ||
      ancestor.type === 'ForOfStatement'
    ) {
      return ancestor.left === child;
    }
    if (ancestor.type === 'UpdateExpression') {
      return true;
    }
    const inTarget =
      ancestor.type === 'ObjectPattern' ||
      ancestor.type === 'ArrayPattern' ||
      ancestor.type === 'RestElement' ||
      ancestor.type === 'ParenthesizedExpression' ||
      ancestor.type === 'TSAsExpression' ||
      ancestor.type === 'TSSatisfiesExpression' ||
      ancestor.type === 'TSNonNullExpression' ||
      ancestor.type === 'TSTypeAssertion' ||
      (ancestor.type === 'Property' && ancestor.value === child) ||
      (ancestor.type === 'AssignmentPattern' && ancestor.left === child);
    if (!inTarget) {
      return false;
    }
    child = ancestor;
  }
  return false;
};

/** Where and why a source does not parse; undefined for one that does. */
export const parseProblem = (
  file: string,
  source: string,
): { readonly message: string; readonly start: number } | undefined => {
  const [error] = parseSync(file, source, {
    astType: 'ts',
    lang: file.endsWith('x') ? 'tsx' : 'ts',
    sourceType: 'module',
  }).errors;
  return error === undefined ? undefined : { message: error.message, start: error.labels[0]?.start ?? 0 };
};

/** The walk under way: what it calls on each node, if any, and the nodes it is inside, innermost last. */
interface Walk {
  enter: ((node: Node, parent: Node) => void) | null;
  inside: Node[];
}

const walk: Walk = { enter: null, inside: [] };

/**
 * The one oxc-parser `Visitor` every walk goes through. Not one per walk: oxc-parser keeps every `Visitor` it builds in a
 * module-level cache, and with it every tree that visitor's functions close over.
 */
const walker = new Visitor(
  Object.fromEntries(
    Object.keys(visitorKeys).flatMap((type): readonly (readonly [string, (node: Node) => void])[] => [
      [
        type,
        (node) => {
          const parent = walk.inside.at(-1);
          if (parent !== undefined) {
            walk.enter?.(node, parent);
          }
          walk.inside.push(node);
        },
      ],
      [
        `${type}:exit`,
        () => {
          walk.inside.pop();
        },
      ],
    ]),
  ),
);

/** Calls `enter` on every node below `program` with its parent, before its children, in the order of the parser's visitor keys. */
export const forEachNode = (program: Program, enter: (node: Node, parent: Node) => void): void => {
  const outer = { ...walk };
  walk.enter = enter;
  walk.inside = [];
  walker.visit(program);
  walk.enter = outer.enter;
  walk.inside = outer.inside;
};

/** Parse source and resolve each of its references; undefined when it does not parse. */
export const moduleBindings = (file: string, source: string): ModuleBindings | undefined => {
  const parsed = parseSync(file, source, {
    astType: 'ts',
    lang: file.endsWith('x') ? 'tsx' : 'ts',
    sourceType: 'module',
  });
  if (parsed.errors.length > 0) {
    return undefined;
  }
  const { program } = parsed;
  const parents = new Map<Node, Node>();
  const nodes: Node[] = [];
  forEachNode(program, (node, parent) => {
    parents.set(node, parent);
    nodes.push(node);
  });
  const scopes = new Map<Node, ScopedDeclaration[]>();
  const declared = new Set<Node>();
  for (const node of nodes) {
    for (const [scope, declarations] of declarationsOf(parents, node)) {
      if (scope !== undefined && declarations.length > 0) {
        scopes.set(scope, [...(scopes.get(scope) ?? []), ...declarations]);
        for (const { identifier } of declarations) {
          declared.add(identifier);
        }
      }
    }
  }
  const bindings = (scopes.get(program) ?? []).flatMap(
    (declaration) => moduleBinding(parents, program, declaration) ?? [],
  );
  const local = new Map<Node, Node>();
  const references = nodes.flatMap((node): readonly ModuleReference[] => {
    if (node.type !== 'Identifier' || declared.has(node) || isNameOnly(parents, node)) {
      return [];
    }
    const lookup = lookupOf(parents, node);
    for (const ancestor of ancestors(parents, node)) {
      const declaration =
        ancestor === program
          ? undefined
          : scopes
              .get(ancestor)
              ?.find(
                ({ identifier, namespaces }) =>
                  identifier.type === 'Identifier' && identifier.name === node.name && isIn(lookup, namespaces),
              );
      if (declaration !== undefined) {
        local.set(node, declaration.identifier);
        return [];
      }
    }
    return [
      {
        bindings: bindings.filter((binding) => binding.name === node.name && isIn(lookup, binding.namespaces)),
        identifier: node,
        name: node.name,
      },
    ];
  });
  const assigned = new Set(
    references.flatMap((reference) =>
      isAssignmentTarget(parents, reference.identifier) ? reference.bindings.map((binding) => binding.identifier) : [],
    ),
  );
  for (const [identifier, declaration] of local) {
    if (isAssignmentTarget(parents, identifier)) {
      assigned.add(declaration);
    }
  }
  return {
    assigned,
    bindings,
    local,
    parents,
    program,
    referenceOf: new Map(references.map((reference) => [reference.identifier, reference])),
    references,
    source,
  };
};

/**
 * How a module graph names and reads modules. `target` gives the module a specifier of `importer` names
 * (`resolvedSpecifier`): a file of the workspace, the specifier itself for a library, and undefined for a workspace
 * specifier that names no file; `parsed` gives its bindings, `unparsable` when its source does not parse, and
 * undefined for a module the graph does not read (a library, a file outside the files the graph reads).
 */
export interface ModuleGraph {
  /**
   * Whether a file is a workspace library's (a package whose files the sources hold that is no module or contract
   * package): the follower goes through it as through any file it reads, and what it ends on there is a library value.
   */
  readonly library: (file: string) => boolean;
  readonly parsed: (target: string) => ModuleBindings | 'unparsable' | undefined;
  readonly target: (importer: string, specifier: string) => string | undefined;
}

/** A module graph over the sources `source` gives, each parsed once. */
export const moduleGraph = (
  target: (importer: string, specifier: string) => string | undefined,
  source: (target: string) => string | undefined,
  library: (file: string) => boolean,
): ModuleGraph => {
  const cache = new Map<string, ModuleBindings | undefined>();
  return {
    library,
    parsed: (file) => {
      const text = source(file);
      if (text !== undefined && !cache.has(file)) {
        cache.set(file, moduleBindings(file, text));
      }
      return text === undefined ? text : (cache.get(file) ?? 'unparsable');
    },
    target,
  };
};

/** What a package manifest's `exports` holds: a path, a list of fallbacks, a map of subpaths or conditions, or none. */
type PackageExports = string | null | readonly PackageExports[] | { readonly [key: string]: PackageExports };

/** An `exports` value as a manifest writes it. */
export const PackageExportsSchema: Schema.Codec<PackageExports> = Schema.Union([
  Schema.String,
  Schema.Null,
  Schema.Array(Schema.suspend((): Schema.Codec<PackageExports> => PackageExportsSchema)),
  Schema.Record(
    Schema.String,
    Schema.suspend((): Schema.Codec<PackageExports> => PackageExportsSchema),
  ),
]);

/** A package of the workspace as the resolver reads its manifest: its directory and its `exports`, if any. */
export interface WorkspacePackage {
  readonly dir: string;
  readonly exports: PackageExports | undefined;
  /**
   * Whether the graph reads its files (a module or a contract package whose files the sources hold), so a specifier
   * naming one must name a file that exists; one of another package names what its `exports` publishes, which the
   * graph never follows.
   */
  readonly read: boolean;
}

/** The scope of the workspace's packages: a specifier in it names a file of the workspace, never a library. */
const WORKSPACE_SCOPE = '@app/';

/** What TypeScript's `Bundler` resolution tries for a path with a JavaScript extension, in its order. */
const SUBSTITUTED_EXTENSIONS = new Map([
  ['.cjs', ['.cts', '.d.cts', '.cjs']],
  ['.js', ['.ts', '.tsx', '.d.ts', '.js', '.jsx']],
  ['.jsx', ['.tsx', '.d.ts', '.jsx']],
  ['.mjs', ['.mts', '.d.mts', '.mjs']],
]);

/** A JavaScript or TypeScript file: source, which the rules parse and read; any other module (JSON, a stylesheet) is data. */
export const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;

/** What it appends to a path without one, and to the index of a directory. */
const IMPLIED_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx'];

/** The files a path may name under `Bundler` resolution, in its order. */
const bundlerCandidates = (target: string): readonly string[] => {
  const extension = nodePath.posix.extname(target);
  const substituted = SUBSTITUTED_EXTENSIONS.get(extension);
  if (substituted !== undefined) {
    const bare = target.slice(0, -extension.length);
    return substituted.map((replacement) => `${bare}${replacement}`);
  }
  return [
    target,
    ...IMPLIED_EXTENSIONS.map((implied) => `${target}${implied}`),
    ...IMPLIED_EXTENSIONS.map((implied) => `${target}/index${implied}`),
  ];
};

/** The conditions `Bundler` resolution matches in an `exports` map: a type import. */
const EXPORT_CONDITIONS = new Set(['default', 'import', 'types']);

/** The path an `exports` entry publishes: a path, the first fallback that gives one, or the first condition it matches. */
const exportedPath = (entry: PackageExports | undefined): string | undefined => {
  if (entry === undefined || entry === null) {
    return undefined;
  }
  if (Predicate.isString(entry)) {
    return entry;
  }
  if (Array.isArray(entry)) {
    return entry.map(exportedPath).find((path) => path !== undefined);
  }
  const matched = Object.entries(entry).find(([condition]) => EXPORT_CONDITIONS.has(condition));
  return matched === undefined ? undefined : exportedPath(matched[1]);
};

interface PatternMatch {
  readonly head: string;
  readonly tail: string;
}

/** The head and tail around the one `*` of an `exports` key that matches `subpath`; undefined when it does not. */
const patternMatch = (key: string, subpath: string): PatternMatch | undefined => {
  const [head, tail, ...more] = key.split('*');
  return head !== undefined &&
    tail !== undefined &&
    more.length === 0 &&
    subpath.length >= head.length + tail.length &&
    subpath.startsWith(head) &&
    subpath.endsWith(tail)
    ? { head, tail }
    : undefined;
};

/** The entry an `exports` map publishes for a subpath (`.`, `./x`), exactly or through one `*` pattern. */
const subpathEntry = (exports: PackageExports, subpath: string): PackageExports | undefined => {
  const entries =
    exports === null || Predicate.isString(exports) || Array.isArray(exports) ? [] : Object.entries(exports);
  if (!entries.some(([key]) => key.startsWith('.'))) {
    // A path, a list of fallbacks or a map of conditions publishes the package itself.
    return subpath === '.' ? exports : undefined;
  }
  const exact = entries.find(([key]) => key === subpath);
  if (exact !== undefined) {
    return exact[1];
  }
  let best: (PatternMatch & { readonly entry: PackageExports; readonly key: string }) | undefined;
  for (const [key, entry] of entries) {
    const match = patternMatch(key, subpath);
    // The most specific pattern, as Node and TypeScript take it: the longest head before `*`, then the longest key.
    if (
      match !== undefined &&
      (best === undefined ||
        match.head.length > best.head.length ||
        (match.head.length === best.head.length && key.length > best.key.length))
    ) {
      best = { ...match, entry, key };
    }
  }
  const published = best === undefined ? undefined : exportedPath(best.entry);
  if (best !== undefined && published !== undefined) {
    return published.replaceAll('*', subpath.slice(best.head.length, subpath.length - best.tail.length));
  }
  return undefined;
};

/**
 * The one resolution of a module specifier, for the rules and the retirement planner alike, as TypeScript's `Bundler`
 * resolution resolves it: a relative or absolute path, with the extension substitutions (`.js` to `.ts`, …), no
 * extension, or the index of a directory (`bundlerCandidates`); a package of the workspace scope, through its
 * `exports` map (a subpath without an entry names nothing), or as a path inside it when it has none. Gives the file
 * that exists, undefined for a workspace specifier that names none, and the specifier itself for a library.
 */
export const resolvedSpecifier = (
  exists: (file: string) => boolean,
  packages: ReadonlyMap<string, WorkspacePackage>,
): ((importer: string, specifier: string) => string | undefined) => {
  const existing = (path: string): string | undefined => bundlerCandidates(nodePath.posix.normalize(path)).find(exists);
  return (importer, specifier) => {
    if (specifier.startsWith('/')) {
      return existing(specifier);
    }
    if (specifier.startsWith('.')) {
      return existing(nodePath.posix.join(nodePath.posix.dirname(importer), specifier));
    }
    if (!specifier.startsWith(WORKSPACE_SCOPE)) {
      return specifier;
    }
    const [scope, name, ...rest] = specifier.split('/');
    const found = packages.get(`${scope}/${name}`);
    const subpath = rest.length === 0 ? '.' : `./${rest.join('/')}`;
    const published = found?.exports === undefined ? subpath : exportedPath(subpathEntry(found.exports, subpath));
    const target =
      found === undefined || published === undefined ? undefined : nodePath.posix.join(found.dir, published);
    // A package the graph reads names a file that exists; another one names what it publishes.
    const named = found?.read === false ? nodePath.posix.normalize : existing;
    return target === undefined ? undefined : named(target);
  };
};

/** An origin that is a declaration of a module the graph reads, one that is not only another name for a binding. */
export interface DeclaredExport {
  readonly bindings: ModuleBindings;
  readonly file: string;
  readonly kind: 'declared';
  /** The declared identifier, or the expression of an `export default` or `export =`. */
  readonly node: Node;
  /** Every file the binding passes through, the one asked about first, `file` last. */
  readonly trail: readonly string[];
}

/** An origin in a module the graph does not read: `name` of it, or `*` for the whole module; or a global (`GLOBAL`). */
interface ForeignExport {
  readonly kind: 'foreign';
  readonly name: string;
  /** The specifier of the last link, as written. */
  readonly specifier: string;
  /** Whether the name is only taken to come through an `export *` of the module, since nothing read exports it. */
  readonly star: boolean;
  readonly target: string;
  readonly trail: readonly string[];
}

/** A whole module the graph reads, used as a whole rather than by a member. */
interface NamespaceExport {
  readonly file: string;
  readonly kind: 'namespace';
  readonly trail: readonly string[];
}

/** A link that cannot be followed: a file that does not parse or exports no such name, a name no scope declares. */
interface UnresolvedExport {
  readonly file: string;
  readonly kind: 'unresolved';
  readonly reason: string;
  readonly trail: readonly string[];
}

export type ExportOrigin = DeclaredExport | ForeignExport | NamespaceExport | UnresolvedExport;

interface ExportStep {
  readonly bindings: ModuleBindings;
  readonly file: string;
  readonly trail: readonly string[];
}

/**
 * What every link still owes: the members to take from what it resolves to (`Read.X` resolves `Read`, then takes
 * `X`), and the declaration that wrote the member access, which is where a member of a declared value ends.
 */
interface Pending {
  readonly holder?: DeclaredExport;
  readonly member: readonly string[];
}

/** A link still to follow: what a binding is, what a reference resolves to, or what a file exports as a name. */
interface BindingLink extends Pending {
  readonly binding: ModuleBinding;
  readonly kind: 'binding';
  readonly step: ExportStep;
}

interface ReferenceLink extends Pending {
  readonly identifier: Node;
  readonly kind: 'reference';
  readonly step: ExportStep;
}

interface NameLink extends Pending {
  readonly file: string;
  readonly kind: 'name';
  readonly name: string;
  /** Whether an `export *` leads here, so a file without the name is no failure of its own. */
  readonly star: boolean;
  /** The files passed through before `file`. */
  readonly trail: readonly string[];
}

type ExportLink = BindingLink | NameLink | ReferenceLink;

/** What an expansion yields: an origin, or a link to follow, with the members it owes of its own (`own`). */
type Expansion = ExportOrigin | ExportLink;

const NO_MEMBER: Pending = { member: [] };

/** The target of a global: what no module declares. */
const GLOBAL = 'globalThis';

/** The text a node writes statically: a literal, or a template literal without interpolation. */
const staticText = (written: Node): string | undefined => {
  if (written.type === 'Literal') {
    return String(written.value);
  }
  return written.type === 'TemplateLiteral' && written.expressions.length === 0
    ? (written.quasis[0]?.value.cooked ?? undefined)
    : undefined;
};

/** A member written so that it cannot be read statically: `Read[key]`, `const { [key]: B } = Read`. */
const UNREAD_MEMBER = '[computed]';

/**
 * The member a key or a member access names: a name, or what a literal or a template literal without interpolation
 * writes, computed or not (`Read.X`, `Read['X']`, `{ 'X': B }`, `{ [\`X\`]: B }`); `UNREAD_MEMBER` for anything else.
 */
const memberName = (key: Node, computed: boolean): string => {
  if (!computed && key.type === 'Identifier') {
    return key.name;
  }
  return staticText(key) ?? UNREAD_MEMBER;
};

/** Node's module loader: what it exports makes loaders whose targets no static rule reads. */
const NODE_MODULE = new Set(['module', 'node:module']);

/** What one wrapper but `await` wraps: parentheses (of a value or a type), an optional chain, `as`, `satisfies`, `!`, `<T>x`, `typeof`, a type reference without type arguments. */
const strippedOnce = (node: Node): Node | undefined => {
  if (
    node.type === 'ParenthesizedExpression' ||
    node.type === 'ChainExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSTypeAssertion'
  ) {
    return node.expression;
  }
  if (node.type === 'TSParenthesizedType') {
    return node.typeAnnotation;
  }
  if (node.type === 'TSTypeQuery') {
    return node.typeArguments === null ? node.exprName : undefined;
  }
  return node.type === 'TSTypeReference' && node.typeArguments === null ? node.typeName : undefined;
};

const strippedAll = (node: Node): Node => {
  let inner = node;
  for (let next = strippedOnce(inner); next !== undefined; next = strippedOnce(inner)) {
    inner = next;
  }
  return inner;
};

/** Whether a reference is the global `name`: a name no scope of the file declares. */
const isGlobal = (bindings: ModuleBindings, node: Node, name: string): boolean =>
  node.type === 'Identifier' && node.name === name && bindings.referenceOf.get(node)?.bindings.length === 0;

/**
 * Whether a callee, under the wrappers, is a loader a readable load may call: the global `require`, or
 * `process.getBuiltinModule`, a member taken by its name.
 */
const isLoaderCallee = (bindings: ModuleBindings, callee: Node): boolean =>
  isGlobal(bindings, callee, 'require') ||
  (callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'getBuiltinModule' &&
    isGlobal(bindings, strippedAll(callee.object), 'process'));

/**
 * Whether a node is a load: an `import()`, or a call whose callee, under the wrappers, is the global `require` or
 * `process.getBuiltinModule`.
 */
const isLoad = (bindings: ModuleBindings, node: Node): boolean =>
  node.type === 'ImportExpression' ||
  (node.type === 'CallExpression' && isLoaderCallee(bindings, strippedAll(node.callee)));

/**
 * What one wrapper wraps, the one list every rule reads names, member chains and loads through: `strippedOnce`, and
 * `await` of a load.
 */
const wraps = (bindings: ModuleBindings, node: Node): Node | undefined =>
  strippedOnce(node) ??
  (node.type === 'AwaitExpression' && isLoad(bindings, strippedAll(node.argument)) ? node.argument : undefined);

/** A node with every wrapper around it taken off. */
const unwrapped = (bindings: ModuleBindings, node: Node): Node => {
  let inner = node;
  for (let next = wraps(bindings, inner); next !== undefined; next = wraps(bindings, inner)) {
    inner = next;
  }
  return inner;
};

/** The outermost node that only wraps a node: where what it stands for is used. */
const wrapperOf = (bindings: ModuleBindings, node: Node): Node => {
  let outer = node;
  for (let parent = bindings.parents.get(outer); parent !== undefined && wraps(bindings, parent) === outer;) {
    outer = parent;
    parent = bindings.parents.get(outer);
  }
  return outer;
};

/** The member a member access takes, by name or by a literal (`a.b`, `a['b']`); undefined for one no literal names. */
export const accessedMember = (access: Node & { readonly type: 'MemberExpression' }): string | undefined => {
  const member = memberName(access.property, access.computed);
  return member === UNREAD_MEMBER ? undefined : member;
};

/**
 * The member a call takes of what its callee is called on, under the wrappers (`wraps`), by name or by a literal
 * (`a.b(…)`, `a['b'](…)`, `a.b!(…)`, `(a.b)(…)`), and the node that names it; undefined for a callee that takes
 * no member or one no literal names, and for anything but a call.
 */
export const calleeMember = (
  bindings: ModuleBindings,
  call: Node,
): { readonly name: string; readonly property: Node } | undefined => {
  if (call.type !== 'CallExpression') {
    return undefined;
  }
  const callee = unwrapped(bindings, call.callee);
  const name = callee.type === 'MemberExpression' ? accessedMember(callee) : undefined;
  return name === undefined || callee.type !== 'MemberExpression' ? undefined : { name, property: callee.property };
};

/**
 * The module a load names when it is readable: `import(<literal>)`, `require(<literal>)`,
 * `process.getBuiltinModule(<literal>)` or `import x = require(<literal>)`, with that one argument and no other, the
 * literal a string or a template without interpolation; undefined for any other load, and for Node's module loader,
 * whose loaders no static rule reads.
 */
const loadSpecifier = (load: Node): string | undefined => {
  let written: Node | undefined;
  if (load.type === 'ImportExpression') {
    written = load.options === null ? load.source : undefined;
  } else if (load.type === 'TSExternalModuleReference') {
    written = load.expression;
  } else if (load.type === 'CallExpression' && load.arguments.length === 1) {
    [written] = load.arguments;
  }
  const text =
    written === undefined ||
    written.type === 'SpreadElement' ||
    (written.type === 'Literal' && !Predicate.isString(written.value))
      ? undefined
      : staticText(written);
  return text === undefined || NODE_MODULE.has(text) ? undefined : text;
};

/**
 * The globals that hold loaders: Node's `require`, `module` (`module.require`, `module.parent`) and `process`
 * (`process.getBuiltinModule`, `process.mainModule`), the global objects they are reached through, and
 * `import.meta` (`import.meta.resolve`, a bundler's `import.meta.webpackContext`). Each is judged where it appears,
 * never by what it is taken for.
 */
const LOADER_GLOBALS = new Set(['global', 'globalThis', 'module', 'process', 'require']);

/**
 * The members of a loader global a source may take directly, by name, none of them a loader: the ones code these
 * rules read uses on the tree at 1f3972b779, measured over what the seam follows in every module (`globalThis.crypto`)
 * and every source the retirement planner reads for some read of its module (the rest, all in tests).
 */
const LOADER_GLOBAL_MEMBERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['globalThis', new Set(['Headers', 'crypto', 'fetch', 'location'])],
  ['import.meta', new Set(['url'])],
  ['process', new Set(['argv', 'cwd', 'execPath', 'exitCode', 'kill', 'pid', 'stderr', 'stdin', 'stdout'])],
]);

/** The loader global a node is, by its name (a name no scope declares) or as the `import.meta` meta-property. */
const loaderGlobal = (bindings: ModuleBindings, node: Node): string | undefined => {
  if (node.type === 'MetaProperty') {
    return node.meta.name === 'import' ? 'import.meta' : undefined;
  }
  return node.type === 'Identifier' && LOADER_GLOBALS.has(node.name) && isGlobal(bindings, node, node.name)
    ? node.name
    : undefined;
};

/**
 * Whether one appearance of a loader global is read: the callee of a load (`require(…)`, which is judged as the
 * load it is), `process.getBuiltinModule` called (a load, judged as one), or a member on `LOADER_GLOBAL_MEMBERS`
 * taken directly by its name. Any other appearance, an alias, a destructuring, an argument, a member no literal or
 * list names, may reach a loader.
 */
const isReadLoaderGlobal = (bindings: ModuleBindings, node: Node, global: string): boolean => {
  const outer = wrapperOf(bindings, node);
  const parent = bindings.parents.get(outer);
  if (global === 'require') {
    return parent?.type === 'CallExpression' && parent.callee === outer;
  }
  // A member by its name: `process.argv`, or the type name `typeof globalThis.fetch`.
  let member: string | undefined;
  if (parent?.type === 'MemberExpression' && parent.object === outer && !parent.computed) {
    member = parent.property.type === 'Identifier' ? parent.property.name : undefined;
  } else if (parent?.type === 'TSQualifiedName' && parent.left === outer) {
    member = parent.right.type === 'Identifier' ? parent.right.name : undefined;
  }
  if (parent !== undefined && global === 'process' && member === 'getBuiltinModule') {
    const call = wrapperOf(bindings, parent);
    const caller = bindings.parents.get(call);
    return caller?.type === 'CallExpression' && caller.callee === call;
  }
  return member !== undefined && LOADER_GLOBAL_MEMBERS.get(global)?.has(member) === true;
};

/** Whether a node is one appearance of a load no static rule reads (`unreadableLoads`). */
const isUnreadableLoad = (bindings: ModuleBindings, node: Node): boolean => {
  if (isLoad(bindings, node) || node.type === 'TSExternalModuleReference') {
    return loadSpecifier(node) === undefined;
  }
  const global = loaderGlobal(bindings, node);
  if (global !== undefined) {
    return !isReadLoaderGlobal(bindings, node, global);
  }
  return (
    (node.type === 'ImportDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'TSImportType') &&
    node.source !== null &&
    NODE_MODULE.has(node.source.value)
  );
};

const unreadable = new WeakMap<ModuleBindings, readonly Node[]>();

/**
 * Every appearance of a load in a source that no static rule reads, the one definition every rule and the retirement
 * planner use: a load that is not readable (`loadSpecifier`: no literal, a literal that is no string, a second
 * argument, Node's module loader); any appearance of a loader global (`LOADER_GLOBALS`, `import.meta`) other than
 * one `isReadLoaderGlobal` reads (`const load = require`, `require.resolve`, `const { require: load } = module`,
 * `module.parent.require`, `process.mainModule`, `import.meta.resolve`); and any import, re-export, import type or
 * load of Node's module loader (`createRequire`).
 */
export const unreadableLoads = (bindings: ModuleBindings): readonly Node[] => {
  const known = unreadable.get(bindings);
  if (known !== undefined) {
    return known;
  }
  const found = [...bindings.parents.keys()].filter((node) => isUnreadableLoad(bindings, node));
  unreadable.set(bindings, found);
  return found;
};

const readable = new WeakMap<ModuleBindings, readonly Node[]>();

/** Every readable load of a source: an `import()` or a `require()` of a module a literal names. */
export const readableLoads = (bindings: ModuleBindings): readonly Node[] => {
  const known = readable.get(bindings);
  if (known !== undefined) {
    return known;
  }
  const found = [...bindings.parents.keys()].filter(
    (node) => isLoad(bindings, node) && loadSpecifier(node) !== undefined,
  );
  readable.set(bindings, found);
  return found;
};

/** Where a source holds a load no static rule reads, as `line N`; undefined for a source that holds none. */
export const unreadableLoadLine = (bindings: ModuleBindings): string | undefined => {
  const [first] = unreadableLoads(bindings);
  return first === undefined ? undefined : `line ${lineOf(bindings.source, first.start)}`;
};

const specifierName = (node: Node): string => {
  if (node.type === 'Identifier') {
    return node.name;
  }
  return node.type === 'Literal' ? String(node.value) : '';
};

/** The identifiers a top-level declaration declares. */
const declaredIdentifiers = (declaration: Node | null): readonly Node[] => {
  if (declaration?.type === 'VariableDeclaration') {
    return declaration.declarations.flatMap((declarator) => patternIdentifiers(declarator.id));
  }
  return declaration !== null && 'id' in declaration && declaration.id?.type === 'Identifier' ? [declaration.id] : [];
};

/** A workspace specifier that names no file: nothing can be read of it. */
const unresolvedSpecifier = (step: ExportStep, specifier: string): ExportOrigin => ({
  file: step.file,
  kind: 'unresolved',
  reason: `names ${specifier}, which is no file of the workspace`,
  trail: step.trail,
});

/** A whole module: a namespace of a module the graph reads, else a foreign export of `*`. */
const wholeModule = (graph: ModuleGraph, step: ExportStep, specifier: string): ExportOrigin => {
  if (NODE_MODULE.has(specifier)) {
    return {
      file: step.file,
      kind: 'unresolved',
      reason: `takes Node's module loader ${specifier}`,
      trail: step.trail,
    };
  }
  const target = graph.target(step.file, specifier);
  if (target === undefined) {
    return unresolvedSpecifier(step, specifier);
  }
  return graph.parsed(target) === undefined
    ? { kind: 'foreign', name: '*', specifier, star: false, target, trail: step.trail }
    : { file: target, kind: 'namespace', trail: [...step.trail, target] };
};

/** `name` of the module `specifier` names: followed in a module the graph reads, else foreign. */
const namedIn = (graph: ModuleGraph, step: ExportStep, specifier: string, name: string): Expansion => {
  if (NODE_MODULE.has(specifier)) {
    return {
      file: step.file,
      kind: 'unresolved',
      reason: `takes Node's module loader ${specifier}`,
      trail: step.trail,
    };
  }
  const target = graph.target(step.file, specifier);
  if (target === undefined) {
    return unresolvedSpecifier(step, specifier);
  }
  return graph.parsed(target) === undefined
    ? { kind: 'foreign', name, specifier, star: false, target, trail: step.trail }
    : { ...NO_MEMBER, file: target, kind: 'name', name, star: false, trail: step.trail };
};

/**
 * `A`, `A.B`, `A['B']`, `(await import('…')).B`, `(typeof A)['B']`, `import('…').B` (as an expression, a qualified
 * type name or an indexed type), under the wrappers at every level: the root, a name, a load or an import type, and
 * the members after it.
 */
const memberPath = (bindings: ModuleBindings, written: Node): readonly [Node, readonly string[]] | undefined => {
  const node = unwrapped(bindings, written);
  if (
    isLoad(bindings, node) ||
    node.type === 'Identifier' ||
    (node.type === 'TSImportType' && node.typeArguments === null)
  ) {
    return [node, []];
  }
  let object: Node;
  let member: string;
  if (node.type === 'TSQualifiedName') {
    object = node.left;
    member = memberName(node.right, false);
  } else if (node.type === 'MemberExpression') {
    ({ object } = node);
    member = memberName(node.property, node.computed);
  } else if (node.type === 'TSIndexedAccessType') {
    // `(typeof Read)['A']` is the type of `Read.A`.
    object = node.objectType;
    member = node.indexType.type === 'TSLiteralType' ? memberName(node.indexType.literal, true) : UNREAD_MEMBER;
  } else {
    return undefined;
  }
  const inner = memberPath(bindings, object);
  return inner === undefined ? undefined : [inner[0], [...inner[1], member]];
};

/** An expansion with the members the link it came from still owes, after its own; an origin takes them. */
const owedBy = (item: Expansion, owed: Pending): Expansion => {
  if (item.kind === 'binding' || item.kind === 'name' || item.kind === 'reference') {
    return { ...item, holder: item.holder ?? owed.holder, member: [...item.member, ...owed.member] };
  }
  const [first, ...rest] = owed.member;
  if (first === undefined) {
    return item;
  }
  if (item.kind === 'namespace') {
    if (first === UNREAD_MEMBER) {
      return {
        file: item.file,
        kind: 'unresolved',
        reason: 'is taken a member that cannot be read statically',
        trail: item.trail,
      };
    }
    return {
      file: item.file,
      holder: owed.holder,
      kind: 'name',
      member: rest,
      name: first,
      star: false,
      trail: item.trail.slice(0, -1),
    };
  }
  if (item.kind === 'foreign') {
    // A whole module, of a library or the workspace, taken a member no literal names, may give any of its exports.
    if (item.name === '*' && first === UNREAD_MEMBER) {
      return {
        file: item.target,
        kind: 'unresolved',
        reason: 'is taken a member that cannot be read statically',
        trail: item.trail,
      };
    }
    return { ...item, name: [...(item.name === '*' ? [] : [item.name]), ...owed.member].join('.') };
  }
  // A member of a declared value is no other name for anything: the declaration that takes it is where it ends.
  return item.kind === 'declared' && owed.holder !== undefined ? owed.holder : item;
};

/** A destructuring with a default on the way to a binding. */
const UNREAD_DESTRUCTURING = 'unread destructuring';

interface Written {
  /** The members a destructuring takes of what is written: `A` of `const { A: B } = Read`. */
  readonly taken: readonly string[];
  readonly written: Node;
}

/**
 * The object pattern a destructured identifier stands in, and the member it takes there; none for an array pattern.
 * A default (`{ A: B = d }`) cannot be read: what it holds depends on whether the member is there, not on its name
 * (`UNREAD_DESTRUCTURING`). An object rest holds some of the members of what is written and nothing else, so it is
 * taken for the whole (measured: one in code the rules read, `verticals/tax/shared/actions/order-tax-finalization.ts`).
 */
const destructuredStep = (
  bindings: ModuleBindings,
  node: Node,
): { readonly member?: string; readonly pattern: Node } | typeof UNREAD_DESTRUCTURING | undefined => {
  const parent = bindings.parents.get(node);
  if (parent?.type === 'AssignmentPattern' && parent.left === node) {
    return UNREAD_DESTRUCTURING;
  }
  const pattern = parent === undefined ? undefined : bindings.parents.get(parent);
  if (pattern?.type !== 'ObjectPattern') {
    return undefined;
  }
  if (parent?.type === 'Property' && parent.value === node) {
    return { member: memberName(parent.key, parent.computed), pattern };
  }
  return parent?.type === 'RestElement' ? { pattern } : undefined;
};

/** What the declaration of `identifier` writes for it: an initializer, a type, an import reference. */
const writtenFor = (bindings: ModuleBindings, identifier: Node): Written | typeof UNREAD_DESTRUCTURING | undefined => {
  const taken: string[] = [];
  let node = identifier;
  for (let step = destructuredStep(bindings, node); step !== undefined; step = destructuredStep(bindings, node)) {
    if (step === UNREAD_DESTRUCTURING) {
      return step;
    }
    if (step.member !== undefined) {
      taken.unshift(step.member);
    }
    node = step.pattern;
  }
  const parent = bindings.parents.get(node);
  if (parent?.type === 'VariableDeclarator') {
    return parent.id === node && parent.init !== null ? { taken, written: parent.init } : undefined;
  }
  // An alias's own type parameters make it no new type: `type B<_T = unknown> = A` is still `A`.
  if (parent?.type === 'TSTypeAliasDeclaration') {
    return { taken, written: parent.typeAnnotation };
  }
  return parent?.type === 'TSImportEqualsDeclaration' ? { taken, written: parent.moduleReference } : undefined;
};

/** `import('…')` and `import('…').A.B` as a type, its type arguments aside: the whole module, or a name of it with the members after it. */
const importTypeLinks = (
  graph: ModuleGraph,
  step: ExportStep,
  node: Node & { readonly type: 'TSImportType' },
  owed: Pending,
): readonly Expansion[] | undefined => {
  if (node.qualifier === null) {
    return [owedBy(wholeModule(graph, step, node.source.value), owed)];
  }
  const qualified = memberPath(step.bindings, node.qualifier);
  return qualified === undefined
    ? undefined
    : [
        owedBy(namedIn(graph, step, node.source.value, specifierName(qualified[0])), {
          holder: owed.holder,
          member: [...qualified[1], ...owed.member],
        }),
      ];
};

/** What a member path is from its root: what a name refers to, or the module a load names, statically or not at all. */
const rootLinks = (graph: ModuleGraph, step: ExportStep, root: Node, owed: Pending): readonly Expansion[] => {
  if (root.type === 'Identifier') {
    return [{ ...owed, identifier: root, kind: 'reference', step }];
  }
  if (root.type === 'TSImportType') {
    return (
      importTypeLinks(graph, step, root, owed) ?? [
        {
          file: step.file,
          kind: 'unresolved',
          reason: 'names a member of an import type it cannot read',
          trail: step.trail,
        },
      ]
    );
  }
  const specifier = loadSpecifier(root);
  return specifier === undefined
    ? [
        {
          file: step.file,
          kind: 'unresolved',
          reason: `loads a module it does not read statically at line ${lineOf(step.bindings.source, root.start)}`,
          trail: step.trail,
        },
      ]
    : [owedBy(wholeModule(graph, step, specifier), owed)];
};

/**
 * What a declaration is only another name for, when it is one (`OWNER_ENTRY_READ_FORMS` states the boundary): `const B =
 * A`, `const B = Read.A`, `const B = Read['A']`, `const { A: B } = Read`, `const { 'A': B } = Read`,
 * `const B = (await import('…')).A`, `const B = require('…').A`, `type B = A`, `type B<_T = unknown> = A`, `type B =
 * typeof Read.A`, `type B = import('…').A`, `import B = Read.A`, `import B = require('…')`, each through the wrappers
 * at every level (`wraps`) and a type annotation. Anything else, a call, an object, array or struct it builds, an array
 * pattern, an operator, type arguments, is a declaration of its own. A `let`, a `var` or a binding written again
 * (`rebinding`), a destructuring default (`UNREAD_DESTRUCTURING`), a member no literal names
 * (`UNREAD_MEMBER`) taken of a whole module, a load that is not readable (`loadSpecifier`), and a loader global
 * used other than as `isReadLoaderGlobal` reads it cannot be followed.
 */
const aliasLinks = (
  graph: ModuleGraph,
  step: ExportStep,
  binding: ModuleBinding,
  declared: DeclaredExport,
): readonly Expansion[] | undefined => {
  const found = writtenFor(step.bindings, binding.identifier);
  if (found === UNREAD_DESTRUCTURING) {
    return [
      {
        file: step.file,
        kind: 'unresolved',
        reason: `${binding.name} is destructured with a default, so what it holds cannot be read`,
        trail: step.trail,
      },
    ];
  }
  const taken = found?.taken ?? [];
  const inner = found === undefined ? undefined : unwrapped(step.bindings, found.written);
  if (inner?.type === 'TSExternalModuleReference') {
    return rootLinks(graph, step, inner, { holder: declared, member: taken });
  }
  const path = inner === undefined ? undefined : memberPath(step.bindings, inner);
  return path === undefined
    ? undefined
    : rootLinks(graph, step, path[0], { holder: declared, member: [...path[1], ...taken] });
};

const destructuringParts = new Set(['ArrayPattern', 'AssignmentPattern', 'ObjectPattern', 'Property', 'RestElement']);

/**
 * Why what an identifier declares cannot be read from its declaration alone: it is declared with `let` or `var`, or
 * an assignment or update writes it again; undefined for a binding that holds only what its declaration gives it.
 */
export const rebinding = (bindings: ModuleBindings, identifier: Node): string | undefined => {
  const name = specifierName(identifier);
  if (bindings.assigned.has(identifier)) {
    return `${name} is assigned after its declaration, so what it holds cannot be read from it`;
  }
  for (const ancestor of ancestors(bindings.parents, identifier)) {
    if (ancestor.type === 'VariableDeclaration') {
      return ancestor.kind === 'let' || ancestor.kind === 'var'
        ? `${name} is declared with ${ancestor.kind}, so what it holds cannot be read from its declaration`
        : undefined;
    }
    if (ancestor.type !== 'VariableDeclarator' && !destructuringParts.has(ancestor.type)) {
      return undefined;
    }
  }
  return undefined;
};

/** A binding, followed while it is only another name: an import, an alias. */
const bindingLinks = (graph: ModuleGraph, { binding, step }: BindingLink): readonly Expansion[] => {
  const { imported } = binding;
  if (imported !== undefined) {
    return [
      imported.name === '*'
        ? wholeModule(graph, step, imported.source)
        : namedIn(graph, step, imported.source, imported.name),
    ];
  }
  const changing = rebinding(step.bindings, binding.identifier);
  if (changing !== undefined) {
    return [{ file: step.file, kind: 'unresolved', reason: changing, trail: step.trail }];
  }
  const declared: DeclaredExport = {
    bindings: step.bindings,
    file: step.file,
    kind: 'declared',
    node: binding.identifier,
    trail: step.trail,
  };
  return aliasLinks(graph, step, binding, declared) ?? [declared];
};

/** A reference: the module bindings it names, a global (`String`, `globalThis`) no scope of the file declares. */
const referenceLinks = ({ identifier, step }: ReferenceLink): readonly Expansion[] => {
  const reference = step.bindings.referenceOf.get(identifier);
  if (reference === undefined) {
    return [
      {
        file: step.file,
        kind: 'unresolved',
        reason: `${specifierName(identifier)} is no reference to a module binding`,
        trail: step.trail,
      },
    ];
  }
  if (isUnreadableLoad(step.bindings, identifier)) {
    return [
      {
        file: step.file,
        kind: 'unresolved',
        reason: `uses the global ${reference.name} other than to load a module a literal names, at line ${lineOf(step.bindings.source, identifier.start)}`,
        trail: step.trail,
      },
    ];
  }
  return reference.bindings.length === 0
    ? [{ kind: 'foreign', name: reference.name, specifier: '', star: false, target: GLOBAL, trail: step.trail }]
    : reference.bindings.map((binding) => ({ ...NO_MEMBER, binding, kind: 'binding', step }));
};

/** What one statement exports as `name`. */
const statementLinks = (graph: ModuleGraph, step: ExportStep, statement: Node, name: string): readonly Expansion[] => {
  if (statement.type === 'ExportNamedDeclaration') {
    const { source } = statement;
    const passed = statement.specifiers.flatMap((specifier): readonly Expansion[] => {
      if (specifierName(specifier.exported) !== name) {
        return [];
      }
      return source === null
        ? [{ ...NO_MEMBER, identifier: specifier.local, kind: 'reference', step }]
        : [namedIn(graph, step, source.value, specifierName(specifier.local))];
    });
    const declared = declaredIdentifiers(statement.declaration).flatMap((identifier) =>
      specifierName(identifier) === name
        ? step.bindings.bindings.filter((binding) => binding.identifier === identifier)
        : [],
    );
    return [...passed, ...declared.map((binding): Expansion => ({ ...NO_MEMBER, binding, kind: 'binding', step }))];
  }
  if (
    (statement.type === 'ExportDefaultDeclaration' || statement.type === 'TSExportAssignment') &&
    name === 'default'
  ) {
    const exported = statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement.expression;
    const declared = declaredIdentifiers(exported).flatMap((identifier) =>
      step.bindings.bindings.filter((binding) => binding.identifier === identifier),
    );
    if (declared.length > 0) {
      return declared.map((binding): Expansion => ({ ...NO_MEMBER, binding, kind: 'binding', step }));
    }
    const path = memberPath(step.bindings, exported);
    return path === undefined
      ? [{ bindings: step.bindings, file: step.file, kind: 'declared', node: exported, trail: step.trail }]
      : rootLinks(graph, step, path[0], { member: path[1] });
  }
  return statement.type === 'ExportAllDeclaration' &&
    statement.exported !== null &&
    specifierName(statement.exported) === name
    ? [wholeModule(graph, step, statement.source.value)]
    : [];
};

/** What a file exports as a name: its own exports of it, or else what each `export *` of it passes on. */
const nameLinks = (graph: ModuleGraph, { file, name, star, trail }: NameLink): readonly Expansion[] => {
  const here = [...trail, file];
  const parsed = graph.parsed(file);
  if (parsed === undefined || parsed === 'unparsable') {
    return [{ file, kind: 'unresolved', reason: parsed === undefined ? 'is not read' : 'does not parse', trail: here }];
  }
  const step: ExportStep = { bindings: parsed, file, trail: here };
  const explicit = parsed.program.body.flatMap((statement) => statementLinks(graph, step, statement, name));
  // An `export *` passes on every name but `default` that the file does not export itself; one of a module the
  // graph does not read is taken to pass it on only when nothing read does (`star`).
  const starred =
    explicit.length > 0 || name === 'default'
      ? []
      : parsed.program.body.flatMap((statement): readonly Expansion[] => {
          if (statement.type !== 'ExportAllDeclaration' || statement.exported !== null) {
            return [];
          }
          const specifier = statement.source.value;
          const target = graph.target(file, specifier);
          if (target === undefined) {
            return [unresolvedSpecifier(step, specifier)];
          }
          return [
            graph.parsed(target) === undefined
              ? { kind: 'foreign', name, specifier, star: true, target, trail: here }
              : { ...NO_MEMBER, file: target, kind: 'name', name, star: true, trail: here },
          ];
        });
  const found = [...explicit, ...starred];
  return found.length > 0 || star ? found : [{ file, kind: 'unresolved', reason: `exports no ${name}`, trail: here }];
};

const linkKey = (link: ExportLink): string => {
  const member = link.member.join('.');
  if (link.kind === 'name') {
    return `${link.file}#${link.name}.${member}`;
  }
  const node = link.kind === 'binding' ? link.binding.identifier : link.identifier;
  return `${link.step.file}@${node.start}:${link.kind}.${member}`;
};

const expansion = (graph: ModuleGraph, link: ExportLink): readonly Expansion[] => {
  if (link.kind === 'name') {
    return nameLinks(graph, link);
  }
  return link.kind === 'binding' ? bindingLinks(graph, link) : referenceLinks(link);
};

/**
 * What the follower ends on in a file of a workspace library, a declaration or the whole module: a library value, the
 * export of the library file the chain entered, as a library the graph does not read gives it. Only the chain of other
 * names is followed into the library; what a library declaration holds is not walked. A link the follower cannot follow
 * there stays one.
 */
const libraryValue = (graph: ModuleGraph, origin: ExportOrigin): ExportOrigin => {
  if ((origin.kind !== 'declared' && origin.kind !== 'namespace') || !graph.library(origin.file)) {
    return origin;
  }
  const entered = origin.trail.findIndex((passed) => graph.library(passed));
  const target = origin.trail[Math.max(entered, 0)] ?? origin.file;
  const named =
    origin.kind === 'declared' && origin.node.type === 'Identifier' ? specifierName(origin.node) : 'default';
  return {
    kind: 'foreign',
    name: origin.kind === 'namespace' ? '*' : named,
    specifier: target,
    star: false,
    target,
    trail: origin.trail.slice(0, Math.max(entered, 1)),
  };
};

const followedOrigins = (graph: ModuleGraph, start: readonly Expansion[], asked: string): readonly ExportOrigin[] => {
  const origins: ExportOrigin[] = [];
  const pending: ExportLink[] = [];
  const add = (item: Expansion): void => {
    if (item.kind === 'binding' || item.kind === 'name' || item.kind === 'reference') {
      pending.push(item);
    } else {
      origins.push(item);
    }
  };
  for (const item of start) {
    add(item);
  }
  const visited = new Set<string>();
  for (let link = pending.pop(); link !== undefined; link = pending.pop()) {
    const key = linkKey(link);
    if (!visited.has(key)) {
      visited.add(key);
      for (const item of expansion(graph, link)) {
        add(owedBy(item, link));
      }
    }
  }
  const settled = origins.map((origin) => libraryValue(graph, origin));
  const declared = settled.filter((origin) => origin.kind !== 'foreign' || !origin.star);
  if (declared.length > 0) {
    return declared;
  }
  return settled.length > 0 ? settled : [{ file: asked, kind: 'unresolved', reason: 'has no origin', trail: [asked] }];
};

/**
 * Where what `file` exports as `name` comes from, followed through re-exports (`export … from`, `export *`,
 * `export * as`), an imported binding exported again under any name, a member of a whole module (`Read.X`,
 * `typeof Read.X`, `import B = Read.X`, `const { X: B } = Read`, `import('…').X`), and a declaration that is only
 * another name for one binding (`aliasLinks`), to a declaration of a read module, a module the graph does not read, a
 * whole module, or a link it cannot follow, which is unresolved. A name that is a value and a type gives an origin for
 * each; a cycle adds nothing.
 */
export const exportOrigins = (
  graph: ModuleGraph,
  file: string,
  name: string,
  member: readonly string[] = [],
): readonly ExportOrigin[] =>
  followedOrigins(graph, [{ file, kind: 'name', member, name, star: false, trail: [] }], file);

/** What a module binding of `file` is, followed as `exportOrigins` does. */
export const bindingOrigins = (
  graph: ModuleGraph,
  file: string,
  bindings: ModuleBindings,
  binding: ModuleBinding,
): readonly ExportOrigin[] =>
  followedOrigins(graph, [{ ...NO_MEMBER, binding, kind: 'binding', step: { bindings, file, trail: [file] } }], file);

/** What an `import('…')` type of `file` names, its type arguments aside, followed as `exportOrigins` does. */
export const importTypeOrigins = (graph: ModuleGraph, file: string, node: Node): readonly ExportOrigin[] => {
  const bindings = graph.parsed(file);
  const links =
    node.type === 'TSImportType' && bindings !== undefined && bindings !== 'unparsable'
      ? importTypeLinks(graph, { bindings, file, trail: [file] }, node, NO_MEMBER)
      : undefined;
  return followedOrigins(graph, links ?? [], file);
};

/** What a reference of `file` resolves to, with the members taken of it (`Read.X`), followed as `exportOrigins` does. */
export const referenceOrigins = (
  graph: ModuleGraph,
  file: string,
  identifier: Node,
  member: readonly string[] = [],
): readonly ExportOrigin[] => {
  const bindings = graph.parsed(file);
  return bindings === undefined || bindings === 'unparsable'
    ? [{ file, kind: 'unresolved', reason: 'is not read', trail: [file] }]
    : followedOrigins(
        graph,
        [{ identifier, kind: 'reference', member, step: { bindings, file, trail: [file] } }],
        file,
      );
};

/** What a member access of a name or a module load takes where it stands, and the node the access ends at. */
interface MemberChain {
  readonly members: readonly string[];
  readonly outer: Node;
}

/**
 * The members a reference or a load takes where it stands (`X` of `Read.X`, `Read['X']`, the type name `Read.X`,
 * `(typeof Read)['X']`, `(await import('…')).X`), through the wrappers (`wraps`), and the outermost node.
 */
export const memberChain = (bindings: ModuleBindings, node: Node): MemberChain => {
  const members: string[] = [];
  let outer = node;
  for (let parent = bindings.parents.get(outer); parent !== undefined; parent = bindings.parents.get(outer)) {
    if (parent.type === 'MemberExpression' && parent.object === outer) {
      members.push(memberName(parent.property, parent.computed));
    } else if (parent.type === 'TSQualifiedName' && parent.left === outer) {
      members.push(memberName(parent.right, false));
    } else if (parent.type === 'TSIndexedAccessType' && parent.objectType === outer) {
      members.push(
        parent.indexType.type === 'TSLiteralType' ? memberName(parent.indexType.literal, true) : UNREAD_MEMBER,
      );
    } else if (wraps(bindings, parent) !== outer) {
      return { members, outer };
    }
    outer = parent;
  }
  return { members, outer };
};

/** The members a reference takes where it stands. */
export const takenMembers = (bindings: ModuleBindings, identifier: Node): readonly string[] =>
  memberChain(bindings, identifier).members;

/** What a module load of `file` gives, with the members taken of it where it stands, followed as `exportOrigins` does. */
export const loadOrigins = (
  graph: ModuleGraph,
  file: string,
  bindings: ModuleBindings,
  load: Node,
): readonly ExportOrigin[] =>
  followedOrigins(
    graph,
    rootLinks(graph, { bindings, file, trail: [file] }, load, { member: memberChain(bindings, load).members }),
    file,
  );

/**
 * Every name a file exports, and every `export *` whose names it cannot list: of a module the graph does not read, or
 * of a workspace specifier that names no file.
 */
interface ModuleExports {
  readonly names: readonly string[];
  readonly opaque: readonly (ForeignExport | UnresolvedExport)[];
}

const statementExportNames = (statement: Node): readonly string[] => {
  if (statement.type === 'ExportAllDeclaration') {
    return statement.exported === null ? [] : [specifierName(statement.exported)];
  }
  if (statement.type === 'ExportNamedDeclaration') {
    return [
      ...statement.specifiers.map((specifier) => specifierName(specifier.exported)),
      ...declaredIdentifiers(statement.declaration).map(specifierName),
    ];
  }
  return statement.type === 'ExportDefaultDeclaration' || statement.type === 'TSExportAssignment' ? ['default'] : [];
};

export const moduleExports = (graph: ModuleGraph, file: string): ModuleExports => {
  const names = new Set<string>();
  const opaque: (ForeignExport | UnresolvedExport)[] = [];
  const pending: (readonly [string, readonly string[]])[] = [[file, []]];
  const visited = new Set<string>();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [current, trail] = next;
    const parsed = graph.parsed(current);
    if (parsed !== undefined && parsed !== 'unparsable' && !visited.has(current)) {
      visited.add(current);
      const here = [...trail, current];
      for (const statement of parsed.program.body) {
        // Only the file asked about passes on its `default`; an `export *` never does.
        for (const exported of statementExportNames(statement)) {
          if (current === file || exported !== 'default') {
            names.add(exported);
          }
        }
        if (statement.type === 'ExportAllDeclaration' && statement.exported === null) {
          const target = graph.target(current, statement.source.value);
          if (target === undefined) {
            opaque.push({
              file: current,
              kind: 'unresolved',
              reason: `names ${statement.source.value}, which is no file of the workspace`,
              trail: here,
            });
          } else if (graph.parsed(target) === undefined) {
            opaque.push({
              kind: 'foreign',
              name: '*',
              specifier: statement.source.value,
              star: true,
              target,
              trail: here,
            });
          } else {
            pending.push([target, here]);
          }
        }
      }
    }
  }
  return { names: [...names], opaque };
};

/** A module specifier as a source writes it: the node that writes it, and the specifier. */
interface ModuleSpecifier {
  readonly node: Node;
  readonly specifier: string;
}

/**
 * Every module specifier of a source: a static import, an `export … from`, an `import('…')` type, and every readable
 * load (`loadSpecifier`: an `import()`, a `require()` and an `import x = require()` a literal names).
 */
export const moduleSpecifiers = (bindings: ModuleBindings): readonly ModuleSpecifier[] =>
  [...bindings.parents.keys()].flatMap((node): readonly ModuleSpecifier[] => {
    if (
      (node.type === 'ImportDeclaration' ||
        node.type === 'ExportAllDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'TSImportType') &&
      node.source !== null
    ) {
      const specifier = staticText(node.source);
      return specifier === undefined ? [] : [{ node, specifier }];
    }
    const specifier =
      isLoad(bindings, node) || node.type === 'TSExternalModuleReference' ? loadSpecifier(node) : undefined;
    return specifier === undefined ? [] : [{ node, specifier }];
  });
