import { Link as LocalizedLink } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import {
  AgentActivityKindSchema,
  AgentModuleKeySchema,
  AgentPrincipalIdSchema,
  agentActivityKindLabel,
} from '@app/shared-contracts/agent-proposals';
import type {
  AgentActivityEntry,
  AgentActivityKind,
  AgentActivityRequest,
  AgentActivityResponse,
  AgentPageCursor,
} from '@app/shared-contracts/agent-proposals';
import { pageDataPending } from '@app/shared-contracts/page-data';
import { Option, Schema } from 'effect';
import type { ComponentProps, ReactNode } from 'react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { ModulePageSkeleton } from '../module-page-skeleton.tsx';
import { formatAgentTime } from './agent-platform-client.ts';
import { DEFAULT_ACTIVITY_REQUEST, agentActivityData } from './platform-page-data.ts';

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>['variant']>;
const ActivityFilterKind = Schema.Union([Schema.Literal(''), AgentActivityKindSchema]);

const activityKinds: readonly AgentActivityKind[] = ['read', 'write', 'denied', 'failed', 'proposal', 'decision'];

const kindBadgeVariant = {
  decision: 'outline',
  denied: 'warning',
  failed: 'warning',
  proposal: 'info',
  read: 'secondary',
  write: 'success',
} satisfies Readonly<Record<AgentActivityKind, BadgeVariant>>;

const activityFailureText = (httpStatus: number): string => {
  if (httpStatus === 403) {
    return 'Aktivitu agentů vidí správce firmy a lidé, kteří schvalují změny.';
  }
  if (httpStatus === 401) {
    return 'Přihlaste se prosím znovu.';
  }
  return 'Aktivitu se nepodařilo načíst.';
};

export const ActivityText = ({
  children,
  path,
}: {
  readonly children: ReactNode;
  readonly path: string | undefined;
}) =>
  path === undefined ? (
    children
  ) : (
    <LocalizedLink className="agent-activity-link" to={path}>
      {children}
    </LocalizedLink>
  );

const activityDetail = (entry: AgentActivityEntry) => {
  if (entry.record !== undefined) {
    return (
      <small className="block text-xs">
        <ActivityText path={entry.record.path}>{entry.record.label}</ActivityText>
      </small>
    );
  }
  return entry.detail === undefined ? null : <small className="text-fg-secondary text-xs"> {entry.detail}</small>;
};

const activityRequest = (
  agent: string,
  moduleKey: string,
  kind: '' | AgentActivityKind,
  cursor: AgentPageCursor | undefined,
): AgentActivityRequest => {
  let value: AgentActivityRequest = { ...DEFAULT_ACTIVITY_REQUEST };
  if (cursor !== undefined) {
    value = { ...value, cursor };
  }
  if (agent !== '') {
    value = { ...value, agentPrincipalId: AgentPrincipalIdSchema.make(agent) };
  }
  if (moduleKey !== '') {
    value = { ...value, moduleKey: AgentModuleKeySchema.make(moduleKey) };
  }
  if (kind !== '') {
    value = { ...value, kind };
  }
  return value;
};

export const ActivityPanel = () => {
  const [agent, setAgent] = useState('');
  const [moduleKey, setModuleKey] = useState('');
  const [kind, setKind] = useState<'' | AgentActivityKind>('');
  const filterKey = [agent, moduleKey, kind].join('|');
  const [page, setPage] = useState<{ readonly cursor: AgentPageCursor; readonly filter: string }>();
  const cursor = page?.filter === filterKey ? page.cursor : undefined;
  const request = activityRequest(agent, moduleKey, kind, cursor);
  // The Shell prepared the default list before it revealed the page; another filter loads on demand.
  const snapshot = useSyncExternalStore(
    agentActivityData.subscribe,
    () => agentActivityData.snapshot(request),
    () => pageDataPending,
  );
  useEffect(
    () => agentActivityData.ensure(activityRequest(agent, moduleKey, kind, cursor)),
    [agent, moduleKey, kind, cursor],
  );
  // While another filter loads, the last settled list stays on screen.
  const [settled, setSettled] = useState(snapshot);
  // Keep discovered filter choices across pages without retaining the activity rows themselves.
  const [options, setOptions] = useState<Pick<AgentActivityResponse, 'agents' | 'modules'>>(
    snapshot.state === 'ready' ? snapshot.value : { agents: [], modules: [] },
  );
  if (snapshot.state !== 'pending' && snapshot !== settled) {
    setSettled(snapshot);
    if (snapshot.state === 'ready') {
      setOptions({
        agents: [
          ...new Map([...options.agents, ...snapshot.value.agents].map((entry) => [entry.principalId, entry])).values(),
        ],
        modules: [
          ...new Map([...options.modules, ...snapshot.value.modules].map((entry) => [entry.moduleKey, entry])).values(),
        ],
      });
    }
  }
  const state = snapshot.state === 'pending' ? settled : snapshot;

  const reload = () => {
    setPage(undefined);
    const { cursor: _cursor, ...firstPage } = request;
    browserRuntime.runFork(agentActivityData.refresh(firstPage));
  };

  return (
    <div className="ai-review">
      <p className="text-fg-secondary text-sm">
        Každé čtení, zápis, odmítnutí i návrh AI agentů v modulech, ve kterých schvalujete jejich změny.
      </p>
      <div className="agent-filters">
        <label>
          <span>Agent</span>
          <select onChange={(event) => setAgent(event.target.value)} value={agent}>
            <option value="">Všichni agenti</option>
            {options.agents.map((entry) => (
              <option key={entry.principalId} value={entry.principalId}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Modul</span>
          <select onChange={(event) => setModuleKey(event.target.value)} value={moduleKey}>
            <option value="">Všechny moduly</option>
            {options.modules.map((entry) => (
              <option key={entry.moduleKey} value={entry.moduleKey}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Výsledek</span>
          <select
            onChange={(event) =>
              setKind(Option.getOrElse(Schema.decodeUnknownOption(ActivityFilterKind)(event.target.value), () => ''))
            }
            value={kind}
          >
            <option value="">Vše</option>
            {activityKinds.map((value) => (
              <option key={value} value={value}>
                {agentActivityKindLabel[value]}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={reload} size="sm" theme="outlined" variant="secondary">
          Obnovit
        </Button>
      </div>
      {state.state === 'pending' && <ModulePageSkeleton />}
      {state.state === 'failed' && (
        <>
          <StatusText aria-live="polite" showIcon status="error">
            {activityFailureText(state.error.httpStatus)}
          </StatusText>
          {state.error.httpStatus !== 401 && state.error.httpStatus !== 403 && (
            <Button onClick={reload} size="sm" theme="outlined" variant="secondary">
              Zkusit znovu
            </Button>
          )}
        </>
      )}
      {state.state === 'ready' &&
        (state.value.entries.length === 0 ? (
          <StatusText status="default">Žádná aktivita pro zvolený filtr.</StatusText>
        ) : (
          <>
            <table aria-label="Aktivita agentů" className="agent-activity-table">
              <thead>
                <tr className="agent-activity-head">
                  <th scope="col">Čas</th>
                  <th scope="col">Agent</th>
                  <th scope="col">Modul</th>
                  <th scope="col">Akce</th>
                  <th scope="col">Výsledek</th>
                </tr>
              </thead>
              <tbody>
                {state.value.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatAgentTime(entry.occurredAt)}</td>
                    <td>
                      <ActivityText path={entry.agentPath}>{entry.agentName}</ActivityText>
                      {entry.grants?.map((grant) => (
                        <small className="block text-xs" key={grant.path}>
                          <ActivityText path={grant.path}>{`Oprávnění: ${grant.label}`}</ActivityText>
                        </small>
                      ))}
                    </td>
                    <td>
                      <ActivityText path={entry.modulePath}>{entry.moduleLabel}</ActivityText>
                    </td>
                    <td>
                      <ActivityText path={entry.actionPath}>{entry.actionLabel}</ActivityText>
                      {activityDetail(entry)}
                    </td>
                    <td>
                      <Badge size="sm" variant={kindBadgeVariant[entry.kind]}>
                        {agentActivityKindLabel[entry.kind]}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-fg-secondary text-xs">{`Zobrazeno ${state.value.entries.length} záznamů.`}</p>
          </>
        ))}
      {state.state === 'ready' && state.value.nextCursor !== undefined && (
        <Button
          disabled={snapshot.state === 'pending'}
          onClick={() => {
            if (state.value.nextCursor !== undefined) {
              setPage({ cursor: state.value.nextCursor, filter: filterKey });
            }
          }}
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          Načíst další
        </Button>
      )}
      <div>
        <LinkButton as={LocalizedLink} size="sm" theme="outlined" to="/sprava/ke-schvaleni" variant="primary">
          Přejít na Ke schválení
        </LinkButton>
      </div>
    </div>
  );
};
