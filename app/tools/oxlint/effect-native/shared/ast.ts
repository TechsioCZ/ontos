import type { ESTree } from '@oxlint/plugins';

/** The permissive ESTree view used by the lexical rules (including parser extensions). */
export type Syntax = ESTree.Node & Record<string, any>;

export const EXPRESSION_WRAPPERS: ReadonlySet<string> = new Set([
  'ParenthesizedExpression',
  'ChainExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
]);
export const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);

export function isNode(value: unknown): value is Syntax {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/** requireStart preserves the stricter generator-walker node guard. */
export function asNode(value: unknown, requireStart = false): Syntax | null {
  if (!isNode(value)) return null;
  return requireStart && typeof value.start !== 'number' ? null : value;
}

export function parentOf(node: unknown): Syntax | null {
  return asNode(asNode(node)?.parent);
}

export interface UnwrapOptions {
  /** Override the wrapper kinds; callers with intentionally narrower syntax keep their set. */
  readonly wrappers?: ReadonlySet<string>;
  readonly maxDepth?: number;
  /** Generator walker copies validate spans on both the input and every wrapper child. */
  readonly requireStart?: boolean;
  /** Await is transparent only for the script provenance family. */
  readonly await?: boolean;
  /** Sequence-last semantics are enabled only for identity/JSON rules. */
  readonly sequence?: boolean;
  /** Some unknown-node walkers accept argument as a fallback for expression. */
  readonly argumentFallback?: boolean;
}

function innerExpression(node: Syntax, options: UnwrapOptions): Syntax | null {
  if (options.sequence && node.type === 'SequenceExpression')
    return asNode(node.expressions.at(-1), options.requireStart);
  if (options.await && node.type === 'AwaitExpression')
    return asNode(node.argument, options.requireStart);
  if (!(options.wrappers ?? EXPRESSION_WRAPPERS).has(node.type)) return null;
  return asNode(options.argumentFallback ? (node.expression ?? node.argument) : node.expression);
}

/** Returns the last valid node if a malformed wrapper has no expression. */
export function unwrapNode(node: ESTree.Node, options: UnwrapOptions = {}): Syntax {
  let current = node as Syntax;
  for (let depth = 0; depth < (options.maxDepth ?? Infinity); depth += 1) {
    const inner = innerExpression(current, options);
    if (inner === null) return current;
    current = inner;
  }
  return current;
}

/** Nullable/unknown input variant of unwrapNode; malformed wrapper children retain the last valid node. */
export function unwrap(value: unknown, options: UnwrapOptions = {}): Syntax | null {
  const node = asNode(value, options.requireStart);
  return node === null ? null : unwrapNode(node, options);
}

/** Unknown-input variant; malformed wrappers return null, matching the script syntax helper. */
export function syntax(value: unknown): Syntax | null {
  let node = asNode(value);
  while (node !== null && (EXPRESSION_WRAPPERS.has(node.type) || node.type === 'AwaitExpression')) {
    node = asNode(node.expression ?? node.argument);
  }
  return node;
}

export function identityUnwrap(node: ESTree.Node): ESTree.Node {
  return unwrapNode(node, { sequence: true });
}

export function skipWrappers(
  node: ESTree.Node,
  wrappers = EXPRESSION_WRAPPERS,
): {
  readonly node: Syntax;
  readonly parent: Syntax | null;
} {
  let current = node as Syntax;
  let parent = parentOf(current);
  while (parent !== null && wrappers.has(parent.type)) {
    current = parent;
    parent = parentOf(current);
  }
  return { node: current, parent };
}

export interface StringOptions {
  readonly templates?: boolean;
  readonly babelStrings?: boolean;
  readonly rawTemplates?: boolean;
  readonly singleQuasi?: boolean;
  readonly unwrap?: UnwrapOptions;
}

function stringNode(value: unknown, options: StringOptions): Syntax | null {
  const node = asNode(value);
  return node && options.unwrap ? unwrapNode(node, options.unwrap) : node;
}
function isStringLiteral(node: Syntax, options: StringOptions): boolean {
  return (
    node.type === 'Literal' ||
    (options.babelStrings === true && (node.type as string) === 'StringLiteral')
  );
}

/** String literals and, by default, interpolation-free cooked templates; never dynamic keys. */
export function staticString(value: unknown, options: StringOptions = {}): string | null {
  const node = stringNode(value, options);
  if (!node) return null;
  if (isStringLiteral(node, options)) {
    return typeof node.value === 'string' ? node.value : null;
  }
  if (
    options.templates !== false &&
    node.type === 'TemplateLiteral' &&
    node.expressions.length === 0
  ) {
    return templateText(node, options.rawTemplates === true, options.singleQuasi === true);
  }
  return null;
}

export function literalText(value: unknown): string | null {
  return staticString(syntax(value));
}

export function keyName(
  value: unknown,
  computed = false,
  options: StringOptions = {},
): string | null {
  const input = asNode(value);
  const key = input && options.unwrap ? unwrapNode(input, options.unwrap) : input;
  if (!computed && key?.type === 'Identifier') return key.name;
  return staticString(key, options);
}

/** Defaults to literal-only computed keys; opt into templates/unwrap to preserve wider copies. */
export function memberName(
  node: unknown,
  options: StringOptions = { templates: false },
): string | null {
  const member = asNode(node);
  return member ? keyName(member.property, member.computed === true, options) : null;
}

/** Script provenance permits keys and properties, awaited wrappers and cooked templates. */
export function propertyText(value: unknown): string | null {
  const node = asNode(value);
  if (!node) return null;
  return keyName(syntax(node.property ?? node.key), node.computed === true);
}

export function nearestFunction(node: unknown, kinds = FUNCTION_TYPES): Syntax | null {
  let current = parentOf(node);
  while (current !== null) {
    if (kinds.has(current.type)) return current;
    current = parentOf(current);
  }
  return null;
}

/** Unwrap parameter binding wrappers only; the original copies stop after four steps. */
export function unwrapBinding(node: ESTree.Node, maxDepth = 4): Syntax {
  let current = node as Syntax;
  const kinds = new Set(['AssignmentPattern', 'RestElement', 'TSParameterProperty']);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!kinds.has(current.type)) return current;
    const inner = asNode(current.left ?? current.argument ?? current.parameter);
    if (!inner) return current;
    current = inner;
  }
  return current;
}

export function childrenOf(
  node: ESTree.Node,
  visitorKeys: Readonly<Record<string, readonly string[]>>,
  requireStart = true,
): Syntax[] {
  const record = node as Syntax;
  const names =
    visitorKeys[node.type] ?? Object.keys(node).filter((key) => key !== 'parent' && key !== 'type');
  return names.flatMap((name) => {
    const value = record[name];
    const values: unknown[] = Array.isArray(value) ? value : [value];
    return values.map((entry) => asNode(entry, requireStart)).filter((entry) => entry !== null);
  });
}

/** Pre-order walk; false skips children. requireStart matches the generator walkers by default. */
export function walk(
  node: ESTree.Node,
  visitorKeys: Readonly<Record<string, readonly string[]>>,
  visit: (node: Syntax) => boolean | void,
  requireStart = true,
): void {
  const stack: Syntax[] = [node as Syntax];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visit(current) === false) continue;
    stack.push(...childrenOf(current, visitorKeys, requireStart).reverse());
  }
}

/** Dotted TS names, without expression evaluation. */
export function typeNameSegments(name: ESTree.TSTypeName): readonly string[] | null {
  if (name.type === 'Identifier') return [name.name];
  if (name.type !== 'TSQualifiedName') return null;
  const left = typeNameSegments(name.left);
  return left === null ? null : [...left, name.right.name];
}

export function isFunctionNode(node: unknown, kinds = FUNCTION_TYPES): boolean {
  const candidate = asNode(node);
  return candidate !== null && kinds.has(candidate.type);
}

export interface TypeUnwrapOptions {
  readonly maxDepth?: number;
  /** Parens only by default; broader dependency wrappers must be passed explicitly. */
  readonly wrappers?: ReadonlySet<string>;
  readonly readonlyOperator?: boolean;
  readonly elementTypeFallback?: boolean;
}
function innerType(node: Syntax, options: TypeUnwrapOptions): Syntax | null {
  const readonly =
    options.readonlyOperator && node.type === 'TSTypeOperator' && node.operator === 'readonly';
  if (!readonly && !(options.wrappers ?? TYPE_WRAPPERS).has(node.type)) return null;
  return asNode(
    options.elementTypeFallback ? (node.typeAnnotation ?? node.elementType) : node.typeAnnotation,
  );
}
const TYPE_WRAPPERS: ReadonlySet<string> = new Set(['TSParenthesizedType']);
export function unwrapType(node: ESTree.Node, options: TypeUnwrapOptions = {}): Syntax {
  let current = node as Syntax;
  for (let depth = 0; depth < (options.maxDepth ?? 8); depth += 1) {
    const inner = innerType(current, options);
    if (!inner) return current;
    current = inner;
  }
  return current;
}

/** Raw fallback/single-quasi defaults preserve the two tag-inspection copies; staticString opts out. */
export function templateText(
  node: ESTree.TemplateLiteral,
  rawFallback = true,
  requireSingleQuasi = true,
): string | null {
  if (requireSingleQuasi && node.quasis.length !== 1) return null;
  const quasi = node.quasis[0];
  if (!quasi) return null;
  return quasi.value.cooked ?? (rawFallback ? quasi.value.raw : null);
}

/** Static member matching with an explicit computed-key resolver for lexical constant aliases. */
export function asNamedMember(
  input: ESTree.Node,
  name: string,
  resolveComputed: (key: ESTree.Node) => string | null,
  options: UnwrapOptions = {},
): ESTree.MemberExpression | null {
  const node = unwrapNode(input, options);
  if (node.type !== 'MemberExpression') return null;
  if (!node.computed)
    return node.property.type === 'Identifier' && node.property.name === name ? node : null;
  if ((node.property.type as string) === 'PrivateIdentifier') return null;
  return resolveComputed(node.property) === name ? node : null;
}
