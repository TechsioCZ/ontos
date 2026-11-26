/**
 * What the Shell hands the component a module offers on the Integrace card of one connector partner's integrations
 * (the core `integration` placement of a public component). The card shows the integration and its keys; the component
 * shows what the partner's own module manages for it.
 *
 * Core identity administration stays the Shell's: the component asks for one of exactly these Core writes, only after
 * the administrator confirmed it, and never calls Core itself. The request is plain data and the answer a plain
 * callback, because the Shell and a remote share no Effect runtime.
 */
import { Schema } from 'effect';

import type { AgentPrincipalIdSchema } from '../agent-proposals.ts';

export const ConnectorPartnerModuleKeySchema = Schema.String.pipe(Schema.brand('ModuleKey'));
export const ConnectorPartnerWorkloadKeySchema = Schema.String.pipe(Schema.brand('WorkloadKey'));
export type ConnectorPartnerWorkloadKey = typeof ConnectorPartnerWorkloadKeySchema.Type;

export const ConnectorPartnerCoreWriteSchema = Schema.Union([
  /** `core.identity.change-system-workload-enrollment`: enroll the Tenant's system Principal for one system workload. */
  Schema.Struct({
    kind: Schema.Literal('enrollSystemWorkload'),
    moduleKey: ConnectorPartnerModuleKeySchema,
    reason: Schema.String,
    workloadKey: ConnectorPartnerWorkloadKeySchema,
  }),
  /** `core.identity.register-integration-workloads`: bind workloads to this integration in the selected company. */
  Schema.Struct({
    kind: Schema.Literal('registerIntegrationWorkloads'),
    workloadKeys: Schema.NonEmptyArray(ConnectorPartnerWorkloadKeySchema),
  }),
]);
export type ConnectorPartnerCoreWrite = typeof ConnectorPartnerCoreWriteSchema.Type;

/** Whether the Shell's Core write went through; a failed write may or may not have happened. */
export const ConnectorPartnerCoreWriteOutcomeSchema = Schema.Literals(['done', 'failed']);
export type ConnectorPartnerCoreWriteOutcome = typeof ConnectorPartnerCoreWriteOutcomeSchema.Type;

export type ConnectorPartnerPrincipalId = typeof AgentPrincipalIdSchema.Type;

export interface ConnectorPartnerComponentProps {
  /** The active integration Principal the card shows. */
  readonly integrationPrincipalId: ConnectorPartnerPrincipalId;
  /** Makes one confirmed Core write for this integration and calls `settle` once with its outcome. */
  readonly writeCore: (
    write: ConnectorPartnerCoreWrite,
    settle: (outcome: ConnectorPartnerCoreWriteOutcome) => void,
  ) => void;
}
