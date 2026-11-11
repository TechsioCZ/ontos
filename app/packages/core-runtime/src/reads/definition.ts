import {
  isOwnerPermissionAccessTargetMetadataValid,
  isOwnerPermissionContract,
} from '../permissions/owner-permission-contract.ts';
import { ReadPermissionUnavailable } from './errors.ts';
/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, typescript/no-unsafe-type-assertion -- Opaque declarations validate and freeze finite keys before their one private representation cast; expires: 2027-03-31. */
import { Option, Predicate, Schema } from 'effect';
import type { Effect } from 'effect';

import { declaredAccessCarrier } from '../authorization/access-declaration.ts';
import { fieldReadGroupSchemaIssue } from '../authorization/field-group-paths.ts';
import type {
  AccessDeclaration,
  AccessDeclarationInput,
  AccessFieldGroup,
  AccessFieldGroupInput,
  AccessTarget,
  AccessActor,
  AccessActorInput,
  AccessWorkload,
  AccessWorkloadInput,
} from '../authorization/access-declaration.ts';
import type { ListAccessPredicate } from '../access/decision/list-access.ts';
import type { AccessDecisionService } from '../access/enforcement/contract.ts';
import type { OwnerAccessFacts } from '../access/enforcement/owner-overlay.ts';
import type { ActionPolicy } from '../actions/policy.ts';
import { isActionPolicy } from '../actions/policy.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { ModuleEntrypointDescriptor, ModuleEntrypointRole } from '../modules/module-entrypoint.ts';
import type { OperationalScope } from '../operations/context.ts';
import { LEGAL_ENTITY_SCOPES } from '../operations/legal-entity-scope.ts';
import type { LegalEntityScope } from '../operations/legal-entity-scope.ts';
import type { OperationContextUnavailable } from '../operations/errors.ts';
import type { ResourceAccessTarget } from '../permissions/context-access.ts';
import type { OwnerPermissionAccessTarget, OwnerPermissionContract } from '../permissions/owner-permission-contract.ts';
import type { LegalEntityPermissionKey, TenantPermissionKey } from '../permissions/context-permissions.ts';
import type { ReadHandlerContext, ReadHandlerResult } from './context.ts';

const registrationMarker: unique symbol = Symbol('@app/core-runtime/reads/registration');
const resourcePermissionDeclarationMarker: unique symbol = Symbol('@app/core-runtime/reads/resource-permission');
const ownerPermissionDeclarationMarker: unique symbol = Symbol('@app/core-runtime/reads/owner-permission');
const conditionalPermissionDeclarationMarker: unique symbol = Symbol('@app/core-runtime/reads/conditional-permission');

class ReadPrivateStorage<Value> {
  declare readonly [registrationMarker]?: true;
  declare readonly [resourcePermissionDeclarationMarker]?: true;
  declare readonly [conditionalPermissionDeclarationMarker]?: true;
  declare readonly [ownerPermissionDeclarationMarker]?: true;
  declare readonly branchTags?: readonly string[];
  declare readonly descriptor?: unknown;
  declare readonly kind?: 'conditional' | 'owner_permission' | 'resource';
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

  static ownsValue(storage: ReadPrivateStorage<unknown>): boolean {
    return #value in storage;
  }
}

export const READ_ACCESS_KINDS = ['detail', 'download', 'export', 'list', 'report', 'search'] as const;
export type ReadAccessKind = (typeof READ_ACCESS_KINDS)[number];
export const READ_EVIDENCE_CAPTURE_MODES = ['hash_only', 'metadata_only'] as const;
export type ReadEvidenceCaptureMode = (typeof READ_EVIDENCE_CAPTURE_MODES)[number];
export const READ_PERMISSION_TARGETS = [
  'owner_permission',
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
      readonly kind: 'owner_permission';
      readonly ownerPermission: OwnerPermissionAccessTarget;
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
      | Readonly<{ readonly kind: 'owner_permission' }>
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
/**
 * The one record a record-scoped detail, download or export read returns, derived from the decoded
 * input and the trusted scope (O9, O27). A row-scoped read resolves records inside the owner query
 * instead, so it declares no single target (O25).
 */
export type ReadAccessTargetResolver<Input> = (input: Input, scope: OperationalScope) => AccessTarget;
/**
 * The owner-local facts this read hands to the owner overlay, derived from the decoded input and the
 * trusted scope (O70). They name the records the owner's own business rule is about; they are never
 * authority and never reach the decision engine.
 */
export type ReadAccessOwnerFactsResolver<Input> = (input: Input, scope: OperationalScope) => OwnerAccessFacts;
export type ReadOwnerPermissionDeclaration<Input> = ReadPrivateStorage<
  (input: Input, scope: OperationalScope) => OwnerPermissionAccessTarget
> & {
  readonly contract: OwnerPermissionContract;
  readonly kind: 'owner_permission';
  readonly [ownerPermissionDeclarationMarker]: true;
};

const ReadDefinitionInvariantError = Schema.TaggedError<Error>()('ReadDefinitionInvariantError', {
  message: Schema.String,
});

const failReadDefinition = (message: string): never => {
  throw new ReadDefinitionInvariantError({ message });
};

export const defineReadOwnerPermission = <Input>(
  contract: OwnerPermissionContract,
  resolver: (input: Input, scope: OperationalScope) => OwnerPermissionAccessTarget,
): ReadOwnerPermissionDeclaration<Input> => {
  if (!Predicate.isFunction(resolver) || !isOwnerPermissionContract(contract)) {
    return failReadDefinition('Read owner permission resolver and contract must be valid');
  }
  return ReadPrivateStorage.create(resolver, {
    contract,
    kind: 'owner_permission' as const,
    [ownerPermissionDeclarationMarker]: true as const,
  });
};

const ReadOwnerPermissionDeclarationSchema = Schema.instanceOf(ReadPrivateStorage).check(
  Schema.makeFilter((declaration) =>
    ReadPrivateStorage.ownsValue(declaration) &&
    declaration[ownerPermissionDeclarationMarker] === true &&
    declaration.kind === 'owner_permission' &&
    Object.isFrozen(declaration)
      ? undefined
      : 'Expected an immutable Read owner permission declaration',
  ),
);

const isReadOwnerPermissionDeclaration = <Input>(
  value:
    | ReadOwnerPermissionDeclaration<Input>
    | ReadConditionalPermissionDeclaration<Input>
    | ReadPermissionTargetResolver<Input>,
): value is ReadOwnerPermissionDeclaration<Input> => Schema.is(ReadOwnerPermissionDeclarationSchema)(value);

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

const normalizeOwnerPermissionResolver = <Input>(
  declared: ReadPermissionTarget | undefined,
  owningModuleKey: string,
  resolver:
    | ReadOwnerPermissionDeclaration<Input>
    | ReadConditionalPermissionDeclaration<Input>
    | ReadPermissionTargetResolver<Input>
    | undefined,
): ReadConditionalPermissionDeclaration<Input> | ReadPermissionTargetResolver<Input> | undefined => {
  if (resolver === undefined) {
    // A v2 `protected` read declares no positional resolver; the vocabulary check decides whether it may.
    return declared === 'owner_permission'
      ? failReadDefinition('Owner permission Read requires its own opaque contract declaration')
      : undefined;
  }
  if (declared === 'conditional' && isReadConditionalPermissionDeclaration(resolver)) {
    const contract = ReadPrivateStorage.getValue(resolver).ownerContract;
    if (contract !== undefined && contract.owningModuleKey !== owningModuleKey) {
      return failReadDefinition('Conditional permission contract belongs to another runtime owner');
    }
  }
  if (declared !== 'owner_permission') {
    if (isReadOwnerPermissionDeclaration(resolver)) {
      return failReadDefinition('Owner permission declaration requires its exact Read target kind');
    }
    return resolver;
  }
  if (!isReadOwnerPermissionDeclaration(resolver) || resolver.contract.owningModuleKey !== owningModuleKey) {
    return failReadDefinition('Owner permission Read requires its own opaque contract declaration');
  }
  const declaration = resolver;
  return (input, scope) => {
    const target = ReadPrivateStorage.getValue(declaration)(input, scope);
    if (target.contract !== declaration.contract) {
      return failReadDefinition('Owner permission target belongs to another declaration');
    }
    if (
      isOwnerPermissionAccessTargetMetadataValid(target) &&
      target.scope.tenantId === scope.tenantId &&
      target.scope.kind === 'legal_entity' &&
      scope.legalEntityId === undefined
    ) {
      throw new ReadPermissionUnavailable({
        code: 'read_permission_unavailable',
        reason: 'The owner permission requires a selected Legal Entity',
      });
    }
    return { kind: 'owner_permission', ownerPermission: target };
  };
};

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

/**
 * The positional permission-target resolver a read declares: a conditional permission plan or a plain
 * resolver. A v2 `protected` read declares neither, because the access gate decides its record (O62).
 */
export type ReadPermissionTargetDeclaration<Input> =
  | ReadConditionalPermissionDeclaration<Input>
  | ReadPermissionTargetResolver<Input>;

export const READ_CONDITIONAL_PERMISSION_REQUIREMENTS = [
  'owner_permission',
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

interface ReadConditionalPermissionRuntimeBranch<Input> {
  readonly requiredKinds: readonly [ReadConditionalPermissionRequirement, ...ReadConditionalPermissionRequirement[]];
  readonly resolve: (
    input: Input,
    selected: Readonly<{ readonly kind: string }>,
    scope: OperationalScope,
  ) => readonly ResolvedReadConditionalPermissionRequirement[];
}

interface ReadConditionalPermissionPrivateValue<Input> {
  readonly branches: Readonly<Record<string, ReadConditionalPermissionRuntimeBranch<Input>>>;
  readonly ownerContract?: OwnerPermissionContract;
  readonly select: (input: Input) => Readonly<{ readonly kind: string }>;
}

export type ReadConditionalPermissionDeclaration<Input> = ReadPrivateStorage<
  ReadConditionalPermissionPrivateValue<Input>
> & {
  readonly branchTags: readonly [string, string, ...string[]];
  readonly [conditionalPermissionDeclarationMarker]: true;
  readonly kind: 'conditional';
  readonly ownerContract?: OwnerPermissionContract;
  readonly permissionKey: string;
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
  branch.requiredKinds.every(
    (kind, index) => kind === 'resource_read' || branch.requiredKinds.indexOf(kind) === index,
  ) &&
  branch.requiredKinds.every((kind) => READ_CONDITIONAL_PERMISSION_REQUIREMENTS.includes(kind)) &&
  Predicate.isFunction(branch.resolve);

const validateConditionalBranches = <Input, Selected extends Readonly<{ readonly kind: string }>>(
  branches: ReadConditionalPermissionBranches<Input, Selected>,
): readonly string[] => {
  const branchTags = Object.keys(branches);
  if (!hasValidConditionalBranchTags(branchTags)) {
    return failReadDefinition('Conditional Read permission branches must be finite and explicit');
  }
  for (const branchTag of branchTags) {
    const branch = branches[branchTag as Selected['kind']];
    if (!hasValidConditionalBranch(branch)) {
      return failReadDefinition('Conditional Read permission branches must declare exact bounded requirements');
    }
  }
  return branchTags;
};

/** Declares a finite tagged-input authorization plan without a default or fallback branch. */
export const defineReadConditionalPermission = <Input, Selected extends Readonly<{ readonly kind: string }>>(input: {
  readonly branches: ReadConditionalPermissionBranches<Input, Selected>;
  readonly ownerContract?: OwnerPermissionContract;
  readonly permissionKey: string;
  readonly select: (input: Input) => Selected;
}): ReadConditionalPermissionDeclaration<Input> => {
  if (!stableConditionalKey(input.permissionKey) || !Predicate.isFunction(input.select)) {
    return failReadDefinition('Conditional Read permission declaration must be stable and typed');
  }
  const branchTags = validateConditionalBranches(input.branches);
  const usesOwnerPermission = branchTags.some((tag) =>
    input.branches[tag as Selected['kind']].requiredKinds.includes('owner_permission'),
  );
  if (usesOwnerPermission && (input.ownerContract === undefined || !isOwnerPermissionContract(input.ownerContract))) {
    return failReadDefinition('Conditional owner permissions require their genuine owner contract');
  }
  // SAFETY: branch keys were enumerated and validated from the exact mapped branch input above;
  // Object.fromEntries cannot retain that mapped-key relationship in TypeScript's standard types.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exact validated mapped copy; expires: 2027-03-31.
  const branches = Object.freeze(
    Object.fromEntries(
      branchTags.map((tag) => {
        const branch = input.branches[tag as Selected['kind']];
        return [
          tag,
          Object.freeze({
            ...branch,
            requiredKinds: Object.freeze([...branch.requiredKinds]),
          }),
        ];
      }),
    ),
  ) as unknown as ReadConditionalPermissionPrivateValue<Input>['branches'];
  const privatePlan =
    input.ownerContract === undefined
      ? { branches, select: input.select }
      : { branches, ownerContract: input.ownerContract, select: input.select };
  return ReadPrivateStorage.create(Object.freeze(privatePlan), {
    branchTags: Object.freeze([...branchTags]) as readonly [string, string, ...string[]],
    [conditionalPermissionDeclarationMarker]: true as const,
    kind: 'conditional' as const,
    permissionKey: input.permissionKey,
  });
};

const isOwnerCompatiblePolicy = (policy: ActionPolicy<unknown, string>, owner: string): boolean =>
  policy.scope === 'global' || policy.owningModuleKey === owner;

/** The access carriers of a read as a module writes them; `defineRead` decodes them (O5, O58, O59, O72). */
export interface AuthoredReadAccessCarriers {
  /** Module-to-module calls this read receives; the calling module is the actor (D5). */
  readonly accessActor?: AccessActorInput;
  /** Optional report-only catalog metadata; governed reads still use their existing permission target. */
  readonly accessDeclaration?: AccessDeclarationInput;
  /** Sensitive result field groups this read projects, each a `field_read` declaration (O58). */
  readonly accessFieldGroups?: readonly AccessFieldGroupInput[];
  /**
   * Marks a read only trusted machine workloads may run (O29, O59, O72). Beside `accessDeclaration`
   * it means both paths exist and stay disjoint: the workload path never admits humans and the
   * declaration path never admits workloads (O67-Q4).
   */
  readonly accessWorkload?: AccessWorkloadInput;
}

/** The decoded, frozen carriers a registration exposes; no request decodes them again (O5, O58, O59). */
export interface DeclaredReadAccessCarriers {
  readonly accessActor?: AccessActor;
  readonly accessDeclaration?: AccessDeclaration;
  readonly accessFieldGroups?: readonly AccessFieldGroup[];
  readonly accessWorkload?: AccessWorkload;
}

export interface ReadDescriptor<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  DomainErrorSchema extends Schema.ConstraintDecoder<{
    readonly _tag: string;
  }> = typeof Schema.Never,
  Carriers extends AuthoredReadAccessCarriers | DeclaredReadAccessCarriers = AuthoredReadAccessCarriers,
> {
  /** Module-to-module calls this read receives; the calling module is the actor (D5). */
  readonly accessActor?: Carriers['accessActor'];
  /** Optional report-only catalog metadata; governed reads still use their existing permission target. */
  readonly accessDeclaration?: Carriers['accessDeclaration'];
  /** Sensitive result field groups this read projects, each a `field_read` declaration (O58). */
  readonly accessFieldGroups?: Carriers['accessFieldGroups'];
  readonly accessKind: ReadAccessKind;
  /**
   * The owner-local facts this read hands to the owner overlay, resolved before the decision is used
   * (O70). A read that declares none keeps the overlay's fact-free answer.
   */
  readonly accessOwnerFacts?: ReadAccessOwnerFactsResolver<InputSchema['Type']>;
  /**
   * The one record this read returns when its declaration is record-scoped (O9, O27); a scope-wide
   * read and every row-scoped read resolve no single target (O25).
   */
  readonly accessTarget?: ReadAccessTargetResolver<InputSchema['Type']>;
  /**
   * Marks a read only trusted machine workloads may run (O29, O59, O72). Beside `accessDeclaration`
   * it means both paths exist and stay disjoint: the workload path never admits humans and the
   * declaration path never admits workloads (O67-Q4).
   */
  readonly accessWorkload?: Carriers['accessWorkload'];
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
  /**
   * The legacy permission target this read was decided with. A read that decides itself through a v2
   * `protected` declaration declares none: its record comes from `accessTarget` and the access gate
   * (O62, CUTOVER-PLAN §4.3). The field disappears with the legacy kinds (C03b).
   */
  readonly permissionTarget?: ReadPermissionTarget;
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
  /**
   * The owner's row filter for a row-scoped read (D16, O25): the service applies it to its own
   * query. The runtime always supplies it for a selector-bearing read, and an owner list query must
   * apply it. It is absent for a detail read, a scope-wide read and a read the gate does not decide,
   * and an owner factory that both an Action and a read build simply declares no fourth parameter.
   */
  listAccess?: ListAccessPredicate,
  /** The transaction-bound access gate is supplied only to registered Shell system reads. */
  shellAccess?: Pick<AccessDecisionService, 'decide' | 'decideMany' | 'list'>,
) => Effect.Effect<Services, OperationContextUnavailable, Requirements>;

export type ReadHandler<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Services,
  Error,
  Requirements = never,
> = (
  input: InputSchema['Type'],
  context: ReadHandlerContext<Services>,
) => Effect.Effect<ReadHandlerResult<ResultSchema['Type']>, Error, Requirements>;

export interface ReadDescriptorValidationInput {
  readonly accessActor?: AccessActorInput;
  readonly accessDeclaration?: AccessDeclarationInput;
  readonly accessFieldGroups?: readonly AccessFieldGroupInput[];
  readonly accessKind?: string;
  readonly accessOwnerFacts?: unknown;
  readonly accessTarget?: unknown;
  readonly accessWorkload?: AccessWorkloadInput;
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

/** Reads that resolve one record per row, so a single declared target would govern the wrong rows. */
const ROW_SCOPED_READ_ACCESS_KINDS: ReadonlySet<string> = new Set(['list', 'report', 'search']);

/**
 * A target is bound to the declaration it serves: only a record-scoped capability has one record,
 * and a list, search or report read resolves its rows inside the owner query (O25).
 */
const validateReadAccessBinding = (
  descriptor: ReadDescriptorValidationInput,
  declaration: AccessDeclaration | undefined,
): void => {
  const { accessTarget } = descriptor;
  if (accessTarget === undefined) {
    return;
  }
  if (!Predicate.isFunction(accessTarget)) {
    return failReadDefinition('Read access target must be a resolver function');
  }
  if (declaration === undefined) {
    return failReadDefinition('Read accessTarget requires the descriptor to declare its own accessDeclaration');
  }
  if (declaration.selectors.length === 0) {
    return failReadDefinition(
      'Read accessTarget requires a record-scoped declaration: a scope-wide read returns no single record (Q2)',
    );
  }
  // See the action rule: a single record is never checked against a holder-relative selector (R5a-7).
  if (declaration.selectors.some((selector) => selector !== 'all')) {
    return failReadDefinition(
      'Read accessTarget decides one record, which no holder-relative selector (assigned, entrusted, team) can be checked against yet (R5a-7)',
    );
  }
  if (descriptor.accessKind !== undefined && ROW_SCOPED_READ_ACCESS_KINDS.has(descriptor.accessKind)) {
    return failReadDefinition(
      'A list, search or report read resolves one record per row inside the owner query and declares no single accessTarget (O25)',
    );
  }
};

/**
 * Owner facts serve the capability a descriptor declares (O70): a resolver without a declaration
 * would hand the overlay records for a surface no gate decided, so it is an authoring mistake.
 */
const validateReadOwnerFactsBinding = (
  descriptor: ReadDescriptorValidationInput,
  declaration: AccessDeclaration | undefined,
): void => {
  const { accessOwnerFacts } = descriptor;
  if (accessOwnerFacts === undefined) {
    return;
  }
  if (!Predicate.isFunction(accessOwnerFacts)) {
    return failReadDefinition('Read access owner facts must be a resolver function');
  }
  if (declaration === undefined) {
    return failReadDefinition('Read accessOwnerFacts requires the descriptor to declare its own accessDeclaration');
  }
};

/**
 * Field access rides the read it belongs to (D14, O58, O74). On a record-scoped read the groups are
 * decided with the one record the read returns, so the read must name that record. A scope-wide read
 * names no record: its groups ride the read's own capability decided scope-wide in the same scope,
 * and a row-scoped read applies the same shape with its row filter bounding the rows (O25, O58).
 */
const validateReadFieldGroupBinding = (
  descriptor: ReadDescriptorValidationInput,
  declaration: AccessDeclaration | undefined,
): void => {
  const groups = descriptor.accessFieldGroups ?? [];
  if (
    groups.length === 0 ||
    (descriptor.accessKind !== undefined && ROW_SCOPED_READ_ACCESS_KINDS.has(descriptor.accessKind)) ||
    // A scope-wide declaration is its own parent read (O74); only a record-scoped one names a record.
    (declaration !== undefined && declaration.selectors.length === 0)
  ) {
    return;
  }
  if (descriptor.accessTarget === undefined) {
    return failReadDefinition(
      'A detail, download or export read with accessFieldGroups must declare its accessTarget when its declaration is record-scoped: field access is decided with the record it belongs to (D14, O74)',
    );
  }
};

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
  // Decodes the declaration and its field groups against the entrypoint (O5, O58).
  const carriers = declaredAccessCarrier(descriptor);
  validateReadAccessBinding(descriptor, carriers.accessDeclaration);
  validateReadOwnerFactsBinding(descriptor, carriers.accessDeclaration);
  validateReadFieldGroupBinding(descriptor, carriers.accessDeclaration);
  if (!LEGAL_ENTITY_SCOPES.some((scope) => scope === descriptor.legalEntityScope)) {
    return failReadDefinition('Read legal-entity scope must be required, optional, or forbidden');
  }
  if (
    descriptor.legalEntityScope === 'forbidden' &&
    descriptor.entrypoint.scope === 'tenant' &&
    descriptor.permissionTarget !== undefined &&
    LEGAL_ENTITY_SCOPED_PERMISSION_TARGETS.has(descriptor.permissionTarget) &&
    // A v2 declaration decides the record target itself, so the legacy requirement below does not
    // apply to a `protected` read.
    descriptor.entrypoint.authorization.kind !== 'protected' &&
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
  Error,
  Requirements = never,
> = Readonly<{
  readonly handler: ReadHandler<InputSchema, ResultSchema, Services, Error, Requirements>;
  /** Absent for a v2 `protected` read, which resolves its record through `accessTarget` (O62). */
  readonly permissionTargetResolver: ReadPermissionTargetDeclaration<InputSchema['Type']> | undefined;
  readonly policies: readonly ActionPolicy<InputSchema['Type'], Owner>[];
  readonly resultPermissionTargetResolver?: ReadResultPermissionTargetResolver<ResultSchema['Type']>;
  readonly serviceFactory: ReadServiceFactory<Services, Requirements>;
}>;

export type ReadRegistration<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Error,
  Requirements = never,
  DomainErrorSchema extends Schema.ConstraintDecoder<{
    readonly _tag: string;
  }> = typeof Schema.Never,
> = ReadPrivateStorage<
  ReadRegistrationPrivateValue<InputSchema, ResultSchema, Owner, Services, Error, Requirements>
> & {
  readonly _domainError?: DomainErrorSchema['Type'];
  readonly _error?: Error;
  readonly _requirements?: Requirements;
  readonly _services?: Services;
  readonly descriptor: Readonly<DeclaredReadDescriptor<InputSchema, ResultSchema, Owner, DomainErrorSchema>>;
  readonly [registrationMarker]: true;
};

/**
 * The descriptor a registration exposes: the authored carriers replaced by the decoded, frozen ones
 * (O5, O58). A runtime decides with exactly what definition time validated, so no request decodes the
 * declaration, its field groups or their rules again.
 */
export type DeclaredReadDescriptor<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  DomainErrorSchema extends Schema.ConstraintDecoder<{
    readonly _tag: string;
  }> = typeof Schema.Never,
> = Readonly<
  Omit<ReadDescriptor<InputSchema, ResultSchema, Owner, DomainErrorSchema>, 'accessDeclaration' | 'accessFieldGroups'> &
    DeclaredReadAccessCarriers
>;

/** Existential descriptor-only view; no handler, service factory, or private storage crosses this seam. */
export interface AnyReadRegistration {
  readonly descriptor: Readonly<
    Pick<
      ReadDescriptor<Schema.ConstraintDecoder<unknown>, Schema.ConstraintDecoder<unknown>, string>,
      'entrypoint' | 'owningModuleKey' | 'readKey' | 'schemaVersion'
    >
  >;
  readonly [registrationMarker]: true;
}

const AnyReadRegistrationSchema = Schema.instanceOf(ReadPrivateStorage).check(
  Schema.makeFilter((registration) =>
    ReadPrivateStorage.ownsValue(registration) &&
    registration[registrationMarker] === true &&
    registration.descriptor !== undefined &&
    Object.isFrozen(registration)
      ? undefined
      : 'Expected an immutable Read registration',
  ),
);

/** Runtime guard for the opaque private-storage-backed value created by defineRead. */
export const isReadRegistration = <Value>(value: Value): value is Value & AnyReadRegistration =>
  Schema.is(AnyReadRegistrationSchema)(value);

/**
 * `targetOptional` is the transitional v2 shape (O62, O68): a `protected` read decides its own record
 * through the access gate, so it declares no legacy permission target. It may still declare one until
 * the module lanes drop the field, and then the closed target vocabulary still applies to it.
 */
const hasClosedReadVocabulary = (
  descriptor: {
    readonly accessKind: string;
    readonly captureMode: string;
    readonly permissionTarget: string | undefined;
    readonly policyKey: string;
    readonly readKey: string;
    readonly schemaVersion: string;
  },
  targetOptional: boolean,
): boolean =>
  READ_ACCESS_KINDS.some((kind) => kind === descriptor.accessKind) &&
  READ_EVIDENCE_CAPTURE_MODES.some((mode) => mode === descriptor.captureMode) &&
  (descriptor.permissionTarget === undefined
    ? targetOptional
    : READ_PERMISSION_TARGETS.some((target) => target === descriptor.permissionTarget)) &&
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
  if (entrypoint.authorization.kind === 'protected' && permissionTargetResolver === undefined) {
    // A v2 protected read resolves its record through `accessTarget` and the access gate, so it declares
    // no positional resolver. A conditional target is a legacy shape and still needs its resolver.
    return !conditional;
  }
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
  permissionTargetResolver: ReadPermissionTargetDeclaration<InputSchema['Type']> | undefined,
  resultPermissionTargetResolver: ReadResultPermissionTargetResolver<ResultSchema['Type']> | undefined,
): void => {
  const v2Protected = descriptor.entrypoint.authorization.kind === 'protected';
  const conditional = descriptor.permissionTarget === 'conditional';
  const conditionalResolver = isReadConditionalPermissionDeclaration(permissionTargetResolver)
    ? permissionTargetResolver
    : undefined;
  if (
    !hasClosedReadVocabulary(
      {
        accessKind: descriptor.accessKind,
        captureMode: descriptor.evidencePolicy.captureMode,
        permissionTarget: descriptor.permissionTarget,
        policyKey: descriptor.evidencePolicy.policyKey,
        readKey: descriptor.readKey,
        schemaVersion: descriptor.schemaVersion,
      },
      v2Protected,
    ) ||
    (descriptor.accessKind === 'search' && !v2Protected && !Predicate.isFunction(resultPermissionTargetResolver)) ||
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

export const defineRead = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  const Owner extends string,
  Services,
  Error,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{
    readonly _tag: string;
  }> = typeof Schema.Never,
>(
  descriptor: ReadDescriptor<InputSchema, ResultSchema, Owner, DomainErrorSchema>,
  ...definition: readonly [
    handler: ReadHandler<InputSchema, ResultSchema, Services, Error, Requirements>,
    serviceFactory: ReadServiceFactory<Services, Requirements>,
    /**
     * The legacy positional permission-target resolver. A v2 `protected` read omits it and declares
     * `accessTarget` instead (O62). The parameter disappears with the legacy kinds (C03b).
     */
    permissionTargetResolver?:
      | ReadConditionalPermissionDeclaration<InputSchema['Type']>
      | ReadOwnerPermissionDeclaration<InputSchema['Type']>
      | ReadPermissionTargetResolver<InputSchema['Type']>
      | undefined,
    resultPermissionTargetResolver?: ReadResultPermissionTargetResolver<ResultSchema['Type']>,
    executablePolicies?: readonly ActionPolicy<InputSchema['Type'], NoInfer<Owner>>[],
  ]
): ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements, DomainErrorSchema> => {
  const [handler, serviceFactory, declaredPermissionResolver, resultPermissionTargetResolver, executablePolicies = []] =
    definition;
  const {
    accessActor: _authoredActor,
    accessDeclaration: _authoredDeclaration,
    accessFieldGroups: _authoredFieldGroups,
    accessWorkload: _authoredWorkload,
    ...descriptorRest
  } = descriptor;
  const permissionTargetResolver = normalizeOwnerPermissionResolver(
    descriptor.permissionTarget,
    descriptor.owningModuleKey,
    declaredPermissionResolver,
  );
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
  const carriers = declaredAccessCarrier(descriptor);
  const fieldGroupIssue = fieldReadGroupSchemaIssue(carriers.accessFieldGroups ?? [], descriptor.resultSchema);
  if (fieldGroupIssue !== undefined) {
    return failReadDefinition(`Read ${descriptor.readKey}: ${fieldGroupIssue}`);
  }
  const frozenDescriptor: DeclaredReadDescriptor<InputSchema, ResultSchema, Owner, DomainErrorSchema> = Object.freeze({
    // The authored carriers are replaced by their decoded form below; they are never registered as written.
    ...descriptorRest,
    ...carriers,
    entrypoint: descriptor.entrypoint,
    evidencePolicy: Object.freeze({ ...descriptor.evidencePolicy }),
    policies: Object.freeze(descriptor.policies.map((reference) => Object.freeze({ ...reference }))),
  });
  const privateValue = {
    handler,
    permissionTargetResolver,
    policies: Object.freeze([...executablePolicies]),
    serviceFactory,
  };
  const publicFields = {
    descriptor: frozenDescriptor,
    [registrationMarker]: true as const,
  };
  if (resultPermissionTargetResolver === undefined) {
    return ReadPrivateStorage.create(Object.freeze(privateValue), publicFields);
  }
  return ReadPrivateStorage.create(Object.freeze({ ...privateValue, resultPermissionTargetResolver }), publicFields);
};

export const getReadPolicyImplementations = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Error,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements, DomainErrorSchema>,
): readonly ActionPolicy<InputSchema['Type'], Owner>[] => ReadPrivateStorage.getValue(registration).policies;

export const getReadResultPermissionTargetResolver = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Error,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements, DomainErrorSchema>,
): ReadResultPermissionTargetResolver<ResultSchema['Type']> | undefined =>
  ReadPrivateStorage.getValue(registration).resultPermissionTargetResolver;

export const getReadPermissionTargetResolver = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Error,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements, DomainErrorSchema>,
): ReadPermissionTargetDeclaration<InputSchema['Type']> | undefined =>
  ReadPrivateStorage.getValue(registration).permissionTargetResolver;

export const getReadConditionalPermissionPlan = <Input>(
  declaration: ReadConditionalPermissionDeclaration<Input>,
): ReadConditionalPermissionPrivateValue<Input> => ReadPrivateStorage.getValue(declaration);

export const getReadDomainErrorSchema = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Error,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements, DomainErrorSchema>,
): DomainErrorSchema | undefined => registration.descriptor.domainErrorSchema;

export const getReadResourcePermissionTargetResolver = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Error,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements, DomainErrorSchema>,
): ReadResourcePermissionTargetResolver<InputSchema['Type']> | undefined =>
  registration.descriptor.resourcePermission === undefined
    ? undefined
    : ReadPrivateStorage.getValue(registration.descriptor.resourcePermission);

/** The record target resolver of a record-scoped read, or undefined for a scope-wide read (O9, Q2). */
export const getReadAccessTargetResolver = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Error,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements, DomainErrorSchema>,
): ReadAccessTargetResolver<InputSchema['Type']> | undefined => registration.descriptor.accessTarget;

/** The owner-local facts resolver of a read handed to the owner overlay, when declared (O70). */
export const getReadOwnerFactsResolver = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Error,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements, DomainErrorSchema>,
): ReadAccessOwnerFactsResolver<InputSchema['Type']> | undefined => registration.descriptor.accessOwnerFacts;

export const getReadHandler = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Error,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements, DomainErrorSchema>,
): ReadHandler<InputSchema, ResultSchema, Services, Error, Requirements> =>
  ReadPrivateStorage.getValue(registration).handler;

export const getReadServiceFactory = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Error,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements, DomainErrorSchema>,
): ReadServiceFactory<Services, Requirements> => ReadPrivateStorage.getValue(registration).serviceFactory;

const asJsonResult = Schema.decodeUnknownOption(Schema.Json);
const isJsonObject = Schema.is(Schema.JsonObject);

/**
 * Removes one declared field path from every object of a result (O17). The path addresses the result
 * root, and an array applies it to each element, so one declared `pricing.margin` path governs both a
 * detail row and every row of a list.
 */
const withoutFieldPath = (value: Schema.Json, segments: readonly string[]): Schema.Json => {
  const [head, ...tail] = segments;
  if (head === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((element) => withoutFieldPath(element, segments));
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const child = value[head];
  if (child === undefined) {
    return value;
  }
  const remaining: [string, Schema.Json][] = [];
  for (const key of Object.keys(value)) {
    if (key !== head) {
      remaining.push([key, value[key] ?? null]);
    }
  }
  const rest = Object.fromEntries(remaining);
  return tail.length === 0 ? rest : { ...rest, [head]: withoutFieldPath(child, tail) };
};

/**
 * Removes one declared path from a decoded value without converting anything it keeps (O17, O74).
 * A decoded payload may hold values that are not JSON data — a `DateTimeUtcFromString`, an `Option`,
 * a `Date` — and redaction must leave those exactly as the owner produced them, otherwise the whole
 * payload fails to re-encode for a caller who merely lacks one field grant.
 */
const withoutFieldPathInPlace = <Value>(value: Value, segments: readonly string[]): Value => {
  const [head, ...tail] = segments;
  if (head === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    // SAFETY: an array maps to an array of the same element type, one declared path removed per row.
    return value.map((element) => withoutFieldPathInPlace(element, segments)) as Value;
  }
  if (!Predicate.isObject(value) || !Object.hasOwn(value, head)) {
    return value;
  }
  const child = value[head];
  const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== head));
  // SAFETY: the path names one property of this object, so replacing that property keeps its shape.
  return (tail.length === 0 ? rest : { ...rest, [head]: withoutFieldPathInPlace(child, tail) }) as Value;
};

export const projectReadResultFields = <Result>(
  result: Result,
  deniedPaths: readonly (readonly string[])[],
  resultSchema: Schema.ConstraintDecoder<Result>,
): Option.Option<Result> => {
  if (deniedPaths.length === 0) {
    return Option.some(result);
  }
  const encodedView = asJsonResult(result);
  if (Option.isSome(encodedView)) {
    // The value is already JSON data (the encoded shape of a plain payload): remove the declared
    // paths from that view and decode the projection back, so the caller keeps the declared type.
    let projected: Schema.Json = encodedView.value;
    for (const path of deniedPaths) {
      projected = withoutFieldPath(projected, path);
    }
    const decoded = Schema.decodeOption(resultSchema)(projected);
    if (Option.isSome(decoded)) {
      return Option.some(decoded.value);
    }
  }
  // A decoded payload that is not JSON data — a DateTimeUtcFromString, an Option, a Date — is
  // projected in place: redaction removes exactly the declared paths and leaves every value the
  // caller may read exactly as the owner produced it, so one missing field grant never turns the
  // whole read into a retryable failure (O17, O74).
  let inPlace: Result = result;
  for (const path of deniedPaths) {
    inPlace = withoutFieldPathInPlace(inPlace, path);
  }
  return Option.some(inPlace);
};
