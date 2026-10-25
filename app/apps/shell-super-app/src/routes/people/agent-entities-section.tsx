import { EmptyState, SectionCard, dialogCloseLabel, formatDateTime, surfaceTileClassName } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import type {
  AgentAuditEntry,
  AgentEntity,
  AgentEntityOverview,
  AgentModuleOption,
  ConnectionSummary,
  ManageAgentEntityRequest,
  PrincipalRef,
} from '@app/shared-contracts/agent-access';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Skeleton } from '@techsio/ui-kit/atoms/skeleton';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { Effect, Match, Option, Schema } from 'effect';
import { useEffect, useRef, useState } from 'react';
import { revokeAgentConnection, runAgentCommand, saveAgentOperators } from './agent-entities-client.ts';
import type { AgentFailure } from './agent-entities-client.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { usePageData } from './use-agent-page-data.ts';
import { newRequestToken } from './people-client.ts';
import { AgentEditorPanel } from './agent-editor-panel.tsx';
import { agentEntitiesData } from './agent-data.ts';

const key = 'shell.agents.section';
const connectionsKey = 'shell.agents.connections';
const PEOPLE_KEY = 'shell.agents';
const PEOPLE_ERROR_KEY = `${PEOPLE_KEY}.errors`;
const AUDIT_LIMIT = 8;
const STATUS_OPERATION = 'change-status';
const AgentDetailSearchSchema = Schema.Struct({ agent: Schema.optionalKey(Schema.String) });

const statusVariant = { active: 'success', archived: 'outline', disabled: 'danger' } as const;

type Notify = (title: string, description?: string) => void;

type EditingState = { readonly mode: 'create' } | { readonly agent: AgentEntity; readonly mode: 'edit' };

interface AgentStatusAction {
  readonly agent: AgentEntity;
  readonly kind: 'activate' | 'deactivate' | 'delete';
}

export interface AgentEntitiesSectionProps {
  /** Key of the prepared agent dataset (see `agent-data.ts`). */
  readonly legalEntityId: string;
  readonly onNotify: (title: string, description?: string) => void;
}

const sameIds = (left: readonly string[], right: readonly string[]) => {
  const rightIds = new Set(right);
  return left.length === right.length && left.every((id) => rightIds.has(id));
};

interface ConnectionRowProps {
  readonly connection: ConnectionSummary;
  readonly onRevoked: (message: string) => void;
}

const ConnectionRow = ({ connection, onRevoked }: ConnectionRowProps) => {
  const { t } = useModernI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const [failure, setFailure] = useState<AgentFailure | null>(null);
  const clientName = connection.client.name;

  const close = () => {
    setOpen(false);
    setReason('');
    setReasonMissing(false);
    setFailure(null);
  };

  const confirm = () => {
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setReasonMissing(true);
      return;
    }
    setBusy(true);
    setFailure(null);
    browserRuntime.runFork(
      revokeAgentConnection({ grantId: connection.grantId, reason: trimmed }).pipe(
        Effect.andThen((outcome) =>
          Effect.sync(() => {
            setBusy(false);
            if (outcome.status === 'failed') {
              setFailure(outcome.reason);
              return;
            }
            close();
            onRevoked(t(`${connectionsKey}.list.revoked`, { client: clientName }));
          }),
        ),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    );
  };

  return (
    <li className="flex flex-wrap items-center justify-between gap-150 border-border-primary/60 border-b py-150 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-50">
        <div className="flex min-w-0 flex-wrap items-center gap-100">
          <span className="font-medium">{clientName}</span>
          <Badge size="sm" variant="outline">
            {connection.client.host}
          </Badge>
        </div>
        <p className="text-fg-secondary text-xs">
          {t(`${connectionsKey}.list.connectedBy`, {
            name: connection.delegatedBy?.displayName ?? connection.user.displayName,
          })}
        </p>
        <p className="text-fg-secondary text-xs tabular-nums">
          {connection.lastUsedAt === null
            ? t(`${connectionsKey}.list.neverUsed`)
            : t(`${connectionsKey}.list.lastUsed`, { date: formatDateTime(connection.lastUsedAt) })}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-100">
        <Badge size="sm" variant="outline">
          {t(`${connectionsKey}.policy.${connection.writePolicy}`)}
        </Badge>
        <Button
          onClick={() => {
            setFailure(null);
            setOpen(true);
          }}
          size="sm"
          variant="danger"
        >
          {t(`${connectionsKey}.list.revoke`)}
        </Button>
      </div>
      <Dialog
        actions={
          <>
            <Button onClick={close} theme="outlined" type="button" variant="secondary">
              {t(`${connectionsKey}.list.cancel`)}
            </Button>
            <Button disabled={busy} isLoading={busy} onClick={confirm} type="button" variant="danger">
              {t(`${connectionsKey}.list.confirm`)}
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description={t(`${connectionsKey}.list.dialogDescription`)}
        onOpenChange={(details) => {
          if (details.open) {
            setOpen(true);
          } else if (!busy) {
            close();
          }
        }}
        open={open}
        role="alertdialog"
        size="sm"
        title={t(`${connectionsKey}.list.dialogTitle`, { client: clientName })}
      >
        <div className="flex min-w-0 flex-col gap-150">
          <FormTextarea
            id={`agent-connection-reason-${connection.grantId}`}
            label={t(`${connectionsKey}.list.reason`)}
            name="reason"
            onChange={(event) => {
              setReasonMissing(false);
              setReason(event.target.value);
            }}
            required
            rows={2}
            value={reason}
          />
          {reasonMissing && (
            <StatusText showIcon status="error">
              {t(`${connectionsKey}.list.reasonRequired`)}
            </StatusText>
          )}
          {failure !== null && (
            <StatusText showIcon status="error">
              {t(`${PEOPLE_ERROR_KEY}.${failure}`)}
            </StatusText>
          )}
        </div>
      </Dialog>
    </li>
  );
};

interface ConnectionsBlockProps {
  readonly agent: AgentEntity;
  readonly onChanged: () => void;
  readonly onNotify: Notify;
}

const ConnectionsBlock = ({ agent, onChanged, onNotify }: ConnectionsBlockProps) => {
  const { t } = useModernI18n();
  return (
    <section className="flex min-w-0 flex-col gap-150">
      <h3 className="font-semibold text-sm">{t(`${connectionsKey}.list.title`)}</h3>
      {agent.connections.length === 0 ? (
        <p className="text-fg-secondary text-sm">{t(`${connectionsKey}.list.empty`)}</p>
      ) : (
        <ul className="flex min-w-0 flex-col">
          {agent.connections.map((connection) => (
            <ConnectionRow
              connection={connection}
              key={connection.grantId}
              onRevoked={(message) => {
                onNotify(message);
                onChanged();
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
};

interface OperatorsBlockProps {
  readonly agent: AgentEntity;
  readonly company: string;
  readonly members: readonly PrincipalRef[];
  readonly onChanged: () => void;
  readonly onNotify: Notify;
}

const OperatorsBlock = ({ agent, company, members, onChanged, onNotify }: OperatorsBlockProps) => {
  const { t } = useModernI18n();
  const initialIds = agent.operators.map((operator) => operator.principalId);
  const [selected, setSelected] = useState<readonly string[]>(initialIds);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AgentFailure | null>(null);
  const [confirming, setConfirming] = useState(false);
  const dirty = !sameIds(selected, initialIds);
  const initialSet = new Set(initialIds);
  const selectedSet = new Set(selected);
  // Connections that saving would cut: the agent connected by people who are being removed.
  const cut = agent.connections.filter(
    (connection) =>
      connection.delegatedBy !== null &&
      initialSet.has(connection.delegatedBy.principalId) &&
      !selectedSet.has(connection.delegatedBy.principalId),
  );
  const cutNames = [...new Set(cut.map((connection) => connection.delegatedBy?.displayName ?? ''))].join(', ');

  const toggle = (principalId: string, checked: boolean) =>
    setSelected((current) =>
      checked
        ? [...current.filter((id) => id !== principalId), principalId]
        : current.filter((id) => id !== principalId),
    );

  const save = () => {
    setConfirming(false);
    setBusy(true);
    setFailure(null);
    browserRuntime.runFork(
      saveAgentOperators({ agentPrincipalId: agent.principalId, operatorPrincipalIds: [...selected] }).pipe(
        Effect.andThen((outcome) =>
          Effect.sync(() => {
            setBusy(false);
            if (outcome.status === 'failed') {
              setFailure(outcome.reason);
              return;
            }
            onNotify(t(`${connectionsKey}.operators.saved`, { name: agent.displayName }));
            if (outcome.value.revokedConnections > 0) {
              onNotify(t(`${connectionsKey}.operators.revoked`, { count: outcome.value.revokedConnections }));
            }
            onChanged();
          }),
        ),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    );
  };

  return (
    <section className="flex min-w-0 flex-col gap-150">
      <h3 className="font-semibold text-sm">{t(`${connectionsKey}.operators.title`)}</h3>
      <p className="text-fg-secondary text-xs">{t(`${connectionsKey}.operators.hint`, { company })}</p>
      <div className="flex flex-col gap-100">
        {members.map((member) => (
          <FormCheckbox
            checked={selectedSet.has(member.principalId)}
            id={`agent-operator-${agent.principalId}-${member.principalId}`}
            key={member.principalId}
            label={member.displayName}
            onCheckedChange={(checked) => toggle(member.principalId, checked)}
            size="sm"
          />
        ))}
      </div>
      {selected.length === 0 && <p className="text-fg-secondary text-xs">{t(`${connectionsKey}.operators.empty`)}</p>}
      {failure !== null && (
        <StatusText showIcon status="error">
          {t(`${PEOPLE_ERROR_KEY}.${failure}`)}
        </StatusText>
      )}
      <div>
        <Button
          disabled={!dirty || busy}
          isLoading={busy}
          loadingText={t(`${connectionsKey}.operators.saving`)}
          onClick={() => (cut.length > 0 ? setConfirming(true) : save())}
          size="sm"
          variant="primary"
        >
          {t(`${connectionsKey}.operators.save`)}
        </Button>
      </div>
      <Dialog
        actions={
          <>
            <Button onClick={() => setConfirming(false)} theme="outlined" type="button" variant="secondary">
              {t(`${connectionsKey}.operators.cancel`)}
            </Button>
            <Button disabled={busy} onClick={save} type="button" variant="danger">
              {t(`${connectionsKey}.operators.confirm`)}
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description={t(`${connectionsKey}.operators.confirmDescription`, { count: cut.length, names: cutNames })}
        onOpenChange={(details) => setConfirming(details.open)}
        open={confirming}
        role="alertdialog"
        size="sm"
        title={t(`${connectionsKey}.operators.confirmTitle`)}
      />
    </section>
  );
};

interface AgentCardProps {
  readonly agent: AgentEntity;
  readonly company: string;
  readonly highlighted: boolean;
  readonly members: readonly PrincipalRef[];
  readonly modules: readonly AgentModuleOption[];
  readonly onChanged: () => void;
  readonly onEdit: () => void;
  readonly onNotify: Notify;
  readonly onStatus: (action: AgentStatusAction) => void;
}

const AgentCard = ({
  agent,
  company,
  highlighted,
  members,
  modules,
  onChanged,
  onEdit,
  onNotify,
  onStatus,
}: AgentCardProps) => {
  const { t } = useModernI18n();
  const moduleLabel = (moduleId: string) => modules.find((option) => option.moduleId === moduleId)?.label ?? moduleId;
  const readable = agent.modules.map((grant) => moduleLabel(grant.moduleId)).join(', ');
  const writable = agent.modules
    .flatMap((grant) => (grant.access === 'write' ? [moduleLabel(grant.moduleId)] : []))
    .join(', ');

  let writeLine = t(`${key}.noWrites`);
  if (writable !== '' && agent.writePolicy === 'direct') {
    writeLine = t(`${key}.writes`, { modules: writable });
  } else if (writable !== '' && agent.writePolicy === 'approval') {
    writeLine = t(`${key}.proposes`, { modules: writable });
  }

  return (
    <article
      aria-current={highlighted ? 'true' : undefined}
      className={`${surfaceTileClassName} flex flex-col gap-200 p-250 scroll-mt-20 ${highlighted ? 'ring-2 ring-primary' : ''}`}
      id={`agent-${agent.principalId}`}
      tabIndex={highlighted ? -1 : undefined}
    >
      <header className="flex flex-wrap items-start justify-between gap-150">
        <div className="flex min-w-0 flex-wrap items-center gap-100">
          <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{agent.displayName}</span>
          <Badge size="sm" variant={statusVariant[agent.status]}>
            {t(`${connectionsKey}.status.${agent.status}`)}
          </Badge>
          <Badge size="sm" variant="outline">
            {agent.hasProfile ? t(`${connectionsKey}.policy.${agent.writePolicy}`) : t(`${key}.noProfile`)}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-100">
          <Button onClick={onEdit} size="sm" theme="outlined" variant="secondary">
            {t(`${key}.edit`)}
          </Button>
          {agent.status === 'active' ? (
            <Button onClick={() => onStatus({ agent, kind: 'deactivate' })} size="sm" theme="outlined" variant="danger">
              {t(`${key}.deactivate`)}
            </Button>
          ) : (
            <Button
              onClick={() => onStatus({ agent, kind: 'activate' })}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {t(`${key}.activate`)}
            </Button>
          )}
          <Button onClick={() => onStatus({ agent, kind: 'delete' })} size="sm" variant="danger">
            {t(`${key}.delete`)}
          </Button>
        </div>
      </header>

      {agent.description !== null && <p className="text-sm">{agent.description}</p>}

      <p className="text-fg-secondary text-xs">
        {agent.owner === null ? t(`${key}.noOwner`) : t(`${key}.owner`, { name: agent.owner.displayName })}
      </p>

      {agent.hasProfile ? (
        <div className="flex min-w-0 flex-col gap-50">
          {readable !== '' && <p className="text-sm">{t(`${key}.reads`, { modules: readable })}</p>}
          <p className="text-sm">{writeLine}</p>
        </div>
      ) : (
        <p className="text-fg-secondary text-sm">{t(`${key}.noProfileDescription`)}</p>
      )}

      {agent.status === 'disabled' && (
        <StatusText showIcon status="warning">
          {t(`${key}.disabledNotice`)}
        </StatusText>
      )}

      <div className="grid grid-cols-1 gap-200 lg:grid-cols-2">
        <OperatorsBlock
          agent={agent}
          company={company}
          // Remount when the server-side operator set changes, so the selection restarts from it.
          key={agent.operators.map((operator) => operator.principalId).join(',')}
          members={members}
          onChanged={onChanged}
          onNotify={onNotify}
        />
        <ConnectionsBlock agent={agent} onChanged={onChanged} onNotify={onNotify} />
      </div>
    </article>
  );
};

const statusCopy = {
  activate: {
    confirmKey: 'activateConfirm',
    descriptionKey: 'activateDescription',
    reasonKey: null,
    titleKey: 'activateTitle',
    toastKey: 'activated',
    variant: 'primary',
  },
  deactivate: {
    confirmKey: 'deactivateConfirm',
    descriptionKey: 'deactivateDescription',
    reasonKey: 'deactivateReason',
    titleKey: 'deactivateTitle',
    toastKey: 'deactivated',
    variant: 'danger',
  },
  delete: {
    confirmKey: 'deleteConfirm',
    descriptionKey: 'deleteDescription',
    reasonKey: 'deleteReason',
    titleKey: 'deleteTitle',
    toastKey: 'deleted',
    variant: 'danger',
  },
} as const;

interface AgentStatusDialogProps {
  readonly action: AgentStatusAction;
  readonly onChanged: () => void;
  readonly onClose: () => void;
  readonly onNotify: Notify;
}

/** Deactivates, reactivates or deletes one agent; deactivation and deletion need a reason for the audit trail. */
const AgentStatusDialog = ({ action, onChanged, onClose, onNotify }: AgentStatusDialogProps) => {
  const { t } = useModernI18n();
  const { agent, kind } = action;
  const copy = statusCopy[kind];
  const [reason, setReason] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const requestIdentity = useRef<{ readonly reason: string; readonly token: string } | null>(null);

  const confirm = () => {
    if (agent.status === 'archived') {
      return;
    }
    const expectedStatus = agent.status;
    const trimmed = reason.trim();
    if (copy.reasonKey !== null && trimmed.length === 0) {
      setReasonMissing(true);
      return;
    }
    const request: ManageAgentEntityRequest = Match.value(kind).pipe(
      Match.when('deactivate', (): ManageAgentEntityRequest => ({
        expectedStatus: 'active' as const,
        newStatus: 'disabled' as const,
        operation: STATUS_OPERATION,
        principalId: agent.principalId,
        reason: trimmed,
      })),
      Match.when('activate', (): ManageAgentEntityRequest => ({
        expectedStatus: 'disabled' as const,
        newStatus: 'active' as const,
        operation: STATUS_OPERATION,
        principalId: agent.principalId,
      })),
      Match.when('delete', () => ({
        expectedStatus,
        operation: 'delete' as const,
        principalId: agent.principalId,
        reason: trimmed,
      })),
      Match.exhaustive,
    );
    setBusy(true);
    setFailure(null);
    // A failed response may follow a committed Action. Retry the exact command with its original key.
    const identity = requestIdentity.current;
    const token =
      identity !== null && identity.reason === trimmed
        ? Effect.succeed(identity.token)
        : newRequestToken.pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                requestIdentity.current = { reason: trimmed, token: value };
              }),
            ),
          );
    browserRuntime.runFork(
      token.pipe(
        Effect.flatMap((value) => runAgentCommand(request, `agent-${value}`)),
        Effect.andThen((outcome) =>
          Effect.sync(() => {
            setBusy(false);
            if (outcome.status === 'failed') {
              setFailure(outcome.detail ?? t(`${PEOPLE_ERROR_KEY}.${outcome.reason}`));
              return;
            }
            onClose();
            onNotify(
              t(`${key}.toast.${copy.toastKey}`, { name: agent.displayName }),
              outcome.value.revokedConnections > 0
                ? t(`${key}.toast.revoked`, { count: outcome.value.revokedConnections })
                : undefined,
            );
            onChanged();
          }),
        ),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    );
  };

  return (
    <Dialog
      actions={
        <>
          <Button
            onClick={() => {
              if (!busy) {
                onClose();
              }
            }}
            theme="outlined"
            type="button"
            variant="secondary"
          >
            {t(`${key}.dialog.cancel`)}
          </Button>
          <Button disabled={busy} isLoading={busy} onClick={confirm} type="button" variant={copy.variant}>
            {t(`${key}.dialog.${copy.confirmKey}`)}
          </Button>
        </>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description={t(`${key}.dialog.${copy.descriptionKey}`)}
      onOpenChange={(details) => {
        if (!details.open && !busy) {
          onClose();
        }
      }}
      open
      role="alertdialog"
      size="sm"
      title={t(`${key}.dialog.${copy.titleKey}`, { name: agent.displayName })}
    >
      <div className="flex min-w-0 flex-col gap-150">
        {copy.reasonKey !== null && (
          <FormTextarea
            id={`agent-status-reason-${agent.principalId}`}
            label={t(`${key}.dialog.${copy.reasonKey}`)}
            name="reason"
            onChange={(event) => {
              setReasonMissing(false);
              setReason(event.target.value);
            }}
            required
            rows={2}
            value={reason}
          />
        )}
        {reasonMissing && (
          <StatusText showIcon status="error">
            {t(`${key}.dialog.reasonRequired`)}
          </StatusText>
        )}
        {failure !== null && (
          <StatusText showIcon status="error">
            {failure}
          </StatusText>
        )}
      </div>
    </Dialog>
  );
};

const DENIED_OPERATIONS = new Set([STATUS_OPERATION, 'configure', 'create', 'delete']);

const AuditBlock = ({ audit }: { readonly audit: readonly AgentAuditEntry[] }) => {
  const { t } = useModernI18n();

  const describe = (entry: AgentAuditEntry): string => {
    const target = entry.targetName ?? t(`${key}.audit.unknownAgent`);
    if (entry.outcome === 'denied' || entry.eventType === 'action.rejected') {
      const operation = (entry.details['operation'] ?? '').replace(/-agent$/u, '');
      const action = t(`${key}.audit.deniedAction.${DENIED_OPERATIONS.has(operation) ? operation : 'other'}`, {
        target,
      });
      return t(`${key}.audit.denied`, { action });
    }
    if (
      entry.eventType === 'identity.agent_operators_changed' ||
      entry.details['operation'] === 'replace-agent-operators'
    ) {
      const revoked = Number(entry.details['revokedConnections'] ?? '0');
      if (entry.details['context'] === 'agent-created') {
        return t(`${key}.audit.operatorsCreated`, { target });
      }
      return revoked > 0
        ? t(`${key}.audit.operatorsRevoked`, { count: revoked, target })
        : t(`${key}.audit.operators`, { target });
    }
    return Match.value(entry.details['operation']).pipe(
      Match.when('create-agent', () => t(`${key}.audit.created`, { target })),
      Match.when('configure-agent', () => t(`${key}.audit.configured`, { target })),
      Match.when('archive-agent', () => t(`${key}.audit.deleted`, { target })),
      Match.when(STATUS_OPERATION, () =>
        entry.details['newStatus'] === 'disabled'
          ? t(`${key}.audit.deactivated`, { target })
          : t(`${key}.audit.activated`, { target }),
      ),
      Match.orElse(() => entry.eventType),
    );
  };

  return (
    <section className="flex min-w-0 flex-col gap-150">
      <h3 className="font-semibold text-sm">{t(`${key}.audit.title`)}</h3>
      {audit.length === 0 ? (
        <p className="text-fg-secondary text-sm">{t(`${key}.audit.empty`)}</p>
      ) : (
        <ul className="flex min-w-0 flex-col">
          {audit.slice(0, AUDIT_LIMIT).map((entry) => {
            const denied = entry.outcome === 'denied' || entry.eventType === 'action.rejected';
            const reason = denied ? undefined : entry.details['reason'];
            return (
              <li
                className="flex flex-wrap gap-150 border-border-primary/60 border-b py-100 last:border-b-0 sm:flex-nowrap"
                key={entry.auditEventId}
              >
                <span
                  aria-hidden
                  className={`mt-50 size-150 shrink-0 rounded-full ${denied ? 'bg-danger' : 'bg-success'}`}
                />
                <div className="order-2 flex min-w-0 basis-full flex-col gap-50 sm:order-none sm:flex-1 sm:basis-auto">
                  <p className="text-sm [overflow-wrap:anywhere]">
                    <span className="font-medium">{entry.actorName ?? t(`${key}.audit.system`)}</span> {describe(entry)}
                  </p>
                  <p className="text-fg-secondary text-xs tabular-nums">
                    {formatDateTime(entry.occurredAt)}
                    {reason !== undefined && reason !== null && <> · {t(`${key}.audit.reason`, { reason })}</>}
                  </p>
                </div>
                <span className="shrink-0 self-start">
                  <Badge size="sm" variant={denied ? 'danger' : 'success'}>
                    {t(denied ? `${key}.audit.deniedStatus` : `${key}.audit.succeeded`)}
                  </Badge>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
const resolvedAgentEditor = (
  legalEntityId: string,
  editing: EditingState | null,
  overview: AgentEntityOverview | null,
) => {
  if (overview === null || editing === null) {
    return null;
  }
  if (editing.mode === 'create') {
    return { agent: null, key: `${legalEntityId}:new`, overview };
  }
  const agent = overview.agents.find((candidate) => candidate.principalId === editing.agent.principalId);
  return agent === undefined ? null : { agent, key: `${legalEntityId}:${agent.principalId}`, overview };
};
/** Agents of the selected company: list, create/edit panel, activate/deactivate/delete, operators, connections and history. */
export const AgentEntitiesSection = ({ legalEntityId, onNotify }: AgentEntitiesSectionProps) => {
  const { t } = useModernI18n();
  // Prepared with the page; a change re-reads it while the current agents stay on screen.
  const state = usePageData(agentEntitiesData, legalEntityId);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const linkedAgent = useRouterState({
    select: (routerState) =>
      Option.getOrUndefined(Schema.decodeOption(AgentDetailSearchSchema)(routerState.location.search))?.agent ?? null,
  });
  const openedAgent = useRef<string | null>(null);
  const [statusAction, setStatusAction] = useState<AgentStatusAction | null>(null);

  const fetchOverview = () => {
    browserRuntime.runFork(agentEntitiesData.refresh(legalEntityId));
  };

  const overview = state.state === 'ready' ? state.value : null;
  const editor = resolvedAgentEditor(legalEntityId, editing, overview);

  useEffect(() => {
    if (linkedAgent === null || state.state !== 'ready') {
      return;
    }
    const agent = state.value.agents.find((item) => item.principalId === linkedAgent);
    if (agent !== undefined && openedAgent.current !== linkedAgent) {
      openedAgent.current = linkedAgent;
      setEditing({ agent, mode: 'edit' });
    }
    const anchor = CSS.escape(`agent-${linkedAgent}`);
    const element = document.querySelector<HTMLElement>(`#${anchor}`);
    element?.scrollIntoView({ block: 'start' });
    element?.focus({ preventScroll: true });
  }, [linkedAgent, state]);

  return (
    <>
      <SectionCard
        actions={
          state.state === 'ready' ? (
            <Button
              icon="icon-[mdi--robot-outline]"
              onClick={() => setEditing({ mode: 'create' })}
              size="sm"
              variant="primary"
            >
              {t(`${key}.create`)}
            </Button>
          ) : null
        }
        title={t(`${key}.title`)}
      >
        <div className="flex min-w-0 flex-col gap-200">
          <p className="text-fg-secondary text-sm">{t(`${key}.description`)}</p>

          {state.state === 'pending' && (
            // Only on a cold mount the Shell could not prepare: one quiet skeleton, the copy stays for screen readers.
            <div aria-busy="true">
              <span className="sr-only">{t(`${key}.loading`)}</span>
              <Skeleton isLoaded={false}>
                <Skeleton.Rectangle className="h-24 w-full" />
              </Skeleton>
            </div>
          )}

          {state.state === 'failed' && (
            <div className="flex flex-wrap items-center gap-150">
              <StatusText showIcon status="error">
                {state.error.reason === 'error'
                  ? t(`${key}.loadError`)
                  : (state.error.detail ?? t(`${PEOPLE_ERROR_KEY}.${state.error.reason}`))}
              </StatusText>
              <Button
                disabled={state.refreshing}
                onClick={fetchOverview}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {t(`${key}.retry`)}
              </Button>
            </div>
          )}

          {overview !== null &&
            linkedAgent !== null &&
            !overview.agents.some((agent) => agent.principalId === linkedAgent) && (
              <StatusText status="warning">Agent z odkazu neexistuje nebo k němu nemáte přístup.</StatusText>
            )}
          {overview !== null && overview.agents.length === 0 && (
            <EmptyState description={t(`${key}.emptyHint`)} title={t(`${key}.empty`)} />
          )}

          {overview !== null &&
            overview.agents.map((agent) => (
              <AgentCard
                agent={agent}
                company={overview.company.legalName.replace(/\.$/u, '')}
                highlighted={agent.principalId === linkedAgent}
                key={agent.principalId}
                members={overview.members}
                modules={overview.modules}
                onChanged={fetchOverview}
                onEdit={() => setEditing({ agent, mode: 'edit' })}
                onNotify={onNotify}
                onStatus={setStatusAction}
              />
            ))}

          {overview !== null && <AuditBlock audit={overview.audit} />}
        </div>
      </SectionCard>

      {editor !== null && (
        <AgentEditorPanel
          agent={editor.agent}
          key={editor.key}
          members={editor.overview.members}
          modules={editor.overview.modules}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            onNotify(message);
            fetchOverview();
          }}
          presets={editor.overview.presets}
        />
      )}

      {statusAction !== null && (
        <AgentStatusDialog
          action={statusAction}
          key={`${statusAction.agent.principalId}:${statusAction.kind}`}
          onChanged={fetchOverview}
          onClose={() => setStatusAction(null)}
          onNotify={onNotify}
        />
      )}
    </>
  );
};
