import { Visitor } from 'oxc-parser';
import type {
  ArrowFunctionExpression,
  Class as AstClass,
  Function as AstFunction,
  ParamPattern,
  Program,
  Span,
} from 'oxc-parser';

type ImplementationFunction = ArrowFunctionExpression | AstFunction;

export const bindingContains = (pattern: ParamPattern, name: string): boolean => {
  if (pattern.type === 'TSParameterProperty') {
    return bindingContains(pattern.parameter, name);
  }
  if (pattern.type === 'Identifier') {
    return pattern.name === name;
  }
  if (pattern.type === 'AssignmentPattern') {
    return bindingContains(pattern.left, name);
  }
  if (pattern.type === 'ObjectPattern') {
    return pattern.properties.some((property) =>
      bindingContains(property.type === 'RestElement' ? property.argument : property.value, name),
    );
  }
  if (pattern.type === 'ArrayPattern') {
    return pattern.elements.some((element) => element !== null && bindingContains(element, name));
  }
  return pattern.type === 'RestElement' && bindingContains(pattern.argument, name);
};

export const bindingShadows = (program: Program, name: string): boolean => {
  let shadowed = false;
  const parameters = (node: ImplementationFunction): void => {
    shadowed ||= node.params.some((parameter) => bindingContains(parameter, name));
  };
  new Visitor({
    ArrowFunctionExpression: parameters,
    AssignmentExpression: (node) => {
      shadowed ||= node.left.type === 'Identifier' && node.left.name === name;
    },
    CatchClause: (node) => {
      shadowed ||= node.param !== null && node.param !== undefined && bindingContains(node.param, name);
    },
    ClassDeclaration: (node) => {
      shadowed ||= node.id?.name === name;
    },
    ClassExpression: (node) => {
      shadowed ||= node.id?.name === name;
    },
    FunctionDeclaration: (node) => {
      parameters(node);
      shadowed ||= node.id?.name === name;
    },
    FunctionExpression: (node) => {
      parameters(node);
      shadowed ||= node.id?.name === name;
    },
    VariableDeclarator: (node) => {
      shadowed ||= bindingContains(node.id, name);
    },
  }).visit(program);
  return shadowed;
};

const hasAmbientNamespaceEscape = (program: Program): boolean => {
  let escaped = false;
  const ambient = new Set(['globalThis', 'global', 'window', 'self', 'Reflect', 'eval', 'Function']);
  const erased: Span[] = [];
  const erasedType = (node: Span): void => {
    erased.push(node);
  };
  const staticKey = (node: { readonly computed: boolean; readonly key: Span }): void => {
    if (!node.computed) {
      erased.push(node.key);
    }
  };
  new Visitor({
    MemberExpression: (node) => {
      if (!node.computed) {
        erased.push(node.property);
      }
    },
    MethodDefinition: staticKey,
    Property: (node) => {
      if (!node.shorthand) {
        staticKey(node);
      }
    },
    PropertyDefinition: staticKey,
    TSInterfaceDeclaration: erasedType,
    TSMethodSignature: staticKey,
    TSPropertySignature: staticKey,
    TSTypeAliasDeclaration: erasedType,
    TSTypeQuery: erasedType,
    TSTypeReference: erasedType,
  }).visit(program);
  new Visitor({
    Identifier: (node) => {
      escaped ||= ambient.has(node.name) && !erased.some((span) => span.start <= node.start && node.end <= span.end);
    },
  }).visit(program);
  return escaped;
};

const classIsExported = (declaration: AstClass, program: Program): boolean =>
  program.body.some(
    (statement) =>
      (statement.type === 'ExportDefaultDeclaration' && statement.declaration === declaration) ||
      (statement.type === 'ExportNamedDeclaration' &&
        (statement.declaration === declaration ||
          statement.specifiers.some(
            (specifier) => specifier.local.type === 'Identifier' && specifier.local.name === declaration.id?.name,
          ))),
  );

const classConstructorClosed = (declaration: AstClass, program: Program): boolean => {
  if (hasAmbientNamespaceEscape(program)) {
    return false;
  }
  const { id } = declaration;
  if (id === null) {
    return false;
  }
  const { name } = id;
  let reflected = false;
  new Visitor({
    CallExpression: (node) => {
      if (
        node.callee.type === 'MemberExpression' &&
        node.callee.object.type === 'Identifier' &&
        node.callee.object.name === 'Reflect'
      ) {
        reflected = true;
      }
    },
    MemberExpression: (node) => {
      reflected ||=
        node.computed ||
        (node.property.type === 'Identifier' &&
          ['constructor', '__proto__', 'getPrototypeOf'].includes(node.property.name));
    },
  }).visit(program);
  if (reflected) {
    return false;
  }
  const uses: Span[] = [id];
  const staticMethods = declaration.body.body.filter(
    (member) =>
      member.type === 'MethodDefinition' &&
      member.static &&
      member.kind === 'method' &&
      !member.computed &&
      member.key.type === 'Identifier',
  );
  const staticNames = new Set(
    staticMethods.flatMap((member) =>
      member.type === 'MethodDefinition' && member.key.type === 'Identifier' ? [member.key.name] : [],
    ),
  );
  let staticThis = false;
  new Visitor({
    ThisExpression: (node) => {
      staticThis ||= staticMethods.some((method) => method.start <= node.start && node.end <= method.end);
    },
  }).visit(program);
  if (staticThis) {
    return false;
  }
  new Visitor({
    BinaryExpression: (node) => {
      if (node.operator === 'instanceof' && node.right.type === 'Identifier' && node.right.name === name) {
        uses.push(node.right);
      }
    },
    CallExpression: (node) => {
      if (
        !node.optional &&
        node.callee.type === 'MemberExpression' &&
        !node.callee.computed &&
        !node.callee.optional &&
        node.callee.property.type === 'Identifier' &&
        staticNames.has(node.callee.property.name) &&
        node.callee.object.type === 'Identifier' &&
        node.callee.object.name === name
      ) {
        uses.push(node.callee.object);
      }
    },
    NewExpression: (node) => {
      if (node.callee.type === 'Identifier' && node.callee.name === name) {
        uses.push(node.callee);
      }
    },
  }).visit(program);
  let escaped = false;
  new Visitor({
    Identifier: (node) => {
      if (node.name === name && !uses.some((use) => use.start === node.start && use.end === node.end)) {
        escaped = true;
      }
    },
  }).visit(program);
  return !escaped;
};

export const hasClosedNativeObjectNamespace = (program: Program): boolean => {
  if (hasAmbientNamespaceEscape(program)) {
    return false;
  }
  const receivers: Span[] = [];
  new Visitor({
    CallExpression: (node) => {
      if (
        !node.optional &&
        node.callee.type === 'MemberExpression' &&
        !node.callee.computed &&
        !node.callee.optional &&
        node.callee.object.type === 'Identifier' &&
        node.callee.object.name === 'Object' &&
        node.callee.property.type === 'Identifier' &&
        Object.hasOwn(Object, node.callee.property.name)
      ) {
        receivers.push(node.callee.object);
      }
    },
  }).visit(program);
  let escaped = false;
  new Visitor({
    Identifier: (node) => {
      if (
        node.name === 'Object' &&
        !receivers.some((receiver) => receiver.start === node.start && receiver.end === node.end)
      ) {
        escaped = true;
      }
    },
  }).visit(program);
  return !escaped;
};

/** Preserve the complete reviewed custody rule across scope and Core fact proofs. */
export const hasClosedClassConstructor = (declaration: AstClass, program: Program): boolean =>
  !classIsExported(declaration, program) && classConstructorClosed(declaration, program);

/** Global constructors may occur only at genuine direct new-sites; aliases cannot mutate a trusted builtin. */
export const hasClosedNativeGlobalConstructor = (program: Program, name: string): boolean => {
  if (hasAmbientNamespaceEscape(program)) {
    return false;
  }
  const uses: Span[] = [];
  new Visitor({
    NewExpression: (node) => {
      if (node.callee.type === 'Identifier' && node.callee.name === name) {
        uses.push(node.callee);
      }
    },
  }).visit(program);
  let escaped = false;
  new Visitor({
    Identifier: (node) => {
      if (node.name === name && !uses.some((use) => use.start === node.start && use.end === node.end)) {
        escaped = true;
      }
    },
  }).visit(program);
  return !escaped;
};
