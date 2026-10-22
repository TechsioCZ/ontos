/**
 * Czech validation of tool arguments against their JSON Schema, before anything reaches a module or a reviewer.
 * An interpreter over the keywords Effect Schema emits (no code generation, so it runs in workerd as well as Node).
 * Unknown keywords are ignored: the module still validates every request itself.
 */
import type { JsonObject } from './catalog.ts';

type Json = JsonObject[string];

const TYPE_CS: Readonly<Record<string, string>> = {
  array: 'seznam',
  boolean: 'true/false',
  integer: 'celé číslo',
  null: 'null',
  number: 'číslo',
  object: 'objekt',
  string: 'text',
};

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const typeOf = (value: unknown): string => {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return typeof value;
};

const matchesType = (expected: string, value: unknown): boolean => {
  const actual = typeOf(value);
  return expected === actual || (expected === 'number' && actual === 'integer');
};

const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const fieldName = (path: readonly string[]): string => (path.length === 0 ? '(vstup)' : path.join('.'));

const patternCache = new Map<string, RegExp | null>();
const patternOf = (source: string): RegExp | null => {
  if (!patternCache.has(source)) {
    try {
      patternCache.set(source, new RegExp(source, 'u'));
    } catch {
      patternCache.set(source, null);
    }
  }
  return patternCache.get(source) ?? null;
};

const MAX_DEPTH = 64;

const check = (
  schema: Json | undefined,
  value: unknown,
  path: readonly string[],
  definitions: JsonObject,
  problems: string[],
  depth: number,
): void => {
  if (!isObject(schema) || depth > MAX_DEPTH) {
    return;
  }
  const field = fieldName(path);
  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    const name = ref.replace(/^#\/(?:\$defs|definitions)\//u, '');
    check(definitions[name], value, path, definitions, problems, depth + 1);
  }
  const branches = Array.isArray(schema['anyOf']) ? schema['anyOf'] : Array.isArray(schema['oneOf']) ? schema['oneOf'] : undefined;
  if (branches !== undefined) {
    const matches = branches.some((branch) => {
      const nested: string[] = [];
      check(branch, value, path, definitions, nested, depth + 1);
      return nested.length === 0;
    });
    if (!matches) {
      problems.push(`„${field}“ neodpovídá žádné povolené variantě`);
      return;
    }
  }
  if (Array.isArray(schema['allOf'])) {
    for (const part of schema['allOf']) {
      check(part, value, path, definitions, problems, depth + 1);
    }
  }
  const type = schema['type'];
  const types = typeof type === 'string' ? [type] : Array.isArray(type) ? type.filter((t) => typeof t === 'string') : [];
  if (types.length > 0 && !types.some((expected) => matchesType(expected as string, value))) {
    problems.push(`„${field}“ musí být ${types.map((t) => TYPE_CS[t as string] ?? t).join(' nebo ')}`);
    return;
  }
  if (Array.isArray(schema['enum']) && !schema['enum'].some((allowed) => equal(allowed, value))) {
    problems.push(`„${field}“ musí být jedna z hodnot ${JSON.stringify(schema['enum'])}`);
  }
  if ('const' in schema && !equal(schema['const'], value)) {
    problems.push(`„${field}“ musí být ${JSON.stringify(schema['const'])}`);
  }
  if (typeof value === 'string') {
    if (typeof schema['minLength'] === 'number' && [...value].length < schema['minLength']) {
      problems.push(`„${field}“ je příliš krátké (nejméně ${schema['minLength']} znaků)`);
    }
    if (typeof schema['maxLength'] === 'number' && [...value].length > schema['maxLength']) {
      problems.push(`„${field}“ je příliš dlouhé (nejvíce ${schema['maxLength']} znaků)`);
    }
    const pattern = typeof schema['pattern'] === 'string' ? patternOf(schema['pattern']) : null;
    if (pattern !== null && !pattern.test(value)) {
      problems.push(`„${field}“ nemá správný tvar`);
    }
  }
  if (typeof value === 'number') {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum']) {
      problems.push(`„${field}“ je příliš malé (>= ${schema['minimum']})`);
    }
    if (typeof schema['maximum'] === 'number' && value > schema['maximum']) {
      problems.push(`„${field}“ je příliš velké (<= ${schema['maximum']})`);
    }
    if (typeof schema['exclusiveMinimum'] === 'number' && value <= schema['exclusiveMinimum']) {
      problems.push(`„${field}“ je příliš malé (> ${schema['exclusiveMinimum']})`);
    }
    if (typeof schema['exclusiveMaximum'] === 'number' && value >= schema['exclusiveMaximum']) {
      problems.push(`„${field}“ je příliš velké (< ${schema['exclusiveMaximum']})`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) {
      problems.push(`„${field}“ musí mít aspoň ${schema['minItems']} položek`);
    }
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) {
      problems.push(`„${field}“ smí mít nejvýše ${schema['maxItems']} položek`);
    }
    const prefixItems = Array.isArray(schema['prefixItems']) ? schema['prefixItems'] : [];
    value.forEach((item, index) => {
      const itemSchema = index < prefixItems.length ? prefixItems[index] : schema['items'];
      check(itemSchema, item, [...path, String(index)], definitions, problems, depth + 1);
    });
  }
  if (isObject(value)) {
    const properties = isObject(schema['properties']) ? schema['properties'] : {};
    const required = Array.isArray(schema['required']) ? schema['required'] : [];
    for (const name of required) {
      if (typeof name === 'string' && !(name in value)) {
        problems.push(`chybí povinné pole „${fieldName([...path, name])}“`);
      }
    }
    for (const [name, child] of Object.entries(value)) {
      if (name in properties) {
        check(properties[name], child, [...path, name], definitions, problems, depth + 1);
      } else if (schema['additionalProperties'] === false) {
        problems.push(`neznámé pole „${fieldName([...path, name])}“`);
      } else if (isObject(schema['additionalProperties'])) {
        check(schema['additionalProperties'], child, [...path, name], definitions, problems, depth + 1);
      }
    }
  }
};

/**
 * Czech list of problems, or `undefined` when the value matches the schema. `prefix` names the argument the value
 * came from (e.g. `input`).
 */
export const inputProblems = (schema: JsonObject, value: unknown, prefix = ''): string | undefined => {
  const problems: string[] = [];
  const definitions = isObject(schema['$defs']) ? schema['$defs'] : {};
  check(schema, value, prefix === '' ? [] : [prefix], definitions, problems, 0);
  const unique = [...new Set(problems)];
  return unique.length === 0 ? undefined : unique.slice(0, 6).join('; ');
};
