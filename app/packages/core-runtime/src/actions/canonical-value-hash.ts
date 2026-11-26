/**
 * Canonical hashing of Action requests and data values. Pure, so browser contracts can share it without the
 * Action repository's database code.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { DateTime, Predicate, Result, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import type { ActionTransportMetadata, TrustedPrincipalContext } from './context.ts';

export interface ActionRequestHashInput {
  readonly actionKey: string;
  readonly normalizedPayload: unknown;
  readonly owningModuleKey: string;
  readonly principal: Pick<TrustedPrincipalContext, 'legalEntityId' | 'principalId' | 'tenantId'>;
  readonly schemaVersion: string;
  readonly target: Pick<ActionTransportMetadata, 'targetModuleKey' | 'targetResourceId' | 'targetResourceType'>;
}

type CanonicalValue =
  | readonly ['array', readonly CanonicalValue[]]
  | readonly ['bigint', string]
  | readonly ['boolean', boolean]
  | readonly ['date', string]
  | readonly ['dateTimeUtc', string]
  | readonly ['null']
  | readonly ['number', string]
  | readonly ['object', readonly (readonly [string, CanonicalValue])[]]
  | readonly ['string', string]
  | readonly ['undefined'];

const CanonicalValueError = Schema.TaggedError<unknown>()('CanonicalValueError', {
  reason: Schema.String,
});

const canonicalValueCodec = Schema.fromJsonString(Schema.Any);

const encodeCanonicalValue = (value: CanonicalValue): string =>
  Result.getOrThrow(Schema.encodeResult(canonicalValueCodec)(value));

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const normalizeObjectForHash = <Value extends object>(
  value: Value,
  seen: WeakSet<object>,
  normalize: <Item>(value: Item, seen: WeakSet<object>) => CanonicalValue,
): CanonicalValue => {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new CanonicalValueError({
        reason: 'Action payloads must not contain cyclic values',
      });
    }
    seen.add(value);
    const normalized = value.map((item) => normalize(item, seen));
    seen.delete(value);
    return ['array', normalized];
  }
  if (seen.has(value)) {
    throw new CanonicalValueError({
      reason: 'Action payloads must not contain cyclic values',
    });
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalValueError({
      reason: 'Action payloads must contain only canonical data values',
    });
  }
  seen.add(value);
  const entries = Object.entries(value)
    .toSorted(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, item]) => [key, normalize(item, seen)] as const);
  seen.delete(value);
  return ['object', entries];
};

const normalizeNumberForHash = (value: number): CanonicalValue => [
  'number',
  Object.is(value, -0) ? '-0' : String(value),
];

const normalizeForHash = <Value>(value: Value, seen: WeakSet<object>): CanonicalValue => {
  if (value === undefined) {
    return ['undefined'];
  }
  if (value === null) {
    return ['null'];
  }
  if (Predicate.isBoolean(value)) {
    return ['boolean', value];
  }
  if (Predicate.isString(value)) {
    return ['string', value];
  }
  if (Predicate.isNumber(value)) {
    return normalizeNumberForHash(value);
  }
  if (Predicate.isBigInt(value)) {
    return ['bigint', value.toString(10)];
  }
  if (DateTime.isDateTime(value) && DateTime.isUtc(value)) {
    return ['dateTimeUtc', DateTime.formatIso(value)];
  }
  if (Predicate.isDate(value)) {
    return ['date', value.toISOString()];
  }
  if (Predicate.isObjectKeyword(value)) {
    return normalizeObjectForHash(value, seen, normalizeForHash);
  }
  const unsupportedKind = Predicate.isFunction(value) ? 'function' : 'symbol';
  throw new CanonicalValueError({
    reason: `Action payloads cannot contain ${unsupportedKind} values`,
  });
};

export const computeActionRequestHash = (input: ActionRequestHashInput): string => {
  const canonicalEnvelope = normalizeForHash(
    {
      actionKey: input.actionKey,
      normalizedPayload: input.normalizedPayload,
      owningModuleKey: input.owningModuleKey,
      principal: {
        legalEntityId: input.principal.legalEntityId,
        principalId: input.principal.principalId,
        tenantId: input.principal.tenantId,
      },
      schemaVersion: input.schemaVersion,
      target: input.target,
    },
    new WeakSet(),
  );

  return Hex.encode(sha256(utf8ToBytes(encodeCanonicalValue(canonicalEnvelope))));
};

export const computeCanonicalValueHash = <Value>(value?: Value): string =>
  Hex.encode(sha256(utf8ToBytes(encodeCanonicalValue(normalizeForHash(value, new WeakSet())))));
