import { Effect, Schema, Predicate } from 'effect';
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
import type { ResourceAccessTarget, TenantPermissionKey } from '../permissions/context-access.ts';

const actionRegistration: unique symbol = Symbol('@app/core-runtime/actions/registration');
const actionHandler: unique symbol = Symbol('@app/core-runtime/actions/registration/handler');
const actionServiceFactory: unique symbol = Symbol(
  '@app/core-runtime/actions/registration/service-factory',
);
const actionResourcePermissionDeclaration: unique symbol = Symbol(
  '@app/core-runtime/actions/resource-permission',
);
const actionResourcePermissionResolver: unique symbol = Symbol(
  '@app/core-runtime/actions/resource-permission/resolver',
);

export type ActionIdempotencyRule = 'optional' | 'required';
export type ActionAuditProfile = 'minimal' | 'sensitive' | 'standard';
export type ActionTenantPermission = Exclude<TenantPermissionKey, 'access' | 'read_party_identity'>;
export type ActionLegalEntityPermission = 'manage_counterparty';
export type ActionResourcePermission = 'read' | 'write';
export interface ActionResourcePermissionTarget {
  readonly permission: ActionResourcePermission;
  readonly resource: ResourceAccessTarget;
}
export type ActionResourcePermissionTargetResolver<Payload> = (
  payload: Payload,
  scope: OperationalScope,
) => ActionResourcePermissionTarget;
export interface ActionResourcePermissionDeclaration<Payload> {
  readonly [actionResourcePermissionDeclaration]: true;
  readonly [actionResourcePermissionResolver]: ActionResourcePermissionTargetResolver<Payload>;
  readonly kind: 'resource';
}

/** Declares a private resolver for an additional Resource permission check. */
export const defineActionResourcePermission = <Payload>(
  resolver: ActionResourcePermissionTargetResolver<Payload>,
): ActionResourcePermissionDeclaration<Payload> => {
  if (!Predicate.isFunction(resolver)) {
    throw new TypeError('Action Resource permission resolver must be a function');
  }
  return Object.freeze({
    [actionResourcePermissionDeclaration]: true as const,
    [actionResourcePermissionResolver]: resolver,
    kind: 'resource' as const,
  });
};

const isActionResourcePermissionDeclaration = (
  declaration: ActionResourcePermissionDeclaration<never> | undefined,
): declaration is ActionResourcePermissionDeclaration<never> => {
  if (!Predicate.isObjectKeyword(declaration) || declaration === null) {
    return false;
  }
  return (
    declaration[actionResourcePermissionDeclaration] === true &&
    Predicate.isFunction(declaration[actionResourcePermissionResolver]) &&
    declaration.kind === 'resource' &&
    Object.isFrozen(declaration)
  );
};

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
  /** Requires a permission on the Legal Entity selected by trusted operational scope. */
  readonly legalEntityPermission?: ActionLegalEntityPermission;
  readonly owningModuleKey: Owner;
  readonly payloadSchema: PayloadSchema;
  readonly policies: readonly ActionPolicy<PayloadSchema['Type'], NoInfer<Owner>>[];
  readonly resultSchema: ResultSchema;
  /** Declares an additional Resource permission resolved from decoded input and trusted scope. */
  readonly resourcePermission?: ActionResourcePermissionDeclaration<PayloadSchema['Type']>;
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

type EmptyActionServices = Readonly<Record<string, never>>;
const emptyActionServices: EmptyActionServices = Object.freeze({});
const emptyActionServiceFactory: ActionServiceFactory<EmptyActionServices> = () =>
  Effect.succeed(emptyActionServices);

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
  readonly [actionHandler]: ActionHandler<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Services,
    HandlerRequirements
  >;
  readonly [actionServiceFactory]: ActionServiceFactory<Services, HandlerRequirements>;
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

export interface ActionDescriptorValidationInput<Policy> {
  readonly entrypoint: ModuleEntrypointDescriptor;
  readonly legalEntityPermission?: unknown;
  readonly legalEntityScope: string;
  readonly owningModuleKey: string;
  readonly policies?: readonly Policy[];
  readonly resourcePermission?: ActionResourcePermissionDeclaration<never>;
  readonly tenantPermission?: unknown;
}

export const validateActionDescriptorInput = <Policy>(
  descriptor: ActionDescriptorValidationInput<Policy>,
): void => {
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
  if (!LEGAL_ENTITY_SCOPES.some((scope) => scope === descriptor.legalEntityScope)) {
    throw new TypeError('Action legal-entity scope must be required, optional, or forbidden');
  }
  if (
    descriptor.legalEntityPermission !== undefined &&
    (descriptor.legalEntityPermission !== 'manage_counterparty' ||
      descriptor.legalEntityScope !== 'required')
  ) {
    throw new TypeError(
      'Action Legal Entity permission must be supported and require trusted Legal Entity scope',
    );
  }
  if (!Array.isArray(descriptor.policies)) {
    throw new TypeError('Action policies must be an explicit readonly array of Policy references');
  }
  if (
    (descriptor.resourcePermission !== undefined &&
      !isActionResourcePermissionDeclaration(descriptor.resourcePermission)) ||
    (descriptor.tenantPermission !== undefined &&
      !Predicate.isFunction(descriptor.tenantPermission))
  ) {
    throw new TypeError('Action permission declarations and resolvers must be valid');
  }
  for (const policy of descriptor.policies) {
    if (!isActionPolicy(policy)) {
      throw new TypeError('Action policies must contain direct Policy object references');
    }
    if (policy.scope === 'microvertical' && policy.owningModuleKey !== descriptor.owningModuleKey) {
      throw new TypeError('A MicroVertical Policy must be owned by the Action owning module');
    }
  }
};

export function defineAction<
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
  DomainEvents extends DomainEventContractMap,
  const Owner extends string,
  HandlerRequirements,
>(
  descriptor: ActionDescriptor<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Owner>,
  handler: ActionHandler<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    EmptyActionServices,
    HandlerRequirements
  >,
): ActionRegistration<
  PayloadSchema,
  ResultSchema,
  DomainErrorSchema,
  DomainEvents,
  Owner,
  EmptyActionServices,
  HandlerRequirements
>;
export function defineAction<
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
  serviceFactory: ActionServiceFactory<Services, HandlerRequirements>,
): ActionRegistration<
  PayloadSchema,
  ResultSchema,
  DomainErrorSchema,
  DomainEvents,
  Owner,
  Services,
  HandlerRequirements
>;
export function defineAction<
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }, never>,
  DomainEvents extends DomainEventContractMap,
  const Owner extends string,
  Services,
  HandlerRequirements,
>(
  descriptor: ActionDescriptor<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Owner>,
  ...definition:
    | readonly [
        handler: ActionHandler<
          PayloadSchema,
          ResultSchema,
          DomainErrorSchema,
          DomainEvents,
          EmptyActionServices,
          HandlerRequirements
        >,
      ]
    | readonly [
        handler: ActionHandler<
          PayloadSchema,
          ResultSchema,
          DomainErrorSchema,
          DomainEvents,
          Services,
          HandlerRequirements
        >,
        serviceFactory: ActionServiceFactory<Services, HandlerRequirements>,
      ]
) {
  validateActionDescriptorInput(descriptor);

  const frozenDescriptor = Object.freeze({
    ...descriptor,
    accessEvidencePolicy: Object.freeze({ ...descriptor.accessEvidencePolicy }),
    domainEvents: Object.freeze({ ...descriptor.domainEvents }),
    entrypoint: descriptor.entrypoint,
    policies: Object.freeze([...descriptor.policies]),
  });
  if (definition.length === 1) {
    const [handler] = definition;
    return Object.freeze({
      [actionHandler]: handler,
      [actionRegistration]: true as const,
      [actionServiceFactory]: emptyActionServiceFactory,
      descriptor: frozenDescriptor,
    });
  }
  const [handler, serviceFactory] = definition;
  return Object.freeze({
    [actionHandler]: handler,
    [actionRegistration]: true as const,
    [actionServiceFactory]: serviceFactory,
    descriptor: frozenDescriptor,
  });
}

/** Runtime guard for the opaque value created by defineAction. */
export const isActionRegistration = <Value>(value: Value): value is Value & AnyActionRegistration =>
  Predicate.isObjectKeyword(value) &&
  value !== null &&
  actionHandler in value &&
  actionServiceFactory in value &&
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
> => registration[actionHandler];

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
): ActionServiceFactory<Services, HandlerRequirements> => registration[actionServiceFactory];

export const getActionResourcePermissionTargetResolver = <
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
): ActionResourcePermissionTargetResolver<PayloadSchema['Type']> | undefined =>
  registration.descriptor.resourcePermission?.[actionResourcePermissionResolver];

export const decodeActionPayload = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never>,
  Payload,
>(
  schema: PayloadSchema,
  payload: Payload,
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

export const decodeActionResult = <
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  Result,
>(
  schema: ResultSchema,
  result: Result,
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
