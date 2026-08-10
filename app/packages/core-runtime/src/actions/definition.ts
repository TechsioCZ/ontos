import { Effect, Schema } from 'effect';
import type { ActionHandlerContext } from './context.ts';
import { ActionPayloadValidationError, ActionResultValidationError } from './errors.ts';
import type { ActionCollectorError } from './errors.ts';
import type { ActionAccessEvidencePolicy, DomainEventContractMap } from './events.ts';
import { isActionPolicy } from './policy.ts';
import type { ActionPolicy } from './policy.ts';
import type { ModuleEntrypointDescriptor } from '../modules/module-entrypoint.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { LEGAL_ENTITY_SCOPES } from '../operations/context.ts';
import type { OperationalScope, LegalEntityScope } from '../operations/context.ts';
import type { OperationContextUnavailable } from '../operations/errors.ts';

const actionRegistration: unique symbol = Symbol('@app/core-runtime/actions/registration');
const actionHandlers = new WeakMap<object, unknown>();
const actionServiceFactories = new WeakMap<object, unknown>();

export type ActionIdempotencyRule = 'optional' | 'required';
export type ActionAuditProfile = 'minimal' | 'sensitive' | 'standard';
export type ActionTenantPermission = 'impersonate' | 'manage_identity';

export interface ActionDescriptor<
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
> {
  readonly accessEvidencePolicy: ActionAccessEvidencePolicy;
  /**
   * Stable, globally unique authorization identity for this Action. Core maps
   * it losslessly to SpiceDB's object-id alphabet. Once relationships reference
   * that identity, the key is immutable; display names, routes, payloads, and
   * target resources must never replace or derive it.
   */
  readonly actionKey: string;
  readonly auditEvidenceSchema?: Schema.ConstraintDecoder<unknown, never>;
  readonly auditProfile: ActionAuditProfile;
  readonly domainErrorSchema: DomainErrorSchema;
  readonly domainEvents: DomainEvents;
  readonly entrypoint: ModuleEntrypointDescriptor<'action', 'write', Owner>;
  readonly idempotency: ActionIdempotencyRule;
  readonly legalEntityScope: LegalEntityScope;
  readonly owningModuleKey: Owner;
  readonly payloadSchema: PayloadSchema;
  readonly policies: readonly ActionPolicy<PayloadSchema['Type'], NoInfer<Owner>>[];
  readonly resultSchema: ResultSchema;
  readonly schemaVersion: string;
  /**
   * Declares an additional tenant-role permission required for the decoded payload.
   * Returning undefined means the Action executor relation is sufficient for that payload.
   */
  readonly tenantPermission?: (
    payload: PayloadSchema['Type'],
  ) => ActionTenantPermission | undefined;
}

export type ActionHandler<
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
  DomainEvents extends DomainEventContractMap,
  Services,
  Requirements = never,
> = (
  payload: PayloadSchema['Type'],
  context: ActionHandlerContext<DomainEvents, Services>,
) => Effect.Effect<
  ResultSchema['Type'],
  ActionCollectorError | DomainErrorSchema['Type'],
  Requirements
>;

export type ActionServiceFactory<Services, Requirements = never> = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
) => Effect.Effect<Services, OperationContextUnavailable, Requirements>;

export interface ActionRegistration<
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
  Services = Readonly<Record<string, never>>,
  HandlerRequirements = never,
> {
  readonly [actionRegistration]: true;
  readonly descriptor: Readonly<
    ActionDescriptor<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Owner>
  >;
  readonly _handlerRequirements?: HandlerRequirements;
  readonly _services?: Services;
}

/**
 * Existential public view of an Action registration. Keeping only the deployment-contract
 * fields avoids pretending TypeScript can express "ActionRegistration for some payload".
 */
export interface AnyActionRegistration {
  readonly [actionRegistration]: true;
  readonly descriptor: Readonly<
    Pick<
      ActionDescriptor<
        Schema.ConstraintDecoder<unknown, never>,
        Schema.ConstraintDecoder<unknown, never>,
        Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
        DomainEventContractMap,
        string
      >,
      | 'actionKey'
      | 'auditProfile'
      | 'idempotency'
      | 'legalEntityScope'
      | 'owningModuleKey'
      | 'schemaVersion'
    >
  >;
}

export type ActionRequirements<Registration> =
  Registration extends ActionRegistration<
    Schema.ConstraintDecoder<unknown, never>,
    Schema.ConstraintDecoder<unknown, never>,
    Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
    DomainEventContractMap,
    string,
    unknown,
    infer Requirements
  >
    ? Requirements
    : never;

export const defineAction = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
  DomainEvents extends DomainEventContractMap,
  const Owner extends string,
  Services,
  HandlerRequirements,
>(
  descriptor: ActionDescriptor<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Owner>,
  handler: ActionHandler<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Services,
    HandlerRequirements
  >,
  serviceFactory?: ActionServiceFactory<Services, HandlerRequirements>,
): ActionRegistration<
  PayloadSchema,
  ResultSchema,
  DomainErrorSchema,
  DomainEvents,
  Owner,
  Services,
  HandlerRequirements
> => {
  if (
    descriptor.entrypoint.role !== 'action' ||
    descriptor.entrypoint.access !== 'write' ||
    descriptor.entrypoint.moduleKey !== descriptor.owningModuleKey ||
    descriptor.entrypoint.scope !==
      (descriptor.owningModuleKey.startsWith('core.') ? 'system' : 'tenant') ||
    !Object.isFrozen(descriptor.entrypoint)
  ) {
    throw new TypeError(
      'Action entrypoint must be an immutable action/write descriptor with the required owner scope',
    );
  }
  if (!LEGAL_ENTITY_SCOPES.includes(descriptor.legalEntityScope)) {
    throw new TypeError('Action legal-entity scope must be required, optional, or forbidden');
  }
  if (!Array.isArray(descriptor.policies)) {
    throw new TypeError('Action policies must be an explicit readonly array of Policy references');
  }
  for (const policy of descriptor.policies) {
    if (!isActionPolicy(policy)) {
      throw new TypeError('Action policies must contain direct Policy object references');
    }
    if (policy.scope === 'microvertical' && policy.owningModuleKey !== descriptor.owningModuleKey) {
      throw new TypeError('A MicroVertical Policy must be owned by the Action owning module');
    }
  }

  const registration: ActionRegistration<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Owner,
    Services,
    HandlerRequirements
  > = Object.freeze({
    [actionRegistration]: true as const,
    descriptor: Object.freeze({
      ...descriptor,
      accessEvidencePolicy: Object.freeze({ ...descriptor.accessEvidencePolicy }),
      domainEvents: Object.freeze({ ...descriptor.domainEvents }),
      entrypoint: descriptor.entrypoint,
      policies: Object.freeze([...descriptor.policies]),
    }),
  });
  actionHandlers.set(registration, handler);
  actionServiceFactories.set(
    registration,
    serviceFactory ?? (() => Effect.succeed(Object.freeze({}) as Services)),
  );
  return registration;
};

/** Runtime guard for the opaque value created by defineAction. */
export const isActionRegistration = (value: unknown): value is AnyActionRegistration =>
  typeof value === 'object' &&
  value !== null &&
  actionHandlers.has(value) &&
  actionRegistration in value &&
  value[actionRegistration] === true;

/** Internal Core runtime seam. Action handlers are intentionally absent from the public registration. */
export const getActionHandler = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
  Services,
  HandlerRequirements,
>(
  registration: ActionRegistration<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Owner,
    Services,
    HandlerRequirements
  >,
): ActionHandler<
  PayloadSchema,
  ResultSchema,
  DomainErrorSchema,
  DomainEvents,
  Services,
  HandlerRequirements
> => {
  const handler = actionHandlers.get(registration);
  if (typeof handler !== 'function') {
    throw new TypeError('Action registration was not created by defineAction');
  }
  return handler as ActionHandler<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Services,
    HandlerRequirements
  >;
};

export const getActionServiceFactory = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
  Services,
  HandlerRequirements,
>(
  registration: ActionRegistration<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Owner,
    Services,
    HandlerRequirements
  >,
): ActionServiceFactory<Services, HandlerRequirements> => {
  const factory = actionServiceFactories.get(registration);
  if (typeof factory !== 'function') {
    throw new TypeError('Action registration was not created by defineAction');
  }
  return factory as ActionServiceFactory<Services, HandlerRequirements>;
};

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
