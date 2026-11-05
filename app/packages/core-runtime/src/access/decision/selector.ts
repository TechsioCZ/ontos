import { Match, Schema } from 'effect';

import type { RecordKey } from '../ids.ts';
import type { CellSelector, Holder, RecordSelector } from '../model.ts';

export const HolderSideSchema = Schema.Literals(['agent', 'principal']);
export type HolderSide = typeof HolderSideSchema.Type;
export const SlotTagSchema = Schema.Literals(['all', 'assigned', 'entrusted', 'team']);
export type SlotTag = typeof SlotTagSchema.Type;

/** The one place that reads a cell-selector tag, so every consumer branches on domain values. */
export const recordSelectorOf = (selector: CellSelector): RecordSelector | undefined =>
  Match.value(selector).pipe(
    Match.tags({
      all: (): RecordSelector => 'all',
      assigned: (): RecordSelector => 'assigned',
      entrusted: (): RecordSelector => 'entrusted',
      targets: (): undefined => undefined,
      team: (): RecordSelector => 'team',
    }),
    Match.exhaustive,
  );

/** Explicit target sets fill the scope-wide `all` slot and are narrowed by the caveat. */
export const slotTagOf = (selector: CellSelector): SlotTag =>
  Match.value(selector).pipe(
    Match.tags({
      all: (): SlotTag => 'all',
      assigned: (): SlotTag => 'assigned',
      entrusted: (): SlotTag => 'entrusted',
      targets: (): SlotTag => 'all',
      team: (): SlotTag => 'team',
    }),
    Match.exhaustive,
  );

export const targetKeysOf = (selector: CellSelector): readonly RecordKey[] =>
  Match.value(selector).pipe(
    Match.tags({
      all: (): readonly RecordKey[] => [],
      assigned: (): readonly RecordKey[] => [],
      entrusted: (): readonly RecordKey[] => [],
      targets: ({ recordKeys }): readonly RecordKey[] => recordKeys,
      team: (): readonly RecordKey[] => [],
    }),
    Match.exhaustive,
  );

export const isTargetSelection = (selector: CellSelector): boolean =>
  Match.value(selector).pipe(
    Match.tag('targets', () => true),
    Match.orElse(() => false),
  );

export const selectorTagOf = (selector: CellSelector): CellSelector['_tag'] =>
  Match.value(selector).pipe(
    Match.tags({
      all: (): CellSelector['_tag'] => 'all',
      assigned: (): CellSelector['_tag'] => 'assigned',
      entrusted: (): CellSelector['_tag'] => 'entrusted',
      targets: (): CellSelector['_tag'] => 'targets',
      team: (): CellSelector['_tag'] => 'team',
    }),
    Match.exhaustive,
  );

export const sideOfHolder = (holder: Holder): HolderSide =>
  Match.value(holder).pipe(
    Match.tags({ Agent: (): HolderSide => 'agent', Principal: (): HolderSide => 'principal' }),
    Match.exhaustive,
  );

export const holderSubjectOf = (holder: Holder) =>
  Match.value(holder).pipe(
    Match.tags({
      Agent: ({ agentId }) => ({ id: agentId, type: 'agent' as const }),
      Principal: ({ principalId }) => ({ id: principalId, type: 'principal' as const }),
    }),
    Match.exhaustive,
  );

export const holderIdOf = (holder: Holder): string =>
  Match.value(holder).pipe(
    Match.tags({
      Agent: ({ agentId }) => `agent:${agentId}`,
      Principal: ({ principalId }) => `principal:${principalId}`,
    }),
    Match.exhaustive,
  );

export const holderEquals = (left: Holder, right: Holder): boolean => holderIdOf(left) === holderIdOf(right);
