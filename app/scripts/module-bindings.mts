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
  readonly parents: ReadonlyMap<Node, Node>;
  readonly program: Program;
  /** Every reference of the file that no inner scope binds, in source order. */
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
export const patternIdentifiers = (pattern: Node | null | undefined): readonly Node[] => {
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

/** The nodes from node's parent up to the program, nearest first. */
export const ancestorsOfNode = (bindings: ModuleBindings, node: Node): readonly Node[] => [
  ...ancestors(bindings.parents, node),
];

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
  const references = nodes.flatMap((node): readonly ModuleReference[] => {
    if (node.type !== 'Identifier' || declared.has(node) || isNameOnly(parents, node)) {
      return [];
    }
    const lookup = lookupOf(parents, node);
    const bindsHere = (scope: Node): boolean =>
      (scopes.get(scope) ?? []).some(
        ({ identifier, namespaces }) =>
          identifier.type === 'Identifier' && identifier.name === node.name && isIn(lookup, namespaces),
      );
    if ([...ancestors(parents, node)].some((ancestor) => ancestor !== program && bindsHere(ancestor))) {
      return [];
    }
    return [
      {
        bindings: bindings.filter((binding) => binding.name === node.name && isIn(lookup, binding.namespaces)),
        identifier: node,
        name: node.name,
      },
    ];
  });
  return { bindings, parents, program, references };
};
