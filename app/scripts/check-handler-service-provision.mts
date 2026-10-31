#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import type { CallExpression, Node } from '@typescript/native/unstable/ast';
import {
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isAsExpression,
  isBindingElement,
  isCallExpression,
  isFunctionLikeDeclaration,
  isIdentifier,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isVariableDeclaration,
} from '@typescript/native/unstable/ast/is';
import { API, isTypeReference, isUnionType, SymbolFlags, TypeFlags } from '@typescript/native/unstable/sync';
import type { Project, Type } from '@typescript/native/unstable/sync';
import { Array as EffectArray, Config, Console, Effect, FileSystem, Layer, Order, Path, Schema } from 'effect';

/**
 * Handler service provision gate.
 *
 * `HttpApiBuilder.group` captures the services of its Layer build and gives them to every handler, yet Effect types a
 * handler's service needs as request requirements (`HttpRouter.Request<'Requires', S>`). `Layer.provide` never
 * discharges such a requirement and the BFF assembly accepts any of them, so a handler group whose Layer lacks a
 * service still type-checks and then answers each request with 500 "Service not found".
 *
 * The gate reads the compiler's own types. For every API root it walks the handler Layer composition handed to
 * `assembleEffectBffRuntime` and requires each request requirement of each handler group to be a service that a
 * Layer on the group's composition path provides, or that the BFF platform provides. A runtime factory parameter
 * declares only part of what its argument provides, so the Layers the API root passes for it count as well; each of
 * them must provide the service. Transport routes resolve their services from the request, so only route middleware
 * discharges their request requirements: none may remain.
 */

export interface HandlerServiceGap {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

const GapOrder = Order.mapInput(
  Order.Tuple([Order.String, Order.Number, Order.String]),
  (gap: HandlerServiceGap) => [gap.file, gap.line, gap.reason] as const,
);

const PROVIDING_COMBINATORS: ReadonlySet<string> = new Set(['provide', 'provideMerge']);
const OUTPUT_MERGING_COMBINATORS: ReadonlySet<string> = new Set(['merge', 'provideMerge']);
const MERGING_COMBINATORS: ReadonlySet<string> = new Set(['merge', 'mergeAll']);
const LAYER_TYPE_ARGUMENTS = 3;
/** Services the BFF platform supplies to the HTTP API Layer, and with it to every handler group it builds. */
const PLATFORM_SERVICES: ReadonlySet<string> = new Set([
  'FileSystem',
  'Generator',
  'HttpPlatform',
  'HttpRouter',
  'Path',
]);
/**
 * Request requirements a handler resolves only when an optional production service is absent. With that service on
 * the group's composition path the handler never reaches them; without it, every one of them must be provided.
 */
const OPTIONAL_PRODUCTION_ALTERNATIVES: readonly {
  readonly production: string;
  readonly replaces: ReadonlySet<string>;
}[] = [
  {
    // Pricing's commitment confirmation Action reads `Effect.serviceOption(PricingCommitmentConfirmationProduction)`
    // and builds its services from these four only when that production service is not installed.
    production: 'PricingCommitmentConfirmationProduction',
    replaces: new Set([
      'PricingCommitmentConfirmationRenewal',
      'PricingCommitmentConfirmationVerification',
      'PricingCurrentBackedConfirmationIssuance',
      'PricingQuotationBackedConfirmationIssuance',
    ]),
  },
];
const EFFECT_DECLARATION = /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?effect\//u;

/** Services by compiler type id, with their display names. */
type Services = ReadonlyMap<number, string>;

const unwrap = (node: Node): Node =>
  isParenthesizedExpression(node) || isAsExpression(node) || isSatisfiesExpression(node) || isNonNullExpression(node)
    ? unwrap(node.expression)
    : node;

const isCall = (node: Node): node is CallExpression => isCallExpression(node);

/** The member name of a `Namespace.member(...)` call, e.g. `provide` for `Layer.provide(live)`. */
const calledMember = (node: Node): string | undefined => {
  if (!isCall(node)) {
    return undefined;
  }
  const callee = unwrap(node.expression);
  return isPropertyAccessExpression(callee) ? callee.name.text : undefined;
};

/** `Layer.mergeAll(...).pipe(...)` -> `Layer.mergeAll(...)`. */
const calleeObject = (call: CallExpression): Node => {
  const callee = unwrap(call.expression);
  return isPropertyAccessExpression(callee) ? callee.expression : callee;
};

const members = (type: Type): readonly Type[] => {
  if (type.flags === TypeFlags.Never) {
    return [];
  }
  return isUnionType(type) ? type.getTypes() : [type];
};

const parametersOf = (factory: Node): readonly Node[] => (isFunctionLikeDeclaration(factory) ? factory.parameters : []);

/** The Layer a property of the `assembleEffectBffRuntime` options names, e.g. `handlers: resolvedApiHandlersLive`. */
const assemblyProperty = (property: Node): { readonly name: string; readonly value: Node } | undefined => {
  if (isShorthandPropertyAssignment(property) || isPropertyAssignment(property)) {
    const { name } = property;
    const value = isPropertyAssignment(property) ? property.initializer : name;
    return isIdentifier(name) ? { name: name.text, value } : undefined;
  }
  return undefined;
};

const union = (...sets: readonly Services[]): Services => new Map(sets.flatMap((set) => [...set]));

const intersection = (sets: readonly Services[]): Services => {
  const [first, ...rest] = sets;
  return new Map([...(first ?? [])].filter(([id]) => rest.every((set) => set.has(id))));
};

const describe = (node: Node): string => {
  const source = node.getSourceFile();
  const text = source.text.slice(node.getStart(source), node.end).replaceAll(/\s+/gu, ' ');
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

const analyzeApiRoot = (root: string, project: Project, file: string): readonly HandlerServiceGap[] => {
  const { checker } = project;
  const source = project.program.getSourceFile(file);
  if (source === undefined) {
    return [{ file: file.slice(root.length + 1), line: 1, reason: 'the API root is not part of its package project' }];
  }
  const gaps: HandlerServiceGap[] = [];
  const record = (node: Node, reason: string) => {
    const nodeSource = node.getSourceFile();
    const line = nodeSource.text.slice(0, node.getStart(nodeSource)).split('\n').length;
    gaps.push({ file: nodeSource.fileName.slice(root.length + 1), line, reason });
  };

  const layerTypeArguments = (node: Node) => {
    const type = checker.getTypeAtLocation(node);
    const typeArguments =
      type !== undefined && isTypeReference(type) && type.getSymbol()?.name === 'Layer'
        ? checker.getTypeArguments(type)
        : [];
    return typeArguments.length === LAYER_TYPE_ARGUMENTS ? typeArguments : undefined;
  };
  /** The service `S` of `HttpRouter.Request<'Requires', S>`, the marker of a request requirement. */
  const requestRequirement = (type: Type): Type | undefined => {
    const [kind, service] =
      isTypeReference(type) && type.getSymbol()?.name === 'Request' ? checker.getTypeArguments(type) : [];
    return kind !== undefined && checker.typeToString(kind) === '"Requires"' ? service : undefined;
  };
  const isPlatformService = (service: Type): boolean => {
    const symbol = service.getSymbol();
    return (
      symbol !== undefined &&
      PLATFORM_SERVICES.has(symbol.name) &&
      symbol.declarations.some((declaration) => EFFECT_DECLARATION.test(declaration.path))
    );
  };

  const declarationOf = (identifier: Node): Node | undefined => {
    let symbol = checker.getSymbolAtLocation(identifier);
    if (symbol !== undefined && symbol.flags === SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    return symbol?.valueDeclaration?.resolve(project);
  };
  const initializerOf = (identifier: Node): Node | undefined => {
    const declaration = declarationOf(identifier);
    return declaration !== undefined && isVariableDeclaration(declaration) ? declaration.initializer : undefined;
  };

  /**
   * The runtime factory parameter a Layer binding comes from, e.g. `governedReadRuntimeLive` in
   * `(...args: Arguments) => { const [governedReadRuntimeLive] = args; ... }`: the factory and the argument position.
   */
  const factoryParameter = (declaration: Node): { readonly factory: Node; readonly index: number } | undefined => {
    if (isParameterDeclaration(declaration)) {
      const index = parametersOf(declaration.parent).indexOf(declaration);
      return index === -1 ? undefined : { factory: declaration.parent, index };
    }
    const pattern = declaration.parent;
    if (!isBindingElement(declaration) || !isArrayBindingPattern(pattern) || !isVariableDeclaration(pattern.parent)) {
      return undefined;
    }
    const { initializer } = pattern.parent;
    const rest = initializer === undefined ? undefined : declarationOf(unwrap(initializer));
    if (rest === undefined || !isParameterDeclaration(rest)) {
      return undefined;
    }
    return {
      factory: rest.parent,
      index: parametersOf(rest.parent).indexOf(rest) + pattern.elements.indexOf(declaration),
    };
  };

  /** The arguments the API root passes for a factory parameter: the Layers the deployment actually mounts. */
  const factoryArguments = (factory: Node, index: number): readonly Node[] => {
    const binding = factory.parent;
    if (!isVariableDeclaration(binding)) {
      return [];
    }
    const factorySymbol = checker.getSymbolAtLocation(binding.name);
    const found: Node[] = [];
    const visit = (node: Node): void => {
      if (isCall(node)) {
        const callee = unwrap(node.expression);
        const argument = node.arguments[index];
        if (
          argument !== undefined &&
          isIdentifier(callee) &&
          factorySymbol !== undefined &&
          checker.getSymbolAtLocation(callee)?.id === factorySymbol.id
        ) {
          found.push(argument);
        }
      }
      node.forEachChild(visit);
    };
    visit(source);
    return found;
  };

  /** Plain services a Layer outputs; route middleware outputs only request markers, never the service itself. */
  const outputsOf = (node: Node, visited: ReadonlySet<Node>): Services => {
    const layer = unwrap(node);
    if (visited.has(layer)) {
      return new Map();
    }
    const seen = new Set(visited).add(layer);
    if (isArrayLiteralExpression(layer)) {
      return union(...layer.elements.map((element) => outputsOf(element, seen)));
    }
    const output = layerTypeArguments(layer)?.[0];
    if (output === undefined) {
      record(layer, `cannot read the services of the provided Layer ${describe(layer)}`);
      return new Map();
    }
    const declared: Services = new Map(
      members(output)
        .filter((service) => requestRequirement(service) === undefined)
        .map((service) => [service.id, checker.typeToString(service)] as const),
    );
    if (isIdentifier(layer)) {
      const initializer = initializerOf(layer);
      if (initializer !== undefined) {
        return union(declared, outputsOf(initializer, seen));
      }
      const declaration = declarationOf(layer);
      const parameter = declaration === undefined ? undefined : factoryParameter(declaration);
      if (parameter === undefined) {
        return declared;
      }
      const passed = factoryArguments(parameter.factory, parameter.index);
      return passed.length === 0 ? declared : union(declared, intersection(passed.map((arg) => outputsOf(arg, seen))));
    }
    const member = calledMember(layer);
    if (!isCall(layer) || member === undefined) {
      return declared;
    }
    if (MERGING_COMBINATORS.has(member)) {
      return union(declared, ...layer.arguments.map((argument) => outputsOf(argument, seen)));
    }
    if (member !== 'pipe') {
      return declared;
    }
    const merged = layer.arguments.flatMap((step) => {
      const operation = unwrap(step);
      const operationMember = calledMember(operation);
      return isCall(operation) && operationMember !== undefined && OUTPUT_MERGING_COMBINATORS.has(operationMember)
        ? operation.arguments.map((argument) => outputsOf(argument, seen))
        : [];
    });
    return union(declared, outputsOf(calleeObject(layer), seen), ...merged);
  };

  const checkLeaf = (node: Node, provided: Services) => {
    const requirements = layerTypeArguments(node)?.[2];
    if (requirements === undefined) {
      record(node, `cannot read the Layer type of handler composition ${describe(node)}`);
      return;
    }
    const providedNames = new Set(provided.values());
    const replaced = new Set(
      OPTIONAL_PRODUCTION_ALTERNATIVES.filter(({ production }) => providedNames.has(production)).flatMap(
        ({ replaces }) => [...replaces],
      ),
    );
    for (const requirement of members(requirements)) {
      const service = requestRequirement(requirement);
      if (service !== undefined && replaced.has(checker.typeToString(service))) {
        continue;
      }
      if (requirement.flags === TypeFlags.Any) {
        record(node, `${describe(node)} has an unchecked (any) requirement`);
      } else if (service !== undefined && !provided.has(service.id) && !isPlatformService(service)) {
        record(
          node,
          `${describe(node)} needs ${checker.typeToString(service)}, but no Layer on its composition path provides it`,
        );
      }
    }
  };

  const walkHandlers = (node: Node, provided: Services, visited: ReadonlySet<Node>): void => {
    const expression = unwrap(node);
    if (visited.has(expression)) {
      return;
    }
    const seen = new Set(visited).add(expression);
    const initializer = isIdentifier(expression) ? initializerOf(expression) : undefined;
    const member = calledMember(expression);
    if (initializer !== undefined) {
      walkHandlers(initializer, provided, seen);
    } else if (!isCall(expression) || member === undefined) {
      checkLeaf(expression, provided);
    } else if (member === 'pipe') {
      let inner = provided;
      for (const step of expression.arguments) {
        const operation = unwrap(step);
        const operationMember = calledMember(operation);
        if (isCall(operation) && operationMember !== undefined && PROVIDING_COMBINATORS.has(operationMember)) {
          inner = union(inner, ...operation.arguments.map((layer) => outputsOf(layer, new Set())));
        } else if (isCall(operation) && operationMember === 'merge') {
          for (const sibling of operation.arguments) {
            walkHandlers(sibling, provided, seen);
          }
        }
      }
      walkHandlers(calleeObject(expression), inner, seen);
    } else if (MERGING_COMBINATORS.has(member)) {
      for (const layer of expression.arguments) {
        walkHandlers(layer, provided, seen);
      }
    } else if (PROVIDING_COMBINATORS.has(member) && expression.arguments.length > 1) {
      const [self, ...layers] = expression.arguments;
      walkHandlers(self ?? expression, union(provided, ...layers.map((layer) => outputsOf(layer, new Set()))), seen);
    } else {
      checkLeaf(expression, provided);
    }
  };

  const checkTransport = (node: Node) => {
    const requirements = layerTypeArguments(unwrap(node))?.[2];
    if (requirements === undefined) {
      record(node, `cannot read the Layer type of transport ${describe(node)}`);
      return;
    }
    for (const requirement of members(requirements)) {
      const service = requestRequirement(requirement);
      if (service !== undefined) {
        record(
          node,
          `transport routes need ${checker.typeToString(service)} per request, but no route middleware provides it`,
        );
      }
    }
  };

  let assemblies = 0;
  const visit = (node: Node): void => {
    const callee = isCall(node) ? unwrap(node.expression) : undefined;
    const [options] = isCall(node) ? node.arguments : [];
    const assembly = options === undefined ? undefined : unwrap(options);
    if (
      callee !== undefined &&
      isIdentifier(callee) &&
      callee.text === 'assembleEffectBffRuntime' &&
      assembly !== undefined &&
      isObjectLiteralExpression(assembly)
    ) {
      assemblies += 1;
      for (const property of assembly.properties) {
        const layer = assemblyProperty(property);
        if (layer?.name === 'handlers') {
          walkHandlers(layer.value, new Map(), new Set());
        } else if (layer?.name === 'transport') {
          checkTransport(layer.value);
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  if (assemblies === 0) {
    record(source, 'the API root assembles no handler Layer through assembleEffectBffRuntime');
  }
  return gaps;
};

class HandlerServiceProvisionFailed extends Schema.TaggedError<HandlerServiceProvisionFailed>()(
  'HandlerServiceProvisionFailed',
  { reason: Schema.String },
) {}

/** Every handler group service and transport request requirement that no Layer provides, in the given API roots. */
export const findHandlerServiceGaps = Effect.fn('HandlerServiceProvision.findGaps')(function* findHandlerServiceGaps(
  root: string,
  apiRoots: readonly string[],
) {
  const path = yield* Path.Path;
  const api = yield* Effect.acquireRelease(
    Effect.sync(() => new API({ cwd: root })),
    (client) => Effect.sync(() => client.close()),
  );
  const gaps = yield* Effect.forEach(
    apiRoots,
    (apiRoot) => {
      const file = path.join(root, apiRoot);
      const config = path.join(path.dirname(path.dirname(file)), 'tsconfig.json');
      return Effect.try({
        catch: (cause) =>
          new HandlerServiceProvisionFailed({
            reason: `the analysis of ${path.relative(root, config)} failed: ${String(cause)}`,
          }),
        try: () => {
          const snapshot = api.updateSnapshot({ openProjects: [config] });
          try {
            const project = snapshot.getProject(config);
            return project === undefined
              ? [{ file: apiRoot, line: 1, reason: `no package project ${path.relative(root, config)}` }]
              : analyzeApiRoot(root, project, file);
          } finally {
            snapshot.dispose();
            // Release the package project before the next one loads, so memory stays bounded by one package.
            api.updateSnapshot({ closeProjects: [config] }).dispose();
          }
        },
      });
    },
    { concurrency: 1 },
  );
  return EffectArray.sort(gaps.flat(), GapOrder);
});

const packageApiRoots = Effect.fn('HandlerServiceProvision.packageApiRoots')(function* packageApiRoots(
  root: string,
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fileSystem.exists(path.join(root, directory)))) {
    return [];
  }
  const names = yield* fileSystem.readDirectory(path.join(root, directory));
  const candidates = names.map((name) => `${directory}/${name}/api/index.ts`);
  const present = yield* Effect.all(candidates.map((candidate) => fileSystem.exists(path.join(root, candidate))));
  return candidates.filter((_candidate, index) => present[index]);
});

/** The package API roots: `api/index.ts` of every app and vertical. */
export const discoverApiRoots = Effect.fn('HandlerServiceProvision.discoverApiRoots')(function* discoverApiRoots(
  root: string,
) {
  const roots = yield* Effect.forEach(['apps', 'verticals'], (directory) => packageApiRoots(root, directory));
  return EffectArray.sort(roots.flat(), Order.String);
});

const [, invokedPath] = process.argv;
if (invokedPath !== undefined && invokedPath === import.meta.filename) {
  const main = Effect.gen(function* handlerServiceProvisionMain() {
    const path = yield* Path.Path;
    const root = yield* Config.String('ULTRAMODERN_WORKSPACE_ROOT').pipe(
      Config.withDefault(path.resolve(import.meta.dirname, '..')),
    );
    const apiRoots = yield* discoverApiRoots(root);
    const gaps = yield* findHandlerServiceGaps(root, apiRoots);
    if (gaps.length > 0) {
      yield* Effect.forEach(gaps, (gap) => Console.error(`${gap.file}:${gap.line}: ${gap.reason}`), { discard: true });
      return yield* new HandlerServiceProvisionFailed({ reason: `${gaps.length} handler service gaps` });
    }
    return yield* Console.log(`Every handler service is provided in all ${apiRoots.length} API roots.`);
  });
  NodeRuntime.runMain(
    Effect.scoped(Layer.build(Layer.effectDiscard(Effect.scoped(main)).pipe(Layer.provide(NodeServices.layer)))).pipe(
      Effect.asVoid,
    ),
  );
}
