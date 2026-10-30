/* oxlint-disable anti-slop/no-unknown-parameters -- Opaque declarations validate and freeze finite keys at their authoring boundary; expires: 2027-03-31. */
import { Effect, Predicate, Schema } from 'effect';

import type { ActionPolicy } from '../actions/policy.ts';
import { isActionPolicy } from '../actions/policy.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { ModuleEntrypointDescriptor, ModuleEntrypointRole } from '../modules/module-entrypoint.ts';
import type { OperationalScope } from '../operations/context.ts';
import { LEGAL_ENTITY_SCOPES } from '../operations/legal-entity-scope.ts';
import type { LegalEntityScope } from '../operations/legal-entity-scope.ts';
import type { OperationContextUnavailable } from '../operations/errors.ts';
import type {
  AssortmentPermissionAccessTarget,
  BusinessPermissionAccessTarget,
  ResourceAccessTarget,
} from '../permissions/context-access.ts';
import type { LegalEntityPermissionKey, TenantPermissionKey } from '../permissions/context-permissions.ts';
import type {
  ReadFinishContext,
  ReadHandlerResult,
  ReadLoadContext,
  ReadOwnerTransaction,
  ReadPrepareContext,
} from './context.ts';

const registrationMarker: unique symbol = Symbol('@app/core-runtime/reads/registration');
const resourcePermissionDeclarationMarker: unique symbol = Symbol('@app/core-runtime/reads/resource-permission');
const conditionalPermissionDeclarationMarker: unique symbol = Symbol('@app/core-runtime/reads/conditional-permission');

class ReadPrivateStorage<Value> {
  declare readonly [registrationMarker]?: true;
  declare readonly [resourcePermissionDeclarationMarker]?: true;
  declare readonly [conditionalPermissionDeclarationMarker]?: true;
  declare readonly branchTags?: readonly string[];
  declare readonly descriptor?: unknown;
  declare readonly kind?: 'conditional' | 'resource';
  declare readonly permissionKey?: string;
  readonly #value: Value;

  constructor(value: Value) {
    this.#value = value;
  }

  static create<Value, PublicFields extends object>(
    value: Value,
    publicFields: PublicFields,
  ): ReadPrivateStorage<Value> & Readonly<PublicFields> {
    const storage = Object.assign(new ReadPrivateStorage(value), publicFields);
    Object.freeze(storage);
    return storage;
  }

  static getValue<Value>(storage: ReadPrivateStorage<Value>): Value {
    return storage.#value;
  }
}

export const READ_ACCESS_KINDS = ['detail', 'download', 'export', 'list', 'report', 'search'] as const;
export type ReadAccessKind = (typeof READ_ACCESS_KINDS)[number];
export const READ_EVIDENCE_CAPTURE_MODES = ['hash_only', 'metadata_only'] as const;
export type ReadEvidenceCaptureMode = (typeof READ_EVIDENCE_CAPTURE_MODES)[number];
export const READ_PERMISSION_TARGETS = [
  'assortment_permission',
  'business_permission',
  'conditional',
  'legal_entity',
  'module',
  'resource',
  'tenant',
] as const;
export type ReadPermissionTarget = (typeof READ_PERMISSION_TARGETS)[number];
export type ReadPermissionDenialStatus = 409 | 422;
export interface ReadPolicyDescriptor {
  readonly denialStatus: ReadPermissionDenialStatus;
  readonly policyKey: string;
}
export type ReadAlternativeTenantPermission = Exclude<TenantPermissionKey, 'access' | 'impersonate'>;
export type AtomicResolvedReadPermissionTarget =
  | Readonly<{
      readonly assortmentPermission: AssortmentPermissionAccessTarget;
      readonly kind: 'assortment_permission';
    }>
  | Readonly<{
      businessPermission: BusinessPermissionAccessTarget;
      kind: 'business_permission';
      trustedStorefrontId?: string;
    }>
  | Readonly<{
      readonly kind: 'legal_entity';
      /** Explicit authorized target; omitted keeps the selected-context behavior. */
      readonly legalEntityId?: string;
      readonly permission?: LegalEntityPermissionKey;
    }>
  | Readonly<{ readonly kind: 'module'; readonly moduleId: string }>
  | Readonly<{
      readonly kind: 'resource';
      readonly resource: ResourceAccessTarget;
    }>
  | Readonly<{
      readonly kind: 'tenant';
      readonly permission: TenantPermissionKey;
    }>;
export type AlternativeResolvedReadPermissionTarget =
  | Exclude<
      AtomicResolvedReadPermissionTarget,
      | Readonly<{ readonly kind: 'business_permission' }>
      | Readonly<{
          readonly kind: 'tenant';
          readonly permission: TenantPermissionKey;
        }>
    >
  | Readonly<{
      readonly kind: 'tenant';
      readonly permission: ReadAlternativeTenantPermission;
    }>;
export type ResolvedReadPermissionTarget =
  | AtomicResolvedReadPermissionTarget
  | Readonly<{
      readonly kind: 'any_of';
      /** The first target is canonical for Policy input and persisted evidence. */
      readonly targets: readonly [
        AlternativeResolvedReadPermissionTarget,
        AlternativeResolvedReadPermissionTarget,
        ...AlternativeResolvedReadPermissionTarget[],
      ];
    }>;
export type ReadPermissionTargetResolver<Input> = (
  input: Input,
  scope: OperationalScope,
) => ResolvedReadPermissionTarget;
export type ReadResultPermissionTargetResolver<Result> = (
  result: Result,
  scope: OperationalScope,
) => readonly ResourceAccessTarget[];
export interface ReadResourcePermissionTarget {
  readonly permission: 'read';
  readonly resource: ResourceAccessTarget;
}
export type ReadResourcePermissionTargetResolver<Input> = (
  input: Input,
  scope: OperationalScope,
) => ReadResourcePermissionTarget;
export type ReadResourcePermissionDeclaration<Input> = ReadPrivateStorage<
  ReadResourcePermissionTargetResolver<Input>
> & {
  readonly kind: 'resource';
  readonly [resourcePermissionDeclarationMarker]: true;
};

export const READ_CONDITIONAL_PERMISSION_REQUIREMENTS = [
  'business_permission',
  'legal_entity',
  'module',
  'resource',
  'resource_read',
  'tenant',
] as const;
export type ReadConditionalPermissionRequirement = (typeof READ_CONDITIONAL_PERMISSION_REQUIREMENTS)[number];
export type ResolvedReadConditionalPermissionRequirement =
  | AtomicResolvedReadPermissionTarget
  | Readonly<{
      readonly kind: 'resource_read';
      readonly permission: 'read';
      readonly resource: ResourceAccessTarget;
    }>;

export interface ReadConditionalPermissionBranch<
  Input,
  Selected extends Readonly<{ readonly kind: string }>,
  Kind extends Selected['kind'],
> {
  readonly requiredKinds: readonly [ReadConditionalPermissionRequirement, ...ReadConditionalPermissionRequirement[]];
  readonly resolve: (
    input: Input,
    selected: Extract<Selected, { readonly kind: Kind }>,
    scope: OperationalScope,
  ) => readonly ResolvedReadConditionalPermissionRequirement[];
}

export type ReadConditionalPermissionBranches<Input, Selected extends Readonly<{ readonly kind: string }>> = {
  readonly [Kind in Selected['kind']]: ReadConditionalPermissionBranch<Input, Selected, Kind>;
};

interface ReadConditionalPermissionRuntimeBranch<Input, Selected> {
  readonly requiredKinds: readonly [ReadConditionalPermissionRequirement, ...ReadConditionalPermissionRequirement[]];
  readonly resolve: (
    input: Input,
    selected: Selected,
    scope: OperationalScope,
  ) => readonly ResolvedReadConditionalPermissionRequirement[];
}

interface ReadConditionalPermissionPrivateValue<Input> {
  readonly resolve: (
    input: Input,
    scope: OperationalScope,
  ) => {
    readonly kind: string;
    readonly requiredKinds: readonly [ReadConditionalPermissionRequirement, ...ReadConditionalPermissionRequirement[]];
    readonly requirements: readonly ResolvedReadConditionalPermissionRequirement[];
  };
}

export type ReadConditionalPermissionDeclaration<Input> = ReadPrivateStorage<
  ReadConditionalPermissionPrivateValue<Input>
> & {
  readonly branchTags: readonly [string, string, ...string[]];
  readonly [conditionalPermissionDeclarationMarker]: true;
  readonly kind: 'conditional';
  readonly permissionKey: string;
};

const ReadDefinitionInvariantError = Schema.TaggedError<Error>()('ReadDefinitionInvariantError', {
  message: Schema.String,
});

const failReadDefinition = (message: string): never => {
  throw new ReadDefinitionInvariantError({ message });
};

const stableConditionalKey = (value: string): boolean =>
  value.length >= 3 && value.length <= 200 && /^[A-Za-z][A-Za-z0-9_.-]*$/u.test(value);

const hasValidConditionalBranchTags = (branchTags: readonly string[]): boolean =>
  branchTags.length >= 2 &&
  branchTags.length <= 8 &&
  branchTags.every((tag) => tag !== 'default' && stableConditionalKey(tag));

const hasValidConditionalBranch = (branch: {
  readonly requiredKinds: readonly ReadConditionalPermissionRequirement[];
  readonly resolve: unknown;
}): boolean =>
  Array.isArray(branch.requiredKinds) &&
  branch.requiredKinds.length > 0 &&
  branch.requiredKinds.length <= 3 &&
  branch.requiredKinds[0] !== 'resource_read' &&
  new Set(branch.requiredKinds).size === branch.requiredKinds.length &&
  branch.requiredKinds.every((kind) => READ_CONDITIONAL_PERMISSION_REQUIREMENTS.includes(kind)) &&
  Predicate.isFunction(branch.resolve);

const hasConditionalBranch = <Input, Selected extends Readonly<{ readonly kind: string }>>(
  branches: ReadConditionalPermissionBranches<Input, Selected>,
  key: string,
): key is Selected['kind'] =>
  Schema.is(Schema.String.check(Schema.makeFilter((value: string) => Object.hasOwn(branches, value))))(key);

const validateConditionalBranches = <Input, Selected extends Readonly<{ readonly kind: string }>>(
  branches: ReadConditionalPermissionBranches<Input, Selected>,
): readonly [string, string, ...string[]] => {
  const [firstTag, secondTag, ...remainingTags] = Object.keys(branches);
  if (firstTag === undefined || secondTag === undefined) {
    return failReadDefinition('Conditional Read permission branches must be finite and explicit');
  }
  const branchTags = [firstTag, secondTag, ...remainingTags] as const;
  if (!hasValidConditionalBranchTags(branchTags)) {
    return failReadDefinition('Conditional Read permission branches must be finite and explicit');
  }
  for (const branchTag in branches) {
    if (hasConditionalBranch(branches, branchTag) && !hasValidConditionalBranch(branches[branchTag])) {
      return failReadDefinition('Conditional Read permission branches must declare exact bounded requirements');
    }
  }
  return branchTags;
};

const hasSelectedBranchKind = <Selected extends Readonly<{ readonly kind: string }>, Kind extends Selected['kind']>(
  selected: Selected,
  kind: Kind,
): selected is Extract<Selected, { readonly kind: Kind }> =>
  Schema.is(Schema.Struct({ kind: Schema.Literal(kind) }))(selected);

/** Declares a finite tagged-input authorization plan without a default or fallback branch. */
export const defineReadConditionalPermission = <Input, Selected extends Readonly<{ readonly kind: string }>>(input: {
  readonly branches: ReadConditionalPermissionBranches<Input, Selected>;
  readonly permissionKey: string;
  readonly select: (input: Input) => Selected;
}): ReadConditionalPermissionDeclaration<Input> => {
  if (!stableConditionalKey(input.permissionKey) || !Predicate.isFunction(input.select)) {
    return failReadDefinition('Conditional Read permission declaration must be stable and typed');
  }
  const branchTags = validateConditionalBranches(input.branches);
  const branches = new Map<string, ReadConditionalPermissionRuntimeBranch<Input, Selected>>();
  for (const tag in input.branches) {
    if (!hasConditionalBranch(input.branches, tag)) {
      continue;
    }
    const branch = input.branches[tag];
    const fields = { ...branch };
    const [firstKind, ...remainingKinds] = branch.requiredKinds;
    const snapshot = Object.freeze({
      ...fields,
      requiredKinds: Object.freeze([firstKind, ...remainingKinds] as const),
    });
    branches.set(
      tag,
      Object.freeze({
        requiredKinds: snapshot.requiredKinds,
        resolve: (request: Input, selected: Selected, scope: OperationalScope) => {
          if (!hasSelectedBranchKind(selected, tag)) {
            return failReadDefinition('Unknown conditional Read permission branch');
          }
          return snapshot.resolve(request, selected, scope);
        },
      }),
    );
  }
  const { select } = input;
  const resolve = (request: Input, scope: OperationalScope) => {
    const selected = select(request);
    const branch = branches.get(selected.kind);
    if (branch === undefined || !branchTags.includes(selected.kind)) {
      return failReadDefinition('Unknown conditional Read permission branch');
    }
    return {
      kind: selected.kind,
      requiredKinds: branch.requiredKinds,
      requirements: branch.resolve(request, selected, scope),
    };
  };
  return ReadPrivateStorage.create(Object.freeze({ resolve }), {
    branchTags: Object.freeze(branchTags),
    [conditionalPermissionDeclarationMarker]: true as const,
    kind: 'conditional' as const,
    permissionKey: input.permissionKey,
  });
};

const isOwnerCompatiblePolicy = (policy: ActionPolicy<unknown, string>, owner: string): boolean =>
  policy.scope === 'global' || policy.owningModuleKey === owner;

export interface ReadDescriptor<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  DomainErrorSchema extends Schema.ConstraintDecoder<{
    readonly _tag: string;
  }> = typeof Schema.Never,
> {
  readonly accessKind: ReadAccessKind;
  /** Declares the only owner failures that may cross the Core Read runtime boundary. */
  readonly domainErrorSchema?: DomainErrorSchema;
  readonly entrypoint: ModuleEntrypointDescriptor<
    Exclude<ModuleEntrypointRole, 'action' | 'worker'>,
    'historical_read' | 'read',
    Owner
  >;
  readonly evidencePolicy: Readonly<{
    readonly captureMode: ReadEvidenceCaptureMode;
    readonly policyKey: string;
  }>;
  readonly inputSchema: InputSchema;
  readonly legalEntityScope: LegalEntityScope;
  readonly owningModuleKey: Owner;
  readonly permissionTarget: ReadPermissionTarget;
  readonly policies: readonly ReadPolicyDescriptor[];
  readonly readKey: string;
  /** Declares an additional exact Resource read permission checked before handler execution. */
  readonly resourcePermission?: ReadResourcePermissionDeclaration<InputSchema['Type']>;
  readonly resultSchema: ResultSchema;
  readonly schemaVersion: string;
}

export type ReadServiceFactory<Services, Requirements = never> = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  compositionRevision: string | undefined,
) => Effect.Effect<Services, OperationContextUnavailable, Requirements>;

/**
 * Owner work before the transaction opens: SpiceDB grants and other remote calls. It has no database access,
 * so a slow authorization round trip never holds a pooled connection.
 */
export type ReadPrepare<Input, Prepared, Failure = never, Requirements = never> = (
  input: Input,
  context: ReadPrepareContext,
) => Effect.Effect<Prepared, Failure, Requirements>;

/** Owner work inside the scoped transaction: database reads only. */
export type ReadLoad<Input, Services, Prepared, Loaded, Failure = never, Requirements = never> = (
  input: Input,
  context: ReadLoadContext<Services, Prepared>,
) => Effect.Effect<Loaded, Failure, Requirements>;

/**
 * Owner work after commit: decoding, row filtering through SpiceDB, remote owner calls, and shaping the result.
 * An evaluation that must read owner state between remote calls opens a short `context.transaction` per read.
 */
export type ReadFinish<Input, Prepared, Loaded, Result, Failure = never, Requirements = never> = (
  input: Input,
  context: ReadFinishContext<Prepared, Loaded>,
) => Effect.Effect<ReadHandlerResult<Result>, Failure, Requirements>;

/** A Read whose transaction step already produces the result. */
interface PreparedReadLoadPipeline<
  Input,
  Result,
  Services,
  Prepared,
  Failure,
  Requirements,
  PrepareError = never,
  PrepareRequirements = never,
> {
  readonly finish?: undefined;
  readonly load: ReadLoad<Input, Services, Prepared, ReadHandlerResult<Result>, Failure, Requirements>;
  readonly prepare: ReadPrepare<Input, Prepared, PrepareError, PrepareRequirements>;
}

interface UnpreparedReadLoadPipeline<Input, Result, Services, Failure, Requirements> {
  readonly finish?: undefined;
  readonly load: ReadLoad<Input, Services, undefined, ReadHandlerResult<Result>, Failure, Requirements>;
  readonly prepare?: undefined;
}

export type ReadLoadPipeline<
  Input,
  Result,
  Services,
  Prepared,
  Failure,
  Requirements,
  PrepareError = never,
  PrepareRequirements = never,
> =
  | PreparedReadLoadPipeline<
      Input,
      Result,
      Services,
      Prepared,
      Failure,
      Requirements,
      PrepareError,
      PrepareRequirements
    >
  | UnpreparedReadLoadPipeline<Input, Result, Services, Failure, Requirements>;

/** A Read that decodes and filters its loaded rows after the transaction commits. */
interface PreparedReadFinishPipeline<
  Input,
  Result,
  Services,
  Prepared,
  Loaded,
  Failure,
  Requirements,
  PrepareError = never,
  PrepareRequirements = never,
  FinishError = never,
  FinishRequirements = never,
> {
  readonly finish: ReadFinish<Input, Prepared, Loaded, Result, FinishError, FinishRequirements>;
  readonly load: ReadLoad<Input, Services, Prepared, Loaded, Failure, Requirements>;
  readonly prepare: ReadPrepare<Input, Prepared, PrepareError, PrepareRequirements>;
}

interface UnpreparedReadFinishPipeline<
  Input,
  Result,
  Services,
  Loaded,
  Failure,
  Requirements,
  FinishError,
  FinishRequirements,
> {
  readonly finish: ReadFinish<Input, undefined, Loaded, Result, FinishError, FinishRequirements>;
  readonly load: ReadLoad<Input, Services, undefined, Loaded, Failure, Requirements>;
  readonly prepare?: undefined;
}

export type ReadFinishPipeline<
  Input,
  Result,
  Services,
  Prepared,
  Loaded,
  Failure,
  Requirements,
  PrepareError = never,
  PrepareRequirements = never,
  FinishError = never,
  FinishRequirements = never,
> =
  | PreparedReadFinishPipeline<
      Input,
      Result,
      Services,
      Prepared,
      Loaded,
      Failure,
      Requirements,
      PrepareError,
      PrepareRequirements,
      FinishError,
      FinishRequirements
    >
  | UnpreparedReadFinishPipeline<
      Input,
      Result,
      Services,
      Loaded,
      Failure,
      Requirements,
      FinishError,
      FinishRequirements
    >;

/** What Core hands the owner pipeline: the prepare context plus the after-commit owner transaction. */
export interface ReadOwnerStepsContext extends ReadPrepareContext {
  readonly transaction: ReadOwnerTransaction;
}

/**
 * The owner pipeline as Core runs it, with the owner's intermediate types closed over: `prepare` runs before
 * the transaction and yields the transaction step; that yields the after-commit step.
 */
export type ReadOwnerStages<Input, Result, Services, Failure, Requirements> = (
  input: Input,
  context: ReadOwnerStepsContext,
) => Effect.Effect<
  (
    services: Services,
  ) => Effect.Effect<Effect.Effect<ReadHandlerResult<Result>, Failure, Requirements>, Failure, Requirements>,
  Failure,
  Requirements
>;

export interface ReadDescriptorValidationInput {
  readonly domainErrorSchema?: unknown;
  readonly entrypoint: ModuleEntrypointDescriptor;
  readonly legalEntityScope: string;
  readonly owningModuleKey: string;
  readonly permissionTarget?: string;
  readonly resourcePermission?: ReadResourcePermissionDeclaration<never>;
}

/**
 * Permission targets that can only be decided inside a legal-entity scope. `tenant` targets are decidable
 * without one, and an explicitly addressed `legal_entity` target carries its own identity.
 */
const LEGAL_ENTITY_SCOPED_PERMISSION_TARGETS: ReadonlySet<string> = new Set(['module', 'resource']);

const hasValidReadEntrypoint = (descriptor: ReadDescriptorValidationInput): boolean =>
  descriptor.entrypoint.moduleKey === descriptor.owningModuleKey &&
  descriptor.entrypoint.scope === (descriptor.owningModuleKey.startsWith('core.') ? 'system' : 'tenant') &&
  ['read', 'historical_read'].includes(descriptor.entrypoint.access) &&
  Object.isFrozen(descriptor.entrypoint);

const ReadResourcePermissionDeclarationSchema = Schema.instanceOf(ReadPrivateStorage).check(
  Schema.makeFilter((declaration) =>
    declaration[resourcePermissionDeclarationMarker] === true &&
    declaration.kind === 'resource' &&
    Object.isFrozen(declaration)
      ? undefined
      : 'Expected an immutable Read Resource permission declaration',
  ),
);

const ReadConditionalPermissionDeclarationSchema = Schema.instanceOf(ReadPrivateStorage).check(
  Schema.makeFilter((declaration) =>
    declaration[conditionalPermissionDeclarationMarker] === true &&
    declaration.kind === 'conditional' &&
    Array.isArray(declaration.branchTags) &&
    declaration.branchTags.length >= 2 &&
    declaration.permissionKey !== undefined &&
    Object.isFrozen(declaration)
      ? undefined
      : 'Expected an immutable conditional Read permission declaration',
  ),
);

const isReadConditionalPermissionDeclaration = (
  value: unknown,
): value is ReadConditionalPermissionDeclaration<unknown> =>
  Schema.is(ReadConditionalPermissionDeclarationSchema)(value);

/** Declares an exact Resource read permission resolved from decoded input and trusted scope. */
export const defineReadResourcePermission = <Input>(
  resolver: ReadResourcePermissionTargetResolver<Input>,
): ReadResourcePermissionDeclaration<Input> => {
  if (!Predicate.isFunction(resolver)) {
    return failReadDefinition('Read Resource permission resolver must be a function');
  }
  return ReadPrivateStorage.create(resolver, {
    kind: 'resource' as const,
    [resourcePermissionDeclarationMarker]: true as const,
  });
};

export const validateReadDescriptorInput = (descriptor: ReadDescriptorValidationInput): void => {
  if (!hasValidReadEntrypoint(descriptor)) {
    return failReadDefinition('Read entrypoint must be immutable, read-only, and owner-scoped');
  }
  if (!LEGAL_ENTITY_SCOPES.some((scope) => scope === descriptor.legalEntityScope)) {
    return failReadDefinition('Read legal-entity scope must be required, optional, or forbidden');
  }
  if (
    descriptor.legalEntityScope === 'forbidden' &&
    descriptor.entrypoint.scope === 'tenant' &&
    descriptor.permissionTarget !== undefined &&
    LEGAL_ENTITY_SCOPED_PERMISSION_TARGETS.has(descriptor.permissionTarget) &&
    // An allow-list, not a deny-list: the only tenant gate that decides independently of this target is a
    // context permission other than `module.access`. `module.access` reuses the primary decision for the read's
    // own module, so it restates the missing decision; authentication, `public` and `capability_issuance` do
    // not evaluate the target at all.
    !(
      descriptor.entrypoint.authorization.kind === 'context_permission' &&
      descriptor.entrypoint.authorization.permission !== 'module.access'
    )
  ) {
    return failReadDefinition(
      'Tenant Read with forbidden legal-entity scope needs a permission target that can be evaluated: it requires a context permission other than module.access, because a module.access gate reuses the target decision and authentication alone evaluates nothing',
    );
  }
  if (
    descriptor.resourcePermission !== undefined &&
    !Schema.is(ReadResourcePermissionDeclarationSchema)(descriptor.resourcePermission)
  ) {
    return failReadDefinition('Read Resource permission declaration and resolver must be valid');
  }
  if (descriptor.domainErrorSchema !== undefined && !Schema.isSchema(descriptor.domainErrorSchema)) {
    return failReadDefinition('Read domain error schema must be a valid Effect Schema');
  }
};

type ReadRegistrationPrivateValue<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Failure,
  Requirements = never,
> = Readonly<{
  readonly permissionTargetResolver:
    | ReadConditionalPermissionDeclaration<InputSchema['Type']>
    | ReadPermissionTargetResolver<InputSchema['Type']>;
  readonly policies: readonly ActionPolicy<InputSchema['Type'], Owner>[];
  readonly resultPermissionTargetResolver?: ReadResultPermissionTargetResolver<ResultSchema['Type']>;
  readonly serviceFactory: ReadServiceFactory<Services, Requirements>;
  readonly stages: ReadOwnerStages<InputSchema['Type'], ResultSchema['Type'], Services, Failure, Requirements>;
}>;

export type ReadRegistration<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Failure,
  Requirements = never,
  DomainErrorSchema extends Schema.ConstraintDecoder<{
    readonly _tag: string;
  }> = typeof Schema.Never,
> = ReadPrivateStorage<
  ReadRegistrationPrivateValue<InputSchema, ResultSchema, Owner, Services, Failure, Requirements>
> & {
  readonly _domainError?: DomainErrorSchema['Type'];
  readonly _error?: Failure;
  readonly _requirements?: Requirements;
  readonly _services?: Services;
  readonly descriptor: Readonly<ReadDescriptor<InputSchema, ResultSchema, Owner, DomainErrorSchema>>;
  readonly [registrationMarker]: true;
};

const hasClosedReadVocabulary = (descriptor: {
  readonly accessKind: string;
  readonly captureMode: string;
  readonly permissionTarget: string;
  readonly policyKey: string;
  readonly readKey: string;
  readonly schemaVersion: string;
}): boolean =>
  READ_ACCESS_KINDS.some((kind) => kind === descriptor.accessKind) &&
  READ_EVIDENCE_CAPTURE_MODES.some((mode) => mode === descriptor.captureMode) &&
  READ_PERMISSION_TARGETS.some((target) => target === descriptor.permissionTarget) &&
  descriptor.policyKey.length > 0 &&
  descriptor.readKey.length > 0 &&
  descriptor.schemaVersion.length > 0;

const hasValidReadPermissionResolvers = (
  conditional: boolean,
  permissionTargetResolver: unknown,
  conditionalResolver: ReadConditionalPermissionDeclaration<unknown> | undefined,
  entrypoint: ModuleEntrypointDescriptor,
  resourcePermission: unknown,
  resultPermissionTargetResolver: unknown,
): boolean => {
  if (!conditional) {
    return conditionalResolver === undefined && Predicate.isFunction(permissionTargetResolver);
  }
  if (conditionalResolver === undefined) {
    return false;
  }
  const { authorization } = entrypoint;
  return (
    authorization.kind === 'context_permission' &&
    conditionalResolver.permissionKey === authorization.permission &&
    resourcePermission === undefined &&
    resultPermissionTargetResolver === undefined
  );
};

const validateReadVocabulary = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  descriptor: ReadDescriptor<InputSchema, ResultSchema, Owner, DomainErrorSchema>,
  permissionTargetResolver:
    | ReadConditionalPermissionDeclaration<InputSchema['Type']>
    | ReadPermissionTargetResolver<InputSchema['Type']>,
  resultPermissionTargetResolver: ReadResultPermissionTargetResolver<ResultSchema['Type']> | undefined,
): void => {
  const conditional = descriptor.permissionTarget === 'conditional';
  const conditionalResolver = isReadConditionalPermissionDeclaration(permissionTargetResolver)
    ? permissionTargetResolver
    : undefined;
  if (
    !hasClosedReadVocabulary({
      accessKind: descriptor.accessKind,
      captureMode: descriptor.evidencePolicy.captureMode,
      permissionTarget: descriptor.permissionTarget,
      policyKey: descriptor.evidencePolicy.policyKey,
      readKey: descriptor.readKey,
      schemaVersion: descriptor.schemaVersion,
    }) ||
    (descriptor.accessKind === 'search' && !Predicate.isFunction(resultPermissionTargetResolver)) ||
    !hasValidReadPermissionResolvers(
      conditional,
      permissionTargetResolver,
      conditionalResolver,
      descriptor.entrypoint,
      descriptor.resourcePermission,
      resultPermissionTargetResolver,
    )
  ) {
    return failReadDefinition('Read metadata must use the closed governed-read vocabulary');
  }
};

type ReadDefinitionTail<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Requirements,
> = readonly [
  serviceFactory: ReadServiceFactory<Services, Requirements>,
  permissionTargetResolver:
    | ReadConditionalPermissionDeclaration<InputSchema['Type']>
    | ReadPermissionTargetResolver<InputSchema['Type']>,
  resultPermissionTargetResolver?: ReadResultPermissionTargetResolver<ResultSchema['Type']>,
  executablePolicies?: readonly ActionPolicy<InputSchema['Type'], NoInfer<Owner>>[],
];

/** The transaction step of a prepared pipeline: owner `load`, then whatever runs after commit. */
const transactionStep =
  <Input, Services, Prepared, Loaded, Failure, Requirements, Next>(step: {
    readonly context: ReadPrepareContext;
    readonly input: Input;
    readonly load: ReadLoad<Input, Services, Prepared, Loaded, Failure, Requirements>;
    readonly next: (loaded: Loaded) => Next;
    readonly prepared: Prepared;
  }) =>
  (services: Services) =>
    Effect.suspend(() => step.load(step.input, { ...step.context, prepared: step.prepared, services })).pipe(
      Effect.map(step.next),
    );

/** One channel (failures or requirements) of all three owner steps. */
type StepChannels<Load, Prepare, Finish> = Finish | Load | Prepare;

/** The step after commit: owner `finish` over what `prepare` established and what `load` read. */
const afterCommitStep =
  <Input, Prepared, Loaded, Result, Failure, Requirements>(step: {
    readonly context: ReadPrepareContext;
    readonly finish: ReadFinish<Input, Prepared, Loaded, Result, Failure, Requirements>;
    readonly input: Input;
    readonly prepared: Prepared;
    readonly transaction: ReadOwnerTransaction;
  }) =>
  (loaded: Loaded) =>
    Effect.suspend(() =>
      step.finish(step.input, { ...step.context, loaded, prepared: step.prepared, transaction: step.transaction }),
    );

/** Owner `prepare` and `load` see only the prepare context; the owner transaction belongs to `finish`. */
const prepareContextOf = ({ transaction: _transaction, ...context }: ReadOwnerStepsContext): ReadPrepareContext =>
  context;

const loadPipelineStages =
  <Input, Result, Services, Prepared, Failure, Requirements, PrepareError, PrepareRequirements>(
    pipeline: ReadLoadPipeline<
      Input,
      Result,
      Services,
      Prepared,
      Failure,
      Requirements,
      PrepareError,
      PrepareRequirements
    >,
  ): ReadOwnerStages<Input, Result, Services, Failure | PrepareError, Requirements | PrepareRequirements> =>
  (input, stepsContext) => {
    const context = prepareContextOf(stepsContext);
    if (pipeline.prepare === undefined) {
      const prepared = pipeline.prepare;
      return Effect.succeed(transactionStep({ context, input, load: pipeline.load, next: Effect.succeed, prepared }));
    }
    const { prepare } = pipeline;
    return Effect.suspend(() => prepare(input, context)).pipe(
      Effect.map((prepared) =>
        transactionStep({ context, input, load: pipeline.load, next: Effect.succeed, prepared }),
      ),
    );
  };

const finishPipelineStages =
  <
    Input,
    Result,
    Services,
    Prepared,
    Loaded,
    Failure,
    Requirements,
    PrepareError,
    PrepareRequirements,
    FinishError,
    FinishRequirements,
  >(
    pipeline: ReadFinishPipeline<
      Input,
      Result,
      Services,
      Prepared,
      Loaded,
      Failure,
      Requirements,
      PrepareError,
      PrepareRequirements,
      FinishError,
      FinishRequirements
    >,
  ): ReadOwnerStages<
    Input,
    Result,
    Services,
    StepChannels<Failure, PrepareError, FinishError>,
    StepChannels<Requirements, PrepareRequirements, FinishRequirements>
  > =>
  (input, stepsContext) => {
    const context = prepareContextOf(stepsContext);
    if (pipeline.prepare === undefined) {
      const prepared = pipeline.prepare;
      return Effect.succeed(
        transactionStep({
          context,
          input,
          load: pipeline.load,
          next: afterCommitStep({
            context,
            finish: pipeline.finish,
            input,
            prepared,
            transaction: stepsContext.transaction,
          }),
          prepared,
        }),
      );
    }
    const { prepare } = pipeline;
    return Effect.suspend(() => prepare(input, context)).pipe(
      Effect.map((prepared) =>
        transactionStep({
          context,
          input,
          load: pipeline.load,
          next: afterCommitStep({
            context,
            finish: pipeline.finish,
            input,
            prepared,
            transaction: stepsContext.transaction,
          }),
          prepared,
        }),
      ),
    );
  };

type AnyReadPipeline<
  Input,
  Result,
  Services,
  Prepared,
  Loaded,
  Failure,
  Requirements,
  PrepareError,
  PrepareRequirements,
  FinishError,
  FinishRequirements,
> =
  | ReadFinishPipeline<
      Input,
      Result,
      Services,
      Prepared,
      Loaded,
      Failure,
      Requirements,
      PrepareError,
      PrepareRequirements,
      FinishError,
      FinishRequirements
    >
  | ReadLoadPipeline<Input, Result, Services, Prepared, Failure, Requirements, PrepareError, PrepareRequirements>;

/**
 * Defines a governed Read. Its owner pipeline runs in three steps around one short transaction:
 * `prepare` (SpiceDB and other remote calls, no database), `load` (scoped database reads only), and
 * `finish` (decoding and SpiceDB row filtering after commit). Without `finish`, `load` yields the result.
 * Write the steps in that order: TypeScript infers each step's context from the step before it.
 */
export function defineRead<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  const Owner extends string,
  Services,
  Failure,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{
    readonly _tag: string;
  }> = typeof Schema.Never,
  Prepared = undefined,
  PrepareError = never,
  PrepareRequirements = never,
>(
  descriptor: ReadDescriptor<InputSchema, ResultSchema, Owner, DomainErrorSchema>,
  ...definition: readonly [
    pipeline: PreparedReadLoadPipeline<
      InputSchema['Type'],
      ResultSchema['Type'],
      Services,
      Prepared,
      Failure,
      Requirements,
      PrepareError,
      PrepareRequirements
    >,
    ...ReadDefinitionTail<InputSchema, ResultSchema, Owner, Services, Requirements>,
  ]
): ReadRegistration<
  InputSchema,
  ResultSchema,
  Owner,
  Services,
  Failure | PrepareError,
  Requirements | PrepareRequirements,
  DomainErrorSchema
>;
export function defineRead<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  const Owner extends string,
  Services,
  Failure,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{
    readonly _tag: string;
  }> = typeof Schema.Never,
>(
  descriptor: ReadDescriptor<InputSchema, ResultSchema, Owner, DomainErrorSchema>,
  ...definition: readonly [
    pipeline: UnpreparedReadLoadPipeline<InputSchema['Type'], ResultSchema['Type'], Services, Failure, Requirements>,
    ...ReadDefinitionTail<InputSchema, ResultSchema, Owner, Services, Requirements>,
  ]
): ReadRegistration<InputSchema, ResultSchema, Owner, Services, Failure, Requirements, DomainErrorSchema>;
export function defineRead<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  const Owner extends string,
  Services,
  Failure,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{
    readonly _tag: string;
  }> = typeof Schema.Never,
  Prepared = undefined,
  Loaded = unknown,
  PrepareError = never,
  PrepareRequirements = never,
  FinishError = never,
  FinishRequirements = never,
>(
  descriptor: ReadDescriptor<InputSchema, ResultSchema, Owner, DomainErrorSchema>,
  ...definition: readonly [
    pipeline: PreparedReadFinishPipeline<
      InputSchema['Type'],
      ResultSchema['Type'],
      Services,
      Prepared,
      Loaded,
      Failure,
      Requirements,
      PrepareError,
      PrepareRequirements,
      FinishError,
      FinishRequirements
    >,
    ...ReadDefinitionTail<InputSchema, ResultSchema, Owner, Services, Requirements>,
  ]
): ReadRegistration<
  InputSchema,
  ResultSchema,
  Owner,
  Services,
  Failure | PrepareError | FinishError,
  Requirements | PrepareRequirements | FinishRequirements,
  DomainErrorSchema
>;
export function defineRead<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  const Owner extends string,
  Services,
  Failure,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{
    readonly _tag: string;
  }> = typeof Schema.Never,
  Loaded = unknown,
  FinishError = never,
  FinishRequirements = never,
>(
  descriptor: ReadDescriptor<InputSchema, ResultSchema, Owner, DomainErrorSchema>,
  ...definition: readonly [
    pipeline: UnpreparedReadFinishPipeline<
      InputSchema['Type'],
      ResultSchema['Type'],
      Services,
      Loaded,
      Failure,
      Requirements,
      FinishError,
      FinishRequirements
    >,
    ...ReadDefinitionTail<InputSchema, ResultSchema, Owner, Services, Requirements>,
  ]
): ReadRegistration<
  InputSchema,
  ResultSchema,
  Owner,
  Services,
  Failure | FinishError,
  Requirements | FinishRequirements,
  DomainErrorSchema
>;
export function defineRead<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  const Owner extends string,
  Services,
  Failure,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{
    readonly _tag: string;
  }>,
  Prepared,
  Loaded,
  PrepareError,
  PrepareRequirements,
  FinishError,
  FinishRequirements,
>(
  descriptor: ReadDescriptor<InputSchema, ResultSchema, Owner, DomainErrorSchema>,
  ...definition: readonly [
    pipeline: AnyReadPipeline<
      InputSchema['Type'],
      ResultSchema['Type'],
      Services,
      Prepared,
      Loaded,
      Failure,
      Requirements,
      PrepareError,
      PrepareRequirements,
      FinishError,
      FinishRequirements
    >,
    ...ReadDefinitionTail<InputSchema, ResultSchema, Owner, Services, Requirements>,
  ]
): ReadRegistration<
  InputSchema,
  ResultSchema,
  Owner,
  Services,
  Failure | PrepareError | FinishError,
  Requirements | PrepareRequirements | FinishRequirements,
  DomainErrorSchema
> {
  const [pipeline, serviceFactory, permissionTargetResolver, resultPermissionTargetResolver, executablePolicies = []] =
    definition;
  if (
    !Predicate.isFunction(pipeline.load) ||
    !(pipeline.prepare === undefined || Predicate.isFunction(pipeline.prepare))
  ) {
    return failReadDefinition('Read pipeline steps must be functions');
  }
  const stages = pipeline.finish === undefined ? loadPipelineStages(pipeline) : finishPipelineStages(pipeline);

  validateReadDescriptorInput(descriptor);
  validateReadVocabulary(descriptor, permissionTargetResolver, resultPermissionTargetResolver);
  if (
    !Array.isArray(descriptor.policies) ||
    descriptor.policies.some(
      ({ denialStatus, policyKey }) => ![409, 422].includes(denialStatus) || policyKey.length === 0,
    ) ||
    descriptor.policies.length !== executablePolicies.length ||
    executablePolicies.some(
      (policy, index) =>
        !isActionPolicy(policy) ||
        descriptor.policies[index]?.policyKey !== policy.policyKey ||
        !isOwnerCompatiblePolicy(policy, descriptor.owningModuleKey),
    )
  ) {
    return failReadDefinition('Read policies must be an explicit array of Policy references');
  }
  const frozenDescriptor = Object.freeze({
    ...descriptor,
    entrypoint: descriptor.entrypoint,
    evidencePolicy: Object.freeze({ ...descriptor.evidencePolicy }),
    policies: Object.freeze(descriptor.policies.map((reference) => Object.freeze({ ...reference }))),
  });
  const privateValue = {
    permissionTargetResolver,
    policies: Object.freeze([...executablePolicies]),
    serviceFactory,
    stages,
  };
  const publicFields = {
    descriptor: frozenDescriptor,
    [registrationMarker]: true as const,
  };
  if (resultPermissionTargetResolver === undefined) {
    return ReadPrivateStorage.create(Object.freeze(privateValue), publicFields);
  }
  return ReadPrivateStorage.create(Object.freeze({ ...privateValue, resultPermissionTargetResolver }), publicFields);
}

export const getReadPolicyImplementations = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Failure,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Failure, Requirements, DomainErrorSchema>,
): readonly ActionPolicy<InputSchema['Type'], Owner>[] => ReadPrivateStorage.getValue(registration).policies;

export const getReadResultPermissionTargetResolver = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Failure,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Failure, Requirements, DomainErrorSchema>,
): ReadResultPermissionTargetResolver<ResultSchema['Type']> | undefined =>
  ReadPrivateStorage.getValue(registration).resultPermissionTargetResolver;

export const getReadPermissionTargetResolver = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Failure,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Failure, Requirements, DomainErrorSchema>,
): ReadConditionalPermissionDeclaration<InputSchema['Type']> | ReadPermissionTargetResolver<InputSchema['Type']> =>
  ReadPrivateStorage.getValue(registration).permissionTargetResolver;

export const getReadConditionalPermissionPlan = <Input>(
  declaration: ReadConditionalPermissionDeclaration<Input>,
): ReadConditionalPermissionPrivateValue<Input> => ReadPrivateStorage.getValue(declaration);

export const getReadDomainErrorSchema = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Failure,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Failure, Requirements, DomainErrorSchema>,
): DomainErrorSchema | undefined => registration.descriptor.domainErrorSchema;

export const getReadResourcePermissionTargetResolver = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Failure,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Failure, Requirements, DomainErrorSchema>,
): ReadResourcePermissionTargetResolver<InputSchema['Type']> | undefined =>
  registration.descriptor.resourcePermission === undefined
    ? undefined
    : ReadPrivateStorage.getValue(registration.descriptor.resourcePermission);

export const getReadStages = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Failure,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Failure, Requirements, DomainErrorSchema>,
): ReadOwnerStages<InputSchema['Type'], ResultSchema['Type'], Services, Failure, Requirements> =>
  ReadPrivateStorage.getValue(registration).stages;

const noOwnerTransaction: ReadOwnerTransaction = () =>
  Effect.die('These owner steps run without Core; pass `transaction` to give finish its owner transaction');

/** Runs a Read's owner steps in order (prepare, load, finish) without Core's runtime: unit tests of owner code. */
export const runReadOwnerSteps = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Failure,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Failure, Requirements, DomainErrorSchema>,
  input: InputSchema['Type'],
  context: ReadPrepareContext & { readonly services: Services; readonly transaction?: ReadOwnerTransaction },
) =>
  getReadStages(registration)(input, {
    compositionRevision: context.compositionRevision,
    readKey: context.readKey,
    scope: context.scope,
    transaction: context.transaction ?? noOwnerTransaction,
  }).pipe(
    Effect.flatMap((load) => load(context.services)),
    Effect.flatten,
  );

export const getReadServiceFactory = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Failure,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Failure, Requirements, DomainErrorSchema>,
): ReadServiceFactory<Services, Requirements> => ReadPrivateStorage.getValue(registration).serviceFactory;
