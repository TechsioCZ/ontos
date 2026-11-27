import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import {
  AgentAccessClientIdSchema,
  CONNECTION_REVOKE_REASON_MAX,
  ConnectionRevokeRequestSchema,
} from '@app/shared-contracts/agent-access';
import { AgentPrincipalIdSchema } from '@app/shared-contracts/agent-proposals';
import {
  ChoiceField,
  FormBuilder,
  FormReact,
  FormRoot,
  FormRootError,
  TextAreaField,
  TextField,
  fromPayload,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { Effect, Option, Schema, Struct } from 'effect';
import { Url } from 'effect/http';
import { AsyncResult } from 'effect/reactivity';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import type {
  ConnectionAdminFilter,
  ConnectionAdminListResponse,
  ConnectionStatus,
  ConnectionSummary,
} from '@app/shared-contracts/agent-access';
import { pageDataPending } from '@app/shared-contracts/page-data';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { revokeConnection } from '../../profile/connected-apps-client.ts';
import { ModulePageSkeleton } from '../../../module-page-skeleton.tsx';
import { DEFAULT_CONNECTIONS_FILTER, companyConnectionsData } from './connections-admin-data.ts';
import {
  accessSummary,
  actingAdminLabel,
  endedDetail,
  failureText,
  formatWhen,
  isStale,
  statusBadge,
  statusLabel,
  writePolicyBadge,
  writePolicyLabel,
} from '../../profile/connected-apps-model.ts';

const DetailValueSchema = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
const ConnectionDetailQuerySchema = Schema.RecordFromUrlParams.pipe(
  Schema.decodeTo(
    Schema.Struct({
      agent: Schema.optionalKey(DetailValueSchema),
      grant: Schema.optionalKey(DetailValueSchema),
    }),
  ),
);
const firstDetailValue = (value: typeof DetailValueSchema.Type | undefined): string | undefined =>
  Schema.is(Schema.String)(value) ? value : value?.[0];
const initialFilter = (grant: string | undefined, agent: string | undefined): ConnectionAdminFilter => {
  if (grant !== undefined) {
    return {};
  }
  return agent === undefined ? DEFAULT_CONNECTIONS_FILTER : { actingPrincipalId: AgentPrincipalIdSchema.make(agent) };
};

const statusOptions: readonly { readonly label: string; readonly value: ConnectionStatus }[] = [
  { label: 'Aktivní', value: 'active' },
  { label: 'Odpojené', value: 'revoked' },
  { label: 'Nahrazené', value: 'superseded' },
  { label: 'Zamítnuté', value: 'denied' },
];

/**
 * The list filter: one choice per filter key, where an empty choice ("Všichni") means no restriction. `routeKey` is
 * the detail link the choice was made for; a choice made for another link does not apply.
 */
const filterForm = FormReact.make(
  FormBuilder.empty
    .addField('actingPrincipalId', Schema.String)
    .addField('clientId', Schema.String)
    .addField('routeKey', Schema.String)
    .addField('status', Schema.String)
    .addField('userPrincipalId', Schema.String),
  {
    fields: {
      actingPrincipalId: ChoiceField,
      clientId: ChoiceField,
      routeKey: TextField,
      status: ChoiceField,
      userPrincipalId: ChoiceField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

type FilterValues = typeof filterForm.schema.Encoded;

const filterValuesOf = (filter: ConnectionAdminFilter, routeKey: string): FilterValues => ({
  actingPrincipalId: filter.actingPrincipalId ?? '',
  clientId: filter.clientId ?? '',
  routeKey,
  status: filter.status ?? '',
  userPrincipalId: filter.userPrincipalId ?? '',
});

const filterOf = (values: FilterValues): ConnectionAdminFilter => {
  let filter: ConnectionAdminFilter = {};
  if (values.actingPrincipalId !== '') {
    filter = { ...filter, actingPrincipalId: AgentPrincipalIdSchema.make(values.actingPrincipalId) };
  }
  if (values.clientId !== '') {
    filter = { ...filter, clientId: AgentAccessClientIdSchema.make(values.clientId) };
  }
  if (values.status !== '') {
    filter = { ...filter, status: values.status };
  }
  if (values.userPrincipalId !== '') {
    filter = { ...filter, userPrincipalId: AgentPrincipalIdSchema.make(values.userPrincipalId) };
  }
  return filter;
};

/**
 * Rendered inside `FormRoot`, which renders its children only once this mount initialized the form: until then the
 * form's atoms can still hold what an earlier mount left, so the values are read only after `onReady`.
 */
const FormReady = ({ onReady }: { readonly onReady: (ready: boolean) => void }) => {
  useEffect(() => onReady(true), [onReady]);
  return null;
};

const useConnectionFilter = () => {
  const searchStr = useRouterState({ select: (routerState) => routerState.location.searchStr });
  const search = Option.getOrElse(
    Schema.decodeOption(ConnectionDetailQuerySchema)(Url.urlParams(new URL(searchStr, 'https://shell.invalid/'))),
    (): typeof ConnectionDetailQuerySchema.Type => ({}),
  );
  const targetGrantId = firstDetailValue(search.grant);
  const targetAgentId = firstDetailValue(search.agent);
  const defaultFilter = initialFilter(targetGrantId, targetAgentId);
  const routeKey = targetGrantId === undefined ? `agent:${targetAgentId ?? ''}` : `grant:${targetGrantId}`;
  const [ready, setReady] = useState(false);
  const chosen = Option.filter(useAtomValue(filterForm.values), (values) => ready && values.routeKey === routeKey);
  const filter = Option.match(chosen, { onNone: () => defaultFilter, onSome: filterOf });
  return { defaultValues: filterValuesOf(defaultFilter, routeKey), filter, routeKey, setReady, targetGrantId };
};

/** The administrator's reason for a revoke; the payload's own reason is optional, this panel always asks for one. */
const revokeReasonSchema = Schema.String.check(Schema.isPattern(/\S/u, { message: 'Uveďte důvod.' }));

/** Why the Shell did not revoke the connection, in the Czech text the dialog shows. */
class RevokeRefused extends Schema.TaggedError<RevokeRefused>()('RevokeRefused', { message: Schema.String }) {}

/** Revokes one connection; answers the notice the list shows, also when the connection had ended meanwhile. */
const revokeGrant = Effect.fn('ConnectionsAdminPanel.revokeGrant')(function* revokeGrant(input: {
  readonly clientName: string;
  readonly grantId: ConnectionSummary['grantId'];
  readonly reason: string;
}) {
  const outcome = yield* revokeConnection({ grantId: input.grantId, reason: input.reason.trim() });
  if (outcome.status === 'ok') {
    return `Připojení ${input.clientName} je odpojené.`;
  }
  if (isStale(outcome.reason)) {
    return `${failureText(outcome.reason, outcome.detail)} Seznam je znovu načtený.`;
  }
  return yield* new RevokeRefused({ message: failureText(outcome.reason, outcome.detail) });
});

const revokeForm = FormReact.make(
  fromPayload(ConnectionRevokeRequestSchema.mapFields(Struct.pick(['grantId'])))
    .addField('clientName', Schema.String)
    .addField('reason', revokeReasonSchema),
  {
    fields: { clientName: TextField, grantId: TextField, reason: TextAreaField },
    onSubmit: (_submit, { decoded }) => revokeGrant(decoded),
    runtime: browserAtomRuntime,
    submitErrors: ({ message }) => [{ message, path: '' }],
  },
);

/** The texts of this panel are Czech already, not i18n keys. */
const shownAsIs = (message: string) => message;

const tiles = (stats: ConnectionAdminListResponse['stats']) => [
  { label: 'Aktivní připojení', value: stats.active },
  { label: 'Připojení agenti', value: stats.agentsConnected },
  { label: 'S přímým zápisem', value: stats.directWrite },
];

/** The stored status, except that an active grant whose live check does not pass now is not usable, not active. */
const StatusBadge = ({ connection }: { readonly connection: ConnectionSummary }) =>
  connection.status === 'active' && !connection.live ? (
    <Badge severity="warning">Teď nelze použít</Badge>
  ) : (
    <Badge severity={statusBadge[connection.status]}>{statusLabel[connection.status]}</Badge>
  );

/** The effective write policy of a live grant; a dash while the grant is not usable, never a ceiling it does not have. */
const WritePolicyCell = ({ connection }: { readonly connection: ConnectionSummary }) =>
  connection.live ? (
    <Badge severity={writePolicyBadge[connection.writePolicy]}>{writePolicyLabel[connection.writePolicy]}</Badge>
  ) : (
    '—'
  );

const EndedDetail = ({ connection }: { readonly connection: ConnectionSummary }) => {
  const detail = endedDetail(connection);
  if (detail === undefined) {
    return null;
  }
  return (
    <span className="grid gap-50 text-fg-secondary text-xs">
      <span>{detail.when === '' ? detail.label : `${detail.label} · ${detail.when}`}</span>
      {detail.note === null ? null : <span className="whitespace-normal">Důvod: {detail.note}</span>}
    </span>
  );
};

const ConnectionRevokeDialog = ({
  closeRevoke,
  target,
}: {
  readonly closeRevoke: () => void;
  readonly target: ConnectionSummary | undefined;
}) => {
  const submitRevoke = useAtomSet(revokeForm.submit);
  const busy = useAtomValue(revokeForm.submit).waiting;
  return (
    <Dialog
      actions={
        <>
          <Button appearance="outline" onClick={closeRevoke} severity="secondary" size="sm">
            Zrušit
          </Button>
          <Button disabled={busy} onClick={() => submitRevoke()} severity="danger" size="sm">
            Odpojit
          </Button>
        </>
      }
      closeLabel="Zavřít dialog"
      customTrigger
      description="Aplikace ztratí přístup hned při dalším požadavku. Uveďte důvod: zapíše se do auditu a ukáže se u připojení ve filtru Odpojené."
      onOpenChange={({ open }) => {
        if (!open) {
          closeRevoke();
        }
      }}
      open={target !== undefined}
      role="alertdialog"
      size="sm"
      title={target === undefined ? '' : `Odpojit ${target.client.name} (${target.user.displayName})?`}
    >
      {target === undefined ? null : (
        <FormRoot
          className="grid gap-150"
          defaultValues={{ clientName: target.client.name, grantId: target.grantId, reason: '' }}
          form={revokeForm}
          key={target.grantId}
          translateMessage={shownAsIs}
        >
          <revokeForm.reason label="Důvod odpojení" maxLength={CONNECTION_REVOKE_REASON_MAX} rows={3} />
          <FormRootError form={revokeForm} />
        </FormRoot>
      )}
    </Dialog>
  );
};

export const ConnectionsAdminPanel = () => {
  const { defaultValues, filter, routeKey, setReady, targetGrantId } = useConnectionFilter();
  const [notice, setNotice] = useState('');
  const [target, setTarget] = useState<ConnectionSummary | undefined>();

  // The Shell prepared the default list before it revealed the page; another filter loads on demand.
  const snapshot = useSyncExternalStore(
    companyConnectionsData.subscribe,
    () => companyConnectionsData.snapshot(filter),
    () => pageDataPending,
  );
  const { actingPrincipalId, clientId, status, userPrincipalId } = filter;
  useEffect(() => {
    // Reconstruct the exact optional fields from scalar dependencies; filter object identity is not a request key.
    let selected: ConnectionAdminFilter = {};
    if (actingPrincipalId !== undefined) {
      selected = { ...selected, actingPrincipalId };
    }
    if (clientId !== undefined) {
      selected = { ...selected, clientId };
    }
    if (status !== undefined) {
      selected = { ...selected, status };
    }
    if (userPrincipalId !== undefined) {
      selected = { ...selected, userPrincipalId };
    }
    companyConnectionsData.ensure(selected);
  }, [actingPrincipalId, clientId, status, userPrincipalId]);
  // While another filter loads, the last settled list stays on screen.
  const [settled, setSettled] = useState(snapshot);
  if (snapshot.state !== 'pending' && snapshot !== settled) {
    setSettled(snapshot);
  }
  const state = snapshot.state === 'pending' ? settled : snapshot;
  const reload = () => {
    browserRuntime.runFork(companyConnectionsData.refresh(filter));
  };

  const closeRevoke = () => {
    setTarget(undefined);
  };
  useAtomSubscribe(revokeForm.submit, (result) => {
    if (result.waiting || !AsyncResult.isSuccess(result)) {
      return;
    }
    setNotice(result.value);
    closeRevoke();
    reload();
  });

  if (state.state === 'pending') {
    return <ModulePageSkeleton />;
  }
  if (state.state === 'failed') {
    return (
      <StatusText aria-live="polite" showIcon status="error">
        {failureText(state.error.reason, state.error.detail)}
      </StatusText>
    );
  }

  const { company, connections: allConnections, filterOptions, stats } = state.value;
  const connections =
    targetGrantId === undefined
      ? allConnections
      : allConnections.filter((connection) => connection.grantId === targetGrantId);
  const filterKeys = Object.keys(filter);
  let emptyText =
    targetGrantId === undefined
      ? 'Filtru neodpovídá žádné připojení.'
      : 'Připojení z odkazu neexistuje nebo k němu nemáte přístup.';
  if (filterKeys.length === 0 && targetGrantId === undefined) {
    emptyText = 'Ve firmě zatím nikdo nepřipojil žádnou aplikaci.';
  } else if (filterKeys.length === 1 && filter.status === 'active') {
    emptyText = 'Ve firmě teď není připojená žádná aplikace. Starší připojení najdete ve filtru Stav.';
  }

  return (
    <div className="flex min-w-0 flex-col gap-250">
      {targetGrantId !== undefined && <h2 className="font-semibold text-lg">Detail oprávnění připojení</h2>}
      {notice === '' ? null : (
        <StatusText aria-live="polite" showIcon status="success">
          {notice}
        </StatusText>
      )}
      <p className="text-fg-secondary">
        Všechna připojení ChatGPT, Claude a dalších aplikací ve firmě {company.legalName.replace(/\.$/u, '')}. Odpojená
        aplikace ztratí přístup hned při dalším požadavku.{' '}
        <a className="font-medium text-fg-primary underline" href="/cs/sprava/aktivita-agentu">
          Zobrazit aktivitu agentů
        </a>
      </p>

      <div className="grid grid-cols-1 gap-200 sm:grid-cols-3">
        {tiles(stats).map((tile) => (
          <div className="ontos-tile rounded-lg bg-surface p-250" key={tile.label}>
            <p className="text-fg-secondary text-sm">{tile.label}</p>
            <p className="font-semibold text-2xl">{tile.value}</p>
          </div>
        ))}
      </div>

      <FormRoot
        className="grid grid-cols-1 gap-200 sm:grid-cols-2 lg:grid-cols-4"
        defaultValues={defaultValues}
        form={filterForm}
        key={routeKey}
        translateMessage={shownAsIs}
      >
        <FormReady onReady={setReady} />
        <filterForm.userPrincipalId
          items={[
            { label: 'Všichni', value: '' },
            ...filterOptions.people.map((person) => ({ label: person.displayName, value: person.principalId })),
          ]}
          label="Osoba"
          placeholder="Všichni"
        />
        <filterForm.actingPrincipalId
          items={[
            { label: 'Všichni', value: '' },
            ...filterOptions.agents.map((agent) => ({ label: agent.displayName, value: agent.principalId })),
          ]}
          label="Agent"
          placeholder="Všichni"
        />
        <filterForm.clientId
          items={[
            { label: 'Všechny', value: '' },
            ...filterOptions.clients.map((client) => ({ label: client.name, value: client.clientId })),
          ]}
          label="Aplikace"
          placeholder="Všechny"
        />
        <filterForm.status
          items={[{ label: 'Všechny', value: '' }, ...statusOptions]}
          label="Stav"
          placeholder="Všechny"
        />
      </FormRoot>

      {connections.length === 0 ? (
        <p className="py-400 text-center text-fg-secondary">{emptyText}</p>
      ) : (
        <>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="whitespace-nowrap text-left text-fg-secondary">
                  <th className="p-100 font-semibold">Aplikace</th>
                  <th className="p-100 font-semibold">Osoba</th>
                  <th className="p-100 font-semibold">Jedná jako</th>
                  <th className="p-100 font-semibold">Přístup</th>
                  <th className="p-100 font-semibold">Zápis</th>
                  <th className="p-100 font-semibold">Stav</th>
                  <th className="p-100 font-semibold">Připojeno</th>
                  <th className="p-100 font-semibold">Naposledy použito</th>
                  <th className="p-100">
                    <span className="sr-only">Odpojit</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {connections.map((c) => (
                  <tr className="border-border-primary/60 border-t" key={c.grantId}>
                    <td className="p-100">
                      <span className="font-semibold">{c.client.name}</span>{' '}
                      <Badge appearance="outline" severity="neutral">
                        {c.client.host}
                      </Badge>
                    </td>
                    <td className="p-100">{c.user.displayName}</td>
                    <td className="p-100">{actingAdminLabel(c)}</td>
                    <td className="p-100">{c.live ? accessSummary(c) : '—'}</td>
                    <td className="whitespace-nowrap p-100">
                      <WritePolicyCell connection={c} />
                    </td>
                    <td className="p-100">
                      <span className="grid gap-50">
                        <span className="whitespace-nowrap">
                          <StatusBadge connection={c} />
                        </span>
                        <EndedDetail connection={c} />
                      </span>
                    </td>
                    <td className="whitespace-nowrap p-100">{formatWhen(c.createdAt)}</td>
                    <td className="whitespace-nowrap p-100">{formatWhen(c.lastUsedAt)}</td>
                    <td className="p-100">
                      {c.status === 'active' ? (
                        <Button onClick={() => setTarget(c)} severity="danger" size="sm">
                          Odpojit
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="grid gap-150 md:hidden">
            {connections.map((c) => (
              <li className="ontos-tile rounded-lg bg-surface p-250" key={c.grantId}>
                <div className="grid gap-100 text-sm">
                  <p>
                    <span className="font-semibold">{c.client.name}</span>{' '}
                    <Badge appearance="outline" severity="neutral">
                      {c.client.host}
                    </Badge>
                  </p>
                  <p>Osoba: {c.user.displayName}</p>
                  <p>Jedná jako: {actingAdminLabel(c)}</p>
                  <p>Přístup: {c.live ? accessSummary(c) : '—'}</p>
                  <p className="flex flex-wrap items-center gap-100">
                    Zápis: <WritePolicyCell connection={c} />
                  </p>
                  <div className="grid gap-50">
                    <p className="flex flex-wrap items-center gap-100">
                      Stav: <StatusBadge connection={c} />
                    </p>
                    <EndedDetail connection={c} />
                  </div>
                  <p>Připojeno: {formatWhen(c.createdAt)}</p>
                  <p>Naposledy použito: {formatWhen(c.lastUsedAt)}</p>
                  {c.status === 'active' ? (
                    <Button onClick={() => setTarget(c)} severity="danger" size="sm">
                      Odpojit
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <ConnectionRevokeDialog closeRevoke={closeRevoke} target={target} />
    </div>
  );
};
