/* eslint-disable complexity -- Definition-time validation keeps the closed read contract and private implementation alignment visible together. */
import type { Effect, Schema } from 'effect';
import type { ActionPolicy } from '../actions/policy.ts';
import { isActionPolicy } from '../actions/policy.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type {
  ModuleEntrypointDescriptor,
  ModuleEntrypointRole,
} from '../modules/module-entrypoint.ts';
import { LEGAL_ENTITY_SCOPES } from '../operations/context.ts';
import type { LegalEntityScope, OperationalScope } from '../operations/context.ts';
import type { OperationContextUnavailable } from '../operations/errors.ts';
import type { ResourceAccessTarget } from '../permissions/context-access.ts';
import type { ReadHandlerContext, ReadHandlerResult } from './context.ts';

const registrationMarker: unique symbol = Symbol('@app/core-runtime/reads/registration');
const handlers = new WeakMap<object, unknown>();
const factories = new WeakMap<object, unknown>();
const permissionTargetResolvers = new WeakMap<object, unknown>();
const resultPermissionTargetResolvers = new WeakMap<object, unknown>();
const policyImplementations = new WeakMap<object, readonly ActionPolicy<unknown, string>[]>();

export const READ_ACCESS_KINDS = [
  'detail',
  'download',
  'export',
  'list',
  'report',
  'search',
] as const;
export type ReadAccessKind = (typeof READ_ACCESS_KINDS)[number];
export const READ_EVIDENCE_CAPTURE_MODES = ['hash_only', 'metadata_only'] as const;
export type ReadEvidenceCaptureMode = (typeof READ_EVIDENCE_CAPTURE_MODES)[number];
export const READ_PERMISSION_TARGETS = ['legal_entity', 'module', 'resource'] as const;
export type ReadPermissionTarget = (typeof READ_PERMISSION_TARGETS)[number];
export type ReadPermissionDenialStatus = 409 | 422;
export interface ReadPolicyDescriptor {
  readonly denialStatus: ReadPermissionDenialStatus;
  readonly policyKey: string;
}
export type ResolvedReadPermissionTarget =
  | Readonly<{ readonly kind: 'legal_entity' }>
  | Readonly<{ readonly kind: 'module'; readonly moduleId: string }>
  | Readonly<{ readonly kind: 'resource'; readonly resource: ResourceAccessTarget }>;
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
  InputSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
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
  InputSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  Services,
  Error,
  Requirements = never,
> = (
  input: InputSchema['Type'],
  context: ReadHandlerContext<Services>,
) => Effect.Effect<ReadHandlerResult<ResultSchema['Type']>, Error, Requirements>;

export interface ReadRegistration<
  InputSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  Owner extends string,
  Services,
  Error,
  Requirements = never,
> {
  readonly [registrationMarker]: true;
  readonly descriptor: Readonly<ReadDescriptor<InputSchema, ResultSchema, Owner>>;
  readonly _error?: Error;
  readonly _requirements?: Requirements;
  readonly _services?: Services;
}

export const defineRead = <
  InputSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  const Owner extends string,
  Services,
  Error,
  Requirements,
>(
  descriptor: ReadDescriptor<InputSchema, ResultSchema, Owner>,
  handler: ReadHandler<InputSchema, ResultSchema, Services, Error, Requirements>,
  serviceFactory: ReadServiceFactory<Services, Requirements>,
  permissionTargetResolver: ReadPermissionTargetResolver<InputSchema['Type']>,
  resultPermissionTargetResolver?: ReadResultPermissionTargetResolver<ResultSchema['Type']>,
  executablePolicies: readonly ActionPolicy<InputSchema['Type'], NoInfer<Owner>>[] = [],
): ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements> => {
  if (
    descriptor.entrypoint.moduleKey !== descriptor.owningModuleKey ||
    descriptor.entrypoint.scope !==
      (descriptor.owningModuleKey.startsWith('core.') ? 'system' : 'tenant') ||
    !['read', 'historical_read'].includes(descriptor.entrypoint.access) ||
    !Object.isFrozen(descriptor.entrypoint)
  ) {
    throw new TypeError('Read entrypoint must be immutable, read-only, and owner-scoped');
  }
  if (!LEGAL_ENTITY_SCOPES.includes(descriptor.legalEntityScope)) {
    throw new TypeError('Read legal-entity scope must be required, optional, or forbidden');
  }
  if (
    !READ_ACCESS_KINDS.includes(descriptor.accessKind) ||
    !READ_EVIDENCE_CAPTURE_MODES.includes(descriptor.evidencePolicy.captureMode) ||
    !READ_PERMISSION_TARGETS.includes(descriptor.permissionTarget) ||
    (descriptor.accessKind === 'search' && typeof resultPermissionTargetResolver !== 'function') ||
    typeof permissionTargetResolver !== 'function' ||
    descriptor.evidencePolicy.policyKey.length === 0 ||
    descriptor.readKey.length === 0 ||
    descriptor.schemaVersion.length === 0
  ) {
    throw new TypeError('Read metadata must use the closed governed-read vocabulary');
  }
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
    throw new TypeError('Read policies must be an explicit array of Policy references');
  }
  const registration = Object.freeze({
    [registrationMarker]: true as const,
    descriptor: Object.freeze({
      ...descriptor,
      entrypoint: descriptor.entrypoint,
      evidencePolicy: Object.freeze({ ...descriptor.evidencePolicy }),
      policies: Object.freeze(
        descriptor.policies.map((reference) => Object.freeze({ ...reference })),
      ),
    }),
  });
  handlers.set(registration, handler);
  factories.set(registration, serviceFactory);
  permissionTargetResolvers.set(registration, permissionTargetResolver);
  policyImplementations.set(
    registration,
    Object.freeze([...executablePolicies]) as readonly ActionPolicy<unknown, string>[],
  );
  if (resultPermissionTargetResolver !== undefined) {
    resultPermissionTargetResolvers.set(registration, resultPermissionTargetResolver);
  }
  return registration;
};

export const getReadPolicyImplementations = <
  InputSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  Owner extends string,
  Services,
  Error,
  Requirements,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements>,
): readonly ActionPolicy<InputSchema['Type'], Owner>[] =>
  policyImplementations.get(registration) as readonly ActionPolicy<InputSchema['Type'], Owner>[];

export const getReadResultPermissionTargetResolver = <
  InputSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  Owner extends string,
  Services,
  Error,
  Requirements,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements>,
): ReadResultPermissionTargetResolver<ResultSchema['Type']> | undefined =>
  resultPermissionTargetResolvers.get(registration) as
    | ReadResultPermissionTargetResolver<ResultSchema['Type']>
    | undefined;

export const getReadPermissionTargetResolver = <
  InputSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  Owner extends string,
  Services,
  Error,
  Requirements,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements>,
): ReadPermissionTargetResolver<InputSchema['Type']> => {
  const resolver = permissionTargetResolvers.get(registration);
  if (typeof resolver !== 'function') {
    throw new TypeError('Invalid read registration');
  }
  return resolver as ReadPermissionTargetResolver<InputSchema['Type']>;
};

export const getReadHandler = <
  InputSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  Owner extends string,
  Services,
  Error,
  Requirements,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements>,
): ReadHandler<InputSchema, ResultSchema, Services, Error, Requirements> => {
  const handler = handlers.get(registration);
  if (typeof handler !== 'function') {
    throw new TypeError('Invalid read registration');
  }
  return handler as ReadHandler<InputSchema, ResultSchema, Services, Error, Requirements>;
};

export const getReadServiceFactory = <
  InputSchema extends Schema.ConstraintDecoder<unknown, never>,
  ResultSchema extends Schema.ConstraintDecoder<unknown, never>,
  Owner extends string,
  Services,
  Error,
  Requirements,
>(
  registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, Error, Requirements>,
): ReadServiceFactory<Services, Requirements> => {
  const factory = factories.get(registration);
  if (typeof factory !== 'function') {
    throw new TypeError('Invalid read registration');
  }
  return factory as ReadServiceFactory<Services, Requirements>;
};
