import { Schema } from 'effect';

const AUTHORIZATION_MUTATION_SAGA_ERROR_CODES = [
  'authorization_mutation_intent_invalid',
  'authorization_mutation_relationship_indeterminate',
  'authorization_mutation_finalization_indeterminate',
  'authorization_mutation_final_state_invalid',
] as const;

const AuthorizationMutationSagaErrorCodeSchema = Schema.Literals(AUTHORIZATION_MUTATION_SAGA_ERROR_CODES);
export type AuthorizationMutationSagaErrorCode = typeof AuthorizationMutationSagaErrorCodeSchema.Type;

export class AuthorizationMutationSagaError extends Schema.TaggedError<AuthorizationMutationSagaError>()(
  'AuthorizationMutationSagaError',
  {
    code: AuthorizationMutationSagaErrorCodeSchema,
    externalMutationMayHaveSucceeded: Schema.Boolean,
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}
