import type { OutboxMessage } from './outbox-message.ts';

// oxlint-disable-next-line typescript/consistent-type-definitions
export type OperationAccessKind = 'read' | 'list' | 'search' | 'export' | 'download';
export type OperationActionInvocationStatus =
  | 'received'
  | 'replayed'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rejected';
export type OperationAuditOutcome = 'allowed' | 'denied' | 'succeeded' | 'failed';
export type OperationAuditProfile = 'standard' | 'sensitive' | 'minimal';
export type OperationAuditStage =
  | 'system'
  | 'authn'
  | 'authz'
  | 'policy'
  | 'validation'
  | 'execution';
export type OperationEvidenceCaptureMode =
  | 'metadata_only'
  | 'hash_only'
  | 'redacted_payload'
  | 'stored_artifact';

export interface OperationContext<TAction> {
  addOutboxMessage?: (message: OutboxMessage<string, unknown>) => void;
  action: TAction;
  actionKey: string;
  actionInvocation?: {
    actionInvocationId: string;
    idempotencyKey?: string;
    requestHash: string;
    status: OperationActionInvocationStatus;
  };
  auditEvents?: readonly {
    auditEventId: string;
    auditProfile: OperationAuditProfile;
    eventType: string;
    outcome: OperationAuditOutcome;
    outcomeCode: string;
    outcomeStage: OperationAuditStage;
  }[];
  authorizationChecks?: readonly {
    decision: 'allowed' | 'denied';
    mode: 'check_permission' | 'placeholder';
    permission?: string;
    provider: 'spicedb';
    reason: string;
    resourceObjectId?: string;
    resourceObjectType?: string;
  }[];
  dataAccessEvents?: readonly {
    accessKind: OperationAccessKind;
    dataAccessEventId: string;
    evidenceCaptureMode: OperationEvidenceCaptureMode;
    evidencePolicyKey: string;
    queryHash: string;
    resultCount: number;
    servingModuleKey: string;
  }[];
  gatewayAudience: string;
  legalEntityId: string;
  policyChecks?: readonly {
    decision: 'allowed' | 'denied';
    mode: 'action-policy' | 'placeholder';
    policyKey: string;
    reason: string;
  }[];
  principalId: string;
  tenantId: string;
}
