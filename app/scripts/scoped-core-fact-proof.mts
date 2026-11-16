import { Schema } from 'effect';
import type { Path } from 'effect';
import { parseSync, Visitor } from 'oxc-parser';
import type {
  ArrowFunctionExpression,
  AssignmentExpression,
  Class as AstClass,
  BindingIdentifier,
  BindingPattern,
  CallExpression,
  Expression,
  Function as AstFunction,
  IdentifierName,
  IdentifierReference,
  MemberExpression,
  ModuleExportName,
  NewExpression,
  MethodDefinition,
  ObjectExpression,
  ParamPattern,
  Program,
  PrivateIdentifier,
  ReturnStatement,
  Span,
  Statement,
  VariableDeclarator,
  YieldExpression,
} from 'oxc-parser';

import {
  hasClosedClassConstructor,
  hasClosedNativeGlobalConstructor,
  hasClosedNativeObjectNamespace,
} from './scoped-proof-custody.mts';

type Identifier = BindingIdentifier | IdentifierName | IdentifierReference;
type Value = Expression | Identifier;
type FunctionNode = AstFunction | ArrowFunctionExpression;
interface Origin {
  readonly imported: string;
  readonly source: string;
}
interface Binding {
  readonly exported: boolean;
  readonly init?: Expression;
  readonly kind: 'const' | 'function' | 'import' | 'parameter' | 'mutable';
  readonly name: string;
  readonly node: Span;
  readonly origin?: Origin;
  readonly scope: Span;
}
interface Model {
  readonly assignments: AssignmentExpression[];
  readonly bindingCache: Map<string, Binding | undefined>;
  readonly bindings: Binding[];
  readonly calls: CallExpression[];
  readonly classes: AstClass[];
  readonly dynamicImports: Expression[];
  readonly exports: Map<string, string | Origin>;
  readonly file: string;
  readonly functions: FunctionNode[];
  readonly identifiers: Identifier[];
  readonly members: MemberExpression[];
  readonly moduleEscapes: string[];
  readonly news: NewExpression[];
  readonly nonReferences: Set<number>;
  readonly parents: Map<Span, Span>;
  readonly program: Program;
  readonly referenceCache: Map<Binding, readonly Identifier[]>;
  readonly returns: ReturnStatement[];
  readonly runtimeReferences: Identifier[];
  readonly source: string;
  readonly thises: Span[];
  readonly types: Span[];
  readonly variables: VariableDeclarator[];
  readonly writes: Span[];
  readonly yields: YieldExpression[];
}
interface SymbolValue {
  readonly binding: Binding;
  readonly model: Model;
}
const limit = 64;
const inside = (node: Span, span: Span): boolean => node.start >= span.start && node.end <= span.end;
const text = (node: ModuleExportName | Expression): string | undefined => {
  if (node.type === 'Identifier') {
    return node.name;
  }
  return node.type === 'Literal' && Schema.is(Schema.String)(node.value) ? node.value : undefined;
};
const wrapperChild = (node: Expression): Expression | undefined => {
  if (
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSInstantiationExpression' ||
    node.type === 'TSTypeAssertion' ||
    node.type === 'ChainExpression' ||
    node.type === 'ParenthesizedExpression'
  ) {
    return node.expression;
  }
  return undefined;
};
const unwrap = (input: Expression): Expression => {
  let node = input;
  for (let hop = 0; hop < limit; hop += 1) {
    const child = wrapperChild(node);
    if (child === undefined) {
      return node;
    }
    node = child;
  }
  return node;
};
const smallest = <T extends Span>(nodes: readonly T[]): T | undefined => {
  let found: T | undefined;
  for (const node of nodes) {
    if (found === undefined || node.end - node.start < found.end - found.start) {
      found = node;
    }
  }
  return found;
};
const narrowestBinding = (nodes: readonly Binding[]): Binding | undefined => {
  let found: Binding | undefined;
  for (const node of nodes) {
    if (found === undefined || node.scope.end - node.scope.start < found.scope.end - found.scope.start) {
      found = node;
    }
  }
  return found;
};
const propertyName = (node: MemberExpression): string | undefined =>
  !node.computed && node.property.type === 'Identifier' ? node.property.name : undefined;
const objectField = (node: ObjectExpression, name: string): Expression | undefined => {
  if (node.properties.some((field) => field.type === 'SpreadElement')) {
    return undefined;
  }
  const fields = node.properties.filter(
    (field) =>
      field.type === 'Property' &&
      !field.computed &&
      field.key.type !== 'PrivateIdentifier' &&
      text(field.key) === name,
  );
  const [field] = fields;
  return fields.length === 1 && field?.type === 'Property' && field.kind === 'init' && !field.method
    ? field.value
    : undefined;
};
const patternNames = (node: BindingPattern | ParamPattern): readonly BindingIdentifier[] => {
  if (node.type === 'Identifier') {
    return [node];
  }
  if (node.type === 'AssignmentPattern') {
    return patternNames(node.left);
  }
  if (node.type === 'RestElement') {
    return patternNames(node.argument);
  }
  if (node.type === 'ArrayPattern') {
    return node.elements.flatMap((element) => (element === null ? [] : patternNames(element)));
  }
  if (node.type === 'ObjectPattern') {
    return node.properties.flatMap((field) =>
      field.type === 'RestElement' ? patternNames(field.argument) : patternNames(field.value),
    );
  }
  return [];
};
const addParents = (model: Model, parent: Span, children: readonly (Span | null | undefined)[]): void => {
  for (const child of children) {
    if (child !== undefined && child !== null) {
      model.parents.set(child, parent);
    }
  }
};
const parseModel = (file: string, source: string): Model | undefined => {
  const parsed = parseSync(file, source, { sourceType: 'module' });
  if (parsed.errors.length !== 0) {
    return undefined;
  }
  const model: Model = {
    assignments: [],
    bindingCache: new Map(),
    bindings: [],
    calls: [],
    classes: [],
    dynamicImports: [],
    exports: new Map(),
    file,
    functions: [],
    identifiers: [],
    members: [],
    moduleEscapes: [],
    news: [],
    nonReferences: new Set(),
    parents: new Map(),
    program: parsed.program,
    referenceCache: new Map(),
    returns: [],
    runtimeReferences: [],
    source,
    thises: [],
    types: [],
    variables: [],
    writes: [],
    yields: [],
  };
  const scopes: Span[] = [parsed.program];
  const declarationKinds = new Map<VariableDeclarator, string>();
  const exported = new Set<Span>();
  const currentScope = (): Span => scopes.at(-1) ?? parsed.program;
  const variableScope = (kind: string | undefined): Span => {
    if (kind !== 'var') {
      return currentScope();
    }
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const scope = scopes.at(index);
      if (scope !== undefined && (scope === parsed.program || model.functions.some((fn) => fn === scope))) {
        return scope;
      }
    }
    return parsed.program;
  };
  const declare = (
    node: BindingIdentifier,
    kind: Binding['kind'],
    scope: Span,
    init?: Expression,
    isExported = false,
    origin?: Origin,
  ): void => {
    model.nonReferences.add(node.start);
    const binding: Binding & { init?: Expression; origin?: Origin } = {
      exported: isExported,
      kind,
      name: node.name,
      node,
      scope,
    };
    if (init !== undefined) {
      binding.init = init;
    }
    if (origin !== undefined) {
      binding.origin = origin;
    }
    model.bindings.push(binding);
  };
  const enterFunction = (node: FunctionNode): void => {
    model.functions.push(node);
    if (node.type === 'FunctionDeclaration' && node.id !== null) {
      declare(node.id, 'function', currentScope(), undefined, exported.has(node));
    }
    scopes.push(node);
    if (node.type === 'FunctionExpression' && node.id !== null) {
      declare(node.id, 'function', node);
    }
    for (const parameter of node.params) {
      for (const name of patternNames(parameter)) {
        declare(name, 'parameter', node);
      }
    }
    addParents(model, node, [node.body, ...node.params]);
  };
  new Visitor({
    ArrayExpression(node) {
      addParents(model, node, node.elements);
    },
    ArrowFunctionExpression: enterFunction,
    'ArrowFunctionExpression:exit'() {
      scopes.pop();
    },
    AssignmentExpression(node) {
      model.assignments.push(node);
      model.writes.push(node.left);
      addParents(model, node, [node.left, node.right]);
    },
    BlockStatement(node) {
      scopes.push(node);
      addParents(model, node, node.body);
    },
    'BlockStatement:exit'() {
      scopes.pop();
    },
    CallExpression(node) {
      model.calls.push(node);
      addParents(model, node, [node.callee, ...node.arguments]);
    },
    CatchClause(node) {
      if (node.param !== null) {
        for (const name of patternNames(node.param)) {
          declare(name, 'parameter', node.body);
        }
      }
    },
    ClassDeclaration(node) {
      model.classes.push(node);
      if (node.id !== null) {
        declare(node.id, 'const', currentScope(), undefined, exported.has(node));
        if (exported.has(node)) {
          model.exports.set(node.id.name, node.id.name);
        }
      }
    },
    ClassExpression(node) {
      model.classes.push(node);
      if (node.id !== null) {
        declare(node.id, 'const', node);
      }
    },
    ExportAllDeclaration(node) {
      if (node.exportKind !== 'type') {
        model.moduleEscapes.push(node.source.value);
      }
    },
    ExportDefaultDeclaration(node) {
      addParents(model, node, [node.declaration]);
    },
    ExportNamedDeclaration(node) {
      if (node.exportKind === 'type') {
        model.types.push(node);
        return;
      }
      if (node.declaration !== null) {
        exported.add(node.declaration);
        return;
      }
      for (const specifier of node.specifiers) {
        if (specifier.exportKind === 'type') {
          continue;
        }
        const name = text(specifier.exported);
        const local = text(specifier.local);
        if (name !== undefined && local !== undefined) {
          model.exports.set(name, node.source === null ? local : { imported: local, source: node.source.value });
        }
        model.nonReferences.add(specifier.exported.start);
      }
    },
    ExpressionStatement(node) {
      addParents(model, node, [node.expression]);
    },
    FunctionDeclaration: enterFunction,
    'FunctionDeclaration:exit'() {
      scopes.pop();
    },
    FunctionExpression: enterFunction,
    'FunctionExpression:exit'() {
      scopes.pop();
    },
    Identifier(node) {
      model.identifiers.push(node);
    },
    ImportDeclaration(node) {
      if (node.importKind === 'type') {
        model.types.push(node);
        return;
      }
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') {
          model.types.push(specifier);
          continue;
        }
        let imported = 'default';
        if (specifier.type === 'ImportSpecifier') {
          imported = text(specifier.imported) ?? '';
        } else if (specifier.type === 'ImportNamespaceSpecifier') {
          imported = '*';
        }
        if (imported !== undefined) {
          declare(specifier.local, 'import', parsed.program, undefined, false, { imported, source: node.source.value });
        }
        if (specifier.type === 'ImportSpecifier') {
          model.nonReferences.add(specifier.imported.start);
        }
      }
    },
    ImportExpression(node) {
      model.dynamicImports.push(node.source);
    },
    MemberExpression(node) {
      model.members.push(node);
      addParents(model, node, [node.object, node.property]);
      if (!node.computed) {
        model.nonReferences.add(node.property.start);
      }
    },
    NewExpression(node) {
      model.news.push(node);
      addParents(model, node, [node.callee, ...node.arguments]);
    },
    ObjectExpression(node) {
      addParents(model, node, node.properties);
    },
    Property(node) {
      addParents(model, node, [node.key, node.value]);
      if (!node.computed && !node.shorthand) {
        model.nonReferences.add(node.key.start);
      }
    },
    ReturnStatement(node) {
      model.returns.push(node);
      addParents(model, node, [node.argument]);
    },
    ThisExpression(node) {
      model.thises.push(node);
    },
    TSInterfaceDeclaration(node) {
      model.types.push(node);
    },
    TSTypeAliasDeclaration(node) {
      model.types.push(node);
    },
    TSTypeAnnotation(node) {
      model.types.push(node);
    },
    TSTypeQuery(node) {
      model.types.push(node);
    },
    TSTypeReference(node) {
      model.types.push(node);
    },
    UnaryExpression(node) {
      if (node.operator === 'delete') {
        model.writes.push(node.argument);
      }
    },
    UpdateExpression(node) {
      model.writes.push(node.argument);
    },
    VariableDeclaration(node) {
      for (const declaration of node.declarations) {
        declarationKinds.set(declaration, node.kind);
        if (exported.has(node)) {
          exported.add(declaration);
        }
      }
    },
    VariableDeclarator(node) {
      model.variables.push(node);
      addParents(model, node, [node.id, node.init]);
      for (const name of patternNames(node.id)) {
        declare(
          name,
          declarationKinds.get(node) === 'const' ? 'const' : 'mutable',
          variableScope(declarationKinds.get(node)),
          node.id.type === 'Identifier' && node.init !== null ? node.init : undefined,
          exported.has(node),
        );
        if (exported.has(node)) {
          model.exports.set(name.name, name.name);
        }
      }
    },
    YieldExpression(node) {
      model.yields.push(node);
      addParents(model, node, [node.argument]);
    },
  }).visit(parsed.program);
  model.runtimeReferences.push(
    ...model.identifiers.filter(
      (node) => !model.nonReferences.has(node.start) && !model.types.some((span) => inside(node, span)),
    ),
  );
  return model;
};
const references = (model: Model): readonly Identifier[] => model.runtimeReferences;
const bindingAt = (model: Model, name: string, at: Span): Binding | undefined => {
  const key = `${at.start}:${name}`;
  if (model.bindingCache.has(key)) {
    return model.bindingCache.get(key);
  }
  const candidates = model.bindings.filter((binding) => binding.name === name && inside(at, binding.scope));
  const result = narrowestBinding(candidates);
  model.bindingCache.set(key, result);
  return result;
};
const bindingReferences = (model: Model, binding: Binding): readonly Identifier[] => {
  const known = model.referenceCache.get(binding);
  if (known !== undefined) {
    return known;
  }
  const result = references(model).filter((node) => bindingAt(model, node.name, node) === binding);
  model.referenceCache.set(binding, result);
  return result;
};
const immutable = (model: Model, binding: Binding): boolean =>
  binding.kind !== 'mutable' &&
  binding.kind !== 'parameter' &&
  !bindingReferences(model, binding).some((node) => model.writes.some((write) => inside(node, write)));
const callOf = (model: Model, node: Span): CallExpression | undefined =>
  model.calls.find((call) => unwrap(call.callee) === node);
const closestFunction = (model: Model, node: Span): FunctionNode | undefined =>
  smallest(model.functions.filter((fn) => inside(node, fn)));

const nativeImportCohortClosed = (model: Model, source: string, exported: string): boolean => {
  if (model.dynamicImports.length !== 0) {
    return false;
  }
  return model.bindings
    .filter(
      (binding) =>
        binding.origin?.source === source && (binding.origin.imported === exported || binding.origin.imported === '*'),
    )
    .every(
      (binding) =>
        immutable(model, binding) &&
        ![...model.exports.values()].some((value) => value === binding.name) &&
        bindingReferences(model, binding).every((reference) => {
          const member = model.members.find((node) => node.object === reference && !node.computed && !node.optional);
          if (member === undefined) {
            return false;
          }
          return (
            binding.origin?.imported !== '*' ||
            propertyName(member) !== exported ||
            model.members.some((node) => node.object === member && !node.computed && !node.optional)
          );
        }),
    );
};
class FactProof {
  readonly authorizedReaders = new Set<CallExpression>();
  readonly models = new Map<string, Model | undefined>();
  readonly sources: ReadonlyMap<string, string>;
  readonly root: string;
  readonly path: Path.Path;
  readonly packageExports: ReadonlyMap<string, string>;
  constructor(
    sources: ReadonlyMap<string, string>,
    root: string,
    path: Path.Path,
    packageExports: ReadonlyMap<string, string>,
  ) {
    this.sources = sources;
    this.root = root;
    this.path = path;
    this.packageExports = packageExports;
  }
  model(file: string): Model | undefined {
    if (!this.models.has(file)) {
      const source = this.sources.get(file);
      this.models.set(file, source === undefined ? undefined : parseModel(file, source));
    }
    return this.models.get(file);
  }
  resolve(file: string, source: string): string | undefined {
    const exported = this.packageExports.get(source);
    if (exported !== undefined) {
      return this.sources.has(exported) ? exported : undefined;
    }
    if (!source.startsWith('./') && !source.startsWith('../')) {
      return undefined;
    }
    const base = this.path.resolve(this.path.dirname(file), source);
    return [base, `${base}.ts`, `${base}.mts`, this.path.join(base, 'index.ts')].find((candidate) =>
      this.sources.has(candidate),
    );
  }
  exported(file: string, name: string, seen = new Set<string>()): SymbolValue | undefined {
    const key = `${file}:${name}`;
    if (seen.has(key) || seen.size >= limit) {
      return undefined;
    }
    seen.add(key);
    const model = this.model(file);
    const target = model?.exports.get(name);
    if (model === undefined || target === undefined) {
      return undefined;
    }
    if (Schema.is(Schema.String)(target)) {
      const binding = bindingAt(model, target, model.program);
      return binding === undefined ? undefined : { binding, model };
    }
    const dependency = this.resolve(file, target.source);
    return dependency === undefined ? undefined : this.exported(dependency, target.imported, seen);
  }
  symbol(model: Model, node: Expression | Identifier): SymbolValue | undefined {
    const value = node.type === 'Identifier' ? node : unwrap(node);
    if (value.type !== 'Identifier') {
      return undefined;
    }
    const binding = bindingAt(model, value.name, value);
    if (binding === undefined || !immutable(model, binding)) {
      return undefined;
    }
    if (binding.origin === undefined) {
      return { binding, model };
    }
    const target = this.resolve(model.file, binding.origin.source);
    return target === undefined ? undefined : this.exported(target, binding.origin.imported);
  }
  named(model: Model, node: Expression, source: string, name: string): boolean {
    if (this.model(model.file) !== model || !nativeImportCohortClosed(model, source, name)) {
      return false;
    }
    const value = unwrap(node);
    if (value.type !== 'Identifier') {
      return false;
    }
    const binding = bindingAt(model, value.name, value);
    if (binding?.origin?.source !== source || binding.origin.imported !== name || !immutable(model, binding)) {
      return false;
    }
    return bindingReferences(model, binding).every((reference) => {
      const parent = model.parents.get(reference);
      return (
        parent !== undefined &&
        (callOf(model, reference) !== undefined ||
          parent === model.members.find((member) => member.object === reference))
      );
    });
  }
  native(model: Model, node: Expression, namespace: string, method: string): boolean {
    const value = unwrap(node);
    if (value.type !== 'MemberExpression' || value.optional || value.computed || propertyName(value) !== method) {
      return false;
    }
    return [
      'effect',
      'effect/http-api',
      '@modern-js/bff-effect/effect-client',
      '@modern-js/bff-effect/effect-edge',
    ].some((source) => this.named(model, value.object, source, namespace));
  }
}

interface PrivateResult {
  readonly declaration: AstClass;
  readonly field: string;
  readonly identityFields: readonly string[];
  readonly method: MethodDefinition;
  readonly property: Expression;
}
const coreSourcePath = (proof: FactProof, model: Model): boolean =>
  proof.path.relative(proof.root, model.file).replaceAll('\\', '/').startsWith('packages/core-runtime/src/');
const coreSource = (proof: FactProof, model: Model): boolean =>
  coreSourcePath(proof, model) &&
  nativeImportCohortClosed(model, 'effect', 'Effect') &&
  nativeImportCohortClosed(model, 'effect', 'Predicate');
const undefinedValue = (model: Model, node: Expression): boolean =>
  node.type === 'Identifier' && node.name === 'undefined' && bindingAt(model, node.name, node) === undefined;
const sameBinding = (model: Model, left: Value, right: Value): boolean =>
  left.type === 'Identifier' &&
  right.type === 'Identifier' &&
  bindingAt(model, left.name, left) === bindingAt(model, right.name, right) &&
  bindingAt(model, left.name, left) !== undefined;
const globalNamespace = (model: Model, name: string): boolean =>
  name === 'Set'
    ? hasClosedNativeGlobalConstructor(model.program, name)
    : hasClosedNativeObjectNamespace(model.program);
const globalMethod = (model: Model, node: Expression, name: string): boolean => {
  const callee = unwrap(node);
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    !callee.optional &&
    propertyName(callee) === name &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'Object' &&
    bindingAt(model, 'Object', callee.object) === undefined &&
    globalNamespace(model, 'Object')
  );
};
const soleReturn = (model: Model, fn: FunctionNode): Expression | undefined => {
  if (fn.body?.type !== 'BlockStatement') {
    return fn.body ?? undefined;
  }
  const returns = model.returns.filter((node) => closestFunction(model, node) === fn);
  const [returned] = returns;
  return returns.length === 1 && fn.body.body.at(-1) === returned && returned?.argument !== null
    ? returned?.argument
    : undefined;
};
const functionValue = (input: Expression | undefined): FunctionNode | undefined => {
  const node = input === undefined ? undefined : unwrap(input);
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression' ? node : undefined;
};
const parameter = (fn: FunctionNode, index: number): Identifier | undefined => {
  const node = fn.params.at(index);
  return node?.type === 'Identifier' ? node : undefined;
};
const privateAccess = (node: Expression, receiver?: Value): string | undefined => {
  const value = unwrap(node);
  return value.type === 'MemberExpression' &&
    !value.computed &&
    !value.optional &&
    value.property.type === 'PrivateIdentifier' &&
    (receiver === undefined ||
      (value.object.type === 'Identifier' && receiver.type === 'Identifier' && value.object.name === receiver.name))
    ? value.property.name
    : undefined;
};
const constructorMethod = (declaration: AstClass): MethodDefinition | undefined => {
  const member = declaration.body.body.find(
    (candidate) => candidate.type === 'MethodDefinition' && candidate.kind === 'constructor' && !candidate.static,
  );
  return member?.type === 'MethodDefinition' ? member : undefined;
};
const constructorParameterForField = (model: Model, declaration: AstClass, field: string): number | undefined => {
  const initializer = constructorMethod(declaration);
  const definition = declaration.body.body.find(
    (member) =>
      member.type === 'PropertyDefinition' && member.key.type === 'PrivateIdentifier' && member.key.name === field,
  );
  if (
    initializer === undefined ||
    definition?.type !== 'PropertyDefinition' ||
    definition.readonly !== true ||
    definition.value !== null
  ) {
    return undefined;
  }
  const writes = model.members.filter(
    (member) =>
      member.property.type === 'PrivateIdentifier' &&
      member.property.name === field &&
      model.writes.some((write) => inside(member, write)),
  );
  const [member] = writes;
  const assignment = member === undefined ? undefined : model.assignments.find((node) => node.left === member);
  if (
    writes.length !== 1 ||
    assignment === undefined ||
    assignment.operator !== '=' ||
    member?.object.type !== 'ThisExpression' ||
    !inside(assignment, initializer.value)
  ) {
    return undefined;
  }
  const index = initializer.value.params.findIndex(
    (param) =>
      param.type === 'Identifier' && assignment.right.type === 'Identifier' && param.name === assignment.right.name,
  );
  return index === -1 ? undefined : index;
};
const descriptorKey = (model: Model, input: Expression, receiver: Value): Expression | undefined => {
  const selected = unwrap(input);
  if (selected.type !== 'MemberExpression' || selected.computed || propertyName(selected) !== 'value') {
    return undefined;
  }
  const call = unwrap(selected.object);
  const [subject, property] = call.type === 'CallExpression' ? call.arguments : [];
  if (
    call.type !== 'CallExpression' ||
    call.optional ||
    call.arguments.length !== 2 ||
    !globalMethod(model, call.callee, 'getOwnPropertyDescriptor') ||
    subject === undefined ||
    subject.type === 'SpreadElement' ||
    !sameBinding(model, subject, receiver) ||
    property === undefined ||
    property.type === 'SpreadElement'
  ) {
    return undefined;
  }
  const key = property.type === 'Identifier' ? bindingAt(model, property.name, property) : undefined;
  return key?.init?.type === 'Literal' && Schema.is(Schema.String)(key.init.value) && immutable(model, key)
    ? property
    : undefined;
};
const descriptorProperty = (
  model: Model,
  fn: FunctionNode,
  receiver: Value,
): { readonly holder: Identifier; readonly property: Expression } | undefined => {
  if (fn.body?.type !== 'BlockStatement' || fn.body.body.length !== 2) {
    return undefined;
  }
  const [statement] = fn.body.body;
  const [declaration] = statement?.type === 'VariableDeclaration' ? statement.declarations : [];
  if (
    statement?.type !== 'VariableDeclaration' ||
    statement.kind !== 'const' ||
    statement.declarations.length !== 1 ||
    declaration?.id.type !== 'Identifier' ||
    declaration.init === null
  ) {
    return undefined;
  }
  const property = descriptorKey(model, declaration.init, receiver);
  return property === undefined ? undefined : { holder: declaration.id, property };
};
const privateIdentifierSchema = Schema.Struct({ name: Schema.String, type: Schema.Literal('PrivateIdentifier') });
const privateName = (node: Expression | PrivateIdentifier): string | undefined =>
  Schema.is(privateIdentifierSchema)(node) ? node.name : undefined;
const conjunction = (input: Expression, hops = 0): readonly Expression[] | undefined => {
  if (hops >= limit) {
    return undefined;
  }
  const node = unwrap(input);
  if (node.type !== 'LogicalExpression' || node.operator !== '&&') {
    return [node];
  }
  const left = conjunction(node.left, hops + 1);
  const right = conjunction(node.right, hops + 1);
  return left === undefined || right === undefined ? undefined : [...left, ...right];
};
const identityField = (
  model: Model,
  leaves: readonly Expression[],
  holder: Value,
  argument: Value,
): string | undefined => {
  for (const leaf of leaves) {
    if (leaf.type === 'BinaryExpression' && leaf.operator === '===' && privateName(leaf.left) === undefined) {
      const field = privateAccess(leaf.left, holder);
      if (field !== undefined && sameBinding(model, leaf.right, argument)) {
        return field;
      }
    }
  }
  return undefined;
};
const gateValue = (model: Model, input: Expression, fn: FunctionNode, holder: Value, hops = 0): boolean => {
  if (hops >= limit) {
    return false;
  }
  const node = unwrap(input);
  if (node.type === 'Literal') {
    return true;
  }
  if (node.type === 'Identifier') {
    return (
      sameBinding(model, node, holder) ||
      fn.params.some((param) => param.type === 'Identifier' && sameBinding(model, node, param)) ||
      undefinedValue(model, node)
    );
  }
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    !node.optional &&
    gateValue(model, node.object, fn, holder, hops + 1)
  );
};
const safeGateTerm = (proof: FactProof, model: Model, node: Expression, fn: FunctionNode, holder: Value): boolean => {
  if (node.type === 'CallExpression') {
    const [argument] = node.arguments;
    return (
      !node.optional &&
      node.arguments.length === 1 &&
      proof.native(model, node.callee, 'Predicate', 'isObject') &&
      argument !== undefined &&
      argument.type !== 'SpreadElement' &&
      sameBinding(model, argument, holder)
    );
  }
  if (node.type === 'BinaryExpression') {
    if (node.operator === 'in' && privateName(node.left) !== undefined) {
      return sameBinding(model, node.right, holder);
    }
    return (
      node.operator === '===' && gateValue(model, node.left, fn, holder) && gateValue(model, node.right, fn, holder)
    );
  }
  return node.type === 'MemberExpression' && privateAccess(node, holder) !== undefined;
};
const sealPredicate = (proof: FactProof, model: Model, leaves: readonly Expression[], holder: Value): boolean =>
  leaves.some((leaf) => {
    const [argument] = leaf.type === 'CallExpression' ? leaf.arguments : [];
    return (
      leaf.type === 'CallExpression' &&
      !leaf.optional &&
      leaf.arguments.length === 1 &&
      proof.native(model, leaf.callee, 'Predicate', 'isObject') &&
      argument !== undefined &&
      argument.type !== 'SpreadElement' &&
      sameBinding(model, argument, holder)
    );
  }) &&
  leaves.some(
    (leaf) =>
      leaf.type === 'BinaryExpression' &&
      leaf.operator === 'in' &&
      privateName(leaf.left) !== undefined &&
      sameBinding(model, leaf.right, holder),
  ) &&
  !leaves.some((leaf) => leaf.type === 'LogicalExpression' || leaf.type === 'ConditionalExpression');
const localStaticMethod = (
  proof: FactProof,
  model: Model,
  call: CallExpression,
): { readonly declaration: AstClass; readonly method: MethodDefinition } | undefined => {
  const callee = unwrap(call.callee);
  if (callee.type !== 'MemberExpression' || callee.computed || callee.optional || callee.object.type !== 'Identifier') {
    return undefined;
  }
  const symbol = proof.symbol(model, callee.object);
  const declaration =
    symbol?.model === model && !symbol.binding.exported
      ? model.classes.find((node) => node.id?.start === symbol.binding.node.start)
      : undefined;
  const method = declaration?.body.body.find(
    (node) =>
      node.type === 'MethodDefinition' &&
      node.static &&
      node.kind === 'method' &&
      node.key.type === 'Identifier' &&
      node.key.name === propertyName(callee),
  );
  return declaration !== undefined &&
    method?.type === 'MethodDefinition' &&
    !method.value.async &&
    !method.value.generator &&
    !call.optional &&
    call.arguments.length === method.value.params.length
    ? { declaration, method }
    : undefined;
};
const fieldReadClosed = (model: Model, declaration: AstClass, field: string, result: Expression): boolean =>
  model.members
    .filter(
      (member) =>
        member.property.type === 'PrivateIdentifier' && member.property.name === field && inside(member, declaration),
    )
    .every(
      (member) =>
        member === result ||
        (member.object.type === 'ThisExpression' && model.assignments.some((assignment) => assignment.left === member)),
    );
const uniqueStaticCall = (
  model: Model,
  declaration: AstClass,
  method: MethodDefinition,
  expected: CallExpression,
): boolean => {
  const binding = declaration.id === null ? undefined : bindingAt(model, declaration.id.name, declaration.id);
  if (binding === undefined || method.key.type !== 'Identifier') {
    return false;
  }
  const methodName = method.key.name;
  const calls = model.calls.filter(
    (call) =>
      call.callee.type === 'MemberExpression' &&
      !call.callee.computed &&
      call.callee.object.type === 'Identifier' &&
      bindingAt(model, call.callee.object.name, call.callee.object) === binding &&
      propertyName(call.callee) === methodName,
  );
  return calls.length === 1 && calls.at(0) === expected;
};
const privateResult = (proof: FactProof, model: Model, call: CallExpression): PrivateResult | undefined => {
  const local = localStaticMethod(proof, model, call);
  if (local === undefined) {
    return undefined;
  }
  const { declaration, method } = local;
  const first = parameter(method.value, 0);
  const descriptor = first === undefined ? undefined : descriptorProperty(model, method.value, first);
  const result = soleReturn(model, method.value);
  if (
    descriptor === undefined ||
    result?.type !== 'ConditionalExpression' ||
    !undefinedValue(model, result.alternate)
  ) {
    return undefined;
  }
  const field = privateAccess(result.consequent, descriptor.holder);
  const leaves = conjunction(result.test);
  if (
    field === undefined ||
    leaves === undefined ||
    !fieldReadClosed(model, declaration, field, unwrap(result.consequent)) ||
    !uniqueStaticCall(model, declaration, method, call) ||
    !sealPredicate(proof, model, leaves, descriptor.holder) ||
    !leaves.every((leaf) => safeGateTerm(proof, model, leaf, method.value, descriptor.holder))
  ) {
    return undefined;
  }
  const identityFields: string[] = [];
  for (let index = 0; index < method.value.params.length; index += 1) {
    const argument = parameter(method.value, index);
    const identity = argument === undefined ? undefined : identityField(model, leaves, descriptor.holder, argument);
    if (identity === undefined || constructorParameterForField(model, declaration, identity) === undefined) {
      return undefined;
    }
    identityFields.push(identity);
  }
  return { declaration, field, identityFields, method, property: descriptor.property };
};
const classInstances = (model: Model, declaration: AstClass): readonly NewExpression[] => {
  const binding = declaration.id === null ? undefined : bindingAt(model, declaration.id.name, declaration.id);
  if (binding === undefined || !immutable(model, binding) || !hasClosedClassConstructor(declaration, model.program)) {
    return [];
  }
  return model.news.filter(
    (node) => node.callee.type === 'Identifier' && bindingAt(model, node.callee.name, node.callee) === binding,
  );
};
const constructorAssignment = (statement: Statement, fn: FunctionNode): boolean => {
  if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'AssignmentExpression') {
    return false;
  }
  const assignment = statement.expression;
  const { right } = assignment;
  return (
    assignment.operator === '=' &&
    assignment.left.type === 'MemberExpression' &&
    assignment.left.object.type === 'ThisExpression' &&
    assignment.left.property.type === 'PrivateIdentifier' &&
    right.type === 'Identifier' &&
    fn.params.some((param) => param.type === 'Identifier' && param.name === right.name)
  );
};
const constructorClosed = (model: Model, declaration: AstClass): boolean => {
  const initializer = constructorMethod(declaration);
  if (initializer?.value.body?.type !== 'BlockStatement') {
    return false;
  }
  const statements = initializer.value.body.body;
  const frozen = statements.at(-1);
  const call = frozen?.type === 'ExpressionStatement' ? frozen.expression : undefined;
  const [receiver] = call?.type === 'CallExpression' ? call.arguments : [];
  if (
    call?.type !== 'CallExpression' ||
    !globalMethod(model, call.callee, 'freeze') ||
    call.arguments.length !== 1 ||
    receiver?.type !== 'ThisExpression'
  ) {
    return false;
  }
  return statements.slice(0, -1).every((statement) => constructorAssignment(statement, initializer.value));
};
const instanceAttachment = (
  model: Model,
  result: PrivateResult,
  instance: NewExpression,
): CallExpression | undefined => {
  const [identity] = result.identityFields;
  const index = identity === undefined ? undefined : constructorParameterForField(model, result.declaration, identity);
  const target = index === undefined ? undefined : instance.arguments.at(index);
  if (target === undefined || target.type === 'SpreadElement') {
    return undefined;
  }
  const attachments = model.calls.filter((call) => {
    if (!globalMethod(model, call.callee, 'defineProperty') || call.arguments.length !== 3) {
      return false;
    }
    const [receiver, property, descriptor] = call.arguments;
    if (
      receiver === undefined ||
      receiver.type === 'SpreadElement' ||
      property === undefined ||
      property.type === 'SpreadElement' ||
      descriptor?.type !== 'ObjectExpression' ||
      !sameBinding(model, receiver, target) ||
      !sameBinding(model, property, result.property)
    ) {
      return false;
    }
    const value = objectField(descriptor, 'value');
    const resolved = value?.type === 'Identifier' ? bindingAt(model, value.name, value)?.init : value;
    return resolved === instance;
  });
  return attachments.length === 1 ? attachments.at(0) : undefined;
};
interface InstanceValue {
  readonly attachment: CallExpression;
  readonly instance: NewExpression;
  readonly value: Expression;
}
const instanceArgument = (model: Model, result: PrivateResult): InstanceValue | undefined => {
  const instances = classInstances(model, result.declaration);
  const [instance] = instances;
  const index = constructorParameterForField(model, result.declaration, result.field);
  const value = index === undefined ? undefined : instance?.arguments.at(index);
  const attachment = instance === undefined ? undefined : instanceAttachment(model, result, instance);
  return instances.length === 1 &&
    instance !== undefined &&
    value !== undefined &&
    value.type !== 'SpreadElement' &&
    constructorClosed(model, result.declaration) &&
    attachment !== undefined
    ? { attachment, instance, value }
    : undefined;
};
const onlyBindingUsesWithin = (model: Model, binding: Binding, allowed: Span): boolean =>
  immutable(model, binding) && bindingReferences(model, binding).every((node) => inside(node, allowed));
const nativeSet = (model: Model, input: Expression): boolean => {
  const node = unwrap(input);
  return (
    node.type === 'NewExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'Set' &&
    bindingAt(model, 'Set', node.callee) === undefined &&
    globalNamespace(model, 'Set') &&
    node.arguments.length <= 1
  );
};
const ownedRecordField = (model: Model, input: Expression, field: string): Expression | undefined => {
  const call = unwrap(input);
  if (call.type !== 'CallExpression' || !globalMethod(model, call.callee, 'freeze') || call.arguments.length !== 1) {
    return undefined;
  }
  const [record] = call.arguments;
  if (record?.type !== 'ObjectExpression') {
    return undefined;
  }
  const last = record.properties.at(-1);
  return last?.type === 'Property' &&
    !last.computed &&
    !last.method &&
    last.kind === 'init' &&
    last.key.type === 'Identifier' &&
    last.key.name === field &&
    record.properties.filter(
      (node) => node.type === 'Property' && !node.computed && node.key.type === 'Identifier' && node.key.name === field,
    ).length === 1
    ? last.value
    : undefined;
};
const resolvedCall = (
  proof: FactProof,
  model: Model,
  input: Expression,
):
  | { readonly call: CallExpression; readonly fn: FunctionNode; readonly model: Model; readonly symbol: SymbolValue }
  | undefined => {
  const call = unwrap(input);
  if (call.type !== 'CallExpression' || call.optional) {
    return undefined;
  }
  const symbol = proof.symbol(model, call.callee);
  const fn = functionValue(symbol?.binding.init);
  return symbol === undefined ||
    fn === undefined ||
    fn.async ||
    fn.generator ||
    !immutable(symbol.model, symbol.binding) ||
    !coreSource(proof, symbol.model)
    ? undefined
    : { call, fn, model: symbol.model, symbol };
};
const optionalProvider = (model: Model, input: Expression): Expression | undefined => {
  const node = unwrap(input);
  if (node.type !== 'ConditionalExpression') {
    return node;
  }
  if (undefinedValue(model, node.consequent)) {
    return node.alternate;
  }
  if (undefinedValue(model, node.alternate)) {
    return node.consequent;
  }
  return undefined;
};
const moduleString = (model: Model, input: Expression, seen = new Set<Binding>(), hops = 0): string | undefined => {
  if (hops >= limit) {
    return undefined;
  }
  const node = unwrap(input);
  if (node.type === 'Literal') {
    return Schema.is(Schema.String)(node.value) ? node.value : undefined;
  }
  if (node.type === 'Identifier') {
    const binding = bindingAt(model, node.name, node);
    return binding?.init !== undefined && immutable(model, binding) && !seen.has(binding)
      ? moduleString(model, binding.init, new Set(seen).add(binding), hops + 1)
      : undefined;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = moduleString(model, node.left, seen, hops + 1);
    const right = moduleString(model, node.right, seen, hops + 1);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (node.type !== 'TemplateLiteral') {
    return undefined;
  }
  let result = '';
  for (const [index, quasi] of node.quasis.entries()) {
    const expression = node.expressions.at(index);
    const value = expression === undefined ? '' : moduleString(model, expression, seen, hops + 1);
    if (value === undefined || quasi.value.cooked === null) {
      return undefined;
    }
    result += quasi.value.cooked + value;
  }
  return result;
};
const sameResolvedSymbol = (left: SymbolValue | undefined, right: SymbolValue): boolean =>
  left?.binding === right.binding && left.model === right.model;
const readerConsumersClosed = (
  proof: FactProof,
  provider: SymbolValue,
  expected: Model,
  expectedCall: CallExpression,
): boolean => {
  if (bindingReferences(provider.model, provider.binding).length !== 0) {
    return false;
  }
  for (const [file, source] of proof.sources) {
    if (
      /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?tsx?$/u.test(file) ||
      (!source.includes('import') && !source.includes('export'))
    ) {
      continue;
    }
    const model = proof.model(file);
    if (
      model === undefined ||
      model.moduleEscapes.some((value) => proof.resolve(file, value) === provider.model.file) ||
      model.dynamicImports.some((node) => {
        const value = moduleString(model, node);
        return value === undefined ? coreSourcePath(proof, model) : proof.resolve(file, value) === provider.model.file;
      })
    ) {
      return false;
    }
    for (const binding of model.bindings) {
      if (binding.origin === undefined) {
        continue;
      }
      const dependency = proof.resolve(file, binding.origin.source);
      const imported = dependency === undefined ? undefined : proof.exported(dependency, binding.origin.imported);
      if (
        (binding.origin.imported === '*' && dependency === provider.model.file) ||
        (sameResolvedSymbol(imported, provider) &&
          (model !== expected || !bindingReferences(model, binding).every((node) => expectedCall.callee === node)))
      ) {
        return false;
      }
    }
    if (
      [...model.exports.values()].some((entry) => {
        if (Schema.is(Schema.String)(entry)) {
          return false;
        }
        const dependency = proof.resolve(file, entry.source);
        return dependency !== undefined && sameResolvedSymbol(proof.exported(dependency, entry.imported), provider);
      })
    ) {
      return false;
    }
  }
  return true;
};
const readerReturn = (
  proof: FactProof,
  provider: NonNullable<ReturnType<typeof resolvedCall>>,
  consumer: Model,
): CallExpression | undefined => {
  const returned = soleReturn(provider.model, provider.fn);
  const receiver = parameter(provider.fn, 0);
  const [argument] = returned?.type === 'CallExpression' ? returned.arguments : [];
  return returned?.type === 'CallExpression' &&
    provider.fn.params.length === 1 &&
    returned.arguments.length === 1 &&
    provider.call.arguments.length === 1 &&
    argument !== undefined &&
    argument.type !== 'SpreadElement' &&
    receiver !== undefined &&
    sameBinding(provider.model, argument, receiver) &&
    readerConsumersClosed(proof, provider.symbol, consumer, provider.call)
    ? returned
    : undefined;
};
const privateVoidClose = (method: MethodDefinition): boolean => {
  const [statement] = method.value.body?.type === 'BlockStatement' ? method.value.body.body : [];
  const assignment =
    statement?.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression'
      ? statement.expression
      : undefined;
  return (
    !method.value.async &&
    !method.value.generator &&
    method.value.body?.type === 'BlockStatement' &&
    method.value.body.body.length === 1 &&
    assignment?.operator === '=' &&
    assignment.left.type === 'MemberExpression' &&
    assignment.left.object.type === 'ThisExpression' &&
    assignment.left.property.type === 'PrivateIdentifier' &&
    assignment.right.type === 'Literal' &&
    assignment.right.value === false
  );
};
const closingMethod = (model: Model, call: CallExpression, instance: NewExpression): boolean => {
  const { callee } = call;
  if (
    callee.type !== 'MemberExpression' ||
    callee.computed ||
    callee.optional ||
    callee.object.type !== 'Identifier' ||
    call.arguments.length !== 0 ||
    instance.callee.type !== 'Identifier'
  ) {
    return false;
  }
  const binding = bindingAt(model, callee.object.name, callee.object);
  const { name } = instance.callee;
  const declaration = model.classes.find((node) => node.id?.name === name);
  const method = declaration?.body.body.find(
    (node) =>
      node.type === 'MethodDefinition' &&
      !node.static &&
      node.key.type === 'Identifier' &&
      node.key.name === propertyName(callee),
  );
  return binding?.init === instance && method?.type === 'MethodDefinition' && privateVoidClose(method);
};
const producerClosed = (proof: FactProof, model: Model, value: InstanceValue): boolean => {
  const producer = closestFunction(model, value.instance);
  if (
    producer === undefined ||
    producer.async ||
    producer.generator ||
    model.writes.some((write) => inside(write, producer))
  ) {
    return false;
  }
  return (
    model.calls
      .filter((call) => inside(call, producer))
      .every(
        (call) =>
          call === value.attachment ||
          globalMethod(model, call.callee, 'freeze') ||
          proof.authorizedReaders.has(call) ||
          closingMethod(model, call, value.instance),
      ) &&
    model.news
      .filter((node) => inside(node, producer))
      .every((node) => node === value.instance || nativeSet(model, node))
  );
};
const sealedRecordSet = (proof: FactProof, model: Model, object: Expression, field: string, allowed: Span): boolean => {
  if (object.type !== 'Identifier') {
    return false;
  }
  const binding = bindingAt(model, object.name, object);
  if (binding?.init === undefined || !onlyBindingUsesWithin(model, binding, allowed)) {
    return false;
  }
  const source = optionalProvider(model, binding.init);
  const provider = source === undefined ? undefined : resolvedCall(proof, model, source);
  const returned = provider === undefined ? undefined : readerReturn(proof, provider, model);
  if (provider === undefined || returned === undefined) {
    return false;
  }
  const result = privateResult(proof, provider.model, returned);
  const instance = result === undefined ? undefined : instanceArgument(provider.model, result);
  const projected = instance === undefined ? undefined : ownedRecordField(provider.model, instance.value, field);
  const proved =
    projected !== undefined &&
    nativeSet(provider.model, projected) &&
    instance !== undefined &&
    producerClosed(proof, provider.model, instance);
  if (proved) {
    proof.authorizedReaders.add(provider.call);
  }
  return proved;
};
const collectionValue = (proof: FactProof, model: Model, input: Expression, allowed: Span, hops = 0): boolean => {
  if (hops >= limit) {
    return false;
  }
  const node = unwrap(input);
  if (nativeSet(model, node)) {
    return true;
  }
  if (node.type === 'Identifier') {
    const binding = bindingAt(model, node.name, node);
    return (
      binding?.init !== undefined &&
      onlyBindingUsesWithin(model, binding, allowed) &&
      collectionValue(proof, model, binding.init, binding.init, hops + 1)
    );
  }
  if (node.type === 'ConditionalExpression') {
    return (
      collectionValue(proof, model, node.consequent, node, hops + 1) &&
      collectionValue(proof, model, node.alternate, node, hops + 1)
    );
  }
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    !node.optional &&
    node.property.type === 'Identifier' &&
    sealedRecordSet(proof, model, node.object, node.property.name, allowed)
  );
};
const failureGuard = (
  proof: FactProof,
  model: Model,
  statement: Statement,
  collection: Value,
  forbidden: readonly Value[],
): boolean => {
  if (
    statement.type !== 'IfStatement' ||
    statement.alternate !== null ||
    statement.test.type !== 'BinaryExpression' ||
    statement.test.operator !== '===' ||
    privateName(statement.test.left) !== undefined ||
    !sameBinding(model, statement.test.left, collection) ||
    !undefinedValue(model, statement.test.right) ||
    statement.consequent.type !== 'BlockStatement'
  ) {
    return false;
  }
  const [returned] = statement.consequent.body;
  const call =
    returned?.type === 'ReturnStatement' && returned.argument !== null ? unwrap(returned.argument) : undefined;
  return (
    statement.consequent.body.length === 1 &&
    call?.type === 'CallExpression' &&
    !call.optional &&
    proof.native(model, call.callee, 'Effect', 'fail') &&
    !references(model).some((node) => inside(node, call) && forbidden.some((param) => sameBinding(model, node, param)))
  );
};
interface BooleanFactParameters {
  readonly scope: Identifier;
  readonly transaction: Identifier;
  readonly workloadKey: Identifier;
}
interface BooleanFactBody {
  readonly collection: Identifier;
  readonly guard: Statement;
  readonly read: CallExpression;
  readonly success: Expression;
}
const booleanProgram = (
  proof: FactProof,
  model: Model,
  fn: FunctionNode,
): { readonly parameters: BooleanFactParameters; readonly program: FunctionNode } | undefined => {
  const [transaction, scope, workloadKey] = [parameter(fn, 0), parameter(fn, 1), parameter(fn, 2)];
  const effect = soleReturn(model, fn);
  const [program] = effect?.type === 'CallExpression' ? effect.arguments : [];
  if (
    transaction === undefined ||
    scope === undefined ||
    workloadKey === undefined ||
    effect?.type !== 'CallExpression' ||
    effect.optional ||
    !proof.native(model, effect.callee, 'Effect', 'suspend') ||
    effect.arguments.length !== 1 ||
    (program?.type !== 'ArrowFunctionExpression' && program?.type !== 'FunctionExpression') ||
    program.params.length !== 0 ||
    program.async ||
    program.generator
  ) {
    return undefined;
  }
  return { parameters: { scope, transaction, workloadKey }, program };
};
const booleanBody = (program: FunctionNode): BooleanFactBody | undefined => {
  if (program.body?.type !== 'BlockStatement' || program.body.body.length !== 3) {
    return undefined;
  }
  const [declaration, guard, returned] = program.body.body;
  const [collection] = declaration?.type === 'VariableDeclaration' ? declaration.declarations : [];
  return declaration?.type === 'VariableDeclaration' &&
    declaration.kind === 'const' &&
    declaration.declarations.length === 1 &&
    collection?.id.type === 'Identifier' &&
    collection.init?.type === 'CallExpression' &&
    guard !== undefined &&
    returned?.type === 'ReturnStatement' &&
    returned.argument !== null
    ? { collection: collection.id, guard, read: collection.init, success: returned.argument }
    : undefined;
};
const authenticCollection = (
  proof: FactProof,
  model: Model,
  body: BooleanFactBody,
  parameters: BooleanFactParameters,
): boolean => {
  const [transaction, scope] = body.read.arguments;
  const result = privateResult(proof, model, body.read);
  const instance = result === undefined ? undefined : instanceArgument(model, result);
  return (
    instance !== undefined &&
    transaction !== undefined &&
    transaction.type !== 'SpreadElement' &&
    scope !== undefined &&
    scope.type !== 'SpreadElement' &&
    sameBinding(model, parameters.transaction, transaction) &&
    sameBinding(model, parameters.scope, scope) &&
    collectionValue(proof, model, instance.value, instance.instance) &&
    producerClosed(proof, model, instance) &&
    failureGuard(proof, model, body.guard, body.collection, [parameters.transaction, parameters.scope, body.collection])
  );
};
const booleanHasResult = (proof: FactProof, model: Model, body: BooleanFactBody, workloadKey: Identifier): boolean => {
  const success = unwrap(body.success);
  const [fact] = success.type === 'CallExpression' ? success.arguments : [];
  const [key] = fact?.type === 'CallExpression' ? fact.arguments : [];
  return (
    success.type === 'CallExpression' &&
    !success.optional &&
    success.arguments.length === 1 &&
    proof.native(model, success.callee, 'Effect', 'succeed') &&
    fact?.type === 'CallExpression' &&
    !fact.optional &&
    fact.arguments.length === 1 &&
    fact.callee.type === 'MemberExpression' &&
    !fact.callee.computed &&
    !fact.callee.optional &&
    propertyName(fact.callee) === 'has' &&
    sameBinding(model, fact.callee.object, body.collection) &&
    key !== undefined &&
    key.type !== 'SpreadElement' &&
    sameBinding(model, key, workloadKey)
  );
};
/** Proves a primitive fact through its actual private seal and native Set construction, never a structural interface. */
export const provesScopedCoreBooleanFact = (
  sources: ReadonlyMap<string, string>,
  root: string,
  path: Path.Path,
  packageExports: ReadonlyMap<string, string>,
  resolvedFile: string,
  resolvedImplementationSpan: Span,
): boolean => {
  const proof = new FactProof(sources, root, path, packageExports);
  const model = proof.model(resolvedFile);
  if (model === undefined || !coreSource(proof, model)) {
    return false;
  }
  const binding = model.bindings.find(
    (candidate) =>
      candidate.init?.start === resolvedImplementationSpan.start &&
      candidate.init.end === resolvedImplementationSpan.end,
  );
  const fn = functionValue(binding?.init);
  if (
    binding === undefined ||
    !binding.exported ||
    !immutable(model, binding) ||
    fn?.type !== 'ArrowFunctionExpression' ||
    fn.body.type === 'BlockStatement' ||
    fn.async ||
    fn.generator ||
    fn.params.length !== 3
  ) {
    return false;
  }
  const configured = booleanProgram(proof, model, fn);
  const body = configured === undefined ? undefined : booleanBody(configured.program);
  return (
    configured !== undefined &&
    body !== undefined &&
    authenticCollection(proof, model, body, configured.parameters) &&
    booleanHasResult(proof, model, body, configured.parameters.workloadKey)
  );
};
