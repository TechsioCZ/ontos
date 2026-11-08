import { isOwnerPermissionContract } from '../permissions/owner-permission-contract.ts';
import { Array as EffectArray, Effect, Schema, Predicate } from 'effect';
import type { Option } from 'effect';
import { declaredAccessCarrier } from '../authorization/access-declaration.ts';
import { fieldWriteGroupSchemaIssue } from '../authorization/field-group-paths.ts';
import type {
  AccessActor,
  AccessActorInput,
  AccessAmount,
  AccessDeclaration,
  AccessDeclarationInput,
  AccessFieldGroup,
  AccessFieldGroupInput,
  AccessTarget,
  AccessWorkload,
  AccessWorkloadInput,
} from '../authorization/access-declaration.ts';
import type { OwnerAccessFacts } from '../access/enforcement/owner-overlay.ts';
import type {
  ActionHandlerContext,
  ActionServicePreparationContext,
  CommittedActionDomainRejection,
} from './context.ts';
import { ActionPermissionCheckError, ActionResultValidationError } from './errors.ts';
import type { ActionCollectorError, ActionCoreError, ActionPayloadValidationError } from './errors.ts';
import type { ActionAccessEvidencePolicy, DomainEventContractMap } from './events.ts';
import { isActionPolicy } from './policy.ts';
import type { ActionPolicy, ActionPreparationPolicyEvaluator } from './policy.ts';
import type { ModuleEntrypointDescriptor } from '../modules/module-entrypoint.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { OperationalScope } from '../operations/context.ts';
import { LEGAL_ENTITY_SCOPES } from '../operations/legal-entity-scope.ts';
import type { LegalEntityScope } from '../operations/legal-entity-scope.ts';
import type { OperationContextUnavailable } from '../operations/errors.ts';
import type { ResourceAccessTarget } from '../permissions/context-access.ts';
import type { OwnerPermissionAccessTarget, OwnerPermissionContract } from '../permissions/owner-permission-contract.ts';
import type { TenantPermissionKey } from '../permissions/context-permissions.ts';
import type { ActionAccessTargetsResolver, ActionTargetSetAdmission } from './target-set.ts';
import { actionGoverningReadIssue } from './governing-read.ts';
import type { ActionGoverningReadDeclaration } from './governing-read.ts';
import { resolveGovernedAmount } from '../access/approvals/governed-amount.ts';
import { writtenFieldPaths } from './field-write-authorization.ts';
import { decodeActionPayload, preserveFailureCause } from './payload-codec.ts';
import type { originalActionPreparationFactory } from './preparation-observation.ts';

export { decodeActionPayload } from './payload-codec.ts';

export type { ActionAccessTargetsResolver, ActionTargetSetAdmission } from './target-set.ts';

const actionRegistration: unique symbol = Symbol('@app/core-runtime/actions/registration');
const actionResourcePermissionDeclaration: unique symbol = Symbol('@app/core-runtime/actions/resource-permission');
const actionOwnerPermissionDeclaration: unique symbol = Symbol('@app/core-runtime/actions/owner-permissions');
const actionAccessTargetsDeclaration: unique symbol = Symbol('@app/core-runtime/actions/access-targets');

class ActionPrivateStorage<Value> {
  declare readonly [actionRegistration]?: true;
  declare readonly [actionResourcePermissionDeclaration]?: true;
  declare readonly [actionOwnerPermissionDeclaration]?: true;
  declare readonly [actionAccessTargetsDeclaration]?: true;
  declare readonly descriptor?: unknown;
  declare readonly kind?: 'owner_permission' | 'record_set' | 'resource';
  readonly #value: Value;
  readonly #commandReader: RegisteredActionCommandReader | undefined;

  constructor(value: Value, commandReader?: RegisteredActionCommandReader) {
    this.#value = value;
    this.#commandReader = commandReader;
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

  static createRegistration<Value, PublicFields extends object>(input: {
    readonly commandReader: RegisteredActionCommandReader;
    readonly publicFields: PublicFields;
    readonly value: Value;
  }): ActionPrivateStorage<Value> & Readonly<PublicFields> {
    const storage = Object.assign(new ActionPrivateStorage(input.value, input.commandReader), input.publicFields);
    Object.freeze(storage);
    return storage;
  }

  static commandReaderOf(storage: AnyActionRegistration): RegisteredActionCommandReader | undefined {
    return Schema.is(Schema.instanceOf(ActionPrivateStorage))(storage) ? storage.#commandReader : undefined;
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
export type ActionDeniedAuditEvidenceValue = Readonly<Record<string, ActionDeniedAuditEvidenceJsonValue>>;
export type ActionDeniedAuditEvidenceResolver<Payload> = (
  payload: Payload,
  scope: OperationalScope,
) => ActionDeniedAuditEvidenceValue;
/**
 * The one record a record-scoped Action acts on, derived from the decoded payload and the trusted
 * scope (O9, O27). The module is the record's own owner, never the capability key's prefix.
 */
export type ActionAccessTargetResolver<Payload> = (payload: Payload, scope: OperationalScope) => AccessTarget;
export type ActionAccessTargetsDeclaration<Payload> = ActionPrivateStorage<ActionAccessTargetsResolver<Payload>> & {
  readonly [actionAccessTargetsDeclaration]: true;
  readonly kind: 'record_set';
};

/** Internal Core lookup; the authored callback is not exposed on the descriptor. */
export const getActionAccessTargetsResolver = <Payload>(
  declaration: ActionAccessTargetsDeclaration<Payload> | undefined,
): ActionAccessTargetsResolver<Payload> | undefined =>
  declaration === undefined ? undefined : ActionPrivateStorage.getValue(declaration);

const isActionAccessTargetsDeclaration = Schema.is(
  Schema.instanceOf(ActionPrivateStorage).check(
    Schema.makeFilter((declaration) =>
      declaration[actionAccessTargetsDeclaration] === true &&
      declaration.kind === 'record_set' &&
      Object.isFrozen(declaration)
        ? undefined
        : 'Expected an immutable Action target-set declaration',
    ),
  ),
);
/**
 * The money value an amount ceiling applies to when `amountInput` names a server-derived total
 * (O18). A composite total is computed server-side and never taken from the client.
 */
export type ActionAccessAmountResolver<Payload> = (payload: Payload, scope: OperationalScope) => AccessAmount;
/**
 * The owner-local facts this Action hands to the owner overlay, derived from the decoded payload and
 * the trusted scope (O70). They name the records the owner's own business rule is about; they are
 * never authority and never reach the decision engine.
 */
export type ActionOwnerFactsResolver<Payload> = (payload: Payload, scope: OperationalScope) => OwnerAccessFacts;
/**
 * Whether this exact payload only *reduces* the acting person's own authority (O35, O71). It is not
 * a capability and grants nothing: a true answer stops the grant decision from blocking an act that
 * takes authority away, and every other payload still needs the declaration's grant.
 */
export type ActionReducesAuthorityResolver<Payload> = (payload: Payload) => boolean;
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

export type ActionOwnerPermissionTarget = OwnerPermissionAccessTarget;
export type ActionOwnerPermissionTargetResolver<Payload> = (
  payload: Payload,
  scope: OperationalScope,
) => readonly ActionOwnerPermissionTarget[];
export type ActionOwnerPermissionDeclaration<Payload> = ActionPrivateStorage<
  ActionOwnerPermissionTargetResolver<Payload>
> & {
  readonly [actionOwnerPermissionDeclaration]: true;
  readonly contract: OwnerPermissionContract;
  readonly kind: 'owner_permission';
};

const ActionDefinitionInvariantError = Schema.TaggedError<Error>()('ActionDefinitionInvariantError', {
  message: Schema.String,
});

const failActionDefinition = (message: string): never => {
  throw new ActionDefinitionInvariantError({ message });
};

/** Declares complete owned-record target resolution, not a grant or an execution alias. */
export const defineActionAccessTargets = <Payload>(
  resolver: (payload: Payload, scope: OperationalScope) => readonly AccessTarget[],
): ActionAccessTargetsDeclaration<Payload> => {
  if (!Predicate.isFunction(resolver)) {
    return failActionDefinition('Action accessTargets resolver must be a function');
  }
  return ActionPrivateStorage.create(resolver, {
    [actionAccessTargetsDeclaration]: true as const,
    kind: 'record_set' as const,
  });
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

/** Declares one exact business permission resolved before policy or handler code. */
/** Declares one or more exact owner policy meanings checked conjunctively. */
export const defineActionOwnerPermissions = <Payload>(
  contract: OwnerPermissionContract,
  resolver: ActionOwnerPermissionTargetResolver<Payload>,
): ActionOwnerPermissionDeclaration<Payload> => {
  if (!Predicate.isFunction(resolver) || !isOwnerPermissionContract(contract)) {
    return failActionDefinition('Action owner permission resolver and contract must be valid');
  }
  return ActionPrivateStorage.create(resolver, {
    [actionOwnerPermissionDeclaration]: true as const,
    contract,
    kind: 'owner_permission' as const,
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
const ActionOwnerPermissionDeclarationSchema = Schema.instanceOf(ActionPrivateStorage).check(
  Schema.makeFilter((declaration) =>
    declaration[actionOwnerPermissionDeclaration] === true &&
    declaration.kind === 'owner_permission' &&
    Object.isFrozen(declaration)
      ? undefined
      : 'Expected an immutable Action owner permission declaration',
  ),
);

/** The access carriers of an Action as a module writes them; `defineAction` decodes them (O5, O58, O59). */
export interface AuthoredActionAccessCarriers {
  /** Module-to-module calls this Action receives; the calling module is the actor (D5). */
  readonly accessActor?: AccessActorInput;
  /** Optional report-only catalog metadata; never grants Action execution. Authoring shape. */
  readonly accessDeclaration?: AccessDeclarationInput;
  /** Sensitive payload field groups written by this Action, each a `field_write` declaration (O58). */
  readonly accessFieldGroups?: readonly AccessFieldGroupInput[];
  /**
   * Marks an Action only trusted machine workloads may run (O29, O59). Beside `accessDeclaration`
   * it means both paths exist and stay disjoint: the workload path never admits humans and the
   * declaration path never admits workloads (O67-Q4).
   */
  readonly accessWorkload?: AccessWorkloadInput;
}

/** The decoded, frozen carriers a registration exposes; no request decodes them again (O5, O58, O59). */
export interface DeclaredActionAccessCarriers {
  readonly accessActor?: AccessActor;
  readonly accessDeclaration?: AccessDeclaration;
  readonly accessFieldGroups?: readonly AccessFieldGroup[];
  readonly accessWorkload?: AccessWorkload;
}

export interface ActionDescriptor<
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
  Carriers extends AuthoredActionAccessCarriers | DeclaredActionAccessCarriers = AuthoredActionAccessCarriers,
> {
  /** Module-to-module calls this Action receives; the calling module is the actor (D5). */
  readonly accessActor?: Carriers['accessActor'];
  /**
   * The money value of the governed command when the declaration's `amountInput` names a
   * server-derived total, e.g. `derived.purchaseValue` (O18).
   */
  readonly accessAmount?: ActionAccessAmountResolver<PayloadSchema['Type']>;
  /** Optional report-only catalog metadata; never grants Action execution. Authoring shape. */
  readonly accessDeclaration?: Carriers['accessDeclaration'];
  readonly accessEvidencePolicy: ActionAccessEvidencePolicy;
  /** Sensitive payload field groups written by this Action, each a `field_write` declaration (O58). */
  readonly accessFieldGroups?: Carriers['accessFieldGroups'];
  /** The independent published record Read retained by forward-version approval commands. */
  readonly accessGoverningRead?: ActionGoverningReadDeclaration;
  /**
   * The owner-local facts this Action hands to the owner overlay (O70), e.g. the counterparty whose
   * own grant the owner rule checks. They grant nothing and never reach the decision engine.
   */
  readonly accessOwnerFacts?: ActionOwnerFactsResolver<PayloadSchema['Type']>;
  /**
   * Whether this exact payload *reduces* the acting person's own authority, so no grant may block it
   * (O35, O71): ending an impersonation, revoking one's own credential, withdrawing one's own
   * proposal. Only a true answer skips the grant decision, and only on a descriptor that declares its
   * own `accessDeclaration`; the request still needs an authenticated principal in a resolved scope
   * and the act is still recorded.
   */
  readonly accessReducesAuthority?: ActionReducesAuthorityResolver<PayloadSchema['Type']>;
  /**
   * The one record this Action acts on when its declaration is record-scoped (O9, O27); a
   * scope-wide Action has no target and the gate never asks for one.
   */
  readonly accessTarget?: ActionAccessTargetResolver<PayloadSchema['Type']>;
  /**
   * Every owned record changed by this one invocation, derived from decoded input and trusted company
   * scope. Mutually exclusive with accessTarget. Core requires every record and applicable field
   * group to pass. Durable proposals/mandates for more than one target are not yet supported and
   * fail closed; an exact singleton retains the existing scalar approval contract.
   */
  readonly accessTargets?: ActionAccessTargetsDeclaration<PayloadSchema['Type']>;
  /**
   * Marks an Action only trusted machine workloads may run (O29, O59). Beside `accessDeclaration`
   * it means both paths exist and stay disjoint: the workload path never admits humans and the
   * declaration path never admits workloads (O67-Q4).
   */
  readonly accessWorkload?: Carriers['accessWorkload'];
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
  /** Resolves a schema-bounded, secret-safe evidence object before authorization/policy denial. */
  readonly deniedAuditEvidence?: ActionDeniedAuditEvidenceDeclaration<PayloadSchema['Type']>;
  readonly domainErrorSchema: DomainErrorSchema;
  readonly domainEvents: DomainEvents;
  readonly entrypoint: ModuleEntrypointDescriptor<'action', 'write', Owner>;
  readonly idempotency: ActionIdempotencyRule;
  /** Requires a permission on the Legal Entity selected by trusted operational scope. */
  readonly legalEntityPermission?: ActionLegalEntityPermission;
  readonly legalEntityScope: LegalEntityScope;
  /** Declares one or more exact owner permission targets checked conjunctively. */
  readonly ownerPermissions?: ActionOwnerPermissionDeclaration<PayloadSchema['Type']>;
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

export type ActionServiceFactory<Services, Requirements = never> = ((
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  compositionRevision: string,
) => Effect.Effect<Services, OperationContextUnavailable, Requirements>) & {
  /** Private test substitution provenance; never used for execution or authorization. */
  readonly [originalActionPreparationFactory]?: ActionServiceFactory<Services, Requirements>;
};

/**
 * Resolve remote facts outside SQL, then return an invocation-local service factory that reloads and
 * compares its owner snapshot before any write. It cannot change the payload or Core authorization.
 */
export type ActionServicePreflight<Payload, Services, DomainError, Requirements = never> = (
  payload: Payload,
  context: ActionServicePreparationContext & {
    readonly evaluatePolicy: ActionPreparationPolicyEvaluator<Payload, DomainError>;
    readonly targetSetAdmission?: ActionTargetSetAdmission;
  },
) => Effect.Effect<ActionServiceFactory<Services, Requirements>, ActionCoreError | DomainError, Requirements>;

export interface ActionServicePreparation<Payload, Result, Services, DomainError, Requirements = never> {
  readonly onDecodedSuccess?: ActionDecodedSuccessHook<Result, Services, DomainError, Requirements>;
  /** Exact descriptor Policy references evaluated through context.evaluatePolicy, never twice statically. */
  readonly preparationPolicies?: readonly ActionPolicy<Payload, string>[];
  readonly prepareServices: ActionServicePreflight<Payload, Services, DomainError, Requirements>;
}

/** Runs only for a decoded successful result inside the owning Action transaction. */
export type ActionDecodedSuccessHook<Result, Services, DomainError, Requirements = never> = (
  context: Readonly<{
    readonly actionInvocationId: string;
    readonly result: Result;
    readonly scope: OperationalScope;
    readonly services: Services;
  }>,
) => Effect.Effect<void, ActionCoreError | DomainError, Requirements>;

const actionPostAttemptOutcomeSchema = <
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  result: ResultSchema,
  rejection: DomainErrorSchema,
) =>
  Schema.Union([
    Schema.TaggedStruct('Committed', { result }),
    Schema.TaggedStruct('CommittedRejection', { rejection }),
    Schema.TaggedStruct('AlreadyCommitted', {}),
    Schema.TaggedStruct('DefinitelyUncommitted', { rejection: Schema.optionalKey(rejection) }),
    Schema.TaggedStruct('Indeterminate', {}),
    Schema.TaggedStruct('Interrupted', {}),
  ]);
const actionPostAttemptResultSchema = <ResultSchema extends Schema.ConstraintDecoder<unknown>>(result: ResultSchema) =>
  Schema.Union([Schema.TaggedStruct('Settled', {}), Schema.TaggedStruct('Recovered', { result })]);
export type ActionPostAttemptOutcome<Result, DomainError extends { readonly _tag: string }> = ReturnType<
  typeof actionPostAttemptOutcomeSchema<Schema.ConstraintDecoder<Result>, Schema.ConstraintDecoder<DomainError>>
>['Type'];
export type ActionPostAttemptResult<Result> = ReturnType<
  typeof actionPostAttemptResultSchema<Schema.ConstraintDecoder<Result>>
>['Type'];

/** Owner-local continuation after transaction settlement; carries no handler services or raw failure. */
export type ActionPostAttemptHook<
  Payload,
  Result,
  DomainError extends { readonly _tag: string },
  Requirements = never,
> = (
  context: Readonly<{
    readonly actionInvocationId: string;
    readonly compositionRevision: string;
    readonly outcome: ActionPostAttemptOutcome<Result, DomainError>;
    readonly payload: Payload;
    readonly scope: OperationalScope;
  }>,
) => Effect.Effect<ActionPostAttemptResult<Result>, ActionCoreError | DomainError, Requirements>;

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
  onDecodedSuccess?:
    | ActionDecodedSuccessHook<ResultSchema['Type'], Services, DomainErrorSchema['Type'], HandlerRequirements>
    | undefined,
  onPostAttempt?:
    | ActionPostAttemptHook<PayloadSchema['Type'], ResultSchema['Type'], DomainErrorSchema['Type'], HandlerRequirements>
    | undefined,
  prepareServices?:
    | ActionServicePreflight<PayloadSchema['Type'], Services, DomainErrorSchema['Type'], HandlerRequirements>
    | undefined,
  preparationPolicies?: readonly ActionPolicy<PayloadSchema['Type'], string>[] | undefined,
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
  readonly descriptor: Readonly<
    DeclaredActionDescriptor<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Owner>
  >;
};

/**
 * The descriptor a registration exposes: the authored carriers replaced by the decoded, frozen ones
 * (O5, O58, O59). A runtime decides and records with exactly what definition time validated, so no
 * request decodes the declaration, its field groups or the workload marker again.
 */
export type DeclaredActionDescriptor<
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
> = Readonly<
  Omit<
    ActionDescriptor<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Owner>,
    'accessActor' | 'accessDeclaration' | 'accessFieldGroups' | 'accessWorkload'
  > &
    DeclaredActionAccessCarriers
>;

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
      | 'accessActor'
      | 'accessDeclaration'
      | 'accessFieldGroups'
      | 'accessWorkload'
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

/** Core-private command projection. It exposes no owner handler, service factory or requirements. */
export interface RegisteredActionCommandReader {
  readonly descriptor: AnyActionRegistration['descriptor'] & {
    readonly accessGoverningRead?: ActionGoverningReadDeclaration;
  };
  readonly resolve: (
    encodedPayload: Schema.Json,
    scope: OperationalScope,
  ) => Effect.Effect<
    {
      readonly amount: Option.Option<AccessAmount>;
      readonly applicableFieldGroups: readonly AccessFieldGroup[];
      readonly encodedPayload: Schema.Json;
      readonly target: AccessTarget | undefined;
      readonly targets: readonly AccessTarget[] | undefined;
    },
    ActionPayloadValidationError | ActionPermissionCheckError
  >;
}
export const RegisteredActionCommandPayloadSchema = Schema.Struct({ payload: Schema.Json });

/** Original registration identity is mandatory. A copied descriptor has no command reader. */
export const getRegisteredActionCommandReader = (
  registration: AnyActionRegistration,
): RegisteredActionCommandReader | undefined => ActionPrivateStorage.commandReaderOf(registration);

const makeRegisteredActionCommandReader = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
>(
  descriptor: DeclaredActionDescriptor<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Owner>,
): RegisteredActionCommandReader =>
  Object.freeze({
    descriptor,
    resolve: Effect.fn('ActionDefinition.resolveRegisteredCommand')(function* resolveRegisteredCommand(
      encodedPayload: Schema.Json,
      scope: OperationalScope,
    ) {
      const payload = yield* decodeActionPayload(descriptor.payloadSchema, encodedPayload);
      const amount = yield* resolveGovernedAmount(
        payload,
        scope,
        descriptor.accessAmount,
        descriptor.accessDeclaration,
      );
      const fields = (descriptor.accessFieldGroups ?? []).filter(
        (group) => writtenFieldPaths(group, payload).length > 0,
      );
      const resolved = yield* Effect.try({
        catch: (cause) =>
          preserveFailureCause(
            new ActionPermissionCheckError({
              code: 'action_permission_check_failed',
              reason: 'The original Action target facts could not be resolved',
            }),
            cause,
          ),
        try: () => ({
          target: descriptor.accessTarget?.(payload, scope),
          targets: getActionAccessTargetsResolver(descriptor.accessTargets)?.(payload, scope),
        }),
      });
      const encoded = yield* Schema.encodeUnknownEffect(
        Schema.make<Schema.ConstraintEncoder<unknown>>(descriptor.payloadSchema.ast),
      )(payload).pipe(
        Effect.flatMap((encodedValue) =>
          Schema.decodeUnknownEffect(RegisteredActionCommandPayloadSchema)({ payload: encodedValue }),
        ),
        Effect.mapError((cause) =>
          preserveFailureCause(
            new ActionPermissionCheckError({
              code: 'action_permission_check_failed',
              reason: 'The original Action payload cannot be frozen as canonical JSON',
            }),
            cause,
          ),
        ),
      );
      return Object.freeze({
        amount,
        applicableFieldGroups: Object.freeze(fields),
        encodedPayload: encoded.payload,
        ...resolved,
      });
    }),
  });

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
  readonly accessActor?: AccessActorInput;
  readonly accessAmount?: unknown;
  readonly accessDeclaration?: AccessDeclarationInput;
  readonly accessFieldGroups?: readonly AccessFieldGroupInput[];
  readonly accessGoverningRead?: ActionGoverningReadDeclaration;
  readonly accessOwnerFacts?: unknown;
  readonly accessReducesAuthority?: unknown;
  readonly accessTarget?: unknown;
  readonly accessTargets?: unknown;
  readonly accessWorkload?: AccessWorkloadInput;
  readonly entrypoint: ModuleEntrypointDescriptor;
  readonly legalEntityPermission?: unknown;
  readonly legalEntityScope: string;
  readonly ownerPermissions?: ActionOwnerPermissionDeclaration<never>;
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
    (descriptor.ownerPermissions !== undefined &&
      (!Schema.is(ActionOwnerPermissionDeclarationSchema)(descriptor.ownerPermissions) ||
        descriptor.ownerPermissions.contract.owningModuleKey !== descriptor.owningModuleKey)) ||
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
const derivedAmountInputPrefix = 'derived.';

const validateActionTargetSetBinding = <Policy>(
  descriptor: ActionDescriptorValidationInput<Policy>,
  declaration: AccessDeclaration | undefined,
): void => {
  if (descriptor.accessTargets === undefined) {
    return;
  }
  if (!isActionAccessTargetsDeclaration(descriptor.accessTargets) || descriptor.accessTarget !== undefined) {
    return failActionDefinition(
      'Action accessTargets must be a target-set declaration and cannot coexist with accessTarget',
    );
  }
  if (
    declaration?.kind !== 'action' ||
    declaration.selectors.length === 0 ||
    declaration.selectors.some((selector) => selector !== 'all') ||
    descriptor.legalEntityScope !== 'required' ||
    descriptor.accessReducesAuthority !== undefined
  ) {
    return failActionDefinition(
      'Action accessTargets requires a record-scoped action declaration with supported selectors, required company scope and no authority-reduction exemption',
    );
  }
};

/**
 * The record target and the amount resolver are bound to the declaration they serve: a target exists
 * only for a record-scoped capability (Q2), and a derived amount only where the declaration names a
 * server-derived total (O18). Both are authoring mistakes worth failing at definition time (O5).
 */
/*
 * A record-scoped decision is answered by the graph, which holds no holder-relative record relation:
 * `assigned`, `entrusted` and `team` are decided from the owner's row projection, which only a list
 * read hands Core today. A single-record capability that offered one would let a role grant it and
 * then deny it on every record, so it is an authoring mistake until owners project their records into
 * the decision (R5a-7).
 */
const validateActionAccessBinding = <Policy>(
  descriptor: ActionDescriptorValidationInput<Policy>,
  declaration: AccessDeclaration | undefined,
): void => {
  const { accessAmount, accessOwnerFacts, accessReducesAuthority, accessTarget } = descriptor;
  validateActionTargetSetBinding(descriptor, declaration);
  if (accessTarget !== undefined && !Predicate.isFunction(accessTarget)) {
    return failActionDefinition('Action access target must be a resolver function');
  }
  if (accessAmount !== undefined && !Predicate.isFunction(accessAmount)) {
    return failActionDefinition('Action access amount must be a resolver function');
  }
  if (accessReducesAuthority !== undefined) {
    if (!Predicate.isFunction(accessReducesAuthority)) {
      return failActionDefinition('Action access reduces-authority declaration must be a resolver function');
    }
    if (declaration === undefined) {
      return failActionDefinition(
        'Action accessReducesAuthority requires the descriptor to declare its own accessDeclaration',
      );
    }
  }
  if (accessOwnerFacts !== undefined) {
    if (!Predicate.isFunction(accessOwnerFacts)) {
      return failActionDefinition('Action access owner facts must be a resolver function');
    }
    if (declaration === undefined) {
      return failActionDefinition(
        'Action accessOwnerFacts requires the descriptor to declare its own accessDeclaration',
      );
    }
  }
  if (accessTarget !== undefined) {
    if (declaration === undefined) {
      return failActionDefinition('Action accessTarget requires the descriptor to declare its own accessDeclaration');
    }
    if (declaration.selectors.length === 0) {
      return failActionDefinition(
        'Action accessTarget requires a record-scoped declaration: a scope-wide capability acts on no single record (Q2)',
      );
    }
    if (declaration.selectors.some((selector) => selector !== 'all')) {
      return failActionDefinition(
        'Action accessTarget decides one record, which no holder-relative selector (assigned, entrusted, team) can be checked against yet (R5a-7)',
      );
    }
  }
  if (accessAmount === undefined) {
    return;
  }
  if (declaration === undefined) {
    return failActionDefinition('Action accessAmount requires the descriptor to declare its own accessDeclaration');
  }
  const { amountInput } = declaration;
  if (amountInput === undefined) {
    return failActionDefinition('Action accessAmount requires the declaration to declare its amountInput');
  }
  if (!amountInput.startsWith(derivedAmountInputPrefix)) {
    return failActionDefinition(
      `Action accessAmount requires amountInput to name a server-derived total (${derivedAmountInputPrefix}*), never a client-supplied amount (O18)`,
    );
  }
};

export const validateActionDescriptorInput = <Policy>(descriptor: ActionDescriptorValidationInput<Policy>): void => {
  validateActionEntrypoint(descriptor);
  // Decodes the declaration, its field groups and the workload marker against the entrypoint (O5).
  const carriers = declaredAccessCarrier(descriptor);
  validateActionAccessBinding(descriptor, carriers.accessDeclaration);
  const readIssue = actionGoverningReadIssue(
    descriptor.accessGoverningRead,
    descriptor.owningModuleKey,
    descriptor.legalEntityScope,
    (carriers.accessDeclaration?.selectors.length ?? 0) > 0,
  );
  if (readIssue !== undefined) {
    return failActionDefinition(readIssue);
  }
  validateActionLegalEntityScope(descriptor);
  validateActionPolicies(descriptor, descriptor.policies);
};

const validatePreparationPolicies = <Payload>(
  policies: readonly ActionPolicy<Payload, string>[] | undefined,
  declared: readonly ActionPolicy<Payload, string>[],
  hasPreparation: boolean,
): readonly ActionPolicy<Payload, string>[] | undefined => {
  const declaredPolicies = new Set(declared);
  const required = declared.filter((policy) => policy.requiresPreparation === true);
  if (!hasPreparation && required.length > 0) {
    return failActionDefinition('An effectful preparation Policy requires registered prepareServices');
  }
  const selected = policies ?? required;
  if (!EffectArray.isArray(selected)) {
    return failActionDefinition('Preparation Policies must be an array of exact declared references');
  }
  const selectedPolicies = new Set(selected);
  if (
    selectedPolicies.size !== selected.length ||
    selected.some((policy) => !declaredPolicies.has(policy)) ||
    required.some((policy) => !selectedPolicies.has(policy))
  ) {
    return failActionDefinition(
      'Preparation Policies must cover every required Policy using unique exact declared references',
    );
  }
  return selected.length === 0 ? undefined : selected;
};

export function defineAction<
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  const Owner extends string,
  Services,
  HandlerRequirements,
  PreparationRequirements,
  PostAttemptRequirements,
>(
  descriptor: ActionDescriptor<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Owner>,
  ...definition: readonly [
    handler: ActionHandler<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Services, HandlerRequirements>,
    serviceFactory: ActionServiceFactory<Services, HandlerRequirements>,
    preparation: ActionServicePreparation<
      PayloadSchema['Type'],
      ResultSchema['Type'],
      Services,
      DomainErrorSchema['Type'],
      PreparationRequirements
    >,
    onPostAttempt: ActionPostAttemptHook<
      PayloadSchema['Type'],
      ResultSchema['Type'],
      DomainErrorSchema['Type'],
      PostAttemptRequirements
    >,
  ]
): ActionRegistration<
  PayloadSchema,
  ResultSchema,
  DomainErrorSchema,
  DomainEvents,
  Owner,
  Services,
  HandlerRequirements | PreparationRequirements | PostAttemptRequirements
>;
export function defineAction<
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  const Owner extends string,
  Services,
  HandlerRequirements,
  PostAttemptRequirements,
>(
  descriptor: ActionDescriptor<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Owner>,
  ...definition: readonly [
    handler: ActionHandler<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Services, HandlerRequirements>,
    serviceFactory: ActionServiceFactory<Services, HandlerRequirements>,
    onDecodedSuccess:
      | ActionDecodedSuccessHook<ResultSchema['Type'], Services, DomainErrorSchema['Type'], HandlerRequirements>
      | undefined,
    onPostAttempt: ActionPostAttemptHook<
      PayloadSchema['Type'],
      ResultSchema['Type'],
      DomainErrorSchema['Type'],
      PostAttemptRequirements
    >,
  ]
): ActionRegistration<
  PayloadSchema,
  ResultSchema,
  DomainErrorSchema,
  DomainEvents,
  Owner,
  Services,
  HandlerRequirements | PostAttemptRequirements
>;
export function defineAction<
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  const Owner extends string,
  Services,
  HandlerRequirements,
  PreparationRequirements,
>(
  descriptor: ActionDescriptor<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Owner>,
  ...definition: readonly [
    handler: ActionHandler<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Services, HandlerRequirements>,
    serviceFactory: ActionServiceFactory<Services, HandlerRequirements>,
    preparation: ActionServicePreparation<
      PayloadSchema['Type'],
      ResultSchema['Type'],
      Services,
      DomainErrorSchema['Type'],
      PreparationRequirements
    >,
  ]
): ActionRegistration<
  PayloadSchema,
  ResultSchema,
  DomainErrorSchema,
  DomainEvents,
  Owner,
  Services,
  HandlerRequirements | PreparationRequirements
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
    onDecodedSuccess: ActionDecodedSuccessHook<
      ResultSchema['Type'],
      Services,
      DomainErrorSchema['Type'],
      HandlerRequirements
    >,
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
  PostAttemptRequirements,
>(
  descriptor: ActionDescriptor<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Owner>,
  ...definition:
    | readonly [
        ActionHandler<
          PayloadSchema,
          ResultSchema,
          DomainErrorSchema,
          DomainEvents,
          EmptyActionServices,
          HandlerRequirements
        >,
      ]
    | readonly [
        ActionHandler<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Services, HandlerRequirements>,
        ActionServiceFactory<Services, HandlerRequirements>,
      ]
    | readonly [
        ActionHandler<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Services, HandlerRequirements>,
        ActionServiceFactory<Services, HandlerRequirements>,
        (
          | ActionDecodedSuccessHook<ResultSchema['Type'], Services, DomainErrorSchema['Type'], HandlerRequirements>
          | ActionServicePreparation<
              PayloadSchema['Type'],
              ResultSchema['Type'],
              Services,
              DomainErrorSchema['Type'],
              HandlerRequirements
            >
        ),
      ]
    | readonly [
        ActionHandler<PayloadSchema, ResultSchema, DomainErrorSchema, DomainEvents, Services, HandlerRequirements>,
        ActionServiceFactory<Services, HandlerRequirements>,
        (
          | ActionDecodedSuccessHook<ResultSchema['Type'], Services, DomainErrorSchema['Type'], HandlerRequirements>
          | ActionServicePreparation<
              PayloadSchema['Type'],
              ResultSchema['Type'],
              Services,
              DomainErrorSchema['Type'],
              HandlerRequirements
            >
          | undefined
        ),
        ActionPostAttemptHook<
          PayloadSchema['Type'],
          ResultSchema['Type'],
          DomainErrorSchema['Type'],
          HandlerRequirements
        >,
      ]
):
  | ActionRegistration<
      PayloadSchema,
      ResultSchema,
      DomainErrorSchema,
      DomainEvents,
      Owner,
      EmptyActionServices,
      HandlerRequirements | PostAttemptRequirements
    >
  | ActionRegistration<
      PayloadSchema,
      ResultSchema,
      DomainErrorSchema,
      DomainEvents,
      Owner,
      Services,
      HandlerRequirements | PostAttemptRequirements
    > {
  validateActionDescriptorInput(descriptor);
  const carriers = declaredAccessCarrier(descriptor);
  const fieldGroupIssue = fieldWriteGroupSchemaIssue(carriers.accessFieldGroups ?? [], descriptor.payloadSchema);
  if (fieldGroupIssue !== undefined) {
    return failActionDefinition(`Action ${descriptor.actionKey}: ${fieldGroupIssue}`);
  }

  const {
    accessActor: _authoredActor,
    accessDeclaration: _authoredDeclaration,
    accessFieldGroups: _authoredFieldGroups,
    accessWorkload: _authoredWorkload,
    ...descriptorRest
  } = descriptor;
  const frozenDescriptor: DeclaredActionDescriptor<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Owner
  > = Object.freeze({
    // The authored carriers are replaced by their decoded form below; they are never registered as written.
    ...descriptorRest,
    ...carriers,
    accessEvidencePolicy: Object.freeze({ ...descriptor.accessEvidencePolicy }),
    domainEvents: Object.freeze({ ...descriptor.domainEvents }),
    entrypoint: descriptor.entrypoint,
    policies: Object.freeze([...descriptor.policies]),
  });
  if (definition.length === 1) {
    validatePreparationPolicies(undefined, frozenDescriptor.policies, false);
    const [handler] = definition;
    return ActionPrivateStorage.createRegistration({
      commandReader: makeRegisteredActionCommandReader(frozenDescriptor),
      publicFields: { [actionRegistration]: true as const, descriptor: frozenDescriptor },
      value: [handler, emptyActionServiceFactory] as const,
    });
  }
  const [handler, serviceFactory, onDecodedSuccessOrPreparation, onPostAttempt] = definition;
  // Two authored shapes reach the third slot: the decoded-success hook, or the owner's staged service
  // preparation object (`{ prepareServices, onDecodedSuccess }`), which keeps remote grants and other
  // owner reads in their own pre-transaction step (D14). The registered value is one normalized tuple.
  const isPreparation =
    onDecodedSuccessOrPreparation !== undefined && !Predicate.isFunction(onDecodedSuccessOrPreparation);
  if (
    isPreparation &&
    (!Predicate.isFunction(onDecodedSuccessOrPreparation.prepareServices) ||
      (onDecodedSuccessOrPreparation.onDecodedSuccess !== undefined &&
        !Predicate.isFunction(onDecodedSuccessOrPreparation.onDecodedSuccess)))
  ) {
    return failActionDefinition('Action service preparation must contain a prepareServices function');
  }
  const onDecodedSuccess = isPreparation
    ? onDecodedSuccessOrPreparation.onDecodedSuccess
    : onDecodedSuccessOrPreparation;
  const prepareServices = isPreparation ? onDecodedSuccessOrPreparation.prepareServices : undefined;
  const preparationPolicies = validatePreparationPolicies(
    isPreparation ? onDecodedSuccessOrPreparation.preparationPolicies : undefined,
    frozenDescriptor.policies,
    isPreparation,
  );
  if (definition.length >= 3 && onDecodedSuccess !== undefined && !Predicate.isFunction(onDecodedSuccess)) {
    return failActionDefinition('Action decoded-success hook must be a function');
  }
  if (definition.length === 4 && onPostAttempt !== undefined && !Predicate.isFunction(onPostAttempt)) {
    return failActionDefinition('Action post-attempt hook must be a function');
  }
  return ActionPrivateStorage.createRegistration({
    commandReader: makeRegisteredActionCommandReader(frozenDescriptor),
    publicFields: { [actionRegistration]: true as const, descriptor: frozenDescriptor },
    value: [
      handler,
      serviceFactory,
      onDecodedSuccess,
      onPostAttempt,
      prepareServices,
      preparationPolicies === undefined ? undefined : Object.freeze([...preparationPolicies]),
    ] as const,
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

/** Internal Core runtime seam; never part of the public Action descriptor. */
export const getActionDecodedSuccessHook = <
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
) => ActionPrivateStorage.getValue(registration)[2];

export const getActionPostAttemptHook = <
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
) => ActionPrivateStorage.getValue(registration)[3];

/**
 * Internal runtime lookup of the owner's staged service preparation, when the Action declares one.
 * Prepared facts live in the runAction fiber, never on the registration.
 */
export const getActionServicePreflight = <
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
):
  | ActionServicePreflight<PayloadSchema['Type'], Services, DomainErrorSchema['Type'], HandlerRequirements>
  | undefined => ActionPrivateStorage.getValue(registration)[4];

/** Internal Core lookup; owners cannot submit or copy an admitted Policy proof. */
export const getActionPreparationPolicies = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
  Services,
  Requirements,
>(
  registration: ActionRegistration<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Owner,
    Services,
    Requirements
  >,
): readonly ActionPolicy<PayloadSchema['Type'], string>[] => ActionPrivateStorage.getValue(registration)[5] ?? [];

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

export const getActionOwnerPermissionTargetResolver = <
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
): ActionOwnerPermissionTargetResolver<PayloadSchema['Type']> | undefined =>
  registration.descriptor.ownerPermissions === undefined
    ? undefined
    : (payload, scope) => {
        const declaration = registration.descriptor.ownerPermissions;
        if (declaration === undefined) {
          return [];
        }
        const targets = ActionPrivateStorage.getValue(declaration)(payload, scope);
        if (!EffectArray.isArray(targets) || targets.some((target) => target.contract !== declaration.contract)) {
          return failActionDefinition('Owner permission target belongs to another declaration');
        }
        return targets;
      };

/** The record target resolver of a record-scoped Action, or undefined for a scope-wide one (O9, Q2). */
export const getActionAccessTargetResolver = <
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
): ActionAccessTargetResolver<PayloadSchema['Type']> | undefined => registration.descriptor.accessTarget;

/** The owner-local facts resolver of an Action handed to the owner overlay, when declared (O70). */
export const getActionOwnerFactsResolver = <
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
): ActionOwnerFactsResolver<PayloadSchema['Type']> | undefined => registration.descriptor.accessOwnerFacts;

/** The server-derived money value resolver of an amount ceiling, when one is declared (O18). */
export const getActionAccessAmountResolver = <
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
): ActionAccessAmountResolver<PayloadSchema['Type']> | undefined => registration.descriptor.accessAmount;

/** The "this payload only reduces authority" resolver of an Action, when one is declared (O35, O71). */
export const getActionReducesAuthorityResolver = <
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
): ActionReducesAuthorityResolver<PayloadSchema['Type']> | undefined => registration.descriptor.accessReducesAuthority;

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

export const decodeActionPostAttemptResult = <ResultSchema extends Schema.ConstraintDecoder<unknown>>(
  schema: ResultSchema,
  value: ActionPostAttemptResult<ResultSchema['Type']>,
) => {
  const contract = actionPostAttemptResultSchema(
    Schema.make<Schema.ConstraintDecoder<ResultSchema['Type']>>(schema.ast),
  );
  return Schema.encodeUnknownEffect(Schema.make<Schema.ConstraintEncoder<unknown>>(contract.ast))(value).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(contract)),
  );
};
