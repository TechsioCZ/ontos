import { GatewayNativeEvidence } from './gateway-native-evidence.ts';

import { Effect, Match } from 'effect';

import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import { gatewayRegisteredOperationContractAllows } from './gateway-delegation-policy.ts';
import type { GatewayModuleBinding, GatewayRegisteredWorkloadRule } from './gateway-delegation-policy.ts';
import type { GatewayDelegationRequestPayload } from './gateway-delegation-issuer.ts';
import { delegationForbidden } from './gateway-delegation-errors.ts';

type WorkloadSubject = Extract<
  GatewayDelegationRequestPayload['subject'],
  { readonly _tag: 'RegisteredWorkload' | 'RegisteredAdmission' }
>;
const subjectMatchesRule = (subject: WorkloadSubject, rule: GatewayRegisteredWorkloadRule): boolean =>
  Match.value(subject).pipe(
    Match.tag(
      'RegisteredWorkload',
      (worker) => rule.workerKey === worker.workerKey && rule.sourceActionKey === undefined,
    ),
    Match.tag(
      'RegisteredAdmission',
      (admission) => rule.sourceActionKey === admission.sourceActionKey && rule.workerKey === undefined,
    ),
    Match.exhaustive,
  );
/** Independently proves a current durable delivery, exact source/destination contract and one enrolled workload actor. */
export const admitRegisteredGatewayWorkload = Effect.fn('GatewayDelegation.admitRegisteredWorkload')(
  function* admitRegisteredWorkload(input: {
    readonly audience: string;
    readonly binding: GatewayModuleBinding;
    readonly installed: ShellInstalledCatalog;
    readonly subject: WorkloadSubject;
  }) {
    const { binding, installed, subject } = input;
    const source = installed.contracts.find((contract) => contract.deployment.appId === binding.sourceAppId);
    const destination = installed.contracts.find((contract) => contract.deployment.appId === input.audience);
    const candidates = (binding.registeredWorkloads ?? []).filter(
      (rule) =>
        rule.recoveryOf === undefined &&
        rule.allowRecoverySource !== true &&
        rule.audience === input.audience &&
        subjectMatchesRule(subject, rule) &&
        rule.declarationKey === subject.declarationKey,
    );
    const [rule] = candidates;
    if (
      candidates.length !== 1 ||
      rule === undefined ||
      source === undefined ||
      destination === undefined ||
      binding.compositionRevision !== installed.composition.revision ||
      binding.sourceBuildMarker !== source.deployment.buildMarker
    ) {
      return yield* delegationForbidden('registered_workload_unmatched')();
    }
    if (
      subject.operationRequirementKey === undefined &&
      !gatewayRegisteredOperationContractAllows(source, destination, rule, subject.legalEntityId)
    ) {
      return yield* delegationForbidden('registered_operation_refused')();
    }
    return yield* (yield* GatewayNativeEvidence).admitWorkload({ binding, destination, rule, source, subject });
  },
);
