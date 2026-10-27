/**
 * Czech validation of tool arguments against their JSON Schema, before anything reaches a module or a reviewer.
 * An interpreter over the keywords Effect Schema emits (no code generation, so it runs in workerd as well as Node).
 * Unknown keywords are ignored: the module still validates every request itself.
 */
import { Array as Arr, Iterable, Result, Schema } from 'effect';

import type { JsonObject } from './catalog.ts';

type Json = JsonObject[string];

const TYPE_CS = new Map<string, string>(
  Object.entries({
    array: 'seznam',
    boolean: 'true/false',
    integer: 'celé číslo',
    null: 'null',
    number: 'číslo',
    object: 'objekt',
    string: 'text',
  }),
);

const isObject = Schema.is(Schema.JsonObject);
const isArray = Arr.isArray<Schema.Json | undefined>;
const isString = Schema.is(Schema.String);
const isNumber = Schema.is(Schema.Finite);

const typeOf = (value: Json | undefined): string => {
  if (value === null) {
    return 'null';
  }
  if (isArray(value)) {
    return 'array';
  }
  if (isNumber(value)) {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  if (isString(value)) {
    return 'string';
  }
  if (Schema.is(Schema.Boolean)(value)) {
    return 'boolean';
  }
  return value === undefined ? 'undefined' : 'object';
};

const matchesType = (expected: string, value: Json | undefined): boolean => {
  const actual = typeOf(value);
  return expected === actual || (expected === 'number' && actual === 'integer');
};

const encodeJson = Schema.encodeResult(Schema.fromJsonString(Schema.Json));
const equal = (left: Json | undefined, right: Json | undefined): Result.Result<boolean, Schema.SchemaError> =>
  Result.gen(function* compareJson() {
    if (left === undefined || right === undefined) {
      return left === right;
    }
    const encodedLeft = yield* encodeJson(left);
    const encodedRight = yield* encodeJson(right);
    return encodedLeft === encodedRight;
  });

const fieldName = (path: readonly string[]): string => (path.length === 0 ? '(vstup)' : path.join('.'));

const patternOf = (source: string): RegExp | null => {
  try {
    return new RegExp(source, 'u');
  } catch {
    return null;
  }
};

const MAX_DEPTH = 64;

const checkString = (schema: JsonObject, value: string, field: string, problems: string[]): void => {
  if (isNumber(schema['minLength']) && Iterable.size(value) < schema['minLength']) {
    problems.push(`„${field}“ je příliš krátké (nejméně ${schema['minLength']} znaků)`);
  }
  if (isNumber(schema['maxLength']) && Iterable.size(value) > schema['maxLength']) {
    problems.push(`„${field}“ je příliš dlouhé (nejvíce ${schema['maxLength']} znaků)`);
  }
  const pattern = isString(schema['pattern']) ? patternOf(schema['pattern']) : null;
  if (pattern !== null && !pattern.test(value)) {
    problems.push(`„${field}“ nemá správný tvar`);
  }
};

const checkNumber = (schema: JsonObject, value: number, field: string, problems: string[]): void => {
  if (isNumber(schema['minimum']) && value < schema['minimum']) {
    problems.push(`„${field}“ je příliš malé (>= ${schema['minimum']})`);
  }
  if (isNumber(schema['maximum']) && value > schema['maximum']) {
    problems.push(`„${field}“ je příliš velké (<= ${schema['maximum']})`);
  }
  if (isNumber(schema['exclusiveMinimum']) && value <= schema['exclusiveMinimum']) {
    problems.push(`„${field}“ je příliš malé (> ${schema['exclusiveMinimum']})`);
  }
  if (isNumber(schema['exclusiveMaximum']) && value >= schema['exclusiveMaximum']) {
    problems.push(`„${field}“ je příliš velké (< ${schema['exclusiveMaximum']})`);
  }
};

interface ValidationContext {
  readonly definitions: JsonObject;
  readonly depth: number;
  readonly path: readonly string[];
  readonly problems: string[];
}

type Check = (
  schema: Json | undefined,
  value: Json | undefined,
  context: ValidationContext,
) => Result.Result<void, Schema.SchemaError>;

const checkArray = (validate: Check, schema: JsonObject, value: readonly Json[], context: ValidationContext) =>
  Result.gen(function* checkArrayKeywords() {
    const { definitions, depth, path, problems } = context;
    const field = fieldName(path);
    if (isNumber(schema['minItems']) && value.length < schema['minItems']) {
      problems.push(`„${field}“ musí mít aspoň ${schema['minItems']} položek`);
    }
    if (isNumber(schema['maxItems']) && value.length > schema['maxItems']) {
      problems.push(`„${field}“ smí mít nejvýše ${schema['maxItems']} položek`);
    }
    const prefixItems = isArray(schema['prefixItems']) ? schema['prefixItems'] : [];
    for (const [index, item] of value.entries()) {
      const itemSchema = index < prefixItems.length ? prefixItems[index] : schema['items'];
      yield* validate(itemSchema, item, { definitions, depth: depth + 1, path: [...path, String(index)], problems });
    }
  });

const checkObject = (validate: Check, schema: JsonObject, value: JsonObject, context: ValidationContext) =>
  Result.gen(function* checkObjectKeywords() {
    const { definitions, depth, path, problems } = context;
    const properties = isObject(schema['properties']) ? schema['properties'] : {};
    const required = isArray(schema['required']) ? schema['required'] : [];
    for (const name of required) {
      if (isString(name) && !(name in value)) {
        problems.push(`chybí povinné pole „${fieldName([...path, name])}“`);
      }
    }
    for (const [name, child] of Object.entries(value)) {
      if (name in properties) {
        yield* validate(properties[name], child, { definitions, depth: depth + 1, path: [...path, name], problems });
      } else if (schema['additionalProperties'] === false) {
        problems.push(`neznámé pole „${fieldName([...path, name])}“`);
      } else if (isObject(schema['additionalProperties'])) {
        yield* validate(schema['additionalProperties'], child, {
          definitions,
          depth: depth + 1,
          path: [...path, name],
          problems,
        });
      }
    }
  });

const checkVariants = (
  validate: Check,
  branches: readonly Json[],
  value: Json | undefined,
  context: ValidationContext,
) =>
  Result.gen(function* checkVariantKeywords() {
    for (const branch of branches) {
      const nested: string[] = [];
      yield* validate(branch, value, { ...context, depth: context.depth + 1, problems: nested });
      if (nested.length === 0) {
        return true;
      }
    }
    context.problems.push(`„${fieldName(context.path)}“ neodpovídá žádné povolené variantě`);
    return false;
  });

const checkAllowedValues = (schema: JsonObject, value: Json | undefined, field: string, problems: string[]) =>
  Result.gen(function* checkAllowedValueKeywords() {
    const allowedValues = schema['enum'];
    if (isArray(allowedValues)) {
      let allowed = false;
      for (const candidate of allowedValues) {
        if (yield* equal(candidate, value)) {
          allowed = true;
          break;
        }
      }
      if (!allowed) {
        const encoded = yield* encodeJson(allowedValues);
        problems.push(`„${field}“ musí být jedna z hodnot ${encoded}`);
      }
    }
    if ('const' in schema && !(yield* equal(schema['const'], value))) {
      const constant = schema['const'];
      const encoded = constant === undefined ? 'undefined' : yield* encodeJson(constant);
      problems.push(`„${field}“ musí být ${encoded}`);
    }
  });

const checkType = (schema: JsonObject, value: Json | undefined, field: string, problems: string[]): boolean => {
  const { type } = schema;
  const types = isArray(type) ? type.filter(isString) : [];
  const expectedTypes = isString(type) ? [type] : types;
  if (expectedTypes.length > 0 && !expectedTypes.some((expected) => matchesType(expected, value))) {
    problems.push(
      `„${field}“ musí být ${expectedTypes.map((expected) => TYPE_CS.get(expected) ?? expected).join(' nebo ')}`,
    );
    return false;
  }
  return true;
};

const check: Check = (schema, value, context) =>
  Result.gen(function* checkKeywords() {
    const { definitions, depth, path, problems } = context;
    if (!isObject(schema) || depth > MAX_DEPTH) {
      return;
    }
    const field = fieldName(path);
    const ref = schema['$ref'];
    if (isString(ref)) {
      const name = ref.replace(/^#\/(?:\$defs|definitions)\//u, '');
      yield* check(definitions[name], value, { ...context, depth: depth + 1 });
    }
    const { anyOf, oneOf } = schema;
    const branches = isArray(anyOf) ? anyOf : oneOf;
    if (isArray(branches) && !(yield* checkVariants(check, branches, value, context))) {
      return;
    }
    const { allOf } = schema;
    if (isArray(allOf)) {
      for (const part of allOf) {
        yield* check(part, value, { ...context, depth: depth + 1 });
      }
    }
    if (!checkType(schema, value, field, problems)) {
      return;
    }
    yield* checkAllowedValues(schema, value, field, problems);
    if (isString(value)) {
      checkString(schema, value, field, problems);
    }
    if (isNumber(value)) {
      checkNumber(schema, value, field, problems);
    }
    if (isArray(value)) {
      yield* checkArray(check, schema, value, context);
    }
    if (isObject(value)) {
      yield* checkObject(check, schema, value, context);
    }
  });

/** Czech keyword diagnostics, retaining any JSON encoding failure in the Result error channel. */
export const inputProblems = (schema: JsonObject, value: Json | undefined, prefix = '') =>
  Result.gen(function* collectInputProblems() {
    const problems: string[] = [];
    const definitions = isObject(schema['$defs']) ? schema['$defs'] : {};
    yield* check(schema, value, { definitions, depth: 0, path: prefix === '' ? [] : [prefix], problems });
    const unique = [...new Set(problems)];
    return unique.length === 0 ? undefined : unique.slice(0, 6).join('; ');
  });
