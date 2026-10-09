import {
  isCallExpression,
  isFunction,
  isFunctionDeclaration,
  isIdentifier,
  isOptionalCallExpression,
  isVariableDeclarator,
  traverseFast,
} from '@babel/types';
import type {
  GraphValue,
  MicroVerticalApiSourceRule,
  ModuleGraph,
} from '@modern-js/code-tools/microvertical-api-boundary';

type ExternalValue = Extract<GraphValue, { readonly kind: 'external' }>;

const forbiddenSchemaMembers = new Set(['Any', 'Json', 'Unknown', 'UnknownFromJsonString']);
const problemDetailsFactoryNames = new Set(['makeProblemDetailsSchema', 'makeRetryableProblemDetailsSchema']);
const endpointMethods = new Set(['delete', 'get', 'head', 'options', 'patch', 'post', 'put']);
const schemaProviderSpecifiers = new Set(['@modern-js/bff-effect/effect-client', 'effect', 'effect/Schema']);
const endpointProviderSpecifiers = new Set([
  '@modern-js/bff-effect/effect-client',
  '@modern-js/bff-effect/effect-edge',
  'effect/unstable/httpapi',
  'effect/unstable/httpapi/HttpApiEndpoint',
]);
const sharedContractsPath = /\/packages\/shared-contracts\//u;

export const violationMessage =
  'HttpApi contracts must use concrete request, response, error, and Problem Details extension schemas; unconstrained schemas, unknown JSON, and arbitrary Problem Details extension records are forbidden';

/** The member path below a package export: `Schema.Unknown` is `['Schema', 'Unknown']`. */
const externalPath = (value: ExternalValue): readonly string[] =>
  value.name === '*' ? value.members : [value.name, ...value.members];

/** The path below `HttpApiEndpoint`: `HttpApiEndpoint.get` is `['get']`. */
const endpointPath = (value: GraphValue): readonly string[] | undefined => {
  if (value.kind !== 'external' || !endpointProviderSpecifiers.has(value.specifier)) {
    return undefined;
  }
  const path = externalPath(value);
  // `effect/unstable/httpapi/HttpApiEndpoint` exports the verbs directly.
  if (value.specifier.endsWith('/HttpApiEndpoint')) {
    return path;
  }
  return path[0] === 'HttpApiEndpoint' ? path.slice(1) : undefined;
};

/** `HttpApiEndpoint.get`, or the endpoint factory `HttpApiEndpoint.make(method)` returns. */
const isEndpointFactory = (graph: ModuleGraph, value: GraphValue): boolean => {
  const path = endpointPath(value);
  if (path !== undefined) {
    return path.length === 1 && endpointMethods.has(path[0] ?? '');
  }
  return (
    value.kind === 'node' &&
    (isCallExpression(value.node) || isOptionalCallExpression(value.node)) &&
    graph.evaluate(value.module, value.node.callee).some((callee) => {
      const factoryPath = endpointPath(callee);
      return factoryPath?.length === 1 && factoryPath[0] === 'make';
    })
  );
};

const schemaMember = (value: ExternalValue): string | undefined => {
  const path = externalPath(value);
  if (value.specifier === 'effect/Schema') {
    return path[0];
  }
  return path[0] === 'Schema' ? path[1] : undefined;
};

const isForbiddenSchema = (value: GraphValue, forbidRecord: boolean): boolean => {
  if (value.kind !== 'external' || !schemaProviderSpecifiers.has(value.specifier)) {
    return false;
  }
  const member = schemaMember(value);
  return member !== undefined && (forbiddenSchemaMembers.has(member) || (forbidRecord && member === 'Record'));
};

/** The name a function value is declared under: `function f` or `const f = () => ...`. */
const declaredName = (value: GraphValue): string | undefined => {
  if (value.kind !== 'node') {
    return undefined;
  }
  const { module, node } = value;
  if (isFunctionDeclaration(node)) {
    return node.id?.name;
  }
  let name: string | undefined;
  traverseFast(module.file, (candidate) => {
    if (
      name === undefined &&
      isVariableDeclarator(candidate) &&
      candidate.init === node &&
      isIdentifier(candidate.id)
    ) {
      ({ name } = candidate.id);
    }
  });
  return name;
};

/** A `@app/shared-contracts` Problem Details factory, followed into its workspace source. */
const isProblemDetailsFactory = (value: GraphValue): boolean =>
  value.kind === 'node' &&
  isFunction(value.node) &&
  sharedContractsPath.test(value.module.path) &&
  problemDetailsFactoryNames.has(declaredName(value) ?? '');

/**
 * Rejects HttpApi endpoints and Problem Details extensions that reach an unconstrained schema. The
 * framework module graph follows imports, re-exports, aliases, destructuring, function returns and
 * member writes across workspace packages.
 */
export const unconstrainedHttpApiContractSchemas: MicroVerticalApiSourceRule = ({ file, graph, module }) => {
  if (file.split('/').includes('tests')) {
    return [];
  }
  const lines = new Set<number>();
  traverseFast(module.file, (node) => {
    if (!isCallExpression(node) && !isOptionalCallExpression(node)) {
      return;
    }
    const callees = graph.evaluate(module, node.callee);
    const endpoint =
      callees.some((callee) => isEndpointFactory(graph, callee)) &&
      node.arguments.some((argument) =>
        graph.reachable(module, argument).some((value) => isForbiddenSchema(value, false)),
      );
    const extensions = node.arguments.at(2);
    const problemDetails =
      extensions !== undefined &&
      callees.some(isProblemDetailsFactory) &&
      graph.reachable(module, extensions).some((value) => isForbiddenSchema(value, true));
    if (endpoint || problemDetails) {
      lines.add(node.loc?.start.line ?? 0);
    }
  });
  return [...lines].map((line) => `line ${line}: ${violationMessage}.`);
};

export default [unconstrainedHttpApiContractSchemas];
