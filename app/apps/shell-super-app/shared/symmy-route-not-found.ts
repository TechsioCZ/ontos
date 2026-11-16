import { Schema } from 'effect';

const SymmyRouteNotFoundWireSchema = Schema.TaggedStruct('SymmyRouteNotFoundProblem', {
  detail: Schema.String,
  status: Schema.Literal(404),
  title: Schema.String,
  type: Schema.String,
});

/** Modern's unbundled native host serializes this value before the Effect API receives a request. */
export const symmyRouteNotFoundPayload = SymmyRouteNotFoundWireSchema.make({
  detail: 'The requested integration path is unavailable.',
  status: SymmyRouteNotFoundWireSchema.fields.status.literal,
  title: 'Integration route not found',
  type: 'https://ontos.dev/problems/symmy-route-not-found',
});
