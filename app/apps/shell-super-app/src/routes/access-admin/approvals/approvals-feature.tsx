import { Effect } from 'effect';
import { startTransition, useActionState, useRef } from 'react';
import type { RefObject } from 'react';

import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import {
  decideApproval,
  executeApproval,
  refreshApprovals,
} from '../../[lang]/access/approvals/approvals-page-model.ts';
import type { ApprovalsContentModel } from '../../[lang]/access/approvals/approvals-page-model.ts';
import { approvalFailureState } from './approvals-contract.ts';
import type { ApprovalClientFailure, ApprovalDecision, ApprovalsClient } from './approvals-contract.ts';
import { ApprovalsInbox } from './approvals-inbox.tsx';

type InboxAction =
  | { readonly kind: 'refresh' }
  | { readonly kind: 'next' }
  | { readonly decision: ApprovalDecision; readonly id: string; readonly kind: 'decide' }
  | { readonly id: string; readonly kind: 'execute' };

type RetryIdentity = { readonly identity: string; readonly key: string } | undefined;
interface InboxOperation {
  readonly action: InboxAction;
  readonly client: ApprovalsClient;
  readonly createKey: Effect.Effect<string, ApprovalClientFailure>;
  readonly previous: ApprovalsContentModel;
  readonly request: Request;
  readonly retryIdentity: RefObject<RetryIdentity>;
}

const performInboxAction = Effect.fn('ApprovalsFeature.performInboxAction')(function* performInboxActionEffect({
  action,
  client,
  createKey,
  previous,
  request,
  retryIdentity,
}: InboxOperation) {
  if (action.kind === 'refresh' || action.kind === 'next') {
    return yield* refreshApprovals(
      request,
      client,
      action.kind === 'next' && previous.state === 'ready' ? (previous.nextCursor ?? undefined) : undefined,
    );
  }
  const item = previous.state === 'ready' ? previous.items.find((candidate) => candidate.id === action.id) : undefined;
  if (item === undefined) {
    return { state: 'forbidden' } as const;
  }
  const decision = action.kind === 'decide' ? action.decision : 'execute';
  const identity = `${item.id}:${item.revision}:${decision}`;
  if (retryIdentity.current?.identity !== identity) {
    const key = yield* createKey;
    retryIdentity.current = { identity, key };
  }
  const { key } = retryIdentity.current;
  return action.kind === 'decide'
    ? yield* decideApproval(previous, item.id, action.decision, request, client, key)
    : yield* executeApproval(previous, item.id, request, client, key);
});

/** Feature integration owns Effects, retry identities and the synchronous duplicate-submit fence. */
export const ApprovalsFeature = ({
  client,
  createKey,
  initial,
}: {
  readonly client: ApprovalsClient;
  readonly createKey: Effect.Effect<string, ApprovalClientFailure>;
  readonly initial: ApprovalsContentModel;
}) => {
  const inFlight = useRef(false);
  const retryIdentity = useRef<RetryIdentity>(undefined);
  const [model, dispatch, pending] = useActionState((previous: ApprovalsContentModel, action: InboxAction) => {
    const operation = performInboxAction({
      action,
      client,
      createKey,
      previous,
      request: new Request(window.location.href),
      retryIdentity,
    }).pipe(
      Effect.match({
        onFailure: (failure): ApprovalsContentModel => ({ state: approvalFailureState(failure) }),
        onSuccess: (content) => content,
      }),
      Effect.ensuring(
        Effect.sync(() => {
          inFlight.current = false;
        }),
      ),
    );
    return browserRuntime.runPromise(operation);
  }, initial);
  const submit = (action: InboxAction) => {
    // React's pending render is not synchronous: fence before dispatch so two same-tick clicks cannot queue writes.
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    startTransition(() => dispatch(action));
  };
  return (
    <ApprovalsInbox
      model={model}
      onDecision={(id, decision) => submit({ decision, id, kind: 'decide' })}
      onExecute={(id) => submit({ id, kind: 'execute' })}
      onNextPage={() => submit({ kind: 'next' })}
      onRefresh={() => submit({ kind: 'refresh' })}
      pending={pending}
    />
  );
};
