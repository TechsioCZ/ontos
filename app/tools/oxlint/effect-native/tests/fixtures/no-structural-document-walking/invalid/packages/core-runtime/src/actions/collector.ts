// expect-count: 5
import * as P from 'effect/Predicate';
import { Predicate as Guard } from 'effect';

export const hasEvidenceKeys = (evidence: Record<string, unknown>): boolean =>
  Object.hasOwn(evidence, 'actionKey') || Object.hasOwn(evidence, 'resultHash');

export const isBag = (input: unknown): boolean =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

export const isNamed = (record: Record<string, unknown>): boolean => P.isString(record['name']);

export const isCounted = (raw: { readonly total: unknown }): boolean => Guard.isNumber(raw.total);
