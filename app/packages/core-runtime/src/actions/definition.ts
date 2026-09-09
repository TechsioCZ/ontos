import { Effect, Schema, Predicate } from 'effect';
import type { ActionHandlerContext, CommittedActionDomainRejection } from './context.ts';
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
import type {
  BusinessPermissionAccessTarget,
  ResourceAccessTarget,
  TenantPermissionKey,
} from '../permissions/context-access.ts';

const actionRegistration: unique symbol = Symbol('@app/core-runtime/actions/registration');
const actionResourcePermissionDeclaration: unique symbol = Symbol(
  '@app/core-runtime/actions/resource-permission',
);
const actionBusinessPermissionDeclaration: unique symbol = Symbol(
  '@app/core-runtime/actions/business-permission',
);

class ActionPrivateStorage<Value> {
  declare readonly [actionRegistration]?: true;
  declare readonly [actionResourcePermissionDeclaration]?: true;
  declare readonly [actionBusinessPermissionDeclaration]?: true;
  declare readonly descriptor?: unknown;
  declare readonly kind?: 'business_permission' | 'resource';
  readonly #value: Value;

  constructor(value: Value) {
    this.#value = value;
  }

  static create<Value, PublicFields extends object>(
    value: Value,
    publicFields: PublicFields,
  ): ActionPrivateStorage<Value> & Readonly<PublicFields> {
    const storage = Object.assign(new ActionPrivateStorage(value), publicFields);
    Object.freeze(storage);
    return storage;
  }

  static getValue<Value>(storage: ActionPrivateStorage<Value>): Value {
    return storage.#value;
  }
}

const ActionIdempotencyRuleSchema = Schema.Literals(['optional', 'required']);
export type ActionIdempotencyRule = typeof ActionIdempotencyRuleSchema.Type;
const ActionAuditProfileSchema = Schema.Literals(['minimal', 'sensitive', 'standard']);
export type ActionAuditProfile = typeof ActionAuditProfileSchema.Type;
export type ActionTenantPermission = Exclude<TenantPermissionKey, 'access' | 'read_party_identity'>;
export type ActionLegalEntityPermission = 'manage_counterparty';
const ActionResourcePermissionSchema = Schema.Literals(['read', 'write']);
export type ActionResourcePermission = typeof ActionResourcePermissionSchema.Type;
export interface ActionResourcePermissionTarget {
  readonly permission: ActionResourcePermission;
  readonly resource: ResourceAccessTarget;
}
export type ActionResourcePermissionTargetResolver<Payload> = (
  payload: Payload,
  scope: OperationalScope,
) => ActionResourcePermissionTarget;
export type ActionDeniedAuditEvidenceJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly ActionDeniedAuditEvidenceJsonValue[]
  | { readonly [key: string]: ActionDeniedAuditEvidenceJsonValue };
export type ActionDeniedAuditEvidenceValue = Readonly<
  Record<string, ActionDeniedAuditEvidenceJsonValue>
>;
export type ActionDeniedAuditEvidenceResolver<Payload> = (
  payload: Payload,
  scope: OperationalScope,
) => ActionDeniedAuditEvidenceValue;
export interface ActionDeniedAuditEvidenceDeclaration<Payload> {
  readonly resolve: ActionDeniedAuditEvidenceResolver<Payload>;
  readonly schema: Schema.ConstraintDecoder<unknown>;
}
export type ActionResourcePermissionDeclaration<Payload> = ActionPrivateStorage<
  ActionResourcePermissionTargetResolver<Payload>
> & {
  readonly [actionResourcePermissionDeclaration]: true;
  readonly kind: 'resource';
};

export interface ActionBusinessPermissionTarget extends BusinessPermissionAccessTarget {
  /** Required only for counterparty_storefront targets and obtained from trusted context. */
  readonly trustedStorefrontId?: string;
}
export type ActionBusinessPermissionTargetResolver<Payload> = (
  payload: Payload,
  scope: OperationalScope,
) => ActionBusinessPermissionTarget;
export type ActionBusinessPermissionDeclaration<Payload> = ActionPrivateStorage<
  ActionBusinessPermissionTargetResolver<Payload>
> & {
  readonly [actionBusinessPermissionDeclaration]: true;
  readonly kind: 'business_permission';
};

const ActionDefinitionInvariantError = Schema.TaggedError<Error>()(
  'ActionDefinitionInvariantError',
  { message: Schema.String },
);

const failActionDefinition = (message: string): never => {
  throw new ActionDefinitionInvariantError({ message });
};

/** Declares a private resolver for an additional Resource permission check. */
export const defineActionResourcePermission = <Payload>(
  resolver: ActionResourcePermissionTargetResolver<Payload>,
): ActionResourcePermissionDeclaration<Payload> => {
  if (!Predicate.isFunction(resolver)) {
    return failActionDefinition('Action Resource permission resolver must be a function');
  }
  return ActionPrivateStorage.create(resolver, {
    [actionResourcePermissionDeclaration]: true as const,
    kind: 'resource' as const,
  });
};

/** Declares one exact profile/counterparty permission resolved before policy or handler code. */
export const defineActionBusinessPermission = <Payload>(
  resolver: ActionBusinessPermissionTargetResolver<Payload>,
): ActionBusinessPermissionDeclaration<Payload> => {
  if (!Predicate.isFunction(resolver)) {
    return failActionDefinition('Action business permission resolver must be a function');
  }
  return ActionPrivateStorage.create(resolver, {
    [actionBusinessPermissionDeclaration]: true as const,
    kind: 'business_permission' as const,
  });
};

const ActionResourcePermissionDeclarationSchema = Schema.instanceOf(ActionPrivateStorage).check(
  Schema.makeFilter((declaration) =>
    declaration[actionResourcePermissionDeclaration] === true &&
    declaration.kind === 'resource' &&
    Object.isFrozen(declaration)
      ? undefined
      : 'Expected an immutable Action Resource permission declaration',
  ),
);
const ActionBusinessPermissionDeclarationSchema = Schema.instanceOf(ActionPrivateStorage).check(
  Schema.makeFilter((declaration) =>
    declaration[actionBusinessPermissionDeclaration] === true &&
    declaration.kind === 'business_permission' &&
    Object.isFrozen(declaration)
      ? undefined
      : 'Expected an immutable Action business permission declaration',
  ),
);

export interface ActionDescriptor<
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
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
  readonly auditEvidenceSchema?: Schema.ConstraintDecoder<unknown>;
  readonly auditProfile: ActionAuditProfile;
  /** Declares one exact business permission resolved from decoded input and trusted scope. */
  readonly businessPermission?: ActionBusinessPermissionDeclaration<PayloadSchema['Type']>;
  /** Resolves a schema-bounded, secret-safe evidence object before authorization/policy denial. */
  readonly deniedAuditEvidence?: ActionDeniedAuditEvidenceDeclaration<PayloadSchema['Type']>;
  readonly domainErrorSchema: DomainErrorSchema;
  readonly domainEvents: DomainEvents;
  readonly entrypoint: ModuleEntrypointDescriptor<'action', 'write', Owner>;
  readonly idempotency: ActionIdempotencyRule;
  /** Requires a permission on the Legal Entity selected by trusted operational scope. */
  readonly legalEntityPermission?: ActionLegalEntityPermission;
  readonly legalEntityScope: LegalEntityScope;
  readonly owningModuleKey: Owner;
  readonly payloadSchema: PayloadSchema;
  readonly policies: readonly ActionPolicy<PayloadSchema['Type'], NoInfer<Owner>>[];
  /** Declares an additional Resource permission resolved from decoded input and trusted scope. */
  readonly resourcePermission?: ActionResourcePermissionDeclaration<PayloadSchema['Type']>;
  readonly resultSchema: ResultSchema;
  readonly schemaVersion: string;
  /**
   * Declares an additional tenant-role permission required for the decoded payload.
   * Returning undefined means the Action executor relation is sufficient for that payload.
   */
  readonly tenantPermission?: (payload: PayloadSchema['Type']) => ActionTenantPermission | undefined;
}

export type ActionHandler<
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  Services,
  Requirements = never,
> = (
  payload: PayloadSchema['Type'],
  context: ActionHandlerContext<DomainEvents, Services>,
) => Effect.Effect<
  ResultSchema['Type'] | CommittedActionDomainRejection<DomainErrorSchema['Type']>,
  ActionCollectorError | DomainErrorSchema['Type'],
  Requirements
>;

export type ActionServiceFactory<Services, Requirements = never> = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
) => Effect.Effect<Services, OperationContextUnavailable, Requirements>;

type EmptyActionServices = Readonly<Record<string, never>>;
const emptyActionServices: EmptyActionServices = Object.freeze({});
const emptyActionServiceFactory: ActionServiceFactory<EmptyActionServices> = () => Effect.succeed(emptyActionServices);

type ActionRegistrationPrivateValue<
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  Services = Readonly<Record<string, never>>,
  HandlerRequirements = never,
> = readonly [
  handler: ActionHandler<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Services, HandlerRequirements>,
  serviceFactory: ActionServiceFactory<Services, HandlerRequirements>,
];

export type ActionRegistration<
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
  Services = Readonly<Record<string, never>>,
  HandlerRequirements = never,
> = ActionPrivateStorage<
  ActionRegistrationPrivateValue<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Services,
    HandlerRequirements
  >
> & {
  readonly _handlerRequirements?: HandlerRequirements;
  readonly _services?: Services;
  readonly [actionRegistration]: true;
  readonly descriptor: Readonly<ActionDescriptor<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Owner>>;
};

/**
 * Existential public view of an Action registration. Keeping only the deployment-contract
 * fields avoids pretending TypeScript can express "ActionRegistration for some payload".
 */
export interface AnyActionRegistration {
  readonly [actionRegistration]: true;
  readonly descriptor: Readonly<
    Pick<
      ActionDescriptor<
        Schema.ConstraintDecoder<unknown>,
        Schema.ConstraintDecoder<unknown>,
        Schema.ConstraintDecoder<{ readonly _tag: string }>,
        DomainEventContractMap,
        string
      >,
      | 'actionKey'
      | 'auditProfile'
      | 'entrypoint'
      | 'idempotency'
      | 'legalEntityScope'
      | 'owningModuleKey'
      | 'schemaVersion'
    >
  >;
}

export type ActionRequirements<Registration> =
  Registration extends ActionRegistration<
    Schema.ConstraintDecoder<unknown>,
    Schema.ConstraintDecoder<unknown>,
    Schema.ConstraintDecoder<{ readonly _tag: string }>,
    DomainEventContractMap,
    string,
    unknown,
    infer Requirements
  >
    ? Requirements
    : never;

export interface ActionDescriptorValidationInput<Policy> {
  readonly businessPermission?: ActionBusinessPermissionDeclaration<never>;
  readonly entrypoint: ModuleEntrypointDescriptor;
  readonly legalEntityPermission?: unknown;
  readonly legalEntityScope: string;
  readonly owningModuleKey: string;
  readonly policies?: readonly Policy[];
  readonly resourcePermission?: ActionResourcePermissionDeclaration<never>;
  readonly tenantPermission?: unknown;
}

const validateActionEntrypoint = <Policy>(descriptor: ActionDescriptorValidationInput<Policy>): void => {
  if (
    descriptor.entrypoint.role !== 'action' ||
    descriptor.entrypoint.access !== 'write' ||
    descriptor.entrypoint.moduleKey !== descriptor.owningModuleKey ||
    descriptor.entrypoint.scope !== (descriptor.owningModuleKey.startsWith('core.') ? 'system' : 'tenant') ||
    !Object.isFrozen(descriptor.entrypoint)
  ) {
    return failActionDefinition(
      'Action entrypoint must be an immutable action/write descriptor with the required owner scope',
    );
  }
};
const validateActionLegalEntityScope = <Policy>(descriptor: ActionDescriptorValidationInput<Policy>): void => {
  if (!LEGAL_ENTITY_SCOPES.some((scope) => scope === descriptor.legalEntityScope)) {
    return failActionDefinition('Action legal-entity scope must be required, optional, or forbidden');
  }
  if (
    descriptor.legalEntityPermission !== undefined &&
    (descriptor.legalEntityPermission !== 'manage_counterparty' || descriptor.legalEntityScope !== 'required')
  ) {
    return failActionDefinition(
      'Action Legal Entity permission must be supported and require trusted Legal Entity scope',
    );
  }
};
const validateActionPermissions = <Policy>(descriptor: ActionDescriptorValidationInput<Policy>): void => {
  if (
    (descriptor.businessPermission !== undefined &&
      !Schema.is(ActionBusinessPermissionDeclarationSchema)(descriptor.businessPermission)) ||
    (descriptor.resourcePermission !== undefined &&
      !Schema.is(ActionResourcePermissionDeclarationSchema)(descriptor.resourcePermission)) ||
    (descriptor.tenantPermission !== undefined && !Predicate.isFunction(descriptor.tenantPermission))
  ) {
    return failActionDefinition('Action permission declarations and resolvers must be valid');
  }
};
const validateActionPolicies = <Policy>(
  descriptor: ActionDescriptorValidationInput<Policy>,
  policies: readonly Policy[] | undefined,
): void => {
  if (!Array.isArray(policies)) {
    return failActionDefinition('Action policies must be an explicit readonly array of Policy references');
  }
  validateActionPermissions(descriptor);
  for (const policy of policies) {
    if (!isActionPolicy(policy)) {
      return failActionDefinition('Action policies must contain direct Policy object references');
    }
    if (policy.scope === 'microvertical' && policy.owningModuleKey !== descriptor.owningModuleKey) {
      return failActionDefinition('A MicroVertical Policy must be owned by the Action owning module');
    }
  }
};
export const validateActionDescriptorInput = <Policy>(descriptor: ActionDescriptorValidationInput<Policy>): void => {
  validateActionEntrypoint(descriptor);
  validateActionLegalEntityScope(descriptor);
  validateActionPolicies(descriptor, descriptor.policies);
};

export function defineAction<
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
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
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  const Owner extends string,
  Services,
  HandlerRequirements,
>(
  descriptor: ActionDescriptor<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Owner>,
  ...definition: readonly [
    handler: ActionHandler<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Services, HandlerRequirements>,
    serviceFactory: ActionServiceFactory<Services, HandlerRequirements>,
  ]
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
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
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
    return ActionPrivateStorage.create([handler, emptyActionServiceFactory] as const, {
      [actionRegistration]: true as const,
      descriptor: frozenDescriptor,
    });
  }
  const [handler, serviceFactory] = definition;
  return ActionPrivateStorage.create([handler, serviceFactory] as const, {
    [actionRegistration]: true as const,
    descriptor: frozenDescriptor,
  });
}

const AnyActionRegistrationSchema = Schema.instanceOf(ActionPrivateStorage).check(
  Schema.makeFilter((registration) =>
    registration[actionRegistration] === true && registration.descriptor !== undefined && Object.isFrozen(registration)
      ? undefined
      : 'Expected an immutable Action registration',
  ),
);

/** Runtime guard for the opaque value created by defineAction. */
export const isActionRegistration = <Value>(value: Value): value is Value & AnyActionRegistration =>
  Schema.is(AnyActionRegistrationSchema)(value);

/** Internal Core runtime seam. Action handlers are intentionally absent from the public registration. */
export const getActionHandler = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
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
): ActionHandler<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Services, HandlerRequirements> =>
  ActionPrivateStorage.getValue(registration)[0];

export const getActionServiceFactory = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
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
): ActionServiceFactory<Services, HandlerRequirements> => ActionPrivateStorage.getValue(registration)[1];

export const getActionResourcePermissionTargetResolver = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
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
  registration.descriptor.resourcePermission === undefined
    ? undefined
    : ActionPrivateStorage.getValue(registration.descriptor.resourcePermission);

export const getActionBusinessPermissionTargetResolver = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
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
): ActionBusinessPermissionTargetResolver<PayloadSchema['Type']> | undefined =>
  registration.descriptor.businessPermission === undefined
    ? undefined
    : ActionPrivateStorage.getValue(registration.descriptor.businessPermission);

const preserveFailureCause = <Failure extends object>(
  failure: Failure,
  cause: unknown,
): Failure => {
  Object.defineProperty(failure, 'cause', {
    configurable: false,
    enumerable: false,
    value: cause,
    writable: false,
  });
  return failure;
};

export const decodeActionPayload = <PayloadSchema extends Schema.ConstraintDecoder<unknown>, Payload>(
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
    Effect.mapError((cause) =>
      preserveFailureCause(
        new ActionPayloadValidationError({
          code: 'action_payload_invalid',
          reason: 'The Action payload does not match its declared schema',
        }),
        cause,
      ),
    ),
  );
};

export const decodeActionResult = <ResultSchema extends Schema.ConstraintDecoder<unknown>, Result>(
  schema: ResultSchema,
  result: Result,
): Effect.Effect<ResultSchema['Type'], ActionResultValidationError> =>
  Schema.encodeUnknownEffect(Schema.make<Schema.ConstraintEncoder<unknown>>(schema.ast))(result).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((cause) =>
      preserveFailureCause(
        new ActionResultValidationError({
          code: 'action_result_invalid',
          reason: 'The Action result does not match its declared schema',
        }),
        cause,
      ),
    ),
  );
