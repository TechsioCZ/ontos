import { Context, Schema } from 'effect';

export type ContextDto = Context.Context<never>;
export interface CallableDto {
  readonly id: string;
  send(): void;
}
const OpaqueSchema = Schema.declare<{ readonly read: () => string }>(() => true);
export type OpaqueDto = typeof OpaqueSchema.Type;
const UnknownSchema = Schema.Struct({ id: Schema.String, dependency: Schema.Unknown });
export type UnknownDto = typeof UnknownSchema.Type;
