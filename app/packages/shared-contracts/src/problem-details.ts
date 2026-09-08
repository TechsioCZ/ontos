import { HttpApiSchema } from '@modern-js/plugin-bff/effect-client';
import { Match, Predicate, Schema, SchemaAST } from 'effect';

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-return, typescript/no-unsafe-type-assertion -- SAFETY: Schema ASTs are runtime-discriminated Effect objects; the clone boundary preserves the checked graph's exact generic schema type. remove-when: Effect exposes a typed AST clone API; expires: 2026-12-31. */

/** HTTP statuses currently used by OntOS public Problem Details contracts. */
export type ProblemDetailsStatus = 400 | 401 | 403 | 404 | 409 | 422 | 428 | 429 | 500 | 503 | 504;

const problemDetailsRepresentation = HttpApiSchema.asJson({
  contentType: 'application/problem+json',
});

const hasJsonSafeNumberCheck = (checks: SchemaAST.Checks | undefined): boolean =>
  checks?.some((check) =>
    Match.value(check).pipe(
      Match.tag(
        'Filter',
        ({ annotations }) =>
          annotations?.representation?.id === 'effect/schema/isFinite' ||
          annotations?.representation?.id === 'effect/schema/isInt',
      ),
      Match.tag('FilterGroup', ({ checks: nestedChecks }) => hasJsonSafeNumberCheck(nestedChecks)),
      Match.exhaustive,
    ),
  ) === true;

const isUnsupportedExtensionPrimitive = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isAny(ast) ||
  SchemaAST.isBigInt(ast) ||
  SchemaAST.isSymbol(ast) ||
  SchemaAST.isUniqueSymbol(ast) ||
  SchemaAST.isUndefined(ast) ||
  SchemaAST.isUnknown(ast) ||
  SchemaAST.isVoid(ast) ||
  SchemaAST.isObjectKeyword(ast);

const isJsonLiteral = (ast: SchemaAST.Literal): boolean =>
  ast.literal === null ||
  Predicate.isString(ast.literal) ||
  (Predicate.isNumber(ast.literal) && Number.isFinite(ast.literal)) ||
  Predicate.isBoolean(ast.literal);

const isConcreteExtensionValue = (ast: SchemaAST.AST): boolean => {
  if (isUnsupportedExtensionPrimitive(ast) || SchemaAST.isDeclaration(ast)) {
    return false;
  }
  if (SchemaAST.isLiteral(ast)) {
    return isJsonLiteral(ast);
  }
  if (SchemaAST.isNumber(ast)) {
    return hasJsonSafeNumberCheck(ast.checks);
  }
  if (SchemaAST.isEnum(ast)) {
    return ast.enums.every(([, value]) => Predicate.isString(value) || Number.isFinite(value));
  }
  return true;
};

const visitExtensionChildren = (
  ast: SchemaAST.AST,
  visit: (ast: SchemaAST.AST) => boolean,
): boolean => {
  if (SchemaAST.isArrays(ast)) {
    return ast.elements.every(visit) && ast.rest.every(visit);
  }
  if (SchemaAST.isObjects(ast)) {
    return (
      ast.indexSignatures.length === 0 &&
      ast.propertySignatures.every(
        ({ name, type }) => Predicate.isString(name) && name !== '__proto__' && visit(type),
      )
    );
  }
  if (SchemaAST.isUnion(ast)) {
    return ast.types.every(visit);
  }
  if (SchemaAST.isSuspend(ast)) {
    return visit(ast.thunk());
  }
  return true;
};

const isConcreteExtensionAst = (root: SchemaAST.AST): boolean => {
  const seen = new Set<SchemaAST.AST>();
  const visit = (ast: SchemaAST.AST): boolean => {
    if (seen.has(ast)) {
      return true;
    }
    seen.add(ast);
    if (ast.encoding !== undefined && ast.encoding.length > 0) {
      if (SchemaAST.isAny(ast) || SchemaAST.isUnknown(ast) || SchemaAST.isObjectKeyword(ast)) {
        return false;
      }
      return ast.encoding.every((link) => visit(link.to));
    }
    return isConcreteExtensionValue(ast) && visitExtensionChildren(ast, visit);
  };
  return visit(root);
};

const cloneDescriptors = <Value>(value: Value, clone: <Current>(value: Current) => Current) => {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if ('value' in descriptor) {
      const descriptorValue = descriptor.value;
      descriptor.value =
        key === 'thunk' &&
        SchemaAST.isAST(value) &&
        SchemaAST.isSuspend(value) &&
        Predicate.isFunction(descriptorValue)
          ? () => clone(descriptorValue())
          : clone(descriptorValue);
    }
  }
  return descriptors;
};

const cloneAstGraph = <Value>(root: Value): Value => {
  const seen = new Map<object, object>();
  const clone = <Current>(value: Current): Current => {
    if (Predicate.isFunction(value) || !Predicate.isObjectKeyword(value)) {
      return value;
    }
    const objectValue = value;
    const existing = seen.get(objectValue);
    if (existing !== undefined) {
      return existing as Current;
    }
    if (Predicate.isMap(value)) {
      const copy = new Map();
      seen.set(objectValue, copy);
      for (const [key, entry] of value) {
        copy.set(clone(key), clone(entry));
      }
      return copy as Current;
    }
    if (Predicate.isSet(value)) {
      const copy = new Set();
      seen.set(objectValue, copy);
      for (const entry of value) {
        copy.add(clone(entry));
      }
      return copy as Current;
    }
    const copy: object = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
    seen.set(objectValue, copy);
    Object.defineProperties(copy, cloneDescriptors(value, clone));
    return copy as Current;
  };
  return clone(root);
};

const stableExtensionField = (name: string, descriptor: PropertyDescriptor) => {
  const field = descriptor.value;
  if (!Schema.isSchema(field)) {
    // eslint-disable-next-line effect-native/no-native-error-construction -- This synchronous, browser-safe schema factory rejects a caller programming error before a contract can be published.
    throw new TypeError(`Problem Details extension field "${name}" must use a concrete schema.`);
  }
  const fieldDescriptors = Object.getOwnPropertyDescriptors(field);
  const astDescriptor = fieldDescriptors.ast;
  if (
    astDescriptor === undefined ||
    !('value' in astDescriptor) ||
    !SchemaAST.isAST(astDescriptor.value)
  ) {
    // eslint-disable-next-line effect-native/no-native-error-construction -- Schema AST accessors could change after validation; the captured AST must be the one consumed by TaggedStruct.
    throw new TypeError(`Problem Details extension field "${name}" must use a concrete schema.`);
  }
  const stableAst = cloneAstGraph(astDescriptor.value);
  if (!isConcreteExtensionAst(stableAst)) {
    // eslint-disable-next-line effect-native/no-native-error-construction -- This synchronous, browser-safe schema factory rejects a caller programming error before a contract can be published.
    throw new TypeError(`Problem Details extension field "${name}" must use a concrete schema.`);
  }
  astDescriptor.value = stableAst;
  return Object.defineProperties(Object.create(Object.getPrototypeOf(field)), fieldDescriptors);
};

const reservedExtensionFields = new Set([
  '__proto__',
  '_tag',
  'detail',
  'retryable',
  'status',
  'title',
  'type',
]);

const concreteExtensionsSnapshot = <const Extensions extends Schema.Struct.Fields>(
  extensions: Extensions,
): Extensions => {
  if (
    Object.getPrototypeOf(extensions) !== Object.prototype &&
    Object.getPrototypeOf(extensions) !== null
  ) {
    // eslint-disable-next-line effect-native/no-native-error-construction -- This synchronous, browser-safe schema factory rejects a caller programming error before a contract can be published.
    throw new TypeError('Problem Details extensions must use a plain object.');
  }
  const snapshot = Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(extensions),
  ) as Extensions;
  for (const name of Reflect.ownKeys(snapshot)) {
    if (!Predicate.isString(name)) {
      // eslint-disable-next-line effect-native/no-native-error-construction -- This synchronous, browser-safe schema factory rejects a caller programming error before a contract can be published.
      throw new TypeError('Problem Details extension field names must be strings.');
    }
    if (reservedExtensionFields.has(name)) {
      // eslint-disable-next-line effect-native/no-native-error-construction -- This synchronous, browser-safe schema factory rejects a caller programming error before a contract can be published.
      throw new TypeError(`Problem Details extension field "${name}" is reserved.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(snapshot, name);
    if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) {
      // eslint-disable-next-line effect-native/no-native-error-construction -- Accessors could change after validation; contract fields must be immutable schema data descriptors.
      throw new TypeError(
        `Problem Details extension field "${name}" must be an enumerable data property.`,
      );
    }
    const stableField = stableExtensionField(name, descriptor);
    Object.defineProperty(snapshot, name, { ...descriptor, value: stableField });
  }
  return snapshot;
};

// eslint-disable-next-line effect-native/no-wide-factory-signature -- These four inputs are immutable schema data, not Effect service dependencies.
const makeAnnotatedProblemDetailsSchema = <
  const Tag extends string,
  const Status extends ProblemDetailsStatus,
  const Marker extends Schema.Struct.Fields,
  const Extensions extends Schema.Struct.Fields,
>(
  tag: Tag,
  status: Status,
  marker: Marker,
  extensions?: Extensions,
) => {
  const concreteExtensions =
    extensions === undefined ? extensions : concreteExtensionsSnapshot(extensions);
  // eslint-disable-next-line prefer-object-spread -- Object.assign preserves the concrete generic marker and extension fields in the inferred schema type.
  const fields = Object.assign(
    {
      detail: Schema.String,
      status: Schema.Literal(status),
      title: Schema.String,
      type: Schema.String,
    },
    marker,
    concreteExtensions,
  );
  return Schema.TaggedStruct(tag, fields).pipe(
    problemDetailsRepresentation,
    HttpApiSchema.status(status),
  );
};

/**
 * Builds an RFC 9457 response schema while coupling its literal body status to its HttpApi status.
 * Endpoint contracts remain responsible for their public tag, extensions, and explicit error list.
 */
// eslint-disable-next-line effect-native/no-wide-factory-signature -- All three inputs are immutable schema data, not Effect service dependencies.
export const makeProblemDetailsSchema = <
  const Tag extends string,
  const Status extends ProblemDetailsStatus,
  const Extensions extends Schema.Struct.Fields = Record<never, never>,
>(
  tag: Tag,
  status: Status,
  extensions?: Extensions,
) => makeAnnotatedProblemDetailsSchema(tag, status, {}, extensions);

/** Builds a Problem Details schema with the deliberate literal `retryable: true` marker. */
// eslint-disable-next-line effect-native/no-wide-factory-signature -- All three inputs are immutable schema data, not Effect service dependencies.
export const makeRetryableProblemDetailsSchema = <
  const Tag extends string,
  const Status extends ProblemDetailsStatus,
  const Extensions extends Schema.Struct.Fields = Record<never, never>,
>(
  tag: Tag,
  status: Status,
  extensions?: Extensions,
) =>
  makeAnnotatedProblemDetailsSchema(tag, status, { retryable: Schema.Literal(true) }, extensions);
