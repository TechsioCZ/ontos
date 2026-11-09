import { Schema } from 'effect';
import type { Path } from 'effect';
import { parseSync, Visitor } from 'oxc-parser';
import type {
  ArrowFunctionExpression,
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
  ObjectExpression,
  ParamPattern,
  Program,
  ReturnStatement,
  Span,
  VariableDeclarator,
  YieldExpression,
} from 'oxc-parser';

type Identifier = BindingIdentifier | IdentifierName | IdentifierReference;
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
  readonly nonReferences: Set<number>;
  readonly parents: Map<Span, Span>;
  readonly program: Program;
  readonly referenceCache: Map<Binding, readonly Identifier[]>;
  readonly returns: ReturnStatement[];
  readonly runtimeReferences: Identifier[];
  readonly source: string;
  readonly types: Span[];
  readonly variables: VariableDeclarator[];
  readonly writes: Span[];
  readonly yields: YieldExpression[];
}
interface SymbolValue {
  readonly binding: Binding;
  readonly model: Model;
}
interface RoleSpan {
  readonly model: Model;
  readonly span: Span;
}
const limit = 64;
const coreDatabaseExport = '@app/core-runtime/db/client';
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
    nonReferences: new Set(),
    parents: new Map(),
    program: parsed.program,
    referenceCache: new Map(),
    returns: [],
    runtimeReferences: [],
    source,
    types: [],
    variables: [],
    writes: [],
    yields: [],
  };
  const scopes: Span[] = [parsed.program];
  const declarationKinds = new Map<VariableDeclarator, string>();
  const exported = new Set<Span>();
  const currentScope = (): Span => scopes.at(-1) ?? parsed.program;
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
    ClassDeclaration(node) {
      model.classes.push(node);
      if (node.id !== null) {
        declare(node.id, 'const', currentScope(), undefined, exported.has(node));
        if (exported.has(node)) {
          model.exports.set(node.id.name, node.id.name);
        }
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
          currentScope(),
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

class IssuerProof {
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
    if (this.model(model.file) !== model) {
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

const sameSymbol = (left: SymbolValue | undefined, right: SymbolValue | undefined): boolean =>
  left !== undefined && right !== undefined && left.model === right.model && left.binding === right.binding;
const callableSpan = (model: Model, binding: Binding): Span | undefined => {
  if (binding.init !== undefined) {
    return binding.init;
  }
  return model.functions.find((fn) => fn.type !== 'ArrowFunctionExpression' && fn.id?.start === binding.node.start);
};
const immutableConstInitializer = (symbol: SymbolValue): Expression | undefined =>
  symbol.binding.kind === 'const' && immutable(symbol.model, symbol.binding) ? symbol.binding.init : undefined;
const usedOnlyAt = (model: Model, reference: IdentifierReference): boolean => {
  const binding = bindingAt(model, reference.name, reference);
  const uses = binding === undefined ? [] : bindingReferences(model, binding);
  return uses.length === 1 && uses[0] === reference;
};

const baseGroup = (
  proof: IssuerProof,
  model: Model,
  input: Expression,
  hops = 0,
  append = false,
): string | undefined => {
  if (hops >= limit) {
    return undefined;
  }
  const node = unwrap(input);
  if (node.type === 'Identifier' && !append) {
    const target = proof.symbol(model, node);
    return target?.binding.init === undefined
      ? undefined
      : baseGroup(proof, target.model, target.binding.init, hops + 1);
  }
  if (
    node.type !== 'CallExpression' ||
    node.optional ||
    (append && node.arguments.some((arg) => arg.type === 'SpreadElement'))
  ) {
    return undefined;
  }
  const callee = unwrap(node.callee);
  if (proof.native(model, callee, 'HttpApiGroup', 'make')) {
    return node.arguments[0]?.type === 'Literal' ? text(node.arguments[0]) : undefined;
  }
  return callee.type === 'MemberExpression' &&
    !callee.optional &&
    !callee.computed &&
    ['add', 'annotate', 'middleware', 'prefix'].includes(propertyName(callee) ?? '')
    ? baseGroup(proof, model, callee.object, hops + 1, append)
    : undefined;
};
const nativeContractHasGateway = (proof: IssuerProof, contract: SymbolValue, gateway: SymbolValue): boolean => {
  let node = contract.binding.init === undefined ? undefined : unwrap(contract.binding.init);
  let hits = 0;
  for (let hop = 0; hop < limit && node !== undefined; hop += 1) {
    if (node.type !== 'CallExpression' || node.optional) {
      return false;
    }
    if (proof.native(contract.model, node.callee, 'HttpApi', 'make')) {
      return hits === 1;
    }
    const callee = unwrap(node.callee);
    if (
      callee.type !== 'MemberExpression' ||
      callee.optional ||
      callee.computed ||
      !['add', 'annotate', 'prefix'].includes(propertyName(callee) ?? '')
    ) {
      return false;
    }
    if (propertyName(callee) === 'add') {
      for (const argument of node.arguments) {
        if (argument.type === 'SpreadElement') {
          return false;
        }
        if (sameSymbol(proof.symbol(contract.model, argument), gateway)) {
          hits += 1;
        } else if (baseGroup(proof, contract.model, argument) === 'gatewayContext') {
          return false;
        }
      }
    }
    node = unwrap(callee.object);
  }
  return false;
};

const layerTransform = (proof: IssuerProof, model: Model, input: Expression): boolean => {
  const node = unwrap(input);
  if (proof.native(model, node, 'Layer', 'orDie')) {
    return true;
  }
  return (
    node.type === 'CallExpression' &&
    !node.optional &&
    node.arguments.length === 1 &&
    ['provide', 'provideMerge'].some((method) => proof.native(model, node.callee, 'Layer', method))
  );
};
interface LayerDependency {
  readonly consumers: readonly Expression[];
  readonly provider: Expression;
}
interface LayerFlow {
  readonly dependencies: readonly LayerDependency[];
  readonly outputs: readonly Expression[];
}
const pipeLayerFlow = (
  proof: IssuerProof,
  model: Model,
  call: CallExpression,
  receiver: Expression,
): LayerFlow | undefined => {
  const outputs = [receiver];
  const dependencies: LayerDependency[] = [];
  for (const argument of call.arguments) {
    if (argument.type === 'SpreadElement' || !layerTransform(proof, model, argument)) {
      return undefined;
    }
    const transform = unwrap(argument);
    if (transform.type === 'CallExpression') {
      const [provider] = transform.arguments;
      if (provider === undefined || provider.type === 'SpreadElement') {
        return undefined;
      }
      dependencies.push({ consumers: [...outputs], provider });
      if (proof.native(model, transform.callee, 'Layer', 'provideMerge')) {
        outputs.push(provider);
      }
    }
  }
  return { dependencies, outputs };
};
const layerFlow = (proof: IssuerProof, model: Model, node: Expression): LayerFlow | undefined => {
  if (
    node.type !== 'CallExpression' ||
    node.optional ||
    node.arguments.some((argument) => argument.type === 'SpreadElement')
  ) {
    return undefined;
  }
  const callee = unwrap(node.callee);
  if (callee.type === 'MemberExpression' && !callee.computed && !callee.optional && propertyName(callee) === 'pipe') {
    return pipeLayerFlow(proof, model, node, callee.object);
  }
  const operands: Expression[] = node.arguments.filter((argument) => argument.type !== 'SpreadElement');
  if (['merge', 'mergeAll'].some((method) => proof.native(model, callee, 'Layer', method))) {
    return { dependencies: [], outputs: operands };
  }
  const [consumer, provider] = operands;
  if (operands.length !== 2 || consumer === undefined || provider === undefined) {
    return undefined;
  }
  if (proof.native(model, callee, 'Layer', 'provide')) {
    return { dependencies: [{ consumers: [consumer], provider }], outputs: [consumer] };
  }
  return proof.native(model, callee, 'Layer', 'provideMerge')
    ? { dependencies: [{ consumers: [consumer], provider }], outputs: [consumer, provider] }
    : undefined;
};
/** Native Layer.provide consumes a dependency; only merge/provideMerge publish it. */
const layerContains = (
  proof: IssuerProof,
  model: Model,
  input: Expression,
  target: SymbolValue,
  seen = new Set<Binding>(),
  hops = 0,
): boolean => {
  if (hops >= limit) {
    return false;
  }
  const node = unwrap(input);
  if (node.type === 'Identifier') {
    const symbol = proof.symbol(model, node);
    if (sameSymbol(symbol, target)) {
      return true;
    }
    return (
      symbol?.binding.init !== undefined &&
      !seen.has(symbol.binding) &&
      layerContains(proof, symbol.model, symbol.binding.init, target, new Set(seen).add(symbol.binding), hops + 1)
    );
  }
  return (
    layerFlow(proof, model, node)?.outputs.some((output) =>
      layerContains(proof, model, output, target, seen, hops + 1),
    ) ?? false
  );
};
const layerProvides = (
  proof: IssuerProof,
  model: Model,
  input: Expression,
  consumer: SymbolValue,
  provider: SymbolValue,
  seen = new Set<Binding>(),
  hops = 0,
): boolean => {
  if (hops >= limit) {
    return false;
  }
  const node = unwrap(input);
  if (node.type === 'Identifier') {
    const symbol = proof.symbol(model, node);
    return (
      symbol?.binding.init !== undefined &&
      !seen.has(symbol.binding) &&
      layerProvides(
        proof,
        symbol.model,
        symbol.binding.init,
        consumer,
        provider,
        new Set(seen).add(symbol.binding),
        hops + 1,
      )
    );
  }
  const flow = layerFlow(proof, model, node);
  return (
    flow !== undefined &&
    (flow.dependencies.some(
      (edge) =>
        edge.consumers.some((value) => layerContains(proof, model, value, consumer)) &&
        layerContains(proof, model, edge.provider, provider),
    ) ||
      flow.outputs.some((value) => layerProvides(proof, model, value, consumer, provider, seen, hops + 1)))
  );
};
interface IssuerRoot {
  readonly assembly: CallExpression;
  readonly contract: SymbolValue;
  readonly factory: FunctionNode;
  readonly handlers: Expression;
  readonly model: Model;
  readonly owner: string;
  readonly spans: readonly RoleSpan[];
}
const closedRuntimeTuple = (proof: IssuerProof, model: Model, input: Expression): boolean => {
  const tuple = proof.symbol(model, input);
  const value = tuple?.binding.init === undefined ? undefined : unwrap(tuple.binding.init);
  if (value?.type !== 'CallExpression' || value.arguments.length !== 1) {
    return false;
  }
  const callee = unwrap(value.callee);
  const [array] = value.arguments;
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    propertyName(callee) === 'freeze' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'Object' &&
    bindingAt(model, 'Object', callee.object) === undefined &&
    array !== undefined &&
    array.type !== 'SpreadElement' &&
    unwrap(array).type === 'ArrayExpression'
  );
};
const synchronousFactory = (node: Expression | undefined): FunctionNode | undefined =>
  (node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression') && !node.async && !node.generator
    ? node
    : undefined;
const rootFactory = (proof: IssuerProof, model: Model): FunctionNode | undefined => {
  const declaration = model.program.body.find((node) => node.type === 'ExportDefaultDeclaration');
  if (declaration?.type !== 'ExportDefaultDeclaration' || declaration.declaration.type !== 'Identifier') {
    return undefined;
  }
  const runtime = proof.symbol(model, declaration.declaration);
  const call = runtime?.binding.init === undefined ? undefined : unwrap(runtime.binding.init);
  if (call?.type !== 'CallExpression' || call.optional) {
    return undefined;
  }
  const factory = proof.symbol(model, call.callee);
  const fn = synchronousFactory(factory?.binding.init === undefined ? undefined : unwrap(factory.binding.init));
  if (factory?.model !== model || !factory.binding.exported || fn === undefined) {
    return undefined;
  }
  return call.arguments.length === 1 &&
    call.arguments.every(
      (argument) => argument.type === 'SpreadElement' && closedRuntimeTuple(proof, model, argument.argument),
    )
    ? fn
    : undefined;
};
const groupCall = (
  proof: IssuerProof,
  model: Model,
  binding: Binding,
  contract: SymbolValue,
  name: string,
): CallExpression | undefined => {
  const call = binding.init === undefined ? undefined : unwrap(binding.init);
  return call?.type === 'CallExpression' &&
    !call.optional &&
    call.arguments.length === 3 &&
    proof.native(model, call.callee, 'HttpApiBuilder', 'group') &&
    call.arguments[0]?.type !== 'SpreadElement' &&
    call.arguments[0] !== undefined &&
    sameSymbol(proof.symbol(model, call.arguments[0]), contract) &&
    call.arguments[1]?.type === 'Literal' &&
    text(call.arguments[1]) === name
    ? call
    : undefined;
};
const endpointLink = (
  node: Expression,
  endpoints: Set<string>,
): { readonly handler: FunctionNode; readonly receiver: Expression } | undefined => {
  if (node.type !== 'CallExpression' || node.optional || node.arguments.length !== 2) {
    return undefined;
  }
  const callee = unwrap(node.callee);
  const [name, handler] = node.arguments;
  if (
    callee.type !== 'MemberExpression' ||
    callee.optional ||
    callee.computed ||
    propertyName(callee) !== 'handle' ||
    name?.type !== 'Literal' ||
    !endpoints.delete(text(name) ?? '') ||
    (handler?.type !== 'ArrowFunctionExpression' && handler?.type !== 'FunctionExpression')
  ) {
    return undefined;
  }
  return { handler, receiver: callee.object };
};
const endpointCallbacks = (model: Model, call: CallExpression): readonly RoleSpan[] => {
  const callback = call.arguments.at(2);
  if (callback?.type !== 'ArrowFunctionExpression' && callback?.type !== 'FunctionExpression') {
    return [];
  }
  const [parameter] = callback.params;
  if (parameter?.type !== 'Identifier' || callback.body === null || callback.body.type === 'BlockStatement') {
    return [];
  }
  const endpoints = new Set(['issueGatewayContext', 'issueApiKeyGatewayContext', 'issueDelegatedGatewayContext']);
  const spans: RoleSpan[] = [];
  let node = unwrap(callback.body);
  for (let hop = 0; hop < limit; hop += 1) {
    if (node.type === 'Identifier') {
      return node.name === parameter.name && spans.length === 3 && endpoints.size === 0 ? spans : [];
    }
    const link = endpointLink(node, endpoints);
    if (link === undefined) {
      return [];
    }
    spans.push({ model, span: link.handler });
    node = unwrap(link.receiver);
  }
  return [];
};
const publishedGateway = (
  proof: IssuerProof,
): { readonly gateway: SymbolValue; readonly owner: string } | undefined => {
  const shared = proof.packageExports.get('@app/shared-contracts');
  if (shared === undefined) {
    return undefined;
  }
  const gateway = proof.exported(shared, 'GatewayContextApiGroup');
  const metadata = proof.exported(shared, 'shellGatewayContextContract');
  if (
    gateway === undefined ||
    metadata?.binding.init === undefined ||
    !proof.path
      .relative(proof.root, gateway.model.file)
      .replaceAll('\\', '/')
      .startsWith('packages/shared-contracts/src/')
  ) {
    return undefined;
  }
  const contractMetadata = unwrap(metadata.binding.init);
  const ownerValue =
    contractMetadata.type === 'ObjectExpression' ? objectField(contractMetadata, 'ownerId') : undefined;
  const owner = ownerValue?.type === 'Literal' ? text(ownerValue) : undefined;
  if (
    owner === undefined ||
    owner.includes('/') ||
    gateway.binding.init === undefined ||
    baseGroup(proof, gateway.model, gateway.binding.init) !== 'gatewayContext'
  ) {
    return undefined;
  }
  return { gateway, owner };
};
const soleDirectReturn = (model: Model, fn: FunctionNode): ReturnStatement | undefined => {
  const returns = model.returns.filter((node) => closestFunction(model, node) === fn);
  const [returned] = returns;
  return returns.length === 1 && fn.body?.type === 'BlockStatement' && fn.body.body.at(-1) === returned
    ? returned
    : undefined;
};
const runtimeAssembly = (proof: IssuerProof, model: Model, factory: FunctionNode): CallExpression | undefined => {
  const returned = soleDirectReturn(model, factory);
  const call = returned?.argument === undefined || returned.argument === null ? undefined : unwrap(returned.argument);
  return call?.type === 'CallExpression' &&
    proof.named(model, call.callee, '@modern-js/bff-effect/assembly', 'assembleEffectBffRuntime') &&
    call.arguments.length === 1 &&
    call.arguments[0]?.type === 'ObjectExpression'
    ? call
    : undefined;
};
const testSource = (file: string): boolean =>
  /(?:^|\/)(?:tests?|__tests__)\//u.test(file) || /\.(?:test|spec)\.[cm]?tsx?$/u.test(file);
const authorized = (spans: readonly RoleSpan[], model: Model, node: Span): boolean =>
  spans.some((entry) => entry.model === model && inside(node, entry.span));
const callClosure = (proof: IssuerProof, root: IssuerRoot, initial: readonly RoleSpan[]): readonly RoleSpan[] => {
  const spans = [...initial];
  const seen = new Set<Binding>();
  const owner = proof.path.join(proof.root, 'apps', root.owner) + proof.path.sep;
  for (let index = 0; index < spans.length && index < 512; index += 1) {
    const current = spans[index];
    if (current === undefined) {
      continue;
    }
    for (const reference of references(current.model)) {
      const target =
        inside(reference, current.span) && callOf(current.model, reference) !== undefined
          ? proof.symbol(current.model, reference)
          : undefined;
      if (target === undefined || seen.has(target.binding) || !target.model.file.startsWith(owner)) {
        continue;
      }
      seen.add(target.binding);
      const span = callableSpan(target.model, target.binding);
      if (span !== undefined) {
        spans.push({ model: target.model, span });
      }
    }
  }
  return spans.length < 512 ? spans : [];
};
const sourceImports = (
  proof: IssuerProof,
  file: string,
): readonly { readonly binding: Binding; readonly model: Model }[] | undefined => {
  const imported: { binding: Binding; model: Model }[] = [];
  for (const [consumer, source] of proof.sources) {
    if (testSource(consumer) || !source.includes('import')) {
      continue;
    }
    const model = proof.model(consumer);
    if (model === undefined) {
      return undefined;
    }
    for (const binding of model.bindings) {
      if (binding.origin !== undefined && proof.resolve(consumer, binding.origin.source) === file) {
        imported.push({ binding, model });
      }
    }
  }
  return imported;
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
const moduleReferencesConfined = (proof: IssuerProof, model: Model, reexports: (name: string) => boolean): boolean => {
  for (const [consumer, source] of proof.sources) {
    if (testSource(consumer) || (!source.includes('export') && !source.includes('import'))) {
      continue;
    }
    const other = proof.model(consumer);
    if (other === undefined) {
      return false;
    }
    if (
      other.dynamicImports.some((node) => {
        const specifier = moduleString(other, node);
        return specifier !== undefined && proof.resolve(consumer, specifier) === model.file;
      })
    ) {
      return false;
    }
    if (other.moduleEscapes.some((specifier) => proof.resolve(consumer, specifier) === model.file)) {
      return false;
    }
    if (
      [...other.exports.values()].some(
        (entry) =>
          !Schema.is(Schema.String)(entry) &&
          reexports(entry.imported) &&
          proof.resolve(consumer, entry.source) === model.file,
      )
    ) {
      return false;
    }
  }
  return true;
};
const namedConsumersConfined = (
  proof: IssuerProof,
  symbol: SymbolValue,
  allowsReference: (model: Model, reference: Identifier) => boolean,
): boolean => {
  const exportedNames = new Set(
    [...symbol.model.exports].filter(([, local]) => local === symbol.binding.name).map(([name]) => name),
  );
  if (exportedNames.size === 0) {
    return true;
  }
  const imports = sourceImports(proof, symbol.model.file);
  return (
    moduleReferencesConfined(proof, symbol.model, (name) => exportedNames.has(name)) &&
    imports !== undefined &&
    imports.every(({ binding, model: importer }) => {
      const imported = binding.origin?.imported;
      return (
        imported !== '*' &&
        (imported === undefined ||
          !exportedNames.has(imported) ||
          (![...importer.exports.values()].includes(binding.name) &&
            bindingReferences(importer, binding).every((reference) => allowsReference(importer, reference))))
      );
    })
  );
};

const namesOtherGroups = (proof: IssuerProof, model: Model, append: CallExpression): boolean => {
  const names = new Set<string>();
  for (const argument of append.arguments) {
    if (argument.type !== 'Identifier') {
      return false;
    }
    const group = proof.symbol(model, argument);
    const isAppendArgument = (source: Model, reference: Identifier): boolean =>
      source === model && reference === argument;
    if (
      group === undefined ||
      !usedOnlyAt(model, argument) ||
      !bindingReferences(group.model, group.binding).every((reference) => isAppendArgument(group.model, reference)) ||
      !namedConsumersConfined(proof, group, isAppendArgument)
    ) {
      return false;
    }
    const initializer = immutableConstInitializer(group);
    const name = initializer === undefined ? undefined : baseGroup(proof, group.model, initializer, 0, true);
    if (name === undefined || name === 'gatewayContext' || names.has(name)) {
      return false;
    }
    names.add(name);
  }
  return names.size > 0;
};

const isOtherGroupName = (name: string | undefined): boolean =>
  name !== undefined && name !== 'gatewayContext' && !Object.hasOwn(Object.prototype, name);

const projectsOtherGroupEndpoint = (model: Model, reference: Identifier): boolean => {
  const memberOn = (object: Span): MemberExpression | undefined =>
    model.members.find((member) => member.object === object && !member.optional && !member.computed);
  const groups = memberOn(reference);
  const group = groups !== undefined && propertyName(groups) === 'groups' ? memberOn(groups) : undefined;
  const groupName = group === undefined ? undefined : propertyName(group);
  const endpoints = group !== undefined && isOtherGroupName(groupName) ? memberOn(group) : undefined;
  return endpoints !== undefined && propertyName(endpoints) === 'endpoints' && memberOn(endpoints) !== undefined;
};

const apiBorrow = (model: Model, reference: Identifier): CallExpression | undefined =>
  model.calls.find(
    (call) =>
      call.arguments[0] === reference &&
      !call.optional &&
      call.arguments.every((argument) => argument.type !== 'SpreadElement'),
  );

const borrowedGroupName = (proof: IssuerProof, model: Model, call: CallExpression): string | undefined => {
  const [, group] = call.arguments;
  return call.arguments.length === 3 &&
    group?.type === 'Literal' &&
    proof.native(model, call.callee, 'HttpApiBuilder', 'group')
    ? text(group)
    : undefined;
};

const borrowsBaseApi = (proof: IssuerProof, model: Model, reference: Identifier): boolean => {
  const call = apiBorrow(model, reference);
  return (
    call !== undefined &&
    (isOtherGroupName(borrowedGroupName(proof, model, call)) ||
      (call.arguments.length <= 2 &&
        proof.named(model, call.callee, '@modern-js/bff-effect/effect-client', 'makeEffectHttpApiClient')))
  );
};

const contractHasGateway = (
  proof: IssuerProof,
  contract: SymbolValue,
  gateway: SymbolValue,
  root: Model,
  api: Expression,
): boolean => {
  const initializer = immutableConstInitializer(contract);
  const append = initializer === undefined ? undefined : unwrap(initializer);
  const member = append?.type === 'CallExpression' ? unwrap(append.callee) : undefined;
  if (
    append?.type !== 'CallExpression' ||
    append.optional ||
    member?.type !== 'MemberExpression' ||
    member.optional ||
    propertyName(member) !== 'add' ||
    member.object.type !== 'Identifier'
  ) {
    return nativeContractHasGateway(proof, contract, gateway);
  }

  // The native add creates a new API with the original groups and the named additions.
  // Resolve the const receiver before using that operation's preservation of gatewayContext.
  const base = proof.symbol(contract.model, member.object);
  const isAppendReceiver = (model: Model, reference: Identifier): boolean =>
    model === contract.model && reference === member.object;
  const usesAssembledApi = (model: Model, reference: Identifier): boolean => {
    // A shorthand assembly field has separate key and value nodes at the same source token.
    if (model === root && reference.start === api.start && reference.end === api.end) {
      return true;
    }
    const call = apiBorrow(model, reference);
    const group = call === undefined ? undefined : borrowedGroupName(proof, model, call);
    return group === 'gatewayContext' || group === 'symmy';
  };
  return (
    base !== undefined &&
    immutableConstInitializer(base) !== undefined &&
    usedOnlyAt(contract.model, member.object) &&
    bindingReferences(contract.model, contract.binding).every((reference) =>
      usesAssembledApi(contract.model, reference),
    ) &&
    namedConsumersConfined(proof, contract, usesAssembledApi) &&
    bindingReferences(base.model, base.binding).every(
      (reference) => isAppendReceiver(base.model, reference) || projectsOtherGroupEndpoint(base.model, reference),
    ) &&
    namedConsumersConfined(
      proof,
      base,
      (model, reference) => isAppendReceiver(model, reference) || borrowsBaseApi(proof, model, reference),
    ) &&
    namesOtherGroups(proof, contract.model, append) &&
    nativeContractHasGateway(proof, base, gateway)
  );
};
const discoverRoot = (proof: IssuerProof): IssuerRoot | undefined => {
  const published = publishedGateway(proof);
  if (published === undefined) {
    return undefined;
  }
  const { gateway, owner } = published;
  const model = proof.model(proof.path.join(proof.root, 'apps', owner, 'api', 'index.ts'));
  if (model === undefined) {
    return undefined;
  }
  const factory = rootFactory(proof, model);
  if (factory === undefined) {
    return undefined;
  }
  const returned = runtimeAssembly(proof, model, factory);
  const [options] = returned?.arguments ?? [];
  if (returned === undefined || options?.type !== 'ObjectExpression') {
    return undefined;
  }
  const api = objectField(options, 'api');
  const handlers = objectField(options, 'handlers');
  if (api === undefined || handlers === undefined) {
    return undefined;
  }
  const contract = proof.symbol(model, api);
  if (contract === undefined || !contractHasGateway(proof, contract, gateway, model, api)) {
    return undefined;
  }
  const groups = model.bindings
    .filter((binding) => binding.kind === 'const' && immutable(model, binding))
    .flatMap((binding) => {
      const call = groupCall(proof, model, binding, contract, 'gatewayContext');
      return call !== undefined && layerContains(proof, model, handlers, { binding, model }) ? [call] : [];
    });
  if (groups.length !== 1) {
    return undefined;
  }
  const [group] = groups;
  if (group === undefined) {
    return undefined;
  }
  const spans = endpointCallbacks(model, group);
  return spans.length === 3 ? { assembly: returned, contract, factory, handlers, model, owner, spans } : undefined;
};

const consumersConfined = (proof: IssuerProof, model: Model, spans: readonly RoleSpan[]): boolean => {
  if (!moduleReferencesConfined(proof, model, () => true)) {
    return false;
  }
  const imports = sourceImports(proof, model.file);
  if (imports === undefined) {
    return false;
  }
  for (const entry of imports) {
    if (entry.binding.origin?.imported === '*') {
      return false;
    }
    if (
      bindingReferences(entry.model, entry.binding).some(
        (reference) => callOf(entry.model, reference) === undefined || !authorized(spans, entry.model, reference),
      )
    ) {
      return false;
    }
  }
  const core = model.bindings.find(
    (binding) => binding.origin?.source === coreDatabaseExport && binding.origin.imported === 'CoreDatabase',
  );
  const coreReferences = core === undefined ? [] : bindingReferences(model, core);
  return model.bindings.every((binding) => {
    const span = callableSpan(model, binding);
    if (
      span === undefined ||
      !model.functions.some((fn) => inside(fn, span)) ||
      !coreReferences.some((reference) => inside(reference, span))
    ) {
      return true;
    }
    return bindingReferences(model, binding).every(
      (reference) => callOf(model, reference) !== undefined && authorized(spans, model, reference),
    );
  });
};
const callbackFunction = (proof: IssuerProof, model: Model, input: Expression): FunctionNode | undefined => {
  const node = unwrap(input);
  if (node.type !== 'CallExpression' || node.optional || node.arguments.length !== 1) {
    return undefined;
  }
  const definition = unwrap(node.callee);
  const [fn] = node.arguments;
  return definition.type === 'CallExpression' &&
    proof.native(model, definition.callee, 'Effect', 'fn') &&
    (fn?.type === 'FunctionExpression' || fn?.type === 'ArrowFunctionExpression')
    ? fn
    : undefined;
};
const transactionUse = (proof: IssuerProof, model: Model, call: CallExpression): boolean => {
  const [argument] = call.arguments;
  if (call.arguments.length !== 1 || argument === undefined || argument.type === 'SpreadElement') {
    return false;
  }
  const fn = callbackFunction(proof, model, argument);
  const [parameter] = fn?.params ?? [];
  if (fn === undefined || parameter?.type !== 'Identifier') {
    return false;
  }
  const binding = bindingAt(model, parameter.name, parameter);
  if (binding === undefined) {
    return false;
  }
  return bindingReferences(model, binding).every((reference) => {
    const member = model.members.find(
      (candidate) =>
        candidate.object === reference &&
        propertyName(candidate) === 'execute' &&
        !candidate.computed &&
        !candidate.optional,
    );
    const execution = member === undefined ? undefined : callOf(model, member);
    if (execution === undefined) {
      return false;
    }
    const nested = closestFunction(model, reference);
    if (nested === fn) {
      return true;
    }
    return (
      nested !== undefined &&
      nested.type === 'FunctionExpression' &&
      nested.generator &&
      model.calls.some(
        (candidate) =>
          candidate.arguments.includes(nested) &&
          callbackFunction(proof, model, candidate) === nested &&
          model.yields.some(
            (yielded) =>
              yielded.delegate &&
              yielded.argument !== null &&
              inside(candidate, yielded.argument) &&
              inside(yielded, fn),
          ),
      )
    );
  });
};
const capabilityClosed = (proof: IssuerProof, model: Model, spans: readonly RoleSpan[]): boolean => {
  if (/from\s*['"](?:pg|drizzle-orm\/node-postgres)['"]/u.test(model.source)) {
    return false;
  }
  const databases = model.bindings.filter(
    (binding) => binding.origin?.source === coreDatabaseExport && binding.origin.imported === 'CoreDatabase',
  );
  if (databases.length !== 1) {
    return false;
  }
  const [imported] = databases;
  if (imported === undefined || !immutable(model, imported)) {
    return false;
  }
  const target = proof.packageExports.get(coreDatabaseExport);
  if (
    target === undefined ||
    !proof.path.relative(proof.root, target).replaceAll('\\', '/').startsWith('packages/core-runtime/src/')
  ) {
    return false;
  }
  if ([...model.exports.values()].some((entry) => entry === imported.name)) {
    return false;
  }
  const uses = bindingReferences(model, imported);
  if (uses.length === 0) {
    return false;
  }
  return uses.every((reference) => {
    const yielded = model.yields.find((node) => node.delegate && node.argument === reference);
    const declaration = yielded === undefined ? undefined : model.variables.find((node) => node.init === yielded);
    if (declaration?.id.type !== 'Identifier' || !authorized(spans, model, reference)) {
      return false;
    }
    const database = bindingAt(model, declaration.id.name, declaration.id);
    if (database === undefined || !immutable(model, database)) {
      return false;
    }
    return bindingReferences(model, database).every((usage) => {
      if (closestFunction(model, usage) !== closestFunction(model, reference)) {
        return false;
      }
      const executor = model.members.find(
        (node) => node.object === usage && propertyName(node) === 'executor' && !node.computed && !node.optional,
      );
      const transaction =
        executor === undefined
          ? undefined
          : model.members.find(
              (node) =>
                node.object === executor && propertyName(node) === 'transaction' && !node.computed && !node.optional,
            );
      const call = transaction === undefined ? undefined : callOf(model, transaction);
      return call !== undefined && transactionUse(proof, model, call);
    });
  });
};

const symmyContract = (proof: IssuerProof, root: IssuerRoot): boolean => {
  const publicFile = proof.packageExports.get('@app/shared-contracts/symmy');
  const routes = publicFile === undefined ? undefined : proof.exported(publicFile, 'SYMMY_ROUTES');
  if (
    routes === undefined ||
    !proof.path
      .relative(proof.root, routes.model.file)
      .replaceAll('\\', '/')
      .startsWith('packages/shared-contracts/src/')
  ) {
    return false;
  }
  const { model } = root.contract;
  const initializer = root.contract.binding.init;
  if (initializer === undefined) {
    return false;
  }
  return model.calls.some(
    (call) =>
      inside(call, initializer) &&
      call.arguments.some((argument) => {
        if (argument.type === 'SpreadElement') {
          return false;
        }
        const group = proof.symbol(model, argument);
        if (group?.binding.init === undefined || baseGroup(proof, group.model, group.binding.init) !== 'symmy') {
          return false;
        }
        return group.model.bindings.some(
          (binding) =>
            binding.origin?.source === '@app/shared-contracts/symmy' &&
            binding.origin.imported === 'SYMMY_ROUTES' &&
            sameSymbol(
              proof.exported(proof.resolve(group.model.file, binding.origin.source) ?? '', binding.origin.imported),
              routes,
            ),
        );
      }),
  );
};
const contextService = (proof: IssuerProof, symbol: SymbolValue, owner: string): boolean => {
  const declaration = symbol.model.classes.find((node) => node.id?.start === symbol.binding.node.start);
  const base =
    declaration?.superClass === null || declaration?.superClass === undefined
      ? undefined
      : unwrap(declaration.superClass);
  if (
    base?.type !== 'CallExpression' ||
    base.arguments.length !== 1 ||
    base.arguments[0]?.type !== 'Literal' ||
    !(text(base.arguments[0]) ?? '').startsWith(`@app/${owner}/`)
  ) {
    return false;
  }
  const factory = unwrap(base.callee);
  return (
    factory.type === 'CallExpression' &&
    factory.arguments.length === 0 &&
    proof.native(symbol.model, factory.callee, 'Context', 'Service')
  );
};
const mountedSymmyTransports = (
  proof: IssuerProof,
  root: IssuerRoot,
): readonly { readonly groupBody: FunctionNode; readonly target: SymbolValue }[] =>
  root.model.bindings.flatMap((binding) => {
    if (binding.origin === undefined) {
      return [];
    }
    const target = proof.exported(proof.resolve(root.model.file, binding.origin.source) ?? '', binding.origin.imported);
    if (target === undefined) {
      return [];
    }
    const group = groupCall(proof, target.model, target.binding, root.contract, 'symmy');
    const groupBody = group?.arguments.at(2);
    return group !== undefined &&
      (groupBody?.type === 'ArrowFunctionExpression' || groupBody?.type === 'FunctionExpression') &&
      layerContains(proof, root.model, root.handlers, target)
      ? [{ groupBody, target }]
      : [];
  });
const invokesYieldedAdmit = (model: Model, yielded: YieldExpression): boolean => {
  const declaration = model.variables.find((node) => node.init === yielded);
  if (declaration?.id.type !== 'Identifier') {
    return false;
  }
  const binding = bindingAt(model, declaration.id.name, declaration.id);
  return (
    binding !== undefined &&
    immutable(model, binding) &&
    bindingReferences(model, binding).some((reference) => {
      const member = model.members.find(
        (node) => node.object === reference && !node.computed && !node.optional && propertyName(node) === 'admit',
      );
      return member !== undefined && callOf(model, member) !== undefined;
    })
  );
};
const transportServices = (
  proof: IssuerProof,
  root: IssuerRoot,
  target: SymbolValue,
  groupBody: FunctionNode,
): readonly SymbolValue[] => {
  const seen = new Set<Binding>();
  const services: SymbolValue[] = [];
  for (const entry of callClosure(proof, root, [{ model: target.model, span: groupBody }])) {
    for (const yielded of entry.model.yields) {
      const service =
        yielded.delegate &&
        yielded.argument !== null &&
        inside(yielded, entry.span) &&
        invokesYieldedAdmit(entry.model, yielded)
          ? proof.symbol(entry.model, yielded.argument)
          : undefined;
      if (
        service !== undefined &&
        service.model === target.model &&
        !seen.has(service.binding) &&
        contextService(proof, service, root.owner)
      ) {
        seen.add(service.binding);
        services.push(service);
      }
    }
  }
  return services;
};
const configuredServiceProgram = (
  proof: IssuerProof,
  root: IssuerRoot,
  service: SymbolValue,
  transport: SymbolValue,
  call: CallExpression,
): FunctionNode | undefined => {
  if (
    !inside(call, root.factory) ||
    !proof.native(root.model, call.callee, 'Layer', 'effect') ||
    call.arguments.length !== 2
  ) {
    return undefined;
  }
  const [tag, program] = call.arguments;
  if (
    tag === undefined ||
    tag.type === 'SpreadElement' ||
    !sameSymbol(proof.symbol(root.model, tag), service) ||
    program?.type !== 'CallExpression' ||
    !proof.native(root.model, program.callee, 'Effect', 'gen')
  ) {
    return undefined;
  }
  const [fn] = program.arguments;
  if (fn?.type !== 'FunctionExpression') {
    return undefined;
  }
  const provider = smallest(
    root.model.variables.filter(
      (node) => node.init !== null && inside(call, node.init) && node.id.type === 'Identifier',
    ),
  );
  const symbol = provider?.id.type === 'Identifier' ? proof.symbol(root.model, provider.id) : undefined;
  return symbol !== undefined && layerProvides(proof, root.model, root.handlers, transport, symbol) ? fn : undefined;
};
const configuredAdmitSpans = (
  proof: IssuerProof,
  root: IssuerRoot,
  service: SymbolValue,
  transport: SymbolValue,
): readonly RoleSpan[] =>
  root.model.calls.flatMap((call) => {
    const fn = configuredServiceProgram(proof, root, service, transport, call);
    if (fn === undefined) {
      return [];
    }
    const returned = soleDirectReturn(root.model, fn);
    const fields =
      returned?.argument === null || returned?.argument === undefined ? undefined : unwrap(returned.argument);
    const admit = fields?.type === 'ObjectExpression' ? objectField(fields, 'admit') : undefined;
    return admit?.type === 'ArrowFunctionExpression' || admit?.type === 'FunctionExpression'
      ? [{ model: root.model, span: admit }]
      : [];
  });
const symmyIngressSpans = (proof: IssuerProof, root: IssuerRoot): readonly RoleSpan[] => {
  if (!symmyContract(proof, root)) {
    return [];
  }
  return mountedSymmyTransports(proof, root).flatMap(({ groupBody, target }) =>
    transportServices(proof, root, target, groupBody).flatMap((service) =>
      configuredAdmitSpans(proof, root, service, target),
    ),
  );
};

/** Prove issuer bootstrap ownership without exempting an API directory or clearing database taint. */
export const provedShellGatewayDatabaseSources = (
  sources: ReadonlyMap<string, string>,
  root: string,
  path: Path.Path,
  packageExports: ReadonlyMap<string, string>,
): ReadonlySet<string> => {
  const proof = new IssuerProof(sources, root, path, packageExports);
  const issuer = discoverRoot(proof);
  if (issuer === undefined) {
    return new Set();
  }
  const spans = callClosure(proof, issuer, [...issuer.spans, ...symmyIngressSpans(proof, issuer)]);
  const result = new Set<string>();
  for (const entry of spans) {
    if (result.has(entry.model.file) || !entry.model.source.includes(coreDatabaseExport)) {
      continue;
    }
    if (capabilityClosed(proof, entry.model, spans) && consumersConfined(proof, entry.model, spans)) {
      result.add(entry.model.file);
    }
  }
  return result;
};
