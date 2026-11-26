import { GatewayNativeEvidence } from './gateway-native-evidence.ts';

import type { ModuleEntrypointAccess } from '@app/core-runtime';

import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';

import { RegisteredGatewayWorkloadSchema } from '@app/core-runtime/auth/system-principal-context-provenance';
import type { RegisteredGatewayWorkload } from '@app/core-runtime/auth/system-principal-context-provenance';
import { Effect, Schema } from 'effect';

import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import {
  gatewayPublishedOperationAccess,
  gatewayRegisteredOperationContractAllows,
} from './gateway-delegation-policy.ts';
import type {
  GatewayConditionalOperationWitness,
  GatewayModuleBinding,
  GatewayRegisteredWorkloadRule,
} from './gateway-delegation-policy.ts';
import type { GatewayDelegationRequestPayload } from './gateway-delegation-issuer.ts';
import { readVerifiedGatewayAssertion, snapshotRegisteredGatewayWorkload } from './gateway-assertion-evidence.ts';
import type { VerifiedGatewayAssertion } from './gateway-assertion-evidence.ts';
import { delegationForbidden } from './gateway-delegation-errors.ts';

type Subject = Extract<GatewayDelegationRequestPayload['subject'], { readonly _tag: 'RegisteredAssertion' }>;

type InstalledContract = ShellInstalledCatalog['contracts'][number];

interface OrganizationProcessingEvidence {
  readonly compositionRevision: string;
  readonly principal: TrustedPrincipalContext;
  readonly sourceValidity: { readonly expiresAt: number; readonly issuedAt: number };
  readonly workload: RegisteredGatewayWorkload;
}
const processingMintKey = Object.freeze({ kind: 'organization_processing_read' });
class AdmittedOrganizationProcessingReadValue {
  readonly #evidence: OrganizationProcessingEvidence | undefined;
  #consumed = false;
  constructor(key: typeof processingMintKey, evidence: OrganizationProcessingEvidence) {
    this.#evidence =
      key === processingMintKey
        ? Object.freeze({
            ...evidence,
            principal: Object.freeze({ ...evidence.principal }),
            sourceValidity: Object.freeze({ ...evidence.sourceValidity }),
            workload: snapshotRegisteredGatewayWorkload(evidence.workload),
          })
        : undefined;
    Object.freeze(this);
  }
  static take(witness: AdmittedOrganizationProcessingReadValue): OrganizationProcessingEvidence | undefined {
    if (!(#evidence in witness) || witness.#consumed) {
      return undefined;
    }
    witness.#consumed = true;
    return witness.#evidence;
  }
}
export type AdmittedOrganizationProcessingRead = AdmittedOrganizationProcessingReadValue;
const processingWitnessSchema = Schema.instanceOf(AdmittedOrganizationProcessingReadValue);
/** Only this module's complete signed-source/native-rule admission mints a one-use signing witness. */
export const takeAdmittedOrganizationProcessingRead = (
  witness: AdmittedOrganizationProcessingRead,
): OrganizationProcessingEvidence | undefined =>
  Schema.is(processingWitnessSchema)(witness) ? AdmittedOrganizationProcessingReadValue.take(witness) : undefined;

const sourceModeAllowsTarget = (
  workload: RegisteredGatewayWorkload,
  subject: Subject,
  rule: GatewayRegisteredWorkloadRule,
  destination: InstalledContract,
): boolean => {
  if (workload.recovery === undefined) {
    return (
      subject.recoveryRequestHash === undefined && rule.recoveryOf === undefined && rule.allowRecoverySource !== true
    );
  }
  const readAccess = gatewayPublishedOperationAccess(destination, rule.entrypointKey, rule.schemaVersion);
  const read = readAccess === 'read' || readAccess === 'historical_read';
  const write = destination.manifest.publicSurface.actions.some(
    (action) => action.entrypoint.entrypointKey === rule.entrypointKey,
  );
  return (
    rule.allowRecoverySource === true &&
    rule.recoveryOf === undefined &&
    subject.recoveryRequestHash !== undefined &&
    read &&
    !write
  );
};

interface NativeAssertionEvidence {
  readonly principal: TrustedPrincipalContext;
  readonly sourceAccess: ModuleEntrypointAccess;
  readonly sourceKey: string;
  readonly workload: RegisteredGatewayWorkload;
}
const finishRegisteredAssertion = Effect.fn('GatewayDelegation.finishRegisteredAssertion')(function* finish(input: {
  readonly admitted: NativeAssertionEvidence;
  readonly audience: string;
  readonly binding: GatewayModuleBinding;
  readonly destination: InstalledContract;
  readonly installed: ShellInstalledCatalog;
  readonly rule: GatewayRegisteredWorkloadRule;
  readonly source: InstalledContract;
  readonly sourceEvidence: NonNullable<ReturnType<typeof readVerifiedGatewayAssertion>>;
  readonly subject: Subject;
  readonly workload: RegisteredGatewayWorkload;
}) {
  const { admitted, audience, binding, destination, installed, rule, source, sourceEvidence, subject, workload } =
    input;
  const { sourceAccess } = admitted;
  if (audience !== 'symmy-integration') {
    if (subject.processingRequestHash !== undefined) {
      return yield* delegationForbidden('processing_read_refused')();
    }
    return { ...admitted, organizationProcessingWitness: null };
  }
  if (
    binding.sourceAppId !== 'privacy' ||
    source.manifest.module.id !== 'privacy.core' ||
    workload.entrypointKey !== 'privacy.core.api.organization-business-applicability' ||
    workload.workloadKey !== 'privacy.core.organization-business-check' ||
    sourceAccess !== 'read' ||
    subject.operationRequirementKey !== 'privacy.core.requirement.organization-business-source-facts' ||
    subject.processingRequestHash === undefined ||
    workload.recovery !== undefined ||
    rule.entrypointKey !== 'integration.symmy.api.symmy-source-organization-facts' ||
    rule.declarationKey !== 'integration.symmy.symmy-source-organization-facts.read' ||
    rule.workloadKey !== 'integration.symmy.source-organization-facts.read' ||
    rule.legalEntityScope !== 'required' ||
    gatewayPublishedOperationAccess(destination, rule.entrypointKey, rule.schemaVersion) !== 'read'
  ) {
    return yield* delegationForbidden('processing_read_refused')();
  }
  const processingWorkload = yield* Schema.decodeUnknownEffect(RegisteredGatewayWorkloadSchema)({
    ...admitted.workload,
    organizationProcessingRead: { requestHash: subject.processingRequestHash },
  }).pipe(Effect.mapError(delegationForbidden('source_evidence_malformed')));
  return {
    ...admitted,
    organizationProcessingWitness: new AdmittedOrganizationProcessingReadValue(processingMintKey, {
      compositionRevision: installed.composition.revision,
      principal: admitted.principal,
      sourceValidity: sourceEvidence.sourceValidity,
      workload: processingWorkload,
    }),
    workload: snapshotRegisteredGatewayWorkload(processingWorkload),
  };
});

const admittedSourceMatchesBinding = (
  evidence: ReturnType<typeof readVerifiedGatewayAssertion>,
  binding: GatewayModuleBinding,
  installed: ShellInstalledCatalog,
) =>
  evidence !== undefined &&
  evidence.workload !== undefined &&
  evidence.workload.organizationProcessingRead === undefined &&
  evidence.providerKeyId === binding.providerKeyId &&
  evidence.sourceAppId === binding.sourceAppId &&
  evidence.sourceBuildMarker === binding.sourceBuildMarker &&
  evidence.compositionRevision === binding.compositionRevision &&
  evidence.compositionRevision === installed.composition.revision;

/** A verified owner request can obtain only an explicitly enrolled downstream workload operation. */
export const admitRegisteredAssertionWorkload = Effect.fn('GatewayDelegation.admitRegisteredAssertion')(
  function* registeredAssertion(input: {
    readonly audience: string;
    readonly binding: GatewayModuleBinding;
    readonly installed: ShellInstalledCatalog;
    readonly source: VerifiedGatewayAssertion;
    readonly subject: Subject;
  }) {
    const { binding, installed, subject } = input;
    const sourceEvidence = readVerifiedGatewayAssertion(input.source);
    if (!admittedSourceMatchesBinding(sourceEvidence, binding, installed) || sourceEvidence?.workload === undefined) {
      return yield* delegationForbidden('subject_assertion_not_attested')();
    }
    const { principal: sourcePrincipal, workload } = sourceEvidence;
    const source = installed.contracts.find((contract) => contract.deployment.appId === binding.sourceAppId);
    const destination = installed.contracts.find((contract) => contract.deployment.appId === input.audience);
    const rules = (binding.registeredWorkloads ?? []).filter(
      (rule) =>
        rule.audience === input.audience &&
        rule.declarationKey === subject.declarationKey &&
        rule.sourceWorkloadKey === workload.workloadKey &&
        (rule.allowRecoverySource === true) === (workload.recovery !== undefined) &&
        rule.workerKey === undefined &&
        rule.sourceActionKey === undefined,
    );
    const [rule] = rules;
    if (
      rules.length !== 1 ||
      rule === undefined ||
      source === undefined ||
      destination === undefined ||
      source.deployment.buildMarker !== binding.sourceBuildMarker ||
      binding.compositionRevision !== installed.composition.revision ||
      (rule.legalEntityScope === 'required' && workload.legalEntityId === undefined)
    ) {
      return yield* delegationForbidden('registered_workload_unmatched')();
    }
    const sourceAccess = gatewayPublishedOperationAccess(source, workload.entrypointKey, workload.schemaVersion);
    if (sourceAccess === undefined) {
      return yield* delegationForbidden('registered_operation_refused')();
    }
    const targetLegalEntityId = rule.legalEntityScope === 'forbidden' ? undefined : workload.legalEntityId;
    const conditionalWitness: GatewayConditionalOperationWitness | undefined =
      subject.operationRequirementKey === undefined
        ? undefined
        : {
            requirementKey: subject.operationRequirementKey,
            sourceEntrypointKey: workload.entrypointKey,
            sourceSchemaVersion: workload.schemaVersion,
          };
    if (
      !gatewayRegisteredOperationContractAllows(source, destination, rule, targetLegalEntityId, conditionalWitness) ||
      !sourceModeAllowsTarget(workload, subject, rule, destination)
    ) {
      return yield* delegationForbidden('registered_operation_refused')();
    }
    const admitted = yield* (yield* GatewayNativeEvidence).admitAssertion({
      binding,
      destination,
      rule,
      source,
      sourceAccess,
      sourcePrincipal,
      subject,
      workload,
    });
    return yield* finishRegisteredAssertion({
      admitted,
      audience: input.audience,
      binding,
      destination,
      installed,
      rule,
      source,
      sourceEvidence,
      subject,
      workload,
    });
  },
);
