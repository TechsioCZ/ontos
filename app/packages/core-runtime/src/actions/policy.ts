import { Schema, Predicate } from 'effect';
import type { Effect } from 'effect';
import type { ActionTransportMetadata, TrustedPrincipalContext } from './context.ts';

const policyReference: unique symbol = Symbol('@app/core-runtime/actions/policy');
const policyReferences = new WeakSet<object>();

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

export class PolicyDenied extends Schema.TaggedErrorClass<PolicyDenied>()('PolicyDenied', {
  reason: Schema.String,
  reasonCode: Schema.String,
}) {}

export type ActionPolicyEvaluator<Payload> = (
  input: ActionPolicyEvaluatorInput<Payload>,
) => Effect.Effect<void, PolicyDenied>;

interface ActionPolicyBase<Payload> {
  readonly [policyReference]: true;
  readonly evaluate: ActionPolicyEvaluator<Payload>;
  readonly policyKey: string;
}

export interface GlobalActionPolicy<Payload> extends ActionPolicyBase<Payload> {
  readonly scope: 'global';
}

export interface MicroverticalActionPolicy<
  Payload,
  Owner extends string,
> extends ActionPolicyBase<Payload> {
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

const requireStableIdentifier = (value: string, field: string): void => {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty stable identifier`);
  }
};

const registerPolicy = <Policy extends object>(policy: Policy): Readonly<Policy> => {
  const frozen = Object.freeze(policy);
  policyReferences.add(frozen);
  return frozen;
};

export const denyPolicy = (reasonCode: string, reason: string): PolicyDenied => {
  requireStableIdentifier(reasonCode, 'Policy reason code');
  requireStableIdentifier(reason, 'Policy denial reason');
  return Object.freeze(new PolicyDenied({ reason, reasonCode }));
};

export const defineGlobalPolicy = <Payload>(
  input: DefineGlobalPolicyInput<Payload>,
): GlobalActionPolicy<Payload> => {
  requireStableIdentifier(input.policyKey, 'Policy key');
  return registerPolicy({
    [policyReference]: true as const,
    evaluate: input.evaluate,
    policyKey: input.policyKey,
    scope: 'global' as const,
  });
};

export const defineMicroverticalPolicy = <Payload, const Owner extends string>(
  input: DefineMicroverticalPolicyInput<Payload, Owner>,
): MicroverticalActionPolicy<Payload, Owner> => {
  requireStableIdentifier(input.policyKey, 'Policy key');
  requireStableIdentifier(input.owningModuleKey, 'Policy owning module key');
  return registerPolicy({
    [policyReference]: true as const,
    evaluate: input.evaluate,
    owningModuleKey: input.owningModuleKey,
    policyKey: input.policyKey,
    scope: 'microvertical' as const,
  });
};

/** Internal definition-time guard; only constructor-produced references pass. */
export const isActionPolicy = <Value>(
  value: Value,
): value is Value & ActionPolicy<unknown, string> =>
  Predicate.isObjectKeyword(value) && value !== null && policyReferences.has(value);
