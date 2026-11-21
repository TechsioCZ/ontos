import { Schema } from 'effect';
import { parseSync, Visitor, visitorKeys } from 'oxc-parser';
import type { Node, Program, VisitorObject } from 'oxc-parser';

/**
 * Module-scope bindings of one TypeScript source and what each reference resolves to, by scope: a name declared in
 * an inner scope (a parameter, a block, a type parameter, an `infer`) hides the module binding of that name in its
 * namespace, so a reference resolves to the declaration TypeScript binds it to, never to whatever shares its name.
 */

export const BindingNamespaceSchema = Schema.Literals(['type', 'value']);
export type BindingNamespace = typeof BindingNamespaceSchema.Type;

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
 * path for a relative specifier, else the specifier itself); `parsed` gives its bindings, `unparsable` when its
 * source does not parse, and undefined for a module the graph does not read (a package, a missing file, a file
 * outside the files the graph reads).
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

/** An export that ends on a declaration of a module the graph reads, one that is not only another name for a binding. */
export interface DeclaredExport {
  readonly bindings: ModuleBindings;
  readonly file: string;
  readonly kind: 'declared';
  /** The declared identifier, or the expression of an `export default` or `export =`. */
  readonly node: Node;
  /** Every file the export passes through, the one asked about first, `file` last. */
  readonly trail: readonly string[];
}

/** An export that ends on a module the graph does not read: `name` of it, or `*` for the whole module. */
export interface ForeignExport {
  readonly kind: 'foreign';
  readonly name: string;
  /** The specifier of the last link, as written. */
  readonly specifier: string;
  /** Whether the name is only taken to come through an `export *` of the module, since nothing read exports it. */
  readonly star: boolean;
  readonly target: string;
  readonly trail: readonly string[];
}

/** A whole module the graph reads, as `export * as`, `import * as` or `import x = require(…)` pass it on. */
export interface NamespaceExport {
  readonly file: string;
  readonly kind: 'namespace';
  readonly trail: readonly string[];
}

/** A link that cannot be followed: a file that does not parse, or a name no scope of the file declares. */
export interface UnresolvedExport {
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

/** A link still to follow: what a binding is, what a reference resolves to, or what a file exports as a name. */
interface BindingLink {
  readonly binding: ModuleBinding;
  readonly kind: 'binding';
  readonly step: ExportStep;
}

interface ReferenceLink {
  readonly identifier: Node;
  readonly kind: 'reference';
  readonly step: ExportStep;
}

interface NameLink {
  readonly file: string;
  readonly kind: 'name';
  readonly name: string;
  /** The files passed through before `file`. */
  readonly trail: readonly string[];
}

type ExportLink = BindingLink | NameLink | ReferenceLink;

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
const namedIn = (graph: ModuleGraph, step: ExportStep, specifier: string, name: string): ExportLink | ExportOrigin => {
  const target = graph.target(step.file, specifier);
  return graph.parsed(target) === undefined
    ? { kind: 'foreign', name, specifier, star: false, target, trail: step.trail }
    : { file: target, kind: 'name', name, trail: step.trail };
};

/** The binding a declaration is only another name for: `const B = A`, `type B = A`, `import B = A`. */
const aliasedName = (parent: Node | undefined, identifier: Node): Node | undefined => {
  // An annotated `const B: T = A` says more than another name for A does.
  if (parent?.type === 'VariableDeclarator') {
    const annotated =
      identifier.type === 'Identifier' && identifier.typeAnnotation !== null && identifier.typeAnnotation !== undefined;
    return parent.id === identifier && !annotated && parent.init?.type === 'Identifier' ? parent.init : undefined;
  }
  if (parent?.type === 'TSTypeAliasDeclaration') {
    const aliased = parent.typeAnnotation;
    return aliased.type === 'TSTypeReference' &&
      aliased.typeName.type === 'Identifier' &&
      aliased.typeArguments === null
      ? aliased.typeName
      : undefined;
  }
  return parent?.type === 'TSImportEqualsDeclaration' && parent.moduleReference.type === 'Identifier'
    ? parent.moduleReference
    : undefined;
};

/** A binding, followed while it is only another name: an import, an alias, `import B = require('…')`. */
const bindingLinks = (graph: ModuleGraph, { binding, step }: BindingLink): readonly (ExportLink | ExportOrigin)[] => {
  const { imported } = binding;
  if (imported !== undefined) {
    return [
      imported.name === '*'
        ? wholeModule(graph, step, imported.source)
        : namedIn(graph, step, imported.source, imported.name),
    ];
  }
  const parent = step.bindings.parents.get(binding.identifier);
  if (parent?.type === 'TSImportEqualsDeclaration' && parent.moduleReference.type === 'TSExternalModuleReference') {
    return [wholeModule(graph, step, parent.moduleReference.expression.value)];
  }
  const aliased = aliasedName(parent, binding.identifier);
  return [
    aliased === undefined
      ? { bindings: step.bindings, file: step.file, kind: 'declared', node: binding.identifier, trail: step.trail }
      : { identifier: aliased, kind: 'reference', step },
  ];
};

const referenceLinks = ({ identifier, step }: ReferenceLink): readonly (ExportLink | ExportOrigin)[] => {
  const bindings = step.bindings.referenceOf.get(identifier)?.bindings ?? [];
  return bindings.length === 0
    ? [
        {
          file: step.file,
          kind: 'unresolved',
          reason: `${specifierName(identifier)} names no binding of the file`,
          trail: step.trail,
        },
      ]
    : bindings.map((binding) => ({ binding, kind: 'binding', step }));
};

/** What one statement exports as `name`. */
const statementLinks = (
  graph: ModuleGraph,
  step: ExportStep,
  statement: Node,
  name: string,
): readonly (ExportLink | ExportOrigin)[] => {
  if (statement.type === 'ExportNamedDeclaration') {
    const { source } = statement;
    const passed = statement.specifiers.flatMap((specifier): readonly (ExportLink | ExportOrigin)[] => {
      if (specifierName(specifier.exported) !== name) {
        return [];
      }
      return source === null
        ? [{ identifier: specifier.local, kind: 'reference', step }]
        : [namedIn(graph, step, source.value, specifierName(specifier.local))];
    });
    const declared = declaredIdentifiers(statement.declaration).flatMap((identifier) =>
      specifierName(identifier) === name
        ? step.bindings.bindings.filter((binding) => binding.identifier === identifier)
        : [],
    );
    return [...passed, ...declared.map((binding): ExportLink => ({ binding, kind: 'binding', step }))];
  }
  if (
    (statement.type === 'ExportDefaultDeclaration' || statement.type === 'TSExportAssignment') &&
    name === 'default'
  ) {
    const exported = statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement.expression;
    if (exported.type === 'Identifier') {
      return [{ identifier: exported, kind: 'reference', step }];
    }
    const declared = declaredIdentifiers(exported).flatMap((identifier) =>
      step.bindings.bindings.filter((binding) => binding.identifier === identifier),
    );
    return declared.length === 0
      ? [{ bindings: step.bindings, file: step.file, kind: 'declared', node: exported, trail: step.trail }]
      : declared.map((binding): ExportLink => ({ binding, kind: 'binding', step }));
  }
  return statement.type === 'ExportAllDeclaration' &&
    statement.exported !== null &&
    specifierName(statement.exported) === name
    ? [wholeModule(graph, step, statement.source.value)]
    : [];
};

/** What a file exports as a name: its own exports of it, or else what each `export *` of a read module passes on. */
const nameLinks = (graph: ModuleGraph, { file, name, trail }: NameLink): readonly (ExportLink | ExportOrigin)[] => {
  const here = [...trail, file];
  const parsed = graph.parsed(file);
  if (parsed === undefined || parsed === 'unparsable') {
    return [{ file, kind: 'unresolved', reason: parsed === undefined ? 'is not read' : 'does not parse', trail: here }];
  }
  const step: ExportStep = { bindings: parsed, file, trail: here };
  const explicit = parsed.program.body.flatMap((statement) => statementLinks(graph, step, statement, name));
  if (explicit.length > 0 || name === 'default') {
    return explicit;
  }
  // An `export *` passes on every name but `default` that the file does not export itself; one of a module the
  // graph does not read is taken to pass it on only when nothing read does (`star`).
  return parsed.program.body.flatMap((statement): readonly (ExportLink | ExportOrigin)[] => {
    if (statement.type !== 'ExportAllDeclaration' || statement.exported !== null) {
      return [];
    }
    const specifier = statement.source.value;
    const target = graph.target(file, specifier);
    return [
      graph.parsed(target) === undefined
        ? { kind: 'foreign', name, specifier, star: true, target, trail: here }
        : { file: target, kind: 'name', name, trail: here },
    ];
  });
};

const followedLinks = (
  graph: ModuleGraph,
  link: BindingLink | ReferenceLink,
): readonly (ExportLink | ExportOrigin)[] =>
  link.kind === 'binding' ? bindingLinks(graph, link) : referenceLinks(link);

const linkKey = (link: ExportLink): string => {
  if (link.kind === 'name') {
    return `${link.file}#${link.name}`;
  }
  const node = link.kind === 'binding' ? link.binding.identifier : link.identifier;
  return `${link.step.file}@${node.start}:${link.kind}`;
};

const followedOrigins = (graph: ModuleGraph, start: ExportLink): readonly ExportOrigin[] => {
  const origins: ExportOrigin[] = [];
  const pending: ExportLink[] = [start];
  const visited = new Set<string>();
  for (let link = pending.pop(); link !== undefined; link = pending.pop()) {
    const key = linkKey(link);
    if (!visited.has(key)) {
      visited.add(key);
      const next = link.kind === 'name' ? nameLinks(graph, link) : followedLinks(graph, link);
      for (const item of next) {
        if (item.kind === 'binding' || item.kind === 'name' || item.kind === 'reference') {
          pending.push(item);
        } else {
          origins.push(item);
        }
      }
    }
  }
  const declared = origins.filter((origin) => origin.kind !== 'foreign' || !origin.star);
  return declared.length > 0 ? declared : origins;
};

/**
 * Where what `file` exports as `name` comes from, followed through re-exports (`export … from`, `export *`,
 * `export * as`), an imported binding exported again under any name, and a declaration that is only another name
 * for one binding (`const B = A`, `type B = A`, `import B = A`, `import B = require('…')`), to a declaration of
 * a read module, a module the graph does not read, a whole module, or a link it cannot follow. Empty when `file`
 * exports no `name`; a name that is a value and a type gives an origin for each; a cycle adds nothing.
 */
export const exportOrigins = (graph: ModuleGraph, file: string, name: string): readonly ExportOrigin[] =>
  followedOrigins(graph, { file, kind: 'name', name, trail: [] });

/** What a reference of `file` resolves to, followed as `exportOrigins` follows an export. */
export const referenceOrigins = (graph: ModuleGraph, file: string, identifier: Node): readonly ExportOrigin[] => {
  const bindings = graph.parsed(file);
  return bindings === undefined || bindings === 'unparsable'
    ? [{ file, kind: 'unresolved', reason: 'is not read', trail: [file] }]
    : followedOrigins(graph, { identifier, kind: 'reference', step: { bindings, file, trail: [file] } });
};

/** Every name a file exports, and every `export *` of a module the graph does not read, whose names it cannot list. */
export interface ModuleExports {
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
export interface ModuleSpecifier {
  readonly literal: Node;
  readonly node: Node;
  readonly specifier: string;
}

/**
 * Every module specifier of a source, of any kind: a static import, an `export … from`, an `import()` expression, an
 * `import('…')` type, a `require('…')` and an `import x = require('…')`.
 */
export const moduleSpecifiers = (bindings: ModuleBindings): readonly ModuleSpecifier[] =>
  [...bindings.parents.keys()].flatMap((node): readonly ModuleSpecifier[] => {
    let written: Node | null | undefined;
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ImportExpression' ||
      node.type === 'TSImportType'
    ) {
      written = node.source;
    } else if (node.type === 'TSExternalModuleReference') {
      written = node.expression;
    } else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') {
      [written] = node.arguments;
    }
    return written?.type === 'Literal' ? [{ literal: written, node, specifier: String(written.value) }] : [];
  });
