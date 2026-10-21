import { EmptyState, SectionCard, dialogCloseLabel, formatDateTime, surfaceTileClassName } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type {
  AgentConnectionsOverview,
  AgentEntity,
  ConnectionSummary,
  PrincipalRef,
} from '@app/shared-contracts/agent-access';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useCallback, useEffect, useState } from 'react';
import {
  loadAgentConnections,
  revokeAgentConnection,
  saveAgentOperators,
} from '../../../../api/agent-entities-client.ts';
import type { AgentFailure } from '../../../../api/agent-entities-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

const key = 'workforce.agents.connections';
const PEOPLE_ERROR_KEY = 'workforce.people.errors';

const statusVariant = { active: 'success', archived: 'outline', disabled: 'danger' } as const;

type LoadState =
  | { readonly status: 'loading' }
  | { readonly reason: AgentFailure; readonly status: 'failed' }
  | { readonly overview: AgentConnectionsOverview; readonly status: 'ready' };

export interface AgentConnectionsSectionProps {
  readonly onNotify: (title: string) => void;
}

const sameIds = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((id) => right.includes(id));

/** Agents of the selected company with who may connect them and their active connections. */
export const AgentConnectionsSection = ({ onNotify }: AgentConnectionsSectionProps) => {
  const { t } = useModernI18n();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const fetchOverview = useCallback(() => {
    void browserRuntime.runPromise(loadAgentConnections).then(
      (outcome) =>
        setState(
          outcome.status === 'ok'
            ? { overview: outcome.value, status: 'ready' }
            : { reason: outcome.reason, status: 'failed' },
        ),
      () => setState({ reason: 'error', status: 'failed' }),
    );
  }, []);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  const retry = () => {
    setState({ status: 'loading' });
    fetchOverview();
  };

  return (
    <SectionCard title={t(`${key}.title`)}>
      <div className="flex min-w-0 flex-col gap-200">
        <p className="text-fg-secondary text-sm">{t(`${key}.description`)}</p>

        {state.status === 'loading' && <p className="text-fg-secondary text-sm">{t(`${key}.loading`)}</p>}

        {state.status === 'failed' && (
          <div className="flex flex-wrap items-center gap-150">
            <StatusText showIcon status="error">
              {t(`${PEOPLE_ERROR_KEY}.${state.reason}`)}
            </StatusText>
            <Button onClick={retry} size="sm" theme="outlined" variant="secondary">
              {t(`${key}.retry`)}
            </Button>
          </div>
        )}

        {state.status === 'ready' && state.overview.agents.length === 0 && (
          <EmptyState description={t(`${key}.noAgentsHint`)} title={t(`${key}.noAgents`)} />
        )}

        {state.status === 'ready' &&
          state.overview.agents.map((agent) => (
            <AgentCard
              agent={agent}
              company={state.overview.company.legalName}
              key={agent.principalId}
              members={state.overview.members}
              onChanged={fetchOverview}
              onNotify={onNotify}
            />
          ))}
      </div>
    </SectionCard>
  );
};

interface AgentCardProps {
  readonly agent: AgentEntity;
  readonly company: string;
  readonly members: readonly PrincipalRef[];
  readonly onChanged: () => void;
  readonly onNotify: (title: string) => void;
}

const AgentCard = ({ agent, company, members, onChanged, onNotify }: AgentCardProps) => {
  const { t } = useModernI18n();
  return (
    <article className={`${surfaceTileClassName} flex flex-col gap-200 p-250`}>
      <header className="flex flex-wrap items-center gap-100">
        <span className="font-semibold">{agent.displayName}</span>
        <Badge size="sm" variant={statusVariant[agent.status]}>
          {t(`${key}.status.${agent.status}`)}
        </Badge>
        <Badge size="sm" variant="outline">
          {t(`${key}.policy.${agent.writePolicy}`)}
        </Badge>
      </header>
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

const OperatorsBlock = ({ agent, company, members, onChanged, onNotify }: AgentCardProps) => {
  const { t } = useModernI18n();
  const initialIds = agent.operators.map((operator) => operator.principalId);
  const [selected, setSelected] = useState<readonly string[]>(initialIds);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AgentFailure | null>(null);
  const dirty = !sameIds(selected, initialIds);

  const toggle = (principalId: string, checked: boolean) =>
    setSelected((current) =>
      checked
        ? [...current.filter((id) => id !== principalId), principalId]
        : current.filter((id) => id !== principalId),
    );

  const save = () => {
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
        onNotify(t(`${key}.operators.saved`, { name: agent.displayName }));
        if (outcome.value.revokedConnections > 0) {
          onNotify(t(`${key}.operators.revoked`, { count: outcome.value.revokedConnections }));
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
      <h3 className="font-semibold text-sm">{t(`${key}.operators.title`)}</h3>
      <p className="text-fg-secondary text-xs">{t(`${key}.operators.hint`, { company })}</p>
      <div className="flex flex-col gap-100">
        {members.map((member) => (
          <FormCheckbox
            checked={selected.includes(member.principalId)}
            id={`agent-operator-${agent.principalId}-${member.principalId}`}
            key={member.principalId}
            label={member.displayName}
            onCheckedChange={(checked) => toggle(member.principalId, checked)}
          />
        ))}
      </div>
      {selected.length === 0 && <p className="text-fg-secondary text-xs">{t(`${key}.operators.empty`)}</p>}
      {failure !== null && (
        <StatusText showIcon status="error">
          {t(`${PEOPLE_ERROR_KEY}.${failure}`)}
        </StatusText>
      )}
      <div>
        <Button
          disabled={!dirty || busy}
          isLoading={busy}
          loadingText={t(`${key}.operators.saving`)}
          onClick={save}
          size="sm"
          variant="primary"
        >
          {t(`${key}.operators.save`)}
        </Button>
      </div>
    </section>
  );
};

const ConnectionsBlock = ({ agent, onChanged, onNotify }: Omit<AgentCardProps, 'company' | 'members'>) => {
  const { t } = useModernI18n();
  return (
    <section className="flex min-w-0 flex-col gap-150">
      <h3 className="font-semibold text-sm">{t(`${key}.list.title`)}</h3>
      {agent.connections.length === 0 ? (
        <p className="text-fg-secondary text-sm">{t(`${key}.list.empty`)}</p>
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
        onRevoked(t(`${key}.list.revoked`, { client: clientName }));
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
          {t(`${key}.list.connectedBy`, { name: connection.delegatedBy?.displayName ?? connection.user.displayName })}
        </p>
        <p className="text-fg-secondary text-xs tabular-nums">
          {connection.lastUsedAt === null
            ? t(`${key}.list.neverUsed`)
            : t(`${key}.list.lastUsed`, { date: formatDateTime(connection.lastUsedAt) })}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-100">
        <Badge size="sm" variant="outline">
          {t(`${key}.policy.${connection.writePolicy}`)}
        </Badge>
        <Button
          onClick={() => {
            setFailure(null);
            setOpen(true);
          }}
          size="sm"
          variant="danger"
        >
          {t(`${key}.list.revoke`)}
        </Button>
      </div>
      <Dialog
        actions={
          <>
            <Button onClick={close} theme="outlined" type="button" variant="secondary">
              {t(`${key}.list.cancel`)}
            </Button>
            <Button disabled={busy} isLoading={busy} onClick={confirm} type="button" variant="danger">
              {t(`${key}.list.confirm`)}
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description={t(`${key}.list.dialogDescription`)}
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
        title={t(`${key}.list.dialogTitle`, { client: clientName })}
      >
        <div className="flex min-w-0 flex-col gap-150">
          <FormTextarea
            id={`agent-connection-reason-${connection.grantId}`}
            label={t(`${key}.list.reason`)}
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
              {t(`${key}.list.reasonRequired`)}
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
