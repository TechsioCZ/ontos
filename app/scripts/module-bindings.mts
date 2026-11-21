import { Schema } from 'effect';
import { parseSync, Visitor, visitorKeys } from 'oxc-parser';
import type { Node, Program, VisitorObject } from 'oxc-parser';

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
  readonly bindings: readonly ModuleBinding[];
  /** Each reference an inner scope binds (a parameter, a local declaration), to the identifier that declares it. */
  readonly local: ReadonlyMap<Node, Node>;
  readonly parents: ReadonlyMap<Node, Node>;
  readonly program: Program;
  /** Every reference of the file that no inner scope binds, by its identifier. */
  readonly referenceOf: ReadonlyMap<Node, ModuleReference>;
  /** The same references, in source order. */
  readonly references: readonly ModuleReference[];
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

const functionScopes = new Set(['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression']);

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

/** A `var` belongs to the nearest function, or to the program. */
const functionScope = (parents: ReadonlyMap<Node, Node>, declaration: Node): Node | undefined => {
  for (const ancestor of ancestors(parents, declaration)) {
    if (functionScopes.has(ancestor.type) || ancestor.type === 'Program' || ancestor.type === 'TSModuleBlock') {
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

/** Parse source and resolve each of its references; undefined when it does not parse. */
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
  const stack: Node[] = [program];
  const tracker: VisitorObject = Object.fromEntries(
    Object.keys(visitorKeys).flatMap((type): readonly (readonly [string, (node: Node) => void])[] => [
      [
        type,
        (node) => {
          const parent = stack.at(-1);
          if (parent !== undefined && node !== program) {
            parents.set(node, parent);
            nodes.push(node);
            stack.push(node);
          }
        },
      ],
      [
        `${type}:exit`,
        (node) => {
          if (node !== program) {
            stack.pop();
          }
        },
      ],
    ]),
  );
  new Visitor(tracker).visit(program);
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
  return {
    bindings,
    local,
    parents,
    program,
    referenceOf: new Map(references.map((reference) => [reference.identifier, reference])),
    references,
  };
};

/**
 * How a module graph names and reads modules. `target` gives the module a specifier of `importer` names (a file
 * path for a relative specifier or for a workspace package it resolves, else the specifier itself); `parsed` gives
 * its bindings, `unparsable` when its source does not parse, and undefined for a module the graph does not read (a
 * library, a missing file, a file outside the files the graph reads).
 */
export interface ModuleGraph {
  readonly parsed: (target: string) => ModuleBindings | 'unparsable' | undefined;
  readonly target: (importer: string, specifier: string) => string;
}

/** A module graph over the sources `source` gives, each parsed once. */
export const moduleGraph = (
  target: (importer: string, specifier: string) => string,
  source: (target: string) => string | undefined,
): ModuleGraph => {
  const cache = new Map<string, ModuleBindings | undefined>();
  return {
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

/** A whole module: a namespace of a module the graph reads, else a foreign export of `*`. */
const wholeModule = (graph: ModuleGraph, step: ExportStep, specifier: string): ExportOrigin => {
  const target = graph.target(step.file, specifier);
  return graph.parsed(target) === undefined
    ? { kind: 'foreign', name: '*', specifier, star: false, target, trail: step.trail }
    : { file: target, kind: 'namespace', trail: [...step.trail, target] };
};

/** `name` of the module `specifier` names: followed in a module the graph reads, else foreign. */
const namedIn = (graph: ModuleGraph, step: ExportStep, specifier: string, name: string): Expansion => {
  const target = graph.target(step.file, specifier);
  return graph.parsed(target) === undefined
    ? { kind: 'foreign', name, specifier, star: false, target, trail: step.trail }
    : { ...NO_MEMBER, file: target, kind: 'name', name, star: false, trail: step.trail };
};

/** Parentheses, `as`, `satisfies`, `!`, `<T>x` and `typeof`: what they wrap is still the same binding. */
const unwrappedName = (node: Node): Node => {
  let inner = node;
  for (;;) {
    if (
      inner.type === 'ParenthesizedExpression' ||
      inner.type === 'TSAsExpression' ||
      inner.type === 'TSSatisfiesExpression' ||
      inner.type === 'TSNonNullExpression' ||
      inner.type === 'TSTypeAssertion'
    ) {
      inner = inner.expression;
    } else if (inner.type === 'TSTypeQuery' && inner.typeArguments === null) {
      inner = inner.exprName;
    } else if (inner.type === 'TSTypeReference' && inner.typeArguments === null) {
      inner = inner.typeName;
    } else {
      return inner;
    }
  }
};

/** `A`, `A.B`, `A.B.C` (as an expression or a qualified type name): the leftmost name and the members after it. */
const memberPath = (node: Node): readonly [Node, readonly string[]] | undefined => {
  if (node.type === 'Identifier') {
    return [node, []];
  }
  let object: Node;
  let property: Node;
  if (node.type === 'TSQualifiedName') {
    ({ left: object, right: property } = node);
  } else if (node.type === 'MemberExpression' && !node.computed) {
    ({ object, property } = node);
  } else {
    return undefined;
  }
  const inner = memberPath(unwrappedName(object));
  return inner === undefined || property.type !== 'Identifier' ? undefined : [inner[0], [...inner[1], property.name]];
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
    return { ...item, name: [...(item.name === '*' ? [] : [item.name]), ...owed.member].join('.') };
  }
  // A member of a declared value is no other name for anything: the declaration that takes it is where it ends.
  return item.kind === 'declared' && owed.holder !== undefined ? owed.holder : item;
};

interface Written {
  /** The members a destructuring takes of what is written: `A` of `const { A: B } = Read`. */
  readonly taken: readonly string[];
  readonly written: Node;
}

/** What the declaration of `identifier` writes for it: an initializer, a type, an import reference. */
const writtenFor = (bindings: ModuleBindings, identifier: Node): Written | undefined => {
  const taken: string[] = [];
  let node = identifier;
  let parent = bindings.parents.get(node);
  while (parent?.type === 'Property' && !parent.computed && parent.value === node && parent.key.type === 'Identifier') {
    const pattern = bindings.parents.get(parent);
    if (pattern?.type !== 'ObjectPattern') {
      return undefined;
    }
    taken.unshift(parent.key.name);
    node = pattern;
    parent = bindings.parents.get(pattern);
  }
  if (parent?.type === 'VariableDeclarator') {
    return parent.id === node && parent.init !== null ? { taken, written: parent.init } : undefined;
  }
  if (parent?.type === 'TSTypeAliasDeclaration') {
    return parent.typeParameters === null ? { taken, written: parent.typeAnnotation } : undefined;
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
  const qualified = memberPath(node.qualifier);
  return qualified === undefined
    ? undefined
    : [
        owedBy(namedIn(graph, step, node.source.value, specifierName(qualified[0])), {
          holder: owed.holder,
          member: [...qualified[1], ...owed.member],
        }),
      ];
};

/**
 * What a declaration is only another name for, when it is one (`OWNER_ENTRY_READ_FORMS` states the boundary): `const B =
 * A`, `const B = Read.A`, `const { A: B } = Read`, `type B = A`, `type B = typeof Read.A`, `type B = import('…').A`,
 * `import B = Read.A`, `import B = require('…')`, each with or without parentheses, `as`, `satisfies`, `!`, `<T>` and a
 * type annotation. Anything else, a call, an object, array or struct it builds, an operator, type arguments, is a
 * declaration of its own.
 */
const aliasLinks = (
  graph: ModuleGraph,
  step: ExportStep,
  binding: ModuleBinding,
  declared: DeclaredExport,
): readonly Expansion[] | undefined => {
  const found = writtenFor(step.bindings, binding.identifier);
  const taken = found?.taken ?? [];
  const inner = found === undefined ? undefined : unwrappedName(found.written);
  if (inner?.type === 'TSExternalModuleReference') {
    return [owedBy(wholeModule(graph, step, inner.expression.value), { holder: declared, member: taken })];
  }
  if (inner?.type === 'TSImportType') {
    return inner.typeArguments === null
      ? importTypeLinks(graph, step, inner, { holder: declared, member: taken })
      : undefined;
  }
  const path = inner === undefined ? undefined : memberPath(inner);
  return path === undefined
    ? undefined
    : [{ holder: declared, identifier: path[0], kind: 'reference', member: [...path[1], ...taken], step }];
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
    const path = memberPath(unwrappedName(exported));
    return path === undefined
      ? [{ bindings: step.bindings, file: step.file, kind: 'declared', node: exported, trail: step.trail }]
      : [{ identifier: path[0], kind: 'reference', member: path[1], step }];
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
  const declared = origins.filter((origin) => origin.kind !== 'foreign' || !origin.star);
  if (declared.length > 0) {
    return declared;
  }
  return origins.length > 0 ? origins : [{ file: asked, kind: 'unresolved', reason: 'has no origin', trail: [asked] }];
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

/** The members a reference takes where it stands: `X` of `Read.X` or of the type name `Read.X`. */
export const takenMembers = (bindings: ModuleBindings, identifier: Node): readonly string[] => {
  const members: string[] = [];
  let child = identifier;
  for (let parent = bindings.parents.get(child); parent !== undefined; parent = bindings.parents.get(child)) {
    let property: Node | undefined;
    if (parent.type === 'MemberExpression' && !parent.computed && parent.object === child) {
      ({ property } = parent);
    } else if (parent.type === 'TSQualifiedName' && parent.left === child) {
      property = parent.right;
    }
    if (property?.type !== 'Identifier') {
      return members;
    }
    members.push(property.name);
    child = parent;
  }
  return members;
};

/** Every name a file exports, and every `export *` of a module the graph does not read, whose names it cannot list. */
interface ModuleExports {
  readonly names: readonly string[];
  readonly opaque: readonly ForeignExport[];
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
  const opaque: ForeignExport[] = [];
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
          if (graph.parsed(target) === undefined) {
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

/** A module specifier as a source writes it: the string literal, and the node that writes it. */
interface ModuleSpecifier {
  readonly literal: Node;
  readonly node: Node;
  readonly specifier: string;
}

/** What a node writes as a module specifier, when it takes one: null or undefined when it names none. */
const writtenSpecifier = (node: Node): Node | null | undefined => {
  if (
    node.type === 'ImportDeclaration' ||
    node.type === 'ExportAllDeclaration' ||
    node.type === 'ExportNamedDeclaration' ||
    node.type === 'ImportExpression' ||
    node.type === 'TSImportType'
  ) {
    return node.source;
  }
  if (node.type === 'TSExternalModuleReference') {
    return node.expression;
  }
  return node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require'
    ? (node.arguments[0] ?? null)
    : undefined;
};

/** The text of a specifier written statically: a string literal, or a template literal without interpolation. */
const staticSpecifier = (written: Node): string | undefined => {
  if (written.type === 'Literal') {
    return String(written.value);
  }
  return written.type === 'TemplateLiteral' && written.expressions.length === 0
    ? (written.quasis[0]?.value.cooked ?? undefined)
    : undefined;
};

/**
 * Every module specifier of a source, of any kind, written as a string literal or a template literal without
 * interpolation: a static import, an `export … from`, an `import()` expression, an `import('…')` type, a
 * `require('…')` and an `import x = require('…')`.
 */
export const moduleSpecifiers = (bindings: ModuleBindings): readonly ModuleSpecifier[] =>
  [...bindings.parents.keys()].flatMap((node): readonly ModuleSpecifier[] => {
    const written = writtenSpecifier(node);
    const specifier = written === null || written === undefined ? undefined : staticSpecifier(written);
    return written === null || written === undefined || specifier === undefined
      ? []
      : [{ literal: written, node, specifier }];
  });

/** Every `import()` and `require()` of a source whose module is computed at run time, so cannot be read statically. */
export const unreadableSpecifiers = (bindings: ModuleBindings): readonly Node[] =>
  [...bindings.parents.keys()].filter((node) => {
    const written = writtenSpecifier(node);
    return (
      (node.type === 'ImportExpression' || node.type === 'CallExpression') &&
      written !== undefined &&
      (written === null || staticSpecifier(written) === undefined)
    );
  });
