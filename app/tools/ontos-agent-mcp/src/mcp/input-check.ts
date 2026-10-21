/**
 * Czech input validation for tool arguments and Action/read inputs (lane mcp-mcp-rs). The SDK's own validation is
 * switched off (server-factory.ts) because it answers in English; tools.ts validates here before any call to OntOS,
 * so a proposal with a broken input never reaches a human reviewer.
 */
import { Ajv } from '@modelcontextprotocol/server/validators/ajv';
import type { JsonSchema } from '../capabilities/types.ts';

interface AjvIssue {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly params: Readonly<Record<string, unknown>>;
}
type Check = ((data: unknown) => boolean) & { errors?: readonly AjvIssue[] | null };

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, validateSchema: false });
const compiled = new WeakMap<object, Check | null>();

const compile = (schema: JsonSchema): Check | null => {
  const cached = compiled.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  let check: Check | null = null;
  try {
    const { $schema: _dialect, $id: _id, ...rest } = schema;
    check = ajv.compile(rest) as unknown as Check;
  } catch {
    // A schema Ajv cannot compile is not checked here; OntOS still validates the request.
    check = null;
  }
  compiled.set(schema, check);
  return check;
};

const TYPE_CS: Readonly<Record<string, string>> = {
  array: 'seznam',
  boolean: 'true/false',
  integer: 'celé číslo',
  null: 'null',
  number: 'číslo',
  object: 'objekt',
  string: 'text',
};

const fieldOf = (instancePath: string, prefix: string): string => {
  const path = instancePath
    .split('/')
    .filter((part) => part !== '')
    .map((part) => part.replace(/~1/gu, '/').replace(/~0/gu, '~'))
    .join('.');
  return [prefix, path].filter((part) => part !== '').join('.') || '(vstup)';
};

const describeIssue = (issue: AjvIssue, prefix: string): string => {
  const field = fieldOf(issue.instancePath, prefix);
  const params = issue.params;
  switch (issue.keyword) {
    case 'required':
      return `chybí povinné pole „${fieldOf(`${issue.instancePath}/${String(params['missingProperty'])}`, prefix)}“`;
    case 'additionalProperties':
      return `neznámé pole „${fieldOf(`${issue.instancePath}/${String(params['additionalProperty'])}`, prefix)}“`;
    case 'type': {
      const types = String(params['type'])
        .split(',')
        .map((type) => TYPE_CS[type] ?? type)
        .join(' nebo ');
      return `„${field}“ musí být ${types}`;
    }
    case 'enum':
      return `„${field}“ musí být jedna z hodnot ${JSON.stringify(params['allowedValues'])}`;
    case 'const':
      return `„${field}“ musí být ${JSON.stringify(params['allowedValue'])}`;
    case 'minLength':
      return `„${field}“ je příliš krátké (nejméně ${String(params['limit'])} znaků)`;
    case 'maxLength':
      return `„${field}“ je příliš dlouhé (nejvíce ${String(params['limit'])} znaků)`;
    case 'minimum':
    case 'exclusiveMinimum':
      return `„${field}“ je příliš malé (${String(params['comparison'])} ${String(params['limit'])})`;
    case 'maximum':
    case 'exclusiveMaximum':
      return `„${field}“ je příliš velké (${String(params['comparison'])} ${String(params['limit'])})`;
    case 'minItems':
      return `„${field}“ musí mít aspoň ${String(params['limit'])} položek`;
    case 'maxItems':
      return `„${field}“ smí mít nejvýše ${String(params['limit'])} položek`;
    case 'pattern':
      return `„${field}“ nemá správný tvar`;
    case 'anyOf':
    case 'oneOf':
      return `„${field}“ neodpovídá žádné povolené variantě`;
    default:
      return `„${field}“ má neplatnou hodnotu (${issue.keyword})`;
  }
};

/**
 * Czech list of problems, or `undefined` when the value matches the schema (or the schema cannot be checked).
 * `prefix` names the argument the value came from (e.g. `input`).
 */
export const inputProblems = (schema: JsonSchema, value: unknown, prefix = ''): string | undefined => {
  const check = compile(schema);
  if (check === null || check(value)) {
    return undefined;
  }
  const issues = (check.errors ?? []).filter(
    // Errors inside anyOf/oneOf branches repeat the variant mismatch; the anyOf error itself is enough.
    (issue) => !/\/(anyOf|oneOf)\/\d+\//u.test(issue.schemaPath),
  );
  const messages = [...new Set(issues.map((issue) => describeIssue(issue, prefix)))];
  return messages.length === 0 ? 'vstup neodpovídá schématu' : messages.slice(0, 6).join('; ');
};
