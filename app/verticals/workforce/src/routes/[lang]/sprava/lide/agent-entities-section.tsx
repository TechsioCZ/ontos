import { EmptyState, SectionCard, dialogCloseLabel, formatDateTime, surfaceTileClassName } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
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
import { Effect } from 'effect';
import { useCallback, useState } from 'react';
import { revokeAgentConnection, runAgentCommand, saveAgentOperators } from '../../../../api/agent-entities-client.ts';
import type { AgentFailure } from '../../../../api/agent-entities-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { usePageData } from '../../../../runtime/use-page-data.ts';
import { newRequestToken } from '../../prodej/zamestnanci/employee-model.ts';
import { AgentEditorPanel } from './agent-editor-panel.tsx';
import { agentEntitiesData } from './people-data.ts';

const key = 'workforce.agents.section';
const connectionsKey = 'workforce.agents.connections';
const PEOPLE_KEY = 'workforce.people';
const PEOPLE_ERROR_KEY = `${PEOPLE_KEY}.errors`;
const AUDIT_LIMIT = 8;

const statusVariant = { active: 'success', archived: 'outline', disabled: 'danger' } as const;

type Notify = (title: string, description?: string) => void;

type EditingState = { readonly mode: 'create' } | { readonly agent: AgentEntity; readonly mode: 'edit' };

interface AgentStatusAction {
  readonly agent: AgentEntity;
  readonly kind: 'activate' | 'deactivate' | 'delete';
}

export interface AgentEntitiesSectionProps {
  /** Key of the prepared agent dataset (see `people-data.ts`). */
  readonly legalEntityId: string;
  readonly onNotify: (title: string, description?: string) => void;
  /** Person name as the people table shows it (Lidé a role labels some demo principals in Czech). */
  readonly personLabel: (displayName: string) => string;
}

/** Same person names as the people table for owners, operators, members, connections and history. */
const labelled = (overview: AgentEntityOverview, label: (name: string) => string): AgentEntityOverview => {
  const ref = (person: PrincipalRef): PrincipalRef => ({ ...person, displayName: label(person.displayName) });
  return {
    ...overview,
    agents: overview.agents.map((agent) => ({
      ...agent,
      connections: agent.connections.map((connection) => ({
        ...connection,
        delegatedBy: connection.delegatedBy === null ? null : ref(connection.delegatedBy),
        user: ref(connection.user),
      })),
      operators: agent.operators.map(ref),
      owner: agent.owner === null ? null : ref(agent.owner),
    })),
    audit: overview.audit.map((entry) => ({
      ...entry,
      actorName: entry.actorName === null ? null : label(entry.actorName),
    })),
    members: overview.members.map(ref),
  };
};

const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id) => right.includes(id));

/** Agents of the selected company: list, create/edit panel, activate/deactivate/delete, operators, connections and history. */
export const AgentEntitiesSection = ({ legalEntityId, onNotify, personLabel }: AgentEntitiesSectionProps) => {
  const { t } = useModernI18n();
  // Prepared with the page; a change re-reads it while the current agents stay on screen.
  const state = usePageData(agentEntitiesData, legalEntityId);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [statusAction, setStatusAction] = useState<AgentStatusAction | null>(null);

  const fetchOverview = useCallback(() => {
    void browserRuntime.runPromise(agentEntitiesData.refresh(legalEntityId));
  }, [legalEntityId]);

  const overview = state.state === 'ready' ? labelled(state.value, personLabel) : null;

  return (
    <>
      <SectionCard
        actions={
          <Button
            disabled={state.state !== 'ready'}
            icon="icon-[mdi--robot-outline]"
            onClick={() => setEditing({ mode: 'create' })}
            size="sm"
            variant="primary"
          >
            {t(`${key}.create`)}
          </Button>
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
                {state.error.detail ?? t(`${PEOPLE_ERROR_KEY}.${state.error.reason}`)}
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

          {overview !== null && overview.agents.length === 0 && (
            <EmptyState description={t(`${key}.emptyHint`)} title={t(`${key}.empty`)} />
          )}

          {overview !== null &&
            overview.agents.map((agent) => (
              <AgentCard
                agent={agent}
                company={overview.company.legalName.replace(/\.$/u, '')}
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

      {overview !== null && editing !== null && (
        <AgentEditorPanel
          agent={editing.mode === 'edit' ? editing.agent : null}
          members={overview.members}
          modules={overview.modules}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            onNotify(message);
            fetchOverview();
          }}
          presets={overview.presets}
        />
      )}

      {statusAction !== null && (
        <AgentStatusDialog
          action={statusAction}
          onChanged={fetchOverview}
          onClose={() => setStatusAction(null)}
          onNotify={onNotify}
        />
      )}
    </>
  );
};

interface AgentCardProps {
  readonly agent: AgentEntity;
  readonly company: string;
  readonly members: readonly PrincipalRef[];
  readonly modules: readonly AgentModuleOption[];
  readonly onChanged: () => void;
  readonly onEdit: () => void;
  readonly onNotify: Notify;
  readonly onStatus: (action: AgentStatusAction) => void;
}

const AgentCard = ({ agent, company, members, modules, onChanged, onEdit, onNotify, onStatus }: AgentCardProps) => {
  const { t } = useModernI18n();
  const moduleLabel = (moduleId: string) => modules.find((option) => option.moduleId === moduleId)?.label ?? moduleId;
  const readable = agent.modules.map((grant) => moduleLabel(grant.moduleId)).join(', ');
  const writable = agent.modules
    .filter((grant) => grant.access === 'write')
    .map((grant) => moduleLabel(grant.moduleId))
    .join(', ');

  let writeLine = t(`${key}.noWrites`);
  if (writable !== '' && agent.writePolicy === 'direct') {
    writeLine = t(`${key}.writes`, { modules: writable });
  } else if (writable !== '' && agent.writePolicy === 'approval') {
    writeLine = t(`${key}.proposes`, { modules: writable });
  }

  return (
    <article className={`${surfaceTileClassName} flex flex-col gap-200 p-250`}>
      <header className="flex flex-wrap items-start justify-between gap-150">
        <div className="flex min-w-0 flex-wrap items-center gap-100">
          <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{agent.displayName}</span>
          <Badge size="sm" variant={statusVariant[agent.status]}>
            {t(`${connectionsKey}.status.${agent.status}`)}
          </Badge>
          <Badge size="sm" variant="outline">
            {t(`${connectionsKey}.policy.${agent.writePolicy}`)}
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
        {agent.owner !== null ? t(`${key}.owner`, { name: agent.owner.displayName }) : t(`${key}.noOwner`)}
      </p>

      <div className="flex min-w-0 flex-col gap-50">
        {readable !== '' && <p className="text-sm">{t(`${key}.reads`, { modules: readable })}</p>}
        <p className="text-sm">{writeLine}</p>
      </div>

      {agent.status === 'disabled' && (
        <StatusText showIcon status="warning">
          {t(`${key}.disabledNotice`)}
        </StatusText>
      )}

      <div className="grid grid-cols-1 gap-200 lg:grid-cols-2">
        <OperatorsBlock
          // Remount when the server-side operator set changes, so the selection restarts from it.
          key={agent.operators.map((operator) => operator.principalId).join(',')}
          agent={agent}
          company={company}
          members={members}
          onChanged={onChanged}
          onNotify={onNotify}
        />
        <ConnectionsBlock agent={agent} onChanged={onChanged} onNotify={onNotify} />
      </div>
    </article>
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
  // Connections that saving would cut: the agent connected by people who are being removed.
  const cut = agent.connections.filter(
    (connection) =>
      connection.delegatedBy !== null &&
      initialIds.includes(connection.delegatedBy.principalId) &&
      !selected.includes(connection.delegatedBy.principalId),
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
    void browserRuntime
      .runPromise(saveAgentOperators({ agentPrincipalId: agent.principalId, operatorPrincipalIds: [...selected] }))
      .then((outcome) => {
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
      })
      .catch(() => {
        setBusy(false);
        setFailure('error');
      });
  };

  return (
    <section className="flex min-w-0 flex-col gap-150">
      <h3 className="font-semibold text-sm">{t(`${connectionsKey}.operators.title`)}</h3>
      <p className="text-fg-secondary text-xs">{t(`${connectionsKey}.operators.hint`, { company })}</p>
      <div className="flex flex-col gap-100">
        {members.map((member) => (
          <FormCheckbox
            checked={selected.includes(member.principalId)}
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
    void browserRuntime
      .runPromise(revokeAgentConnection({ grantId: connection.grantId, reason: trimmed }))
      .then((outcome) => {
        setBusy(false);
        if (outcome.status === 'failed') {
          setFailure(outcome.reason);
          return;
        }
        close();
        onRevoked(t(`${connectionsKey}.list.revoked`, { client: clientName }));
      })
      .catch(() => {
        setBusy(false);
        setFailure('error');
      });
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

  const confirm = () => {
    const trimmed = reason.trim();
    if (copy.reasonKey !== null && trimmed.length === 0) {
      setReasonMissing(true);
      return;
    }
    const request: ManageAgentEntityRequest =
      kind === 'deactivate'
        ? {
            expectedStatus: 'active',
            newStatus: 'disabled',
            operation: 'change-status',
            principalId: agent.principalId,
            reason: trimmed,
          }
        : kind === 'activate'
          ? {
              expectedStatus: 'disabled',
              newStatus: 'active',
              operation: 'change-status',
              principalId: agent.principalId,
            }
          : { operation: 'delete', principalId: agent.principalId, reason: trimmed };
    setBusy(true);
    setFailure(null);
    void browserRuntime
      .runPromise(newRequestToken.pipe(Effect.flatMap((token) => runAgentCommand(request, `agent-${token}`))))
      .then((outcome) => {
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
      })
      .catch(() => {
        setBusy(false);
        setFailure(t(`${PEOPLE_ERROR_KEY}.error`));
      });
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

const DENIED_OPERATIONS = new Set(['change-status', 'configure', 'create', 'delete']);

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
    if (entry.eventType === 'identity.agent_operators_changed') {
      const revoked = Number(entry.details['revokedConnections'] ?? '0');
      if (entry.details['context'] === 'agent-created') {
        return t(`${key}.audit.operatorsCreated`, { target });
      }
      return revoked > 0
        ? t(`${key}.audit.operatorsRevoked`, { count: revoked, target })
        : t(`${key}.audit.operators`, { target });
    }
    switch (entry.details['operation']) {
      case 'create-agent':
        return t(`${key}.audit.created`, { target });
      case 'configure-agent':
        return t(`${key}.audit.configured`, { target });
      case 'archive-agent':
        return t(`${key}.audit.deleted`, { target });
      case 'change-status':
        return entry.details['newStatus'] === 'disabled'
          ? t(`${key}.audit.deactivated`, { target })
          : t(`${key}.audit.activated`, { target });
      default:
        return entry.eventType;
    }
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
                className="flex gap-150 border-border-primary/60 border-b py-100 last:border-b-0"
                key={entry.auditEventId}
              >
                <span
                  aria-hidden
                  className={`mt-50 size-150 shrink-0 rounded-full ${denied ? 'bg-danger' : 'bg-success'}`}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-50">
                  <p className="text-sm [overflow-wrap:anywhere]">
                    <span className="font-medium">{entry.actorName ?? t(`${key}.audit.system`)}</span> {describe(entry)}
                  </p>
                  <p className="text-fg-secondary text-xs tabular-nums">
                    {formatDateTime(entry.occurredAt)}
                    {typeof reason === 'string' && ` · ${t(`${key}.audit.reason`, { reason })}`}
                  </p>
                </div>
                <span className="shrink-0 self-start">
                  <Badge size="sm" variant={denied ? 'danger' : 'success'}>
                    {t(denied ? `${PEOPLE_KEY}.audit.denied` : `${PEOPLE_KEY}.audit.succeeded`)}
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
