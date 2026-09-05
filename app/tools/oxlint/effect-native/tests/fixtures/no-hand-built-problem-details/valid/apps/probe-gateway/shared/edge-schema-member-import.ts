// The blessed declaration, reached through a destructured member import and through the framework
// re-export the repo already uses, aliased. Both are Schema-owned contracts, not hand-built payloads.
import { annotations } from 'effect/unstable/httpapi/HttpApiSchema';
import { String as SchemaString, TaggedError } from 'effect/Schema';
import { HttpApiSchema as EdgeApiSchema, Schema as EdgeSchema } from '@modern-js/plugin-bff/effect-edge';

export class CProblem extends TaggedError<CProblem>()(
  'CProblem',
  { detail: SchemaString },
  annotations({ status: 500, title: 'C failed', type: 'https://ontos.dev/problems/c-failed' }),
) {}

export const DProblem = EdgeSchema.TaggedStruct('DProblem', { detail: EdgeSchema.String }).pipe(
  EdgeApiSchema.annotations({
    status: 409,
    title: 'D conflict',
    type: 'https://ontos.dev/problems/d-conflict',
  }),
);
