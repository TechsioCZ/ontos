import { createHash } from 'node:crypto';
import type { JsonSchema } from '../capabilities/types.ts';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Resolves a local $ref ('#/$defs/Name' or '#/definitions/Name') against defs; anything else is returned unchanged. */
export const resolveRef = (node: unknown, defs: Record<string, unknown>): unknown => {
  if (!isRecord(node) || typeof node['$ref'] !== 'string') {
    return node;
  }
  const name = node['$ref'].replace(/^#\/(\$defs|definitions)\//u, '');
  return defs[name] ?? node;
};

export interface TaggedVariant {
  readonly tag: string;
  readonly schema: Record<string, unknown>;
}

/** The single `_tag` literal of an object schema, or undefined when the object is not a tagged variant. */
const variantTag = (node: Record<string, unknown>): string | undefined => {
  const properties = node['properties'];
  if (!isRecord(properties) || !isRecord(properties['_tag'])) {
    return undefined;
  }
  const values = properties['_tag']['enum'];
  return Array.isArray(values) && values.length === 1 && typeof values[0] === 'string' ? values[0] : undefined;
};

/** Every object whose properties._tag.enum has exactly one string, found depth-first through anyOf/oneOf (and $ref). Source order. */
export const taggedVariants = (node: unknown, defs: Record<string, unknown>): TaggedVariant[] => {
  const resolved = resolveRef(node, defs);
  if (!isRecord(resolved)) {
    return [];
  }
  const tag = variantTag(resolved);
  if (tag !== undefined) {
    return [{ tag, schema: resolved }];
  }
  return [resolved['anyOf'], resolved['oneOf']].flatMap((branches) =>
    Array.isArray(branches) ? branches.flatMap((branch) => taggedVariants(branch, defs)) : [],
  );
};

/** The variant's fields without `_tag` plus optional integer expectedRevision. */
export const commandInputSchema = (variant: Record<string, unknown>, defs: Record<string, unknown>): JsonSchema => {
  const sourceProperties = isRecord(variant['properties']) ? variant['properties'] : {};
  const { _tag: _omittedTag, ...properties } = sourceProperties;
  const required = Array.isArray(variant['required'])
    ? variant['required'].filter((name): name is string => typeof name === 'string' && name !== '_tag')
    : [];
  return {
    type: 'object',
    properties: {
      ...properties,
      expectedRevision: {
        type: 'integer',
        minimum: 0,
        description: 'Revize modulu pro kontrolu souběžných změn. Když chybí, MCP ji načte sám.',
      },
    },
    required,
    additionalProperties: variant['additionalProperties'] ?? true,
    ...(Object.keys(defs).length > 0 ? { $defs: defs } : {}),
  };
};

/** Tags of the operation union inside the `AiProposeChanges` variant; empty set when the module has none. */
export const proposableTags = (variants: readonly TaggedVariant[], defs: Record<string, unknown>): ReadonlySet<string> => {
  const proposal = variants.find((variant) => variant.tag === 'AiProposeChanges');
  if (proposal === undefined) {
    return new Set();
  }
  const properties = proposal.schema['properties'];
  const changes = isRecord(properties) ? resolveRef(properties['changes'], defs) : undefined;
  const items = isRecord(changes) ? resolveRef(changes['items'], defs) : undefined;
  const operationProperties = isRecord(items) && isRecord(items['properties']) ? items['properties'] : undefined;
  if (operationProperties === undefined) {
    return new Set();
  }
  return new Set(taggedVariants(operationProperties['operation'], defs).map((variant) => variant.tag));
};

export const snakeCase = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[-.\s]+/gu, '_')
    .toLowerCase();

/** MCP tool name `<app_id>__<suffix>`; names longer than 64 chars become first 55 chars + '_' + first 8 hex of sha256(full name). */
export const toolNameOf = (appId: string, suffix: string): string => {
  const full = `${snakeCase(appId)}__${snakeCase(suffix)}`;
  return full.length <= 64 ? full : `${full.slice(0, 55)}_${createHash('sha256').update(full).digest('hex').slice(0, 8)}`;
};
