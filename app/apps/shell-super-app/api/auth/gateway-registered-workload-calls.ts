import { registeredWorkloadCallReceiverIssue } from '@app/core-runtime';
import type { OntosRegisteredWorkloadCall, RegisteredWorkloadCallReceiver } from '@app/core-runtime';

/** The parts of an installed contract the derivation reads: its deployment and, when present, its manifest. */
interface DerivationContract {
  readonly deployment: { readonly appId: string; readonly buildMarker: string };
  readonly manifest?: RegisteredWorkloadCallReceiver['manifest'] & {
    readonly registeredWorkloadCalls?: readonly OntosRegisteredWorkloadCall[];
  };
}

/**
 * The calls the attested source contract declares that its receiver, as installed now, still takes. A call is dropped
 * unless the installed receiver publishes its exact operation version with that declaration and that workload, so a
 * receiver that was removed, replaced or changed never inherits a caller's earlier declaration.
 */
const receivedCalls = (source: DerivationContract, contracts: readonly DerivationContract[]) =>
  (source.manifest?.registeredWorkloadCalls ?? []).filter((call) => {
    const receiver = contracts.find((candidate) => candidate.deployment.appId === call.audience);
    return (
      registeredWorkloadCallReceiverIssue(
        call,
        receiver?.manifest === undefined ? undefined : { deployment: receiver.deployment, manifest: receiver.manifest },
      ) === undefined
    );
  });

/**
 * A module credential's binding with the registered-workload calls its module's reviewed manifest declares. The calls
 * come only from the installed contract of exactly the bound app, build and composition revision; any other binding
 * keeps its identity and gets no call. No configuration, table or request adds one.
 */
export const withRegisteredWorkloadCalls = <
  Binding extends {
    readonly compositionRevision: string;
    readonly sourceAppId: string;
    readonly sourceBuildMarker: string;
  },
>(
  binding: Binding,
  installed: {
    readonly composition: { readonly revision: string };
    readonly contracts: readonly DerivationContract[];
  },
): Binding & { readonly registeredWorkloads?: readonly OntosRegisteredWorkloadCall[] } => {
  const contract = installed.contracts.find((candidate) => candidate.deployment.appId === binding.sourceAppId);
  if (
    contract?.manifest?.registeredWorkloadCalls === undefined ||
    contract.deployment.buildMarker !== binding.sourceBuildMarker ||
    installed.composition.revision !== binding.compositionRevision
  ) {
    return binding;
  }
  return { ...binding, registeredWorkloads: receivedCalls(contract, installed.contracts) };
};
