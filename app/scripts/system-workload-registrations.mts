import { Predicate } from 'effect';
import type { Node } from 'oxc-parser';

import { forEachNode, moduleBindings, parseProblem } from './module-bindings.mts';
import type { ModuleBinding, ModuleBindings } from './module-bindings.mts';

/*
 * Which system workloads a module's own source registers, read from its AST, and how that compares with the keys its
 * manifest declares in `systemWorkloads`. A registration is a direct call of `registerSystemWorkload` as it is
 * imported (under any local name, or as a member of a namespace import) with one object argument whose `jobKey` is a
 * string, or a top-level `const` string of the same file. Names are resolved by lexical scope (`module-bindings.mts`),
 * so a parameter or local declaration that shadows the import or the constant is not mistaken for it. Anything this
 * reading cannot name a key for fails closed: a file that does not parse, the function used as a value, re-exported or
 * destructured, a call with a computed, spread or variable key.
 */

export interface SystemWorkloadSourceFile {
  readonly content: string;
  /** The path named in an issue, relative to the module. */
  readonly path: string;
}

type CallExpression = Extract<Node, { readonly type: 'CallExpression' }>;

const registrationName = 'registerSystemWorkload';

const nameOf = (node: Node): string | undefined => {
  if (node.type === 'Identifier') {
    return node.name;
  }
  return node.type === 'Literal' && Predicate.isString(node.value) ? node.value : undefined;
};

/** The string a node states: a string literal, or a template literal without substitutions. */
const stringOf = (node: Node): string | undefined => {
  if (node.type === 'Literal' && Predicate.isString(node.value)) {
    return node.value;
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
};

/** The top-level `const` strings of a file, by the identifier that declares each. */
const topLevelStrings = ({ program }: ModuleBindings): ReadonlyMap<Node, string> =>
  new Map(
    program.body.flatMap((statement) => {
      const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
      if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') {
        return [];
      }
      return declaration.declarations.flatMap((declarator) => {
        const value = declarator.init === null ? undefined : stringOf(declarator.init);
        return declarator.id.type === 'Identifier' && value !== undefined ? [[declarator.id, value] as const] : [];
      });
    }),
  );

/** The module bindings a name resolves to; none when an inner scope or no declaration of the file binds it. */
const boundTo = (source: ModuleBindings, node: Node): readonly ModuleBinding[] =>
  source.referenceOf.get(node)?.bindings ?? [];

/** Whether a name resolves to an import, of values and not only of types, that `imports` accepts. */
const resolvesToImport = (source: ModuleBindings, node: Node, imports: (imported: string) => boolean): boolean =>
  boundTo(source, node).some(({ identifier, imported, statement }) => {
    const specifier = source.parents.get(identifier);
    return (
      imported !== undefined &&
      imports(imported.name) &&
      statement.type === 'ImportDeclaration' &&
      statement.importKind !== 'type' &&
      !(specifier?.type === 'ImportSpecifier' && specifier.importKind === 'type')
    );
  });

const isFactory = (source: ModuleBindings, node: Node): boolean =>
  resolvesToImport(source, node, (imported) => imported === registrationName);

/** The node that names the factory in a call that registers: an imported name, or a namespace import's member. */
const registeringCallee = (source: ModuleBindings, { callee }: CallExpression): Node | undefined => {
  if (callee.type === 'Identifier') {
    return isFactory(source, callee) ? callee : undefined;
  }
  return callee.type === 'MemberExpression' &&
    !callee.computed &&
    resolvesToImport(source, callee.object, (imported) => imported === '*') &&
    callee.property.type === 'Identifier' &&
    callee.property.name === registrationName
    ? callee.property
    : undefined;
};

/** The `jobKey` of a registration's one plain object argument, when the reading can name it. */
const jobKeyOf = (
  source: ModuleBindings,
  call: CallExpression,
  strings: ReadonlyMap<Node, string>,
): string | undefined => {
  const [argument, ...others] = call.arguments;
  if (others.length > 0 || argument?.type !== 'ObjectExpression') {
    return undefined;
  }
  // A spread, a computed key or a method could set the key the reading does not see.
  const plain = argument.properties.every(
    (property) => property.type === 'Property' && property.kind === 'init' && !property.computed && !property.method,
  );
  const keys = argument.properties.filter(
    (property) => property.type === 'Property' && nameOf(property.key) === 'jobKey',
  );
  const [only] = keys;
  if (!plain || keys.length !== 1 || only?.type !== 'Property') {
    return undefined;
  }
  const [bound, ...more] = boundTo(source, only.value);
  return stringOf(only.value) ?? (bound === undefined || more.length > 0 ? undefined : strings.get(bound.identifier));
};

/** Whether the factory's name here names a member or an export of something, which hands the function on. */
const namesMember = (parent: Node, node: Node): boolean =>
  (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
  (parent.type === 'Property' && parent.key === node && !parent.computed) ||
  parent.type === 'ExportSpecifier';

/**
 * Whether a node uses the factory in a way the reading cannot follow. A name that an inner scope or a declaration of
 * the file's own binds is another thing, whatever it is called; an undeclared one is taken for the factory.
 */
const handsOnFactory = (source: ModuleBindings, node: Node, parent: Node): boolean => {
  if (node.type === 'Literal') {
    return node.value === registrationName;
  }
  if (node.type !== 'Identifier') {
    return false;
  }
  const reference = source.referenceOf.get(node);
  if (reference !== undefined) {
    return isFactory(source, node) || (node.name === registrationName && reference.bindings.length === 0);
  }
  return node.name === registrationName && namesMember(parent, node);
};

/** The keys one file registers, and an issue for every use of the registration this reading cannot follow. */
export const registeredSystemWorkloadKeys = (file: SystemWorkloadSourceFile) => {
  const keys: string[] = [];
  const issues: string[] = [];
  const source = moduleBindings(file.path, file.content);
  if (source === undefined) {
    const reason = parseProblem(file.path, file.content)?.message ?? 'unreadable';
    issues.push(`${file.path} does not parse, so its system workload registrations cannot be read: ${reason}`);
    return { issues, keys };
  }
  const strings = topLevelStrings(source);
  const permitted = new Set<Node>();
  // A call is entered before its callee, so the callee is permitted by the time the walk reaches it.
  forEachNode(source.program, (node, parent) => {
    const callee = node.type === 'CallExpression' ? registeringCallee(source, node) : undefined;
    if (node.type === 'CallExpression' && callee !== undefined) {
      permitted.add(callee);
      const key = jobKeyOf(source, node, strings);
      if (key === undefined) {
        issues.push(
          `${file.path} registers a system workload whose jobKey is not a string or a top-level const string`,
        );
      } else {
        keys.push(key);
      }
    }
    if (!permitted.has(node) && handsOnFactory(source, node, parent)) {
      issues.push(`${file.path} uses ${registrationName} other than by a direct call`);
    }
  });
  return { issues, keys };
};

/**
 * Every system workload a module's own source registers is one its manifest declares, and every declared one is
 * registered by its source, so the published `systemWorkloads` are exactly the keys the module's code runs as.
 */
export const systemWorkloadRegistrationIssues = (input: {
  readonly appId: string;
  readonly declared: readonly string[];
  readonly files: readonly SystemWorkloadSourceFile[];
}): readonly string[] => {
  const registered = new Map<string, string>();
  const issues: string[] = [];
  for (const file of input.files) {
    const read = registeredSystemWorkloadKeys(file);
    issues.push(...read.issues.map((issue) => `${input.appId} ${issue}`));
    for (const key of read.keys) {
      registered.set(key, registered.get(key) ?? file.path);
    }
  }
  const declared = new Set(input.declared);
  for (const [key, filePath] of registered) {
    if (!declared.has(key)) {
      issues.push(
        `${input.appId} ${filePath} registers system workload ${key}, which its manifest does not declare in systemWorkloads`,
      );
    }
  }
  for (const key of input.declared) {
    if (!registered.has(key)) {
      issues.push(`${input.appId} manifest declares system workload ${key}, which no source of the module registers`);
    }
  }
  return issues;
};

/**
 * Every system workload Core's own source registers is one Core declares (`core-system-workloads.ts`): core modules have
 * no manifest, so that declaration is what an app's manifest is for its module. Unlike an app, Core is not required to
 * register every key it declares: the declaration may name a key before the source that runs as it exists.
 */
export const coreSystemWorkloadRegistrationIssues = (input: {
  readonly declared: readonly string[];
  readonly files: readonly SystemWorkloadSourceFile[];
}): readonly string[] => {
  const declared = new Set(input.declared);
  return input.files.flatMap((file) => {
    const read = registeredSystemWorkloadKeys(file);
    return [
      ...read.issues.map((issue) => `core ${issue}`),
      ...read.keys
        .filter((key) => !declared.has(key))
        .map(
          (key) =>
            `core ${file.path} registers system workload ${key}, which Core does not declare in core-system-workloads.ts`,
        ),
    ];
  });
};
