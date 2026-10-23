import { Link as LocalizedLink } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { agentActivityKindLabel } from '@app/shared-contracts/agent-proposals';
import type { AgentActivityKind, AgentActivityRequest } from '@app/shared-contracts/agent-proposals';
import { pageDataPending } from '@app/shared-contracts/page-data';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { ModulePageSkeleton } from '../module-page-skeleton.tsx';
import { formatAgentTime } from './agent-platform-client.ts';
import { DEFAULT_ACTIVITY_REQUEST, agentActivityData } from './platform-page-data.ts';

type BadgeVariant = 'secondary' | 'success' | 'warning' | 'info' | 'outline';

const activityKinds: readonly AgentActivityKind[] = ['read', 'write', 'denied', 'failed', 'proposal', 'decision'];

const kindBadgeVariant: Readonly<Record<AgentActivityKind, BadgeVariant>> = {
  decision: 'outline',
  denied: 'warning',
  failed: 'warning',
  proposal: 'info',
  read: 'secondary',
  write: 'success',
};

const activityFailureText = (httpStatus: number): string => {
  if (httpStatus === 403) {
    return 'Aktivitu agentů vidí správce firmy a lidé, kteří schvalují změny.';
  }
  if (httpStatus === 401) {
    return 'Přihlaste se prosím znovu.';
  }
  return 'Aktivitu se nepodařilo načíst.';
};

export const ActivityPanel = () => {
  const [agent, setAgent] = useState('');
  const [moduleKey, setModuleKey] = useState('');
  const [kind, setKind] = useState<'' | AgentActivityKind>('');
  const request = useMemo(
    (): AgentActivityRequest => ({
      ...DEFAULT_ACTIVITY_REQUEST,
      ...(agent === '' ? {} : { agentPrincipalId: agent }),
      ...(moduleKey === '' ? {} : { moduleKey }),
      ...(kind === '' ? {} : { kind }),
    }),
    [agent, moduleKey, kind],
  );
  // The Shell prepared the default list before it revealed the page; another filter loads on demand.
  const snapshot = useSyncExternalStore(
    agentActivityData.subscribe,
    () => agentActivityData.snapshot(request),
    () => pageDataPending,
  );
  useEffect(() => agentActivityData.ensure(request), [request]);
  // While another filter loads, the last settled list stays on screen.
  const [settled, setSettled] = useState(snapshot);
  if (snapshot.state !== 'pending' && snapshot !== settled) {
    setSettled(snapshot);
  }
  const state = snapshot.state === 'pending' ? settled : snapshot;
  const options = state.state === 'ready' ? state.value : { agents: [], modules: [] };

  const reload = () => {
    browserRuntime.runFork(agentActivityData.refresh(request));
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
          <select onChange={(event) => setKind(event.target.value as '' | AgentActivityKind)} value={kind}>
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
            <div aria-label="Aktivita agentů" className="agent-activity-table" role="table">
              <div className="agent-activity-head" role="row">
                <span role="columnheader">Čas</span>
                <span role="columnheader">Agent</span>
                <span role="columnheader">Modul</span>
                <span role="columnheader">Akce</span>
                <span role="columnheader">Výsledek</span>
              </div>
              {state.value.entries.map((entry) => (
                <div key={entry.id} role="row">
                  <span role="cell">{formatAgentTime(entry.occurredAt)}</span>
                  <span role="cell">{entry.agentName}</span>
                  <span role="cell">{entry.moduleLabel}</span>
                  <span role="cell">
                    <span>{entry.actionLabel}</span>
                    {entry.detail !== undefined && <small className="text-fg-secondary text-xs"> {entry.detail}</small>}
                  </span>
                  <span role="cell">
                    <Badge size="sm" variant={kindBadgeVariant[entry.kind]}>
                      {agentActivityKindLabel[entry.kind]}
                    </Badge>
                  </span>
                </div>
              ))}
            </div>
            <p className="text-fg-secondary text-xs">{`Zobrazeno ${state.value.entries.length} posledních záznamů.`}</p>
          </>
        ))}
      <div>
        <LinkButton as={LocalizedLink} size="sm" theme="outlined" to="/sprava/ke-schvaleni" variant="primary">
          Přejít na Ke schválení
        </LinkButton>
      </div>
    </div>
  );
};
