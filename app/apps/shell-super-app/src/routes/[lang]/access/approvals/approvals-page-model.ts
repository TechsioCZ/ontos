import { DateTime, Effect, Match } from 'effect';

import type { AccessApprovalSchema } from '../../../../../shared/access-admin-api.ts';
import { approvalFailureState } from '../../../access-admin/approvals/approvals-contract.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { approvalsClient } from '../../../access-admin/approvals/approvals-client.ts';
import type {
  ApprovalDecision,
  ApprovalItem,
  ApprovalsClient,
  ApprovalsList,
} from '../../../access-admin/approvals/approvals-contract.ts';
import { loadHomePageModel } from '../../home-page-model.ts';
import type { HomePageModel } from '../../home-page-model.ts';

const requestTimeout = '30 seconds';

type EncodedApproval = typeof AccessApprovalSchema.Encoded;

export interface ApprovalCardModel {
  readonly approval:
    | {
        readonly approvalExpiresAt: NonNullable<EncodedApproval['approver']>['approvalExpiresAt'];
        readonly approvedAt: NonNullable<EncodedApproval['approver']>['approvedAt'];
        readonly approverName: string | undefined;
      }
    | undefined;
  readonly canApprove: boolean;
  readonly canExecute: boolean;
  readonly canReject: boolean;
  readonly canWithdraw: boolean;
  readonly capability: string;
  readonly command: {
    readonly actionKey: string;
    readonly digestShort: string;
    readonly fields: readonly { readonly label: string; readonly value: string }[];
    readonly frozenAt: EncodedApproval['command']['frozenAt'];
    readonly redactedFieldCount: number;
    readonly targetLabel: string | undefined;
  };
  readonly createdAt: EncodedApproval['createdAt'];
  readonly executionReasonKey: string;
  readonly expiresAt: EncodedApproval['expiresAt'];
  readonly id: ApprovalItem['proposalId'];
  readonly requesterKind: 'human' | 'agent';
  readonly requesterName: string | undefined;
  readonly revision: string;
  readonly risk: ApprovalItem['risk'];
  readonly scopeKind: 'tenant' | 'company';
  readonly status: ApprovalItem['status'];
  readonly title: string;
}

export type ApprovalsContentModel =
  | {
      readonly items: readonly ApprovalCardModel[];
      readonly nextCursor: string | null;
      readonly revision: string;
      readonly state: 'ready';
    }
  | {
      readonly state:
        | 'loading'
        | 'unauthenticated'
        | 'forbidden'
        | 'conflict'
        | 'invalid'
        | 'unavailable'
        | 'reload_required';
    };

export interface ApprovalsPageModel {
  readonly content: ApprovalsContentModel;
  readonly shell: HomePageModel;
}

const executionReasonKey = (reason: string): string =>
  Match.value(reason).pipe(
    Match.when('mandate_runner_unproven', () => 'shell.accessAdmin.approvals.executeDisabled'),
    Match.when('approval_execution_disabled', () => 'shell.accessAdmin.approvals.executeUnavailable'),
    Match.when('not_approver', () => 'shell.accessAdmin.approvals.notEligible'),
    Match.when('mandate_expired', () => 'shell.accessAdmin.reason.deny.deadline_passed'),
    Match.when('agent_forbidden', () => 'shell.accessAdmin.approvals.humanOnly'),
    Match.orElse(() => 'shell.accessAdmin.common.unavailable'),
  );

/** Only display server-projected facts. Dates are server deadlines, never recomputed with a browser clock. */
export const approvalsViewModel = (response: ApprovalsList): ApprovalsContentModel => ({
  items: response.items.map((item) => ({
    approval:
      item.approver === undefined
        ? undefined
        : {
            approvalExpiresAt: DateTime.formatIso(item.approver.approvalExpiresAt),
            approvedAt: DateTime.formatIso(item.approver.approvedAt),
            approverName: item.approver.displayName,
          },
    canApprove: item.requester.kind === 'human' && item.status === 'pending' && item.permitted.approval.allowed,
    canExecute: item.requester.kind === 'human' && item.status === 'approved' && item.execution.available,
    canReject: item.status === 'pending' && item.permitted.rejection.allowed,
    canWithdraw: (item.status === 'pending' || item.status === 'approved') && item.permitted.withdrawal.allowed,
    capability: item.capabilityKey,
    command: {
      actionKey: item.command.actionKey,
      digestShort: item.command.digestShort,
      fields: item.command.fields,
      frozenAt: DateTime.formatIso(item.command.frozenAt),
      redactedFieldCount: item.command.redactedFieldCount,
      targetLabel: item.command.target?.label,
    },
    createdAt: DateTime.formatIso(item.createdAt),
    executionReasonKey: executionReasonKey(item.execution.reason),
    expiresAt: DateTime.formatIso(item.expiresAt),
    id: item.proposalId,
    requesterKind: item.requester.kind,
    requesterName: item.requester.displayName,
    revision: item.revision,
    risk: item.risk,
    scopeKind: item.scope.kind,
    status: item.status,
    title: item.capabilityLabel,
  })),
  nextCursor: response.nextCursor,
  revision: response.items.map((item) => `${item.proposalId}:${item.revision}`).join(','),
  state: 'ready',
});

export const refreshApprovals = (
  request: Request,
  client: ApprovalsClient,
  cursor?: string,
): Effect.Effect<ApprovalsContentModel> =>
  client.list(request, cursor).pipe(
    Effect.timeout(requestTimeout),
    Effect.match({
      onFailure: (error): ApprovalsContentModel => ({ state: approvalFailureState(error) }),
      onSuccess: approvalsViewModel,
    }),
  );

export const loadApprovalsPage = (
  request: Request,
  client: ApprovalsClient = approvalsClient,
): Effect.Effect<ApprovalsPageModel> =>
  loadHomePageModel(request).pipe(
    Effect.flatMap((shell) => {
      if (shell.state === 'authenticated') {
        // Tenant authentication is sufficient; selected company and business navigation are not prerequisites (O28).
        return refreshApprovals(request, client).pipe(Effect.map((content) => ({ content, shell })));
      }
      return Effect.succeed<ApprovalsPageModel>({
        content: { state: shell.state === 'anonymous' ? 'unauthenticated' : shell.state },
        shell,
      });
    }),
  );

export const decideApproval = (
  model: ApprovalsContentModel,
  proposalId: string,
  decision: ApprovalDecision,
  request: Request,
  client: ApprovalsClient,
  idempotencyKey: string,
): Effect.Effect<ApprovalsContentModel> => {
  const item = model.state === 'ready' ? model.items.find((candidate) => candidate.id === proposalId) : undefined;
  const permitted =
    item !== undefined && { approve: item.canApprove, reject: item.canReject, withdraw: item.canWithdraw }[decision];
  if (item === undefined || !permitted || (item.status !== 'pending' && item.status !== 'approved')) {
    return Effect.succeed({ state: 'forbidden' });
  }
  // A preview is never a command payload. No digest, actor, scope or permission flag is sent back.
  return client
    .decide(
      { decision, expectedStatus: item.status, proposalId: item.id, revision: item.revision },
      request,
      idempotencyKey,
    )
    .pipe(
      Effect.timeout(requestTimeout),
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed<ApprovalsContentModel>({ state: approvalFailureState(error) }),
        onSuccess: () => refreshApprovals(request, client),
      }),
    );
};

export const executeApproval = (
  model: ApprovalsContentModel,
  proposalId: string,
  request: Request,
  client: ApprovalsClient,
  idempotencyKey: string,
): Effect.Effect<ApprovalsContentModel> => {
  const item = model.state === 'ready' ? model.items.find((candidate) => candidate.id === proposalId) : undefined;
  if (item === undefined || !item.canExecute || item.status !== 'approved') {
    return Effect.succeed({ state: 'forbidden' });
  }
  return client
    .execute({ expectedStatus: 'approved', proposalId: item.id, revision: item.revision }, request, idempotencyKey)
    .pipe(
      Effect.timeout(requestTimeout),
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed<ApprovalsContentModel>({ state: approvalFailureState(error) }),
        onSuccess: () => refreshApprovals(request, client),
      }),
    );
};

export const loader = ({ request }: { readonly request: Request }): Promise<ApprovalsPageModel> =>
  browserRuntime.runPromise(loadApprovalsPage(request), { signal: request.signal });
