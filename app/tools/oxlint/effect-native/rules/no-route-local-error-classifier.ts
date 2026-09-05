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

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production `routeGlobs` defaults instead of
 * forcing the fixture config to pass loosened options (which `run-on-repo.mts` reuses).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_ROUTE_GLOBS = ['apps/*/src/routes/**', 'verticals/*/src/routes/**'];

// A9 targets error classifiers, not unrelated helpers such as classifyGridDensity.
const DEFAULT_NAME_PATTERN = '^classify.*(?:Error|Failure|Problem|Defect|Cause)(?:$|[A-Z])';

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

type AnyNode = Record<string, unknown> & { readonly type: string };

function isNode(value: unknown): value is AnyNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function compile(value: unknown, fallback: string, flags: string): RegExp {
  const source = typeof value === 'string' && value.length > 0 ? value : fallback;
  try {
    return new RegExp(source, flags);
  } catch {
    return new RegExp(fallback, flags);
  }
}

function readOptions(context: Context): RuleOptions {
  const raw = context.options?.[0];
  const record: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    routeGlobs: stringArray(record.routeGlobs, DEFAULT_ROUTE_GLOBS),
    namePattern: compile(record.namePattern, DEFAULT_NAME_PATTERN, 'u'),
    classifierInputTypes: stringArray(record.classifierInputTypes, DEFAULT_CLASSIFIER_INPUT_TYPES),
    errorParameterPattern: compile(
      record.errorParameterPattern,
      DEFAULT_ERROR_PARAMETER_PATTERN,
      'iu',
    ),
    detectTagDiscrimination: record.detectTagDiscrimination !== false,
    includeInlineHandlers: record.includeInlineHandlers !== false,
    allowedNames: stringArray(record.allowedNames, []),
    allowTestFiles: record.allowTestFiles === true,
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/**
 * Depth-first walk over an AST subtree. `parent` back-references are skipped (they would loop), a
 * visited set guards against any other shared node reference, and `skip` prunes whole subtrees
 * (used to honour shadowing: a nested function that re-binds the tracked name).
 */
function forEachNode(
  root: unknown,
  visit: (node: AnyNode) => void,
  skip?: (node: AnyNode) => boolean,
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
    for (const key of Object.keys(current)) {
      if (key === 'parent') continue;
      const value = current[key];
      if (value === null || typeof value !== 'object') continue;
      stack.push(value);
    }
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

/**
 * `import type { ErrorClassificationInput as X }` → `X` really *is* the projection type, while a
 * local alias that merely prints as `ErrorClassificationInput` is not. Maps local → imported name.
 */
/** Identifier names bound to the literal `'_tag'`, so `error[TAG]` is still a discriminant read. */
/** Non-computed `.x`, computed `["x"]`, or computed `[TAG]` where `const TAG = '_tag'`. */
function memberPropertyName(node: AnyNode, tagKeyAliases: ReadonlySet<string>): string | null {
  const property = node.property;
  if (!isNode(property)) return null;
  if (node.computed === true) {
    if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
    if (
      property.type === 'Identifier' &&
      typeof property.name === 'string' &&
      tagKeyAliases.has(property.name)
    ) {
      return TAG_PROPERTY;
    }
    return null;
  }
  if (property.type === 'PrivateIdentifier') return null;
  return property.type === 'Identifier' && typeof property.name === 'string' ? property.name : null;
}

/** `error.reason._tag` → `error`; stops at anything that is not a member/assertion wrapper. */
function rootIdentifierName(node: unknown): string | null {
  let current: unknown = node;
  while (isNode(current)) {
    if (current.type === 'Identifier')
      return typeof current.name === 'string' ? current.name : null;
    if (current.type === 'MemberExpression') {
      current = current.object;
      continue;
    }
    if (TRANSPARENT_EXPRESSIONS.has(current.type)) {
      current = current.expression;
      continue;
    }
    return null;
  }
  return null;
}

/** Every identifier a binding pattern introduces (`{ error }`, `[first]`, `{ a: { b } }`, rest, default). */
function patternBindingNames(pattern: unknown, into: Set<string>): void {
  let target: unknown = pattern;
  while (isNode(target)) {
    if (target.type === 'TSParameterProperty') {
      target = target.parameter;
      continue;
    }
    if (target.type === 'AssignmentPattern') {
      target = target.left;
      continue;
    }
    if (target.type === 'RestElement') {
      target = target.argument;
      continue;
    }
    break;
  }
  if (!isNode(target)) return;
  if (target.type === 'Identifier') {
    if (typeof target.name === 'string') into.add(target.name);
    return;
  }
  if (target.type === 'ObjectPattern') {
    const properties = Array.isArray(target.properties) ? target.properties : [];
    for (const property of properties) {
      if (!isNode(property)) continue;
      if (property.type === 'Property') patternBindingNames(property.value, into);
      else patternBindingNames(property, into);
    }
    return;
  }
  if (target.type === 'ArrayPattern') {
    const elements = Array.isArray(target.elements) ? target.elements : [];
    for (const element of elements) patternBindingNames(element, into);
  }
}

/** `{ _tag }` / `{ _tag: tag }` / `{ '_tag': tag }` — the pattern pulls out the discriminant. */
function patternHasTagKey(pattern: AnyNode): boolean {
  if (pattern.type !== 'ObjectPattern') return false;
  const properties = Array.isArray(pattern.properties) ? pattern.properties : [];
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
  let target: unknown = parameter;
  while (isNode(target)) {
    if (target.type === 'TSParameterProperty') {
      target = target.parameter;
      continue;
    }
    if (target.type === 'AssignmentPattern') {
      target = target.left;
      continue;
    }
    if (target.type === 'RestElement') {
      target = target.argument;
      continue;
    }
    break;
  }
  if (!isNode(target))
    return { name: null, bindings: [], typeNames: new Set(), destructuresTag: false };
  const typeNames = referencedTypeNames(target.typeAnnotation);
  const bindings = new Set<string>();
  patternBindingNames(target, bindings);
  return {
    name: target.type === 'Identifier' && typeof target.name === 'string' ? target.name : null,
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
  let scope: Scope | null = context.sourceCode.getScope(node as unknown as ESTree.Node);
  while (scope !== null) {
    const variable = scope.set.get(node.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

function discriminatesTag(
  context: Context,
  body: unknown,
  binding: string,
  parameter: AnyNode,
): boolean {
  const fromParameter = (value: unknown, depth = 0): boolean => {
    if (depth > 8) return false;
    const node = unwrapExpression(value);
    if (node === null) return false;
    if (node.type === 'MemberExpression') return fromParameter(node.object, depth + 1);
    const variable = variableAt(context, node);
    if (variable === null) return false;
    return variable.defs.some((definition) => {
      if (
        definition.name.name === binding &&
        definition.name.start >= Number(parameter.start) &&
        definition.name.end <= Number(parameter.end)
      )
        return true;
      if (definition.type !== 'Variable' || definition.node.type !== 'VariableDeclarator')
        return false;
      // Reassigned aliases do not prove identity at this use site.
      if (variable.references.some((reference) => reference.isWrite() && !reference.init))
        return false;
      return fromParameter(definition.node.init, depth + 1);
    });
  };
  let found = false;
  forEachNode(body, (node) => {
    if (found) return;
    if (node.type === 'MemberExpression') {
      let key = memberPropertyName(node, new Set());
      if (key === null && node.computed === true && isNode(node.property)) {
        const variable = variableAt(context, node.property);
        if (
          variable !== null &&
          !variable.references.some((reference) => reference.isWrite() && !reference.init)
        ) {
          for (const definition of variable.defs) {
            if (definition.type !== 'Variable' || definition.node.type !== 'VariableDeclarator')
              continue;
            const init = unwrapExpression(definition.node.init);
            if (init?.type === 'Literal' && init.value === TAG_PROPERTY) key = TAG_PROPERTY;
          }
        }
      }
      if (key === TAG_PROPERTY && fromParameter(node.object)) found = true;
    } else if (node.type === 'VariableDeclarator' && isNode(node.id) && patternHasTagKey(node.id)) {
      if (fromParameter(node.init)) found = true;
    }
  });
  return found;
}

/** Only the Exit envelope's own tag is success/failure state, not a contract error classifier. */
function isExitEnvelope(context: Context, parameter: unknown): boolean {
  let target = parameter;
  while (isNode(target) && ['AssignmentPattern', 'TSParameterProperty'].includes(target.type)) {
    target = target.type === 'AssignmentPattern' ? target.left : target.parameter;
  }
  if (!isNode(target) || !isNode(target.typeAnnotation)) return false;
  const type = target.typeAnnotation.typeAnnotation;
  if (!isNode(type) || type.type !== 'TSTypeReference' || !isNode(type.typeName)) return false;
  let root = type.typeName;
  const parts: string[] = [];
  while (root.type === 'TSQualifiedName' && isNode(root.left) && isNode(root.right)) {
    if (typeof root.right.name !== 'string') return false;
    parts.unshift(root.right.name);
    root = root.left;
  }
  const variable = variableAt(context, root);
  if (variable === null) return false;
  return variable.defs.some((definition) => {
    if (definition.type !== 'ImportBinding') return false;
    const declaration = definition.parent;
    if (declaration?.type !== 'ImportDeclaration') return false;
    const source = declaration.source.value;
    const specifier = definition.node;
    if (specifier.type === 'ImportSpecifier') {
      const imported =
        specifier.imported.type === 'Identifier'
          ? specifier.imported.name
          : specifier.imported.value;
      return (
        (source === 'effect' && imported === 'Exit' && parts.join('.') === 'Exit') ||
        (source === 'effect/Exit' && imported === 'Exit' && parts.length === 0)
      );
    }
    return (
      specifier.type === 'ImportNamespaceSpecifier' &&
      ((source === 'effect/Exit' && parts.join('.') === 'Exit') ||
        (source === 'effect' && parts.join('.') === 'Exit.Exit'))
    );
  });
}

/** Type identity needs an import, not just a matching printed local type name. */
function importsClassifierType(context: Context, parameter: unknown, expected: string): boolean {
  let found = false;
  forEachNode(parameter, (node) => {
    if (node.type !== 'TSTypeReference' || !isNode(node.typeName)) return;
    const name = node.typeName;
    const root = name.type === 'TSQualifiedName' && isNode(name.left) ? name.left : name;
    const variable = variableAt(context, root);
    if (variable === null) return;
    for (const definition of variable.defs) {
      if (definition.type !== 'ImportBinding') continue;
      const imported = definition.node;
      if (name.type === 'Identifier' && imported.type === 'ImportSpecifier') {
        const key =
          imported.imported.type === 'Identifier'
            ? imported.imported.name
            : imported.imported.value;
        if (key === expected) found = true;
      } else if (
        name.type === 'TSQualifiedName' &&
        imported.type === 'ImportNamespaceSpecifier' &&
        isNode(name.right) &&
        name.right.name === expected
      )
        found = true;
    }
  });
  return found;
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
    if (TRANSPARENT_EXPRESSIONS.has(parent.type) && parent.expression === current) {
      current = parent;
      continue;
    }
    if (
      parent.type === 'CallExpression' &&
      Array.isArray(parent.arguments) &&
      parent.arguments.includes(current)
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

/** Definition name for a function-like node, taken from the declaration site. */
function definitionName(node: ESTree.Node): { name: string; node: ESTree.Node } | null {
  const candidate = node as unknown as AnyNode;
  if (
    candidate.type === 'FunctionDeclaration' &&
    isNode(candidate.id) &&
    typeof candidate.id.name === 'string'
  ) {
    return { name: candidate.id.name, node: candidate.id as unknown as ESTree.Node };
  }
  const anchor = bindingAnchor(node);
  const parent = (anchor as { parent?: unknown }).parent;
  if (isNode(parent)) {
    if (parent.type === 'VariableDeclarator' && parent.init === anchor) {
      const id = parent.id;
      if (isNode(id) && id.type === 'Identifier' && typeof id.name === 'string') {
        return { name: id.name, node: id as unknown as ESTree.Node };
      }
    } else if (
      (parent.type === 'Property' ||
        parent.type === 'PropertyDefinition' ||
        parent.type === 'MethodDefinition') &&
      parent.value === anchor &&
      parent.computed !== true
    ) {
      const name = keyName(parent.key);
      if (name !== null) return { name, node: parent.key as unknown as ESTree.Node };
    } else if (parent.type === 'AssignmentExpression' && parent.right === anchor) {
      const left = parent.left;
      if (isNode(left) && left.type === 'Identifier' && typeof left.name === 'string') {
        return { name: left.name, node: left as unknown as ESTree.Node };
      }
      if (isNode(left) && left.type === 'MemberExpression') {
        const property = memberPropertyName(left, new Set());
        if (property !== null) return { name: property, node: left as unknown as ESTree.Node };
      }
    }
  }
  // `const f = function named() {}`, `export default function () {}`, inline callbacks.
  if (
    candidate.type === 'FunctionExpression' &&
    isNode(candidate.id) &&
    typeof candidate.id.name === 'string'
  ) {
    return { name: candidate.id.name, node: candidate.id as unknown as ESTree.Node };
  }
  return null;
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
        if (FUNCTION_TYPES.has(current.type) && reported.has(current)) return true;
        current = (current as { parent?: unknown }).parent;
      }
      return false;
    };

    const inspect = (node: ESTree.Node): void => {
      if (reported.has(node)) return;
      const raw = node as unknown as AnyNode;
      const parameters = Array.isArray(raw.params) ? raw.params : [];
      const shapes = parameters.map((parameter) => parameterShape(parameter));
      const definition = definitionName(node);
      const name = definition?.name ?? null;
      const target = definition?.node ?? node;
      if (name !== null && options.allowedNames.includes(name)) return;
      const anonymous = name === null;
      if (anonymous && insideReportedFunction(node)) return;

      // Axis 1 — the definition is named like a classifier.
      if (name !== null && options.namePattern.test(name)) {
        reported.add(node);
        context.report({ node: target, messageId: 'namedClassifier', data: { name } });
        return;
      }

      // Axis 2 — a parameter is annotated with the erased-union projection type.
      for (const [index, shape] of shapes.entries()) {
        const matched = options.classifierInputTypes.find((type) =>
          importsClassifierType(context, parameters[index], type),
        );
        if (matched === undefined) continue;
        if (anonymous && !options.includeInlineHandlers) continue;
        reported.add(node);
        context.report({
          node: target,
          messageId: 'classifierInput',
          data: { name: name ?? '(anonymous)', type: matched },
        });
        return;
      }

      if (!options.detectTagDiscrimination) return;
      if (anonymous && !options.includeInlineHandlers) return;

      // Axis 3 — an error-shaped parameter whose `_tag` this function discriminates.
      for (const [index, shape] of shapes.entries()) {
        if (isExitEnvelope(context, parameters[index])) continue;
        const typeMatches = [...shape.typeNames].some((type) =>
          options.errorParameterPattern.test(type),
        );
        if (
          shape.destructuresTag &&
          (typeMatches ||
            shape.bindings.some((binding) => options.errorParameterPattern.test(binding)))
        ) {
          reported.add(node);
          context.report({
            node: target,
            messageId: anonymous ? 'inlineClassifier' : 'tagDiscriminator',
            data: { name: name ?? '(anonymous)', parameter: shape.name ?? '{ _tag }' },
          });
          return;
        }
        for (const binding of shape.bindings) {
          if (!options.errorParameterPattern.test(binding) && !typeMatches) continue;
          const parameter = parameters[index];
          if (!isNode(parameter) || !discriminatesTag(context, raw.body, binding, parameter))
            continue;
          reported.add(node);
          context.report({
            node: target,
            messageId: anonymous ? 'inlineClassifier' : 'tagDiscriminator',
            data: { name: name ?? '(anonymous)', parameter: binding },
          });
          return;
        }
      }
    };

    return {
      FunctionDeclaration: inspect,
      FunctionExpression: inspect,
      ArrowFunctionExpression: inspect,
    };
  },
});
