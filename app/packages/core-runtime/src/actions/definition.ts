import { Effect, Schema } from 'effect';
import type { ActionHandlerContext } from './context.ts';
import { ActionPayloadValidationError, ActionResultValidationError } from './errors.ts';
import type { ActionCollectorError } from './errors.ts';
import type { ActionAccessEvidencePolicy, DomainEventContractMap } from './events.ts';

export type ActionIdempotencyRule = 'optional' | 'required';
export type ActionAuditProfile = 'minimal' | 'sensitive' | 'standard';

export interface ActionDescriptor<
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
  DomainEvents extends DomainEventContractMap,
> {
  readonly accessEvidencePolicy: ActionAccessEvidencePolicy;
  readonly actionKey: string;
  readonly auditProfile: ActionAuditProfile;
  readonly domainErrorSchema: DomainErrorSchema;
  readonly domainEvents: DomainEvents;
  readonly idempotency: ActionIdempotencyRule;
  readonly owningModuleKey: string;
  readonly payloadSchema: PayloadSchema;
  readonly resultSchema: ResultSchema;
  readonly schemaVersion: string;
}

export type ActionHandler<
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
  DomainEvents extends DomainEventContractMap,
> = (
  payload: PayloadSchema['Type'],
  context: ActionHandlerContext<DomainEvents>,
) => Effect.Effect<ResultSchema['Type'], ActionCollectorError | DomainErrorSchema['Type']>;

export interface ActionRegistration<
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
  DomainEvents extends DomainEventContractMap,
> {
  readonly descriptor: Readonly<
    ActionDescriptor<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents>
  >;
  readonly handler: ActionHandler<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents>;
}

export const defineAction = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
  DomainEvents extends DomainEventContractMap,
>(
  descriptor: ActionDescriptor<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents>,
  handler: ActionHandler<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents>,
): ActionRegistration<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents> =>
  Object.freeze({
    descriptor: Object.freeze({
      ...descriptor,
      accessEvidencePolicy: Object.freeze({ ...descriptor.accessEvidencePolicy }),
      domainEvents: Object.freeze({ ...descriptor.domainEvents }),
    }),
    handler,
  });

export const decodeActionPayload = <PayloadSchema extends Schema.ConstraintDecoder<unknown, never>>(
  schema: PayloadSchema,
  payload: unknown,
): Effect.Effect<PayloadSchema['Type'], ActionPayloadValidationError> => {
  if (Object.is(schema, Schema.Void) && payload !== undefined) {
    return Effect.fail(
      new ActionPayloadValidationError({
        code: 'action_payload_invalid',
        reason: 'This Action does not accept a business payload',
      }),
    );
  }

  return Schema.decodeUnknownEffect(schema)(payload).pipe(
    Effect.mapError(
      () =>
        new ActionPayloadValidationError({
          code: 'action_payload_invalid',
          reason: 'The Action payload does not match its declared schema',
        }),
    ),
  );
};

export const decodeActionResult = <ResultSchema extends Schema.ConstraintDecoder<unknown, never>>(
  schema: ResultSchema,
  result: unknown,
): Effect.Effect<ResultSchema['Type'], ActionResultValidationError> =>
  Schema.decodeUnknownEffect(schema)(result).pipe(
    Effect.mapError(
      () =>
        new ActionResultValidationError({
          code: 'action_result_invalid',
          reason: 'The Action result does not match its declared schema',
        }),
    ),
  );
