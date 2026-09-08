import { Schema } from 'effect';

/** The Effect-native replacement: the tag lives in the Schema, the type is derived. */
export class GatewayUnavailableProblem extends Schema.TaggedError<GatewayUnavailableProblem>()(
  'GatewayUnavailableProblem',
  { status: Schema.Literal(503) },
) {}

export const LookupFound = Schema.TaggedStruct('found', { value: Schema.String });
export const LookupMissing = Schema.TaggedStruct('not_found', {});
export const LookupResultSchema = Schema.Union([LookupFound, LookupMissing]);
export type LookupResult = Schema.Schema.Type<typeof LookupResultSchema>;

/** An ordinary interface with no discriminant is untouched. */
export interface ProblemDetails {
  readonly detail: string;
  readonly status: number;
  readonly title: string;
  readonly type: string;
}
