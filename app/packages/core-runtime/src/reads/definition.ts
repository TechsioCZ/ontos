import { Predicate, Schema } from 'effect';
import type { Effect } from 'effect';

import type { ActionPolicy } from '../actions/policy.ts';
import { isActionPolicy } from '../actions/policy.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { ModuleEntrypointDescriptor, ModuleEntrypointRole } from '../modules/module-entrypoint.ts';
import { LEGAL_ENTITY_SCOPES } from '../operations/context.ts';
import type { LegalEntityScope, OperationalScope } from '../operations/context.ts';
import type { OperationContextUnavailable } from '../operations/errors.ts';
import type {
  LegalEntityPermissionKey,
  ResourceAccessTarget,
  TenantPermissionKey,
} from '../permissions/context-access.ts';
import type { ReadHandlerContext, ReadHandlerResult } from './context.ts';

const registrationMarker: unique symbol = Symbol('@app/core-runtime/reads/registration');

class ReadPrivateStorage<Value> {
  declare readonly [registrationMarker]?: true;
  declare readonly descriptor?: unknown;
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
export const READ_PERMISSION_TARGETS = ['legal_entity', 'module', 'resource', 'tenant'] as const;
export type ReadPermissionTarget = (typeof READ_PERMISSION_TARGETS)[number];
export type ReadPermissionDenialStatus = 409 | 422;
export interface ReadPolicyDescriptor {
  readonly denialStatus: ReadPermissionDenialStatus;
  readonly policyKey: string;
}
export type ReadAlternativeTenantPermission = Exclude<TenantPermissionKey, 'access' | 'impersonate'>;
export type AtomicResolvedReadPermissionTarget =
  | Readonly<{
      readonly kind: 'legal_entity';
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
      Readonly<{
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

const isOwnerCompatiblePolicy = (policy: ActionPolicy<unknown, string>, owner: string): boolean =>
  policy.scope === 'global' || policy.owningModuleKey === owner;

export interface ReadDescriptor<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
> {
  readonly accessKind: ReadAccessKind;
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
  readonly resultSchema: ResultSchema;
  readonly schemaVersion: string;
}

export type ReadServiceFactory<Services, Requirements = never> = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
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
  readonly entrypoint: ModuleEntrypointDescriptor;
  readonly legalEntityScope: string;
  readonly owningModuleKey: string;
}

const ReadDefinitionInvariantError = Schema.TaggedError<Error>()('ReadDefinitionInvariantError', {
  message: Schema.String,
});

const failReadDefinition = (message: string): never => {
  throw new ReadDefinitionInvariantError({ message });
};

export const validateReadDescriptorInput = (descriptor: ReadDescriptorValidationInput): void => {
  if (
    descriptor.entrypoint.moduleKey !== descriptor.owningModuleKey ||
    descriptor.entrypoint.scope !== (descriptor.owningModuleKey.startsWith('core.') ? 'system' : 'tenant') ||
    !['read', 'historical_read'].includes(descriptor.entrypoint.access) ||
    !Object.isFrozen(descriptor.entrypoint)
  ) {
    return failReadDefinition('Read entrypoint must be immutable, read-only, and owner-scoped');
  }
  if (!LEGAL_ENTITY_SCOPES.some((scope) => scope === descriptor.legalEntityScope)) {
    return failReadDefinition('Read legal-entity scope must be required, optional, or forbidden');
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
  readonly permissionTargetResolver: ReadPermissionTargetResolver<InputSchema['Type']>;
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
> = ReadPrivateStorage<
  ReadRegistrationPrivateValue<InputSchema, ResultSchema, Owner, Services, Error, Requirements>
> & {
  readonly _error?: Error;
  readonly _requirements?: Requirements;
  readonly _services?: Services;
  readonly descriptor: Readonly<ReadDescriptor<InputSchema, ResultSchema, Owner>>;
  readonly [registrationMarker]: true;
};

const validateReadVocabulary = <Input, Result>(
  descriptor: ReadDescriptor<Schema.ConstraintDecoder<unknown>, Schema.ConstraintDecoder<unknown>, string>,
  permissionTargetResolver: ReadPermissionTargetResolver<Input>,
  resultPermissionTargetResolver: ReadResultPermissionTargetResolver<Result> | undefined,
): void => {
  if (
    !READ_ACCESS_KINDS.includes(descriptor.accessKind) ||
    !READ_EVIDENCE_CAPTURE_MODES.includes(descriptor.evidencePolicy.captureMode) ||
    !READ_PERMISSION_TARGETS.includes(descriptor.permissionTarget) ||
    (descriptor.accessKind === 'search' && !Predicate.isFunction(resultPermissionTargetResolver)) ||
    !Predicate.isFunction(permissionTargetResolver) ||
    descriptor.evidencePolicy.policyKey.length === 0 ||
    descriptor.readKey.length === 0 ||
    descriptor.schemaVersion.length === 0
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
>(
  descriptor: ReadDescriptor<InputSchema, ResultSchema, Owner>,
  ...definition: readonly [
    handler: ReadHandler<InputSchema, ResultSchema, Services, Error, Requirements>,
    serviceFactory: ReadServiceFactory<Services, Requirements>,
    permissionTargetResolver: ReadPermissionTargetResolver<InputSchema['Type']>,
    resultPermissionTargetResolver?: ReadResultPermissionTargetResolver<ResultSchema['Type']>,
    executablePolicies?: readonly ActionPolicy<InputSchema['Type'], NoInfer<Owner>>[],
  ]
): ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements> => {
  const [handler, serviceFactory, permissionTargetResolver, resultPermissionTargetResolver, executablePolicies = []] =
    definition;
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
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements>,
): readonly ActionPolicy<InputSchema['Type'], Owner>[] => ReadPrivateStorage.getValue(registration).policies;

export const getReadResultPermissionTargetResolver = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Error,
  Requirements,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements>,
): ReadResultPermissionTargetResolver<ResultSchema['Type']> | undefined =>
  ReadPrivateStorage.getValue(registration).resultPermissionTargetResolver;

export const getReadPermissionTargetResolver = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Error,
  Requirements,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements>,
): ReadPermissionTargetResolver<InputSchema['Type']> =>
  ReadPrivateStorage.getValue(registration).permissionTargetResolver;

export const getReadHandler = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Error,
  Requirements,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements>,
): ReadHandler<InputSchema, ResultSchema, Services, Error, Requirements> =>
  ReadPrivateStorage.getValue(registration).handler;

export const getReadServiceFactory = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  Error,
  Requirements,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements>,
): ReadServiceFactory<Services, Requirements> => ReadPrivateStorage.getValue(registration).serviceFactory;
