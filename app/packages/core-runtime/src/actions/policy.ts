import { Effect, Schema } from 'effect';

import type { ActionTransportMetadata, TrustedPrincipalContext } from './context.ts';
import type { ActionCoreError } from './errors.ts';

const policyReference = '__actionPolicyReference' as const;
const policyKeyField = 'Policy key';

export interface ActionPolicyIdentity {
  readonly actionKey: string;
  readonly owningModuleKey: string;
  readonly schemaVersion: string;
}

export interface ActionPolicyTarget {
  readonly targetModuleKey?: string;
  readonly targetResourceId?: string;
  readonly targetResourceType?: string;
}

export interface ActionPolicyEvaluatorInput<Payload> {
  readonly action: Readonly<ActionPolicyIdentity>;
  readonly payload: Payload;
  readonly principal: Readonly<TrustedPrincipalContext>;
  readonly target: Readonly<ActionPolicyTarget>;
  readonly transport: Readonly<Pick<ActionTransportMetadata, 'correlationId' | 'traceId'>>;
}

const policyDeniedFields = {
  reason: Schema.String,
  reasonCode: Schema.String,
};
const PolicyDeniedContract = Schema.TaggedStruct('PolicyDenied', policyDeniedFields);
type PolicyDeniedSelf = typeof PolicyDeniedContract.Type;
const PolicyDeniedValue = Schema.TaggedError<PolicyDeniedSelf>()('PolicyDenied', policyDeniedFields);
export type PolicyDenied = InstanceType<typeof PolicyDeniedValue>;
export { PolicyDeniedValue as PolicyDenied };

export type ActionPolicyEvaluator<Payload> = (
  input: ActionPolicyEvaluatorInput<Payload>,
) => Effect.Effect<void, PolicyDenied>;

/**
 * Invocation-local Core evaluator available only during registered service preparation. Requirements
 * remain on the owner's Effect; the static Policy evaluator never acquires hidden ports.
 */
export type ActionPreparationPolicyEvaluator<Payload, DomainError> = <Value, Requirements>(
  policy: ActionPolicy<Payload, string>,
  evaluate: (
    input: ActionPolicyEvaluatorInput<Payload>,
  ) => Effect.Effect<Value, ActionCoreError | DomainError | PolicyDenied, Requirements>,
) => Effect.Effect<Value, ActionCoreError | DomainError, Requirements>;

interface ActionPolicyBase<Payload> {
  readonly evaluate: ActionPolicyEvaluator<Payload>;
  readonly policyKey: string;
  readonly [policyReference]: true;
  /** Intrinsic obligation: missing preparation can never turn this Policy into a static allow. */
  readonly requiresPreparation?: true;
}

export interface GlobalActionPolicy<Payload> extends ActionPolicyBase<Payload> {
  readonly scope: 'global';
}

export interface MicroverticalActionPolicy<Payload, Owner extends string> extends ActionPolicyBase<Payload> {
  readonly owningModuleKey: Owner;
  readonly scope: 'microvertical';
}

export type ActionPolicy<Payload, Owner extends string> =
  | GlobalActionPolicy<Payload>
  | MicroverticalActionPolicy<Payload, Owner>;

export interface DefineGlobalPolicyInput<Payload> {
  readonly evaluate: ActionPolicyEvaluator<Payload>;
  readonly policyKey: string;
}

export interface DefineMicroverticalPolicyInput<
  Payload,
  Owner extends string,
> extends DefineGlobalPolicyInput<Payload> {
  readonly owningModuleKey: Owner;
}

export interface DefineMicroverticalPreparationPolicyInput<Owner extends string> {
  readonly owningModuleKey: Owner;
  readonly policyKey: string;
}

const makePolicyDefinitionError = TypeError.bind(null);

const requireStableIdentifier = (value: string, field: string): void => {
  if (value.trim().length === 0) {
    throw makePolicyDefinitionError(`${field} must be a non-empty stable identifier`);
  }
};

const registerPolicy = <Policy extends object>(policy: Policy): Readonly<Policy> => {
  Object.defineProperty(policy, policyReference, {
    enumerable: false,
    value: true,
  });
  const frozen = Object.freeze(policy);
  return frozen;
};

export const denyPolicy = (reasonCode: string, reason: string): PolicyDenied => {
  requireStableIdentifier(reasonCode, 'Policy reason code');
  requireStableIdentifier(reason, 'Policy denial reason');
  return Object.freeze(new PolicyDeniedValue({ reason, reasonCode }));
};

export const defineGlobalPolicy = <Payload>(input: DefineGlobalPolicyInput<Payload>): GlobalActionPolicy<Payload> => {
  requireStableIdentifier(input.policyKey, policyKeyField);
  return registerPolicy({
    evaluate: input.evaluate,
    policyKey: input.policyKey,
    [policyReference]: true as const,
    scope: 'global' as const,
  });
};

export const defineMicroverticalPolicy = <Payload, const Owner extends string>(
  input: DefineMicroverticalPolicyInput<Payload, Owner>,
): MicroverticalActionPolicy<Payload, Owner> => {
  requireStableIdentifier(input.policyKey, policyKeyField);
  requireStableIdentifier(input.owningModuleKey, 'Policy owning module key');
  return registerPolicy({
    evaluate: input.evaluate,
    owningModuleKey: input.owningModuleKey,
    policyKey: input.policyKey,
    [policyReference]: true as const,
    scope: 'microvertical' as const,
  });
};

/**
 * An effectful owner Policy identity. The evaluator runs through preparation's Core hook; static
 * use fails closed. Its real requirements belong to that preparation Effect, not all static Policies.
 */
export const defineMicroverticalPreparationPolicy = <Payload, const Owner extends string>(
  input: DefineMicroverticalPreparationPolicyInput<Owner>,
): MicroverticalActionPolicy<Payload, Owner> => {
  requireStableIdentifier(input.policyKey, policyKeyField);
  requireStableIdentifier(input.owningModuleKey, 'Policy owning module key');
  return registerPolicy({
    evaluate: () => Effect.fail(denyPolicy('policy_preparation_required', 'This Policy requires Core preparation')),
    owningModuleKey: input.owningModuleKey,
    policyKey: input.policyKey,
    [policyReference]: true as const,
    requiresPreparation: true as const,
    scope: 'microvertical' as const,
  });
};

/** Internal definition-time guard; only constructor-produced references pass. */
const ActionPolicyReferenceSchema = Schema.Union([
  Schema.Struct({
    evaluate: Schema.Any,
    policyKey: Schema.String.pipe(Schema.brand('PolicyKey'), Schema.decodeTo(Schema.String)),
    [policyReference]: Schema.Literal(true),
    requiresPreparation: Schema.optionalKey(Schema.Literal(true)),
    scope: Schema.Literal('global'),
  }),
  Schema.Struct({
    evaluate: Schema.Any,
    owningModuleKey: Schema.String.pipe(Schema.brand('OwningModuleKey'), Schema.decodeTo(Schema.String)),
    policyKey: Schema.String.pipe(Schema.brand('PolicyKey'), Schema.decodeTo(Schema.String)),
    [policyReference]: Schema.Literal(true),
    requiresPreparation: Schema.optionalKey(Schema.Literal(true)),
    scope: Schema.Literal('microvertical'),
  }),
]);

export const isActionPolicy: (value: ActionPolicy<never, string>) => value is ActionPolicy<never, string> =
  Schema.is(ActionPolicyReferenceSchema);
