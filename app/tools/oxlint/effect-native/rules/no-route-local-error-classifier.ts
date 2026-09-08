/**
 * Audit findings: **A9** — "Preserve typed Effects through the frontend" ("ten route-specific error
 * classifiers", "Exhaustive `Match` against a shared frontend failure vocabulary") and **A4** —
 * "Rebuild the error system around typed channels and contract-owned Problem Details" ("frontend
 * reclassification after `runPromise` erases the original union", "Generate or centralize frontend
 * classification from the same error vocabulary"), both in
 * `docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`.
 *
 * Sixteen `classify*Error` / `classifyHttpClientFailure` functions live inside Contacts and Shell
 * route pages; three are verbatim copies. Each one re-derives a UI state from `_tag` *after* the
 * Promise adapter erased the typed failure union, so the vocabulary is owned by whichever page
 * happens to render it instead of by the contract.
 *
 * What is detected — inside route modules only (`routeGlobs`), never in tests:
 * 1. An error-classifier name (`namePattern`, requiring Error/Failure/Problem/Defect/Cause). The name is
 *    taken from the declaration site even when the function is wrapped: `const classifyX = (…) => …`,
 *    `function classifyX`, object/class members (including `#private` fields), `handlers.classifyX =`,
 *    `const classifyX = ((…) => …) satisfies F` / `as F`, and `const classifyX = useCallback(fn, [])`
 *    (any call wrapper — `useMemo`, `memo`, `flow`, …).
 * 2. Any function with a parameter whose TypeScript annotation references — recursively, through
 *    unions, intersections, arrays, generics and qualified names — one of `classifierInputTypes`
 *    (default `ErrorClassificationInput`, the erased-union projection type in
 *    `verticals/contacts/src/error-classification.ts`). Identity is resolved through the file's
 *    `import` declarations, so `import type { ErrorClassificationInput as X }` still matches and a
 *    local alias that merely *prints* as `ErrorClassificationInput` does not.
 * 3. `detectTagDiscrimination` (default true): a function with an error-shaped parameter (parameter
 *    binding name or annotated type name matches `errorParameterPattern`) whose body discriminates
 *    `_tag` off that binding — `error._tag === 'X'`, `switch (error._tag)`, `error.reason._tag`,
 *    `error?.["_tag"]`, `error[TAG]` where `const TAG = '_tag'`, a `{ _tag }` destructuring
 *    parameter, `const { _tag } = error` in the body, and through one or more local aliases
 *    (`const failure = error`). Destructured props count too: `({ error }: { error: F }) => …`
 *    links the `error` binding back to the parameter.
 *
 * Anonymous inline handlers are reported as well (`includeInlineHandlers`, default **true**): the
 * A4 shape in `apps/shell-super-app/src/routes/[lang]/search/page.data.ts` and `…/login/page.tsx`
 * is exactly an unnamed `Effect.catch((error) => … error._tag …)` / `.catch((error) => …)` that
 * re-derives a page model after the adapter erased the union. Set the option to `false` to limit
 * the rule to named definitions.
 *
 * Reported once per definition: the three axes never double-report the same function, and an
 * unnamed function nested inside an already-reported one is attributed to the outer definition.
 *
 * What is deliberately allowed
 * - Everything outside `routeGlobs`: the shared frontend failure vocabulary itself
 *   (`verticals/*​/src/errors/**`, `src/error-classification.ts`), API clients, services and Core.
 *   The audit's target is one shared module consumed by routes, not zero classification code.
 * - Test files (`isTestFile`) — tests exercising the closed vocabulary are healthy.
 * - Route helpers that never discriminate a failure: `Match.tag`/`Match.typeTags` consumers,
 *   `className`/`classNames` helpers, sorting and formatting, and `_tag` reads on module-level
 *   constants rather than on the function's own parameter.
 * - A `_tag` read that belongs to a *shadowing* inner binding is attributed to the inner function,
 *   not to the enclosing parameter of the same name.
 * - `allowedNames`: an explicit, narrow escape hatch (empty by default).
 *
 * Narrower than the original spec: generic classifyX names, local lookalike type aliases, and
 * destructured domain tags without error evidence are not error classifiers. Exit is not an error
 * token: inspecting its success/failure envelope is a legitimate adapter operation.
 * Known limitation: with no type information, "error-shaped parameter" is a lexical judgement about
 * names and annotations. This rule only reports; it never fixes or suggests.
 */
import { defineRule } from '@oxlint/plugins';
import type { Context, ESTree, Variable } from '@oxlint/plugins';

import { isNode, memberName, type Syntax } from '../shared/ast.ts';
import { lookupVariable } from '../shared/bindings.ts';
import { importedName } from '../shared/imports.ts';
import { optionRecord } from '../shared/options.ts';
import { compile, stringArray } from '../shared/options.ts';
import { isTestFile, scopePath, matchesGlobs } from '../shared/paths.ts';

const DEFAULT_ROUTE_GLOBS = [
  'apps/*/src/routes/**',
  'verticals/*/src/routes/**',
];

// A9 targets error classifiers, not unrelated helpers such as classifyGridDensity.
const DEFAULT_NAME_PATTERN =
  '^classify.*(?:Error|Failure|Problem|Defect|Cause)(?:$|[A-Z])';

const DEFAULT_CLASSIFIER_INPUT_TYPES = ['ErrorClassificationInput'];

const DEFAULT_ERROR_PARAMETER_PATTERN = 'error|failure|problem|defect|cause';

const TAG_PROPERTY = '_tag';

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/** Expression wrappers that keep the same runtime value (type assertions, parens, chains). */
const TRANSPARENT_EXPRESSIONS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
  'ParenthesizedExpression',
  'ChainExpression',
]);

interface RuleOptions {
  readonly routeGlobs: readonly string[];
  readonly namePattern: RegExp;
  readonly classifierInputTypes: readonly string[];
  readonly errorParameterPattern: RegExp;
  readonly detectTagDiscrimination: boolean;
  readonly includeInlineHandlers: boolean;
  readonly allowedNames: readonly string[];
  readonly allowTestFiles: boolean;
}

type AnyNode = Syntax;

function readOptions(context: Context): RuleOptions {
  const record = optionRecord(context.options?.[0]);
  return {
    routeGlobs: stringArray(record.routeGlobs, DEFAULT_ROUTE_GLOBS),
    namePattern: compile(record.namePattern, DEFAULT_NAME_PATTERN, 'u'),
    classifierInputTypes: stringArray(
      record.classifierInputTypes,
      DEFAULT_CLASSIFIER_INPUT_TYPES
    ),
    errorParameterPattern: compile(
      record.errorParameterPattern,
      DEFAULT_ERROR_PARAMETER_PATTERN,
      'iu'
    ),
    detectTagDiscrimination: record.detectTagDiscrimination !== false,
    includeInlineHandlers: record.includeInlineHandlers !== false,
    allowedNames: stringArray(record.allowedNames, []),
    allowTestFiles: record.allowTestFiles === true,
  };
}

/**
 * Depth-first walk over an AST subtree. `parent` back-references are skipped (they would loop), a
 * visited set guards against any other shared node reference, and `skip` prunes whole subtrees
 * (used to honour shadowing: a nested function that re-binds the tracked name).
 */
function forEachNode(
  root: unknown,
  visit: (node: AnyNode) => void,
  skip?: (node: AnyNode) => boolean
): void {
  const stack: unknown[] = [root];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const entry of current) stack.push(entry);
      continue;
    }
    if (!isNode(current)) continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (skip !== undefined && skip(current)) continue;
    visit(current);
    pushChildren(current, stack);
  }
}

function pushChildren(node: AnyNode, stack: unknown[]): void {
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (value !== null && typeof value === 'object') stack.push(value);
  }
}

/** Strip type assertions / parens / optional-chain wrappers to reach the underlying expression. */
function unwrapExpression(node: unknown): AnyNode | null {
  let current: unknown = node;
  while (isNode(current) && TRANSPARENT_EXPRESSIONS.has(current.type)) {
    current = current.expression;
  }
  return isNode(current) ? current : null;
}

/** `error`, `Effect.Error<…>` → the identifier names a type annotation references. */
function referencedTypeNames(annotation: unknown): ReadonlySet<string> {
  const names = new Set<string>();
  forEachNode(annotation, (node) => {
    if (node.type === 'TSTypeReference') {
      collectTypeName(node.typeName, names);
      return;
    }
    if (node.type === 'TSQualifiedName') collectTypeName(node, names);
  });
  return names;
}

function collectTypeName(typeName: unknown, into: Set<string>): void {
  if (!isNode(typeName)) return;
  if (typeName.type === 'Identifier') {
    const name = typeName.name;
    if (typeof name === 'string') into.add(name);
    return;
  }
  if (typeName.type !== 'TSQualifiedName') return;
  collectTypeName(typeName.left, into);
  collectTypeName(typeName.right, into);
}

/** Every identifier a binding pattern introduces (`{ error }`, `[first]`, `{ a: { b } }`, rest, default). */
function unwrapParameter(pattern: unknown): AnyNode | null {
  let target = pattern;
  const edges: Readonly<Record<string, string>> = {
    TSParameterProperty: 'parameter',
    AssignmentPattern: 'left',
    RestElement: 'argument',
  };
  while (isNode(target)) {
    const edge = edges[target.type];
    if (edge === undefined) return target;
    target = target[edge];
  }
  return null;
}

function patternBindingNames(pattern: unknown, into: Set<string>): void {
  const target = unwrapParameter(pattern);
  if (target === null) return;
  if (target.type === 'Identifier') {
    if (typeof target.name === 'string') into.add(target.name);
    return;
  }
  if (target.type === 'ObjectPattern') {
    collectObjectBindings(target.properties, into);
    return;
  }
  if (target.type === 'ArrayPattern' && Array.isArray(target.elements)) {
    for (const element of target.elements) patternBindingNames(element, into);
  }
}

function collectObjectBindings(properties: unknown, into: Set<string>): void {
  if (!Array.isArray(properties)) return;
  for (const property of properties) {
    if (!isNode(property)) continue;
    patternBindingNames(
      property.type === 'Property' ? property.value : property,
      into
    );
  }
}

/** `{ _tag }` / `{ _tag: tag }` / `{ '_tag': tag }` — the pattern pulls out the discriminant. */
function patternHasTagKey(pattern: AnyNode): boolean {
  if (pattern.type !== 'ObjectPattern') return false;
  const properties = Array.isArray(pattern.properties)
    ? pattern.properties
    : [];
  return properties.some((property) => {
    if (!isNode(property) || property.type !== 'Property') return false;
    if (property.computed === true) return false;
    const key = property.key;
    if (!isNode(key)) return false;
    if (key.type === 'Identifier') return key.name === TAG_PROPERTY;
    return key.type === 'Literal' && key.value === TAG_PROPERTY;
  });
}

interface ParameterShape {
  /** Display name: the binding when the parameter is a plain identifier. */
  readonly name: string | null;
  /** Every binding the parameter introduces (destructured props included). */
  readonly bindings: readonly string[];
  /** Type names referenced by the parameter's annotation. */
  readonly typeNames: ReadonlySet<string>;
  /** `({ _tag }) => …` — the parameter itself destructures the discriminant. */
  readonly destructuresTag: boolean;
}

function parameterShape(parameter: unknown): ParameterShape {
  const target = unwrapParameter(parameter);
  if (!isNode(target))
    return {
      name: null,
      bindings: [],
      typeNames: new Set(),
      destructuresTag: false,
    };
  const typeNames = referencedTypeNames(target.typeAnnotation);
  const bindings = new Set<string>();
  patternBindingNames(target, bindings);
  return {
    name:
      target.type === 'Identifier' && typeof target.name === 'string'
        ? target.name
        : null,
    bindings: [...bindings],
    typeNames,
    destructuresTag: patternHasTagKey(target),
  };
}

/**
 * `true` when the function body discriminates `_tag` off `binding` — directly, through a chained
 * member, through a body destructuring (`const { _tag } = error`), or through local aliases
 * (`const failure = error`). Subtrees of nested functions that re-bind the same name are pruned, so
 * a shadowing inner callback is attributed to the inner function instead.
 */
function variableAt(context: Context, node: AnyNode): Variable | null {
  if (node.type !== 'Identifier' || typeof node.name !== 'string') return null;
  return lookupVariable(context, node as unknown as ESTree.Node);
}

function computedTagKey(context: Context, node: AnyNode): boolean {
  if (node.computed !== true || !isNode(node.property)) return false;
  const variable = variableAt(context, node.property);
  if (
    variable === null ||
    variable.references.some(
      (reference) => reference.isWrite() && !reference.init
    )
  )
    return false;
  return variable.defs.some((definition) => {
    if (
      definition.type !== 'Variable' ||
      definition.node.type !== 'VariableDeclarator'
    )
      return false;
    const init = unwrapExpression(definition.node.init);
    return init?.type === 'Literal' && init.value === TAG_PROPERTY;
  });
}

function readsParameterTag(
  context: Context,
  node: AnyNode,
  fromParameter: (value: unknown) => boolean
): boolean {
  if (node.type === 'MemberExpression') {
    const key = memberName(node);
    const isTag =
      key === TAG_PROPERTY || (key === null && computedTagKey(context, node));
    return isTag && fromParameter(node.object);
  }
  return (
    node.type === 'VariableDeclarator' &&
    isNode(node.id) &&
    patternHasTagKey(node.id) &&
    fromParameter(node.init)
  );
}

function discriminatesTag(
  context: Context,
  body: unknown,
  binding: string,
  parameter: AnyNode
): boolean {
  const fromParameter = (value: unknown, depth = 0): boolean => {
    if (depth > 8) return false;
    const node = unwrapExpression(value);
    if (node === null) return false;
    if (node.type === 'MemberExpression')
      return fromParameter(node.object, depth + 1);
    const variable = variableAt(context, node);
    if (variable === null) return false;
    return variable.defs.some((definition) => {
      if (
        definition.name.name === binding &&
        definition.name.start >= Number(parameter.start) &&
        definition.name.end <= Number(parameter.end)
      )
        return true;
      if (
        definition.type !== 'Variable' ||
        definition.node.type !== 'VariableDeclarator'
      )
        return false;
      // Reassigned aliases do not prove identity at this use site.
      if (
        variable.references.some(
          (reference) => reference.isWrite() && !reference.init
        )
      )
        return false;
      return fromParameter(definition.node.init, depth + 1);
    });
  };
  let found = false;
  forEachNode(body, (node) => {
    if (!found) found = readsParameterTag(context, node, fromParameter);
  });
  return found;
}

/** Only the Exit envelope's own tag is success/failure state, not a contract error classifier. */
function isExitEnvelope(context: Context, parameter: unknown): boolean {
  let target = parameter;
  while (
    isNode(target) &&
    ['AssignmentPattern', 'TSParameterProperty'].includes(target.type)
  ) {
    target =
      target.type === 'AssignmentPattern' ? target.left : target.parameter;
  }
  if (!isNode(target) || !isNode(target.typeAnnotation)) return false;
  const type = target.typeAnnotation.typeAnnotation;
  if (
    !isNode(type) ||
    type.type !== 'TSTypeReference' ||
    !isNode(type.typeName)
  )
    return false;
  return exitTypeReference(context, type.typeName);
}

function exitTypeReference(context: Context, name: AnyNode): boolean {
  let root = name;
  const parts: string[] = [];
  while (
    root.type === 'TSQualifiedName' &&
    isNode(root.left) &&
    isNode(root.right)
  ) {
    if (typeof root.right.name !== 'string') return false;
    parts.unshift(root.right.name);
    root = root.left;
  }
  const variable = variableAt(context, root);
  if (variable === null) return false;
  return variable.defs.some((definition) => {
    if (
      definition.type !== 'ImportBinding' ||
      definition.parent?.type !== 'ImportDeclaration'
    )
      return false;
    return isExitImport(
      definition.node,
      definition.parent.source.value,
      parts.join('.')
    );
  });
}

function isExitImport(
  specifier: ESTree.Node,
  source: unknown,
  path: string
): boolean {
  if (specifier.type === 'ImportSpecifier') {
    if (importedName(specifier) !== 'Exit') return false;
    return (
      (source === 'effect' && path === 'Exit') ||
      (source === 'effect/Exit' && path === '')
    );
  }
  if (specifier.type !== 'ImportNamespaceSpecifier') return false;
  return (
    (source === 'effect/Exit' && path === 'Exit') ||
    (source === 'effect' && path === 'Exit.Exit')
  );
}

/** Type identity needs an import, not just a matching printed local type name. */
function importsClassifierType(
  context: Context,
  parameter: unknown,
  expected: string
): boolean {
  let found = false;
  forEachNode(parameter, (node) => {
    if (node.type !== 'TSTypeReference' || !isNode(node.typeName)) return;
    const name = node.typeName;
    const root =
      name.type === 'TSQualifiedName' && isNode(name.left) ? name.left : name;
    const variable = variableAt(context, root);
    if (variable === null) return;
    if (
      variable.defs.some(
        (definition) =>
          definition.type === 'ImportBinding' &&
          matchesClassifierImport(name, definition.node, expected)
      )
    )
      found = true;
  });
  return found;
}

function matchesClassifierImport(
  name: AnyNode,
  imported: ESTree.Node,
  expected: string
): boolean {
  if (name.type === 'Identifier' && imported.type === 'ImportSpecifier')
    return importedName(imported) === expected;
  return (
    name.type === 'TSQualifiedName' &&
    imported.type === 'ImportNamespaceSpecifier' &&
    isNode(name.right) &&
    name.right.name === expected
  );
}

/**
 * Climb from a function to the expression that is actually bound to a name: through type assertions
 * (`(… ) satisfies F`, `… as F`) and through call wrappers (`useCallback(fn, [])`, `useMemo`, `memo`,
 * `flow(…)`), which is how a React route module hides a classifier one refactor deep.
 */
function bindingAnchor(node: ESTree.Node): AnyNode {
  let current = node as unknown as AnyNode;
  for (let hops = 0; hops < 8; hops += 1) {
    const parent = (current as { parent?: unknown }).parent;
    if (!isNode(parent)) break;
    if (
      TRANSPARENT_EXPRESSIONS.has(parent.type) &&
      parent.expression === current
    ) {
      current = parent;
      continue;
    }
    if (
      parent.type === 'CallExpression' &&
      Array.isArray(parent.arguments) &&
      (parent.arguments as readonly unknown[]).includes(current)
    ) {
      current = parent;
      continue;
    }
    break;
  }
  return current;
}

function keyName(key: unknown): string | null {
  if (!isNode(key)) return null;
  if (key.type === 'Identifier' || key.type === 'PrivateIdentifier') {
    return typeof key.name === 'string' ? key.name : null;
  }
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

type Definition = { name: string; node: ESTree.Node };

function identifierDefinition(value: unknown): Definition | null {
  if (
    !isNode(value) ||
    value.type !== 'Identifier' ||
    typeof value.name !== 'string'
  )
    return null;
  return { name: value.name, node: value };
}

function assignmentDefinition(left: unknown): Definition | null {
  const identifier = identifierDefinition(left);
  if (identifier !== null) return identifier;
  if (!isNode(left) || left.type !== 'MemberExpression') return null;
  const name = memberName(left);
  return name === null ? null : { name, node: left };
}

function anchorDefinition(anchor: AnyNode): Definition | null {
  const parent = anchor.parent;
  if (!isNode(parent)) return null;
  if (parent.type === 'VariableDeclarator' && parent.init === anchor)
    return identifierDefinition(parent.id);
  if (parent.type === 'AssignmentExpression' && parent.right === anchor)
    return assignmentDefinition(parent.left);
  return propertyDefinition(parent, anchor);
}

function propertyDefinition(
  parent: AnyNode,
  anchor: AnyNode
): Definition | null {
  if (
    !['Property', 'PropertyDefinition', 'MethodDefinition'].includes(
      parent.type
    )
  )
    return null;
  if (parent.value !== anchor || parent.computed === true) return null;
  const name = keyName(parent.key);
  return name === null ? null : { name, node: parent.key as ESTree.Node };
}

/** Prefer declaration-site names over internal named function expressions. */
function definitionName(node: ESTree.Node): Definition | null {
  const candidate = node as unknown as AnyNode;
  if (candidate.type === 'FunctionDeclaration') {
    const id = candidate.id;
    if (isNode(id) && typeof id.name === 'string')
      return { name: id.name, node: id };
  }
  const definition = anchorDefinition(bindingAnchor(node));
  if (definition !== null) return definition;
  if (candidate.type !== 'FunctionExpression') return null;
  const id = candidate.id;
  return isNode(id) && typeof id.name === 'string'
    ? { name: id.name, node: id }
    : null;
}

function discriminatedParameter(
  context: Context,
  raw: AnyNode,
  parameter: unknown,
  options: RuleOptions
): string | null {
  if (isExitEnvelope(context, parameter)) return null;
  const shape = parameterShape(parameter);
  const typeMatches = [...shape.typeNames].some((type) =>
    options.errorParameterPattern.test(type)
  );
  const errorBindings = shape.bindings.filter((binding) =>
    options.errorParameterPattern.test(binding)
  );
  if (shape.destructuresTag && (typeMatches || errorBindings.length > 0))
    return shape.name ?? '{ _tag }';
  if (!isNode(parameter)) return null;
  return (
    (typeMatches ? shape.bindings : errorBindings).find((binding) =>
      discriminatesTag(context, raw.body, binding, parameter)
    ) ?? null
  );
}

function classifierInput(
  context: Context,
  parameters: readonly unknown[],
  options: RuleOptions
): string | undefined {
  for (const parameter of parameters) {
    const matched = options.classifierInputTypes.find((type) =>
      importsClassifierType(context, parameter, type)
    );
    if (matched !== undefined) return matched;
  }
  return undefined;
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A9/A4: route modules must not define their own error classifiers. Sixteen `classify*Error` ' +
        'functions in Contacts/Shell route pages re-derive UI state from `_tag` after the Promise adapter ' +
        'erased the typed failure union; three are verbatim copies. Route pages should consume one shared ' +
        'frontend failure vocabulary through exhaustive `Match`.',
    },
    messages: {
      namedClassifier:
        'Route module defines its own error classifier `{{name}}`. Match exhaustively against the shared ' +
        "frontend failure vocabulary (`Match.typeTags<E>()({ … })` over the contract's `Schema.TaggedError` " +
        "union) exported from the vertical's shared errors module, and consume it here.",
      classifierInput:
        'Route module defines its own error classifier `{{name}}` over `{{type}}`. That projection type exists ' +
        'because the typed failure union was erased at the Promise adapter: keep the failure in `E` up to the ' +
        "React boundary and map it once with `Match.typeTags` in the vertical's shared errors module.",
      tagDiscriminator:
        'Route module classifies failures locally in `{{name}}` by reading `{{parameter}}._tag`. Replace the ' +
        'hand-written `_tag` discrimination with an exhaustive `Match.typeTags`/`Match.tags` over the ' +
        "contract's `Schema.TaggedError` union, exported once as the shared frontend failure vocabulary.",
      inlineClassifier:
        'Route module reclassifies a failure inline by reading `{{parameter}}._tag`. Handle the typed failure ' +
        'in the Effect channel (`Effect.catchTag`/`Effect.catchTags`) or map it through the shared frontend ' +
        'failure vocabulary (`Match.typeTags`) instead of re-deriving UI state per call site.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          routeGlobs: { type: 'array', items: { type: 'string' } },
          namePattern: { type: 'string' },
          classifierInputTypes: { type: 'array', items: { type: 'string' } },
          errorParameterPattern: { type: 'string' },
          detectTagDiscrimination: { type: 'boolean' },
          includeInlineHandlers: { type: 'boolean' },
          allowedNames: { type: 'array', items: { type: 'string' } },
          allowTestFiles: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        routeGlobs: [...DEFAULT_ROUTE_GLOBS],
        namePattern: DEFAULT_NAME_PATTERN,
        classifierInputTypes: [...DEFAULT_CLASSIFIER_INPUT_TYPES],
        errorParameterPattern: DEFAULT_ERROR_PARAMETER_PATTERN,
        detectTagDiscrimination: true,
        includeInlineHandlers: true,
        allowedNames: [],
        allowTestFiles: false,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (!matchesGlobs(path, options.routeGlobs)) return {};
    if (!options.allowTestFiles && isTestFile(path)) return {};

    const reported = new Set<unknown>();

    /** An unnamed function inside an already-reported one belongs to that definition. */
    const insideReportedFunction = (node: ESTree.Node): boolean => {
      let current: unknown = (node as { parent?: unknown }).parent;
      while (isNode(current)) {
        if (FUNCTION_TYPES.has(current.type) && reported.has(current))
          return true;
        current = (current as { parent?: unknown }).parent;
      }
      return false;
    };

    const inspectParameters = (
      node: ESTree.Node,
      definition: Definition | null
    ): void => {
      const anonymous = definition === null;
      if (anonymous && !options.includeInlineHandlers) return;
      const target = definition?.node ?? node;
      const name = definition?.name ?? '(anonymous)';
      const raw = node as AnyNode;
      const parameters: readonly unknown[] = Array.isArray(raw.params)
        ? raw.params
        : [];
      const matched = classifierInput(context, parameters, options);
      if (matched !== undefined) {
        reported.add(node);
        context.report({
          node: target,
          messageId: 'classifierInput',
          data: { name, type: matched },
        });
        return;
      }
      inspectDiscrimination(node, parameters, target, name, anonymous);
    };

    const inspectDiscrimination = (
      node: ESTree.Node,
      parameters: readonly unknown[],
      target: ESTree.Node,
      name: string,
      anonymous: boolean
    ): void => {
      if (!options.detectTagDiscrimination) return;
      for (const parameter of parameters) {
        const binding = discriminatedParameter(
          context,
          node as AnyNode,
          parameter,
          options
        );
        if (binding === null) continue;
        reported.add(node);
        context.report({
          node: target,
          messageId: anonymous ? 'inlineClassifier' : 'tagDiscriminator',
          data: { name, parameter: binding },
        });
        return;
      }
    };

    const inspect = (node: ESTree.Node): void => {
      if (reported.has(node)) return;
      const definition = definitionName(node);
      if (definition === null) {
        if (!insideReportedFunction(node)) inspectParameters(node, null);
        return;
      }
      if (options.allowedNames.includes(definition.name)) return;
      if (options.namePattern.test(definition.name)) {
        reported.add(node);
        context.report({
          node: definition.node,
          messageId: 'namedClassifier',
          data: { name: definition.name },
        });
        return;
      }
      inspectParameters(node, definition);
    };

    return {
      FunctionDeclaration: inspect,
      FunctionExpression: inspect,
      ArrowFunctionExpression: inspect,
    };
  },
});
