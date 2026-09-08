import { Effect, Schema } from 'effect';

const Vertical = Schema.Struct({ id: Schema.String, kind: Schema.Literal('vertical') });
const Topology = Schema.Struct({ verticals: Schema.Array(Vertical) });

export const decodeTopology = (input: unknown) =>
  Schema.decodeUnknownEffect(Topology, { onExcessProperty: 'error' })(input);

export const installedIds = (input: unknown) =>
  Effect.map(decodeTopology(input), (topology) => topology.verticals.map((vertical) => vertical.id));

/** Plain locals: nothing says these came out of a decoded document. */
export const listOf = (items: readonly string[] | string): readonly string[] =>
  Array.isArray(items) ? items : [items];

/** A lone object guard is ordinary nullability narrowing, not document walking. */
export const isBag = (candidate: unknown): boolean =>
  typeof candidate === 'object' && candidate !== null;
