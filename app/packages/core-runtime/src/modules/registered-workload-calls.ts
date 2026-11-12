import { Schema } from 'effect';

import { RegisteredGatewayWorkloadSchema } from '../auth/system-principal-context-provenance.ts';

const nonEmpty = Schema.String.check(Schema.isMinLength(1));
/** The gateway audience rule (`GatewayAudienceSchema` in `@app/shared-contracts`, which Core does not import). */
const GatewayAudienceSchema = nonEmpty.check(
  Schema.makeFilter((value) =>
    /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(value) ? undefined : 'audience must be a stable topology app ID',
  ),
);
const sourceActionKeySchema = nonEmpty.pipe(Schema.brand('GatewaySourceActionKey'), Schema.decodeTo(Schema.String));
const workerKeySchema = nonEmpty.pipe(Schema.brand('GatewayWorkerKey'), Schema.decodeTo(Schema.String));
const workloadFields = RegisteredGatewayWorkloadSchema.fields;

/**
 * One registered-workload call the calling module makes: exactly the fields of upstream main's env-configured
 * binding rule. Upstream main has no production source for these rules (`ONTOS_GATEWAY_MODULE_BINDINGS=[]` in
 * `.env.example`); declaring them in the caller's manifest is demo divergence exception 8, to be offered upstream.
 */
export const OntosRegisteredWorkloadCallSchema = Schema.Struct({
  allowHistoricalDeliveryRecovery: Schema.optionalKey(Schema.Boolean),
  allowRecoverySource: Schema.optionalKey(Schema.Boolean),
  audience: GatewayAudienceSchema,
  declarationKey: workloadFields.declarationKey,
  entrypointKey: workloadFields.entrypointKey,
  jobKey: workloadFields.jobKey.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u)),
  legalEntityScope: Schema.Literals(['forbidden', 'optional', 'required']),
  recoveryOf: Schema.optionalKey(
    Schema.Struct({
      actionKey: sourceActionKeySchema,
      jobKey: workloadFields.jobKey,
    }),
  ),
  schemaVersion: nonEmpty,
  sourceActionKey: Schema.optionalKey(sourceActionKeySchema),
  sourceWorkloadKey: Schema.optionalKey(workloadFields.workloadKey),
  workerKey: Schema.optionalKey(workerKeySchema),
  workloadKey: workloadFields.workloadKey,
});
export type OntosRegisteredWorkloadCall = typeof OntosRegisteredWorkloadCallSchema.Type;
export type OntosRegisteredWorkloadCallInput = typeof OntosRegisteredWorkloadCallSchema.Encoded;

type CallSelectorFields = Pick<
  OntosRegisteredWorkloadCallInput,
  | 'allowHistoricalDeliveryRecovery'
  | 'allowRecoverySource'
  | 'audience'
  | 'declarationKey'
  | 'recoveryOf'
  | 'sourceActionKey'
  | 'sourceWorkloadKey'
  | 'workerKey'
>;

/**
 * The request shapes the Shell's consumers select a call by (a nested assertion, a current worker or admission, a
 * worker, historical-delivery or admission recovery). Each consumer admits only when exactly one call matches.
 */
const callSelectors = (call: CallSelectorFields): readonly string[] => {
  const base = [call.audience, call.declarationKey];
  const selectors: (readonly (boolean | string)[])[] = [];
  if (call.workerKey === undefined && call.sourceActionKey === undefined && call.sourceWorkloadKey !== undefined) {
    selectors.push(['assertion', ...base, call.sourceWorkloadKey, call.allowRecoverySource === true]);
  }
  if (call.recoveryOf === undefined && call.allowRecoverySource !== true) {
    if (call.workerKey !== undefined && call.sourceActionKey === undefined) {
      selectors.push(['worker', ...base, call.workerKey]);
    }
    if (call.sourceActionKey !== undefined && call.workerKey === undefined) {
      selectors.push(['admission', ...base, call.sourceActionKey]);
    }
  }
  if (call.recoveryOf !== undefined && call.sourceWorkloadKey === undefined) {
    const recovery = [...base, call.recoveryOf.actionKey];
    if (call.workerKey !== undefined && call.sourceActionKey === undefined) {
      selectors.push(['worker-recovery', ...recovery, call.workerKey]);
      if (call.allowHistoricalDeliveryRecovery === true && call.recoveryOf.jobKey === call.workerKey) {
        selectors.push(['historical-recovery', ...recovery, call.workerKey]);
      }
    }
    if (call.sourceActionKey !== undefined && call.workerKey === undefined) {
      selectors.push(['admission-recovery', ...recovery, call.sourceActionKey]);
    }
  }
  // Length-prefixed parts, so no key text can make two different selectors read alike.
  return selectors.map((selector) => selector.map((part) => `${String(part).length}:${String(part)}`).join(''));
};

/** A module's calls: none repeated, and no request shape that two calls would both match. */
const registeredWorkloadCallsIssue = (calls: readonly CallSelectorFields[]): string | undefined => {
  const selected = new Set<string>();
  for (const call of calls) {
    const selectors = callSelectors(call);
    if (selectors.length === 0) {
      return `registered-workload call to ${call.audience} ${call.declarationKey} names no caller mode`;
    }
    for (const selector of selectors) {
      if (selected.has(selector)) {
        return `registered-workload calls to ${call.audience} ${call.declarationKey} are repeated or ambiguous`;
      }
      selected.add(selector);
    }
  }
  return undefined;
};

export const OntosRegisteredWorkloadCallsSchema = Schema.Array(OntosRegisteredWorkloadCallSchema).check(
  Schema.isMaxLength(512),
  Schema.makeFilter((calls) => registeredWorkloadCallsIssue(calls)),
);

/** The published parts of an installed receiver that decide whether it takes a call. */
export interface RegisteredWorkloadCallReceiver {
  readonly deployment: { readonly appId: string };
  readonly manifest: {
    readonly publicSurface: {
      readonly actions: readonly {
        readonly accessActor?: { readonly subjectWorkloads?: readonly string[] } | undefined;
        readonly accessDeclaration?: { readonly key: string } | undefined;
        readonly accessWorkload?: { readonly workloads: readonly string[] } | undefined;
        readonly entrypoint: { readonly entrypointKey: string };
        readonly schemaVersion: string;
      }[];
      readonly operationContracts?:
        | readonly {
            readonly entrypoint: { readonly entrypointKey: string };
            readonly schemaVersion: string;
            readonly workloadCarrier?:
              | { readonly declarationKey: string; readonly workloads: readonly string[] }
              | undefined;
          }[]
        | undefined;
    };
  };
}

/**
 * Whether the receiver publishes the call's exact operation version and, on it, the call's declaration and its
 * registered workload (as an `accessWorkload` workload or an `accessActor` subject workload). A call to anything else
 * is refused: an absent receiver, operation or version, another declaration, or a workload the receiver does not name.
 */
export const registeredWorkloadCallReceiverIssue = (
  call: Pick<OntosRegisteredWorkloadCallInput, 'audience' | 'declarationKey' | 'entrypointKey' | 'schemaVersion'> & {
    readonly workloadKey: string;
  },
  receiver: RegisteredWorkloadCallReceiver | undefined,
): string | undefined => {
  const label = `registered-workload call ${call.entrypointKey}@${call.schemaVersion} to ${call.audience}`;
  if (receiver?.deployment.appId !== call.audience) {
    return `${label}: the receiver is not installed`;
  }
  const { actions, operationContracts } = receiver.manifest.publicSurface;
  const matches = (operation: {
    readonly entrypoint: { readonly entrypointKey: string };
    readonly schemaVersion: string;
  }) => operation.entrypoint.entrypointKey === call.entrypointKey && operation.schemaVersion === call.schemaVersion;
  const declared = [
    ...actions.flatMap((action) =>
      matches(action)
        ? [
            {
              declarationKey: action.accessDeclaration?.key,
              workloads: [...(action.accessWorkload?.workloads ?? []), ...(action.accessActor?.subjectWorkloads ?? [])],
            },
          ]
        : [],
    ),
    ...(operationContracts ?? []).flatMap((operation) =>
      matches(operation)
        ? [
            {
              declarationKey: operation.workloadCarrier?.declarationKey,
              workloads: operation.workloadCarrier?.workloads ?? [],
            },
          ]
        : [],
    ),
  ];
  if (declared.length === 0) {
    return `${label}: the receiver publishes no such operation version`;
  }
  return declared.every(
    ({ declarationKey, workloads }) => declarationKey === call.declarationKey && workloads.includes(call.workloadKey),
  )
    ? undefined
    : `${label}: the receiver does not declare ${call.declarationKey} for workload ${call.workloadKey}`;
};
