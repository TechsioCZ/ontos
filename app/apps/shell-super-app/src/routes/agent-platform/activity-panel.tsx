import { ChoiceField, FormBuilder, FormReact, FormRoot, useAtomValue } from '@app/core-runtime/ui/form';
import { Link as LocalizedLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
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
import { Effect, Option, Schema } from 'effect';
import type { ComponentProps, ReactNode } from 'react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { browserAtomRuntime, browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { ModulePageSkeleton } from '../module-page-skeleton.tsx';
import { formatAgentTime } from './agent-platform-client.ts';
import { DEFAULT_ACTIVITY_REQUEST, agentActivityData } from './platform-page-data.ts';

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>['severity']>;
const ActivityFilterKind = Schema.Union([Schema.Literal(''), AgentActivityKindSchema]);

const activityKinds: readonly AgentActivityKind[] = ['read', 'write', 'denied', 'failed', 'proposal', 'decision'];

/** The activity filters; each choice applies at once, so the form never submits. `""` is every agent, module or result. */
const activityFilterForm = FormReact.make(
  FormBuilder.empty
    .addField('agent', Schema.String)
    .addField('kind', Schema.String)
    .addField('moduleKey', Schema.String),
  {
    fields: { agent: ChoiceField, kind: ChoiceField, moduleKey: ChoiceField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
const noFilter = { agent: '', kind: '', moduleKey: '' };
const kindChoices = [
  { label: 'Vše', value: '' },
  ...activityKinds.map((value) => ({ label: agentActivityKindLabel[value], value })),
];

const kindBadgeVariant = {
  decision: 'neutral',
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
    <Link as={LocalizedLink} className="text-current wrap-anywhere hover:text-primary" size="current" to={path}>
      {children}
    </Link>
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
  const { t } = useModernI18n();
  const filters = Option.getOrElse(useAtomValue(activityFilterForm.values), () => noFilter);
  const { agent, moduleKey } = filters;
  const kind = Schema.decodeUnknownOption(ActivityFilterKind)(filters.kind).pipe(
    Option.getOrElse((): '' | AgentActivityKind => ''),
  );
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
    <div className="flex min-w-0 flex-col gap-5">
      <p className="text-fg-secondary text-sm">
        Každé čtení, zápis, odmítnutí i návrh AI agentů v modulech, ve kterých schvalujete jejich změny.
      </p>
      <FormRoot
        className="flex flex-wrap items-end gap-3"
        defaultValues={noFilter}
        form={activityFilterForm}
        translateMessage={(message) => t(message)}
      >
        <activityFilterForm.agent
          items={[
            { label: 'Všichni agenti', value: '' },
            ...options.agents.map((entry) => ({ label: entry.name, value: entry.principalId })),
          ]}
          label="Agent"
          placeholder="Všichni agenti"
        />
        <activityFilterForm.moduleKey
          items={[
            { label: 'Všechny moduly', value: '' },
            ...options.modules.map((entry) => ({ label: entry.label, value: entry.moduleKey })),
          ]}
          label="Modul"
          placeholder="Všechny moduly"
        />
        <activityFilterForm.kind items={kindChoices} label="Výsledek" placeholder="Vše" />
      </FormRoot>
      {state.state === 'pending' && <ModulePageSkeleton />}
      {state.state === 'failed' && (
        <>
          <StatusText aria-live="polite" showIcon status="error">
            {activityFailureText(state.error.httpStatus)}
          </StatusText>
          {state.error.httpStatus !== 401 && state.error.httpStatus !== 403 && (
            <Button appearance="outline" onClick={reload} severity="secondary" size="sm">
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
            <table aria-label={t('shell.agentPlatform.activity.table')} className="grid w-full min-w-0">
              <thead className="contents">
                <tr className="flex min-w-0 flex-col gap-1 border-border-primary/60 border-b py-3 sm:flex-row sm:items-start sm:gap-3 sm:py-2 hidden sm:flex">
                  <th
                    className="min-w-0 text-left font-semibold text-fg-secondary text-xs wrap-anywhere sm:w-36 sm:shrink-0"
                    scope="col"
                  >
                    Čas
                  </th>
                  <th
                    className="min-w-0 text-left font-semibold text-fg-secondary text-xs wrap-anywhere sm:flex-1"
                    scope="col"
                  >
                    Agent
                  </th>
                  <th
                    className="min-w-0 text-left font-semibold text-fg-secondary text-xs wrap-anywhere sm:flex-1"
                    scope="col"
                  >
                    Modul
                  </th>
                  <th
                    className="min-w-0 text-left font-semibold text-fg-secondary text-xs wrap-anywhere sm:flex-1"
                    scope="col"
                  >
                    Akce
                  </th>
                  <th
                    className="min-w-0 text-left font-semibold text-fg-secondary text-xs wrap-anywhere sm:w-36 sm:shrink-0"
                    scope="col"
                  >
                    Výsledek
                  </th>
                </tr>
              </thead>
              <tbody className="contents">
                {state.value.entries.map((entry) => (
                  <tr
                    className="flex min-w-0 flex-col gap-1 border-border-primary/60 border-b py-3 sm:flex-row sm:items-start sm:gap-3 sm:py-2"
                    key={entry.id}
                  >
                    <td className="min-w-0 wrap-anywhere sm:w-36 sm:shrink-0">{formatAgentTime(entry.occurredAt)}</td>
                    <td className="min-w-0 wrap-anywhere sm:flex-1">
                      <ActivityText path={entry.agentPath}>{entry.agentName}</ActivityText>
                      {entry.grants?.map((grant) => (
                        <small className="block text-xs" key={grant.path}>
                          <ActivityText path={grant.path}>{`Oprávnění: ${grant.label}`}</ActivityText>
                        </small>
                      ))}
                    </td>
                    <td className="min-w-0 wrap-anywhere sm:flex-1">
                      <ActivityText path={entry.modulePath}>{entry.moduleLabel}</ActivityText>
                    </td>
                    <td className="min-w-0 wrap-anywhere sm:flex-1">
                      <ActivityText path={entry.actionPath}>{entry.actionLabel}</ActivityText>
                      {activityDetail(entry)}
                    </td>
                    <td className="min-w-0 wrap-anywhere sm:w-36 sm:shrink-0">
                      <Badge severity={kindBadgeVariant[entry.kind]} size="sm">
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
          appearance="outline"
          disabled={snapshot.state === 'pending'}
          onClick={() => {
            if (state.value.nextCursor !== undefined) {
              setPage({ cursor: state.value.nextCursor, filter: filterKey });
            }
          }}
          severity="secondary"
          size="sm"
        >
          Načíst další
        </Button>
      )}
      <div>
        <LinkButton appearance="outline" as={LocalizedLink} severity="primary" size="sm" to="/sprava/ke-schvaleni">
          Přejít na Ke schválení
        </LinkButton>
      </div>
    </div>
  );
};
