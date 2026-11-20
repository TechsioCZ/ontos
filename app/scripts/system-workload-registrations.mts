import { Predicate } from 'effect';
import { parseSync, Visitor } from 'oxc-parser';
import type { Node, Program } from 'oxc-parser';

/*
 * Which system workloads a module's own source registers, read from its AST, and how that compares with the keys its
 * manifest declares in `systemWorkloads`. A registration is a direct call of `registerSystemWorkload` as it is
 * imported (under any local name, or as a member of a namespace import) with one object argument whose `jobKey` is a
 * string, or a top-level `const` string of the same file bound nowhere else. Anything this reading cannot name a key
 * for fails closed: the function used as a value, re-exported or destructured, a call with a computed, spread or
 * variable key.
 */

export interface SystemWorkloadSourceFile {
  readonly content: string;
  /** The path named in an issue, relative to the module. */
  readonly path: string;
}

type CallExpression = Extract<Node, { readonly type: 'CallExpression' }>;
type Identifier = Extract<Node, { readonly type: 'Identifier' }>;

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

/** How many bindings of a name the file declares, as a variable or a function parameter, in any scope. */
const bindingCount = (program: Program, name: string): number => {
  let count = 0;
  const parameters = (node: { readonly params: readonly Node[] }): void => {
    count += node.params.filter((parameter) => parameter.type === 'Identifier' && parameter.name === name).length;
  };
  new Visitor({
    ArrowFunctionExpression: parameters,
    FunctionDeclaration: parameters,
    FunctionExpression: parameters,
    VariableDeclarator: (declarator) => {
      count += declarator.id.type === 'Identifier' && declarator.id.name === name ? 1 : 0;
    },
  }).visit(program);
  return count;
};

/** The top-level `const` strings of a file that nothing else in it binds again, by name. */
const topLevelStrings = (program: Program): ReadonlyMap<string, string> =>
  new Map(
    program.body.flatMap((statement) => {
      const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
      if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') {
        return [];
      }
      return declaration.declarations.flatMap((declarator) => {
        const value = declarator.init === null ? undefined : stringOf(declarator.init);
        return declarator.id.type === 'Identifier' &&
          value !== undefined &&
          bindingCount(program, declarator.id.name) === 1
          ? [[declarator.id.name, value] as const]
          : [];
      });
    }),
  );

/** The `jobKey` of a registration's one plain object argument, when the reading can name it. */
const jobKeyOf = (call: CallExpression, strings: ReadonlyMap<string, string>): string | undefined => {
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
  return stringOf(only.value) ?? (only.value.type === 'Identifier' ? strings.get(only.value.name) : undefined);
};

/** The keys one file registers, and an issue for every use of the registration this reading cannot follow. */
export const registeredSystemWorkloadKeys = (file: SystemWorkloadSourceFile) => {
  const parsed = parseSync(file.path, file.content, { astType: 'ts', lang: 'ts', sourceType: 'module' });
  const { program } = parsed;
  const locals = new Set<string>();
  const namespaces = new Set<string>();
  const permitted = new Set<Identifier>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (
        specifier.type === 'ImportSpecifier' &&
        specifier.importKind !== 'type' &&
        nameOf(specifier.imported) === registrationName
      ) {
        locals.add(specifier.local.name);
        permitted.add(specifier.local);
        if (specifier.imported.type === 'Identifier') {
          permitted.add(specifier.imported);
        }
      }
      if (specifier.type === 'ImportNamespaceSpecifier') {
        namespaces.add(specifier.local.name);
      }
    }
  }
  const strings = topLevelStrings(program);
  const keys: string[] = [];
  const issues: string[] = [];
  new Visitor({
    CallExpression: (call) => {
      const { callee } = call;
      if (callee.type === 'Identifier' && locals.has(callee.name)) {
        permitted.add(callee);
      } else if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.object.type === 'Identifier' &&
        namespaces.has(callee.object.name) &&
        callee.property.type === 'Identifier' &&
        callee.property.name === registrationName
      ) {
        permitted.add(callee.property);
      } else {
        return;
      }
      const key = jobKeyOf(call, strings);
      if (key === undefined) {
        issues.push(
          `${file.path} registers a system workload whose jobKey is not a string or a top-level const string`,
        );
      } else {
        keys.push(key);
      }
    },
  }).visit(program);
  const unfollowed = () => {
    issues.push(`${file.path} uses ${registrationName} other than by a direct call`);
  };
  new Visitor({
    Identifier: (identifier) => {
      if ((identifier.name === registrationName || locals.has(identifier.name)) && !permitted.has(identifier)) {
        unfollowed();
      }
    },
    Literal: (literal) => {
      if (literal.value === registrationName) {
        unfollowed();
      }
    },
  }).visit(program);
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
