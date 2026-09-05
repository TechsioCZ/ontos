// Contract-owned declarations reached through aliased and namespace imports of `effect` modules.
import * as ApiSchema from 'effect/unstable/httpapi/HttpApiSchema';
import { Schema as Codec } from 'effect';

export const AProblem = Codec.TaggedStruct('AProblem', { detail: Codec.String }).pipe(
  ApiSchema.annotations({
    status: 503,
    title: 'A unavailable',
    type: 'https://ontos.dev/problems/a-unavailable',
  }),
);

export const BProblem = Codec.TaggedStruct('BProblem', { detail: Codec.String }).pipe(
  Codec.annotations({
    status: 404,
    title: 'B not found',
    type: 'https://ontos.dev/problems/b-not-found',
  }),
);
