// expect-count: 2
import { Layer } from 'effect';
import * as LayerNs from 'effect/Layer';

declare const Base: Layer.Layer<never>;

// Destructuring the effect namespace hides the member access from a MemberExpression-only matcher.
const { fresh } = Layer;
export const viaDestructure = fresh(Base);

const { fresh: freshAlias } = LayerNs;
export const viaAliasedDestructure = freshAlias(Base);
