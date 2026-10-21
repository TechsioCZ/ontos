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
import type { ChangeEvent } from 'react';
import { useEffect, useState } from 'react';

import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { loadCompanyConnections, revokeConnection } from '../../profile/connected-apps-client.ts';
import type { ConnectionsFailure } from '../../profile/connected-apps-client.ts';
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

type FilterKey = 'actingPrincipalId' | 'clientId' | 'status' | 'userPrincipalId';

type PanelState =
  | { readonly status: 'loading' }
  | { readonly response: ConnectionAdminListResponse; readonly status: 'ready' }
  | { readonly detail: string | null; readonly reason: ConnectionsFailure; readonly status: 'failed' };

const statusOptions: readonly { readonly value: ConnectionStatus; readonly label: string }[] = [
  { label: 'Aktivní', value: 'active' },
  { label: 'Odpojené', value: 'revoked' },
  { label: 'Nahrazené', value: 'superseded' },
  { label: 'Zamítnuté', value: 'denied' },
];

/** Sets one filter key; an empty choice removes the key, so "Všichni" means no restriction. */
const withFilterValue = (filter: ConnectionAdminFilter, key: FilterKey, value: string): ConnectionAdminFilter => {
  const kept = Object.fromEntries(Object.entries(filter).filter(([name]) => name !== key));
  return (value === '' ? kept : { ...kept, [key]: value }) as ConnectionAdminFilter;
};

const tiles = (stats: ConnectionAdminListResponse['stats']) => [
  { label: 'Aktivní připojení', value: stats.active },
  { label: 'Připojení agenti', value: stats.agentsConnected },
  { label: 'S přímým zápisem', value: stats.directWrite },
];

const selectClass = 'w-full min-w-0 max-w-full truncate rounded-md border border-border-primary bg-base p-100';
const labelClass = 'grid min-w-0 gap-50 text-sm';

/** The list opens on active connections; history (Odpojené, Nahrazené, …) is one filter away. */
const DEFAULT_FILTER: ConnectionAdminFilter = { status: 'active' };

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

export const ConnectionsAdminPanel = () => {
  const [filter, setFilter] = useState<ConnectionAdminFilter>(DEFAULT_FILTER);
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState('');
  const [target, setTarget] = useState<ConnectionSummary | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [revokeError, setRevokeError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    browserRuntime.runPromise(loadCompanyConnections({ filter })).then((outcome) => {
      if (!current) {
        return;
      }
      setState(
        outcome.status === 'ok'
          ? { response: outcome.value, status: 'ready' }
          : { detail: outcome.detail, reason: outcome.reason, status: 'failed' },
      );
    });
    return () => {
      current = false;
    };
  }, [filter, version]);

  const closeRevoke = () => {
    setTarget(undefined);
    setReason('');
    setRevokeError('');
  };

  const submitRevoke = () => {
    if (target === undefined) {
      return;
    }
    const trimmed = reason.trim();
    if (trimmed === '') {
      setRevokeError('Uveďte důvod.');
      return;
    }
    setBusy(true);
    setRevokeError('');
    browserRuntime.runPromise(revokeConnection({ grantId: target.grantId, reason: trimmed })).then((outcome) => {
      setBusy(false);
      if (outcome.status === 'ok') {
        setNotice(`Připojení ${target.client.name} je odpojené.`);
        closeRevoke();
        setVersion((count) => count + 1);
        return;
      }
      if (isStale(outcome.reason)) {
        setNotice(`${failureText(outcome.reason, outcome.detail)} Seznam je znovu načtený.`);
        closeRevoke();
        setVersion((count) => count + 1);
        return;
      }
      setRevokeError(failureText(outcome.reason, outcome.detail));
    });
  };

  const onFilterChange = (key: FilterKey) => (event: ChangeEvent<HTMLSelectElement>) => {
    const { value } = event.target;
    setFilter((current) => withFilterValue(current, key, value));
  };

  if (state.status === 'loading') {
    return <p className="text-fg-secondary text-sm">Načítám připojení…</p>;
  }
  if (state.status === 'failed') {
    return (
      <StatusText aria-live="polite" showIcon status="error">
        {failureText(state.reason, state.detail)}
      </StatusText>
    );
  }

  const { company, connections, filterOptions, stats } = state.response;
  const filterKeys = Object.keys(filter);
  let emptyText = 'Filtru neodpovídá žádné připojení.';
  if (filterKeys.length === 0) {
    emptyText = 'Ve firmě zatím nikdo nepřipojil žádnou aplikaci.';
  } else if (filterKeys.length === 1 && filter.status === 'active') {
    emptyText = 'Ve firmě teď není připojená žádná aplikace. Starší připojení najdete ve filtru Stav.';
  }

  return (
    <div className="flex min-w-0 flex-col gap-250">
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

      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2 lg:grid-cols-4">
        <label className={labelClass}>
          Osoba
          <select
            className={selectClass}
            onChange={onFilterChange('userPrincipalId')}
            value={filter.userPrincipalId ?? ''}
          >
            <option value="">Všichni</option>
            {filterOptions.people.map((person) => (
              <option key={person.principalId} value={person.principalId}>
                {person.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Agent
          <select
            className={selectClass}
            onChange={onFilterChange('actingPrincipalId')}
            value={filter.actingPrincipalId ?? ''}
          >
            <option value="">Všichni</option>
            {filterOptions.agents.map((agent) => (
              <option key={agent.principalId} value={agent.principalId}>
                {agent.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Aplikace
          <select className={selectClass} onChange={onFilterChange('clientId')} value={filter.clientId ?? ''}>
            <option value="">Všechny</option>
            {filterOptions.clients.map((client) => (
              <option key={client.clientId} value={client.clientId}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Stav
          <select className={selectClass} onChange={onFilterChange('status')} value={filter.status ?? ''}>
            <option value="">Všechny</option>
            {statusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

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
                  <th className="p-100" />
                </tr>
              </thead>
              <tbody>
                {connections.map((c) => (
                  <tr className="border-border-primary/60 border-t" key={c.grantId}>
                    <td className="p-100">
                      <span className="font-semibold">{c.client.name}</span>{' '}
                      <Badge variant="outline">{c.client.host}</Badge>
                    </td>
                    <td className="p-100">{c.user.displayName}</td>
                    <td className="p-100">{actingAdminLabel(c)}</td>
                    <td className="p-100">{accessSummary(c)}</td>
                    <td className="whitespace-nowrap p-100">
                      <Badge variant={writePolicyBadge[c.writePolicy]}>{writePolicyLabel[c.writePolicy]}</Badge>
                    </td>
                    <td className="p-100">
                      <span className="grid gap-50">
                        <span className="whitespace-nowrap">
                          <Badge variant={statusBadge[c.status]}>{statusLabel[c.status]}</Badge>
                        </span>
                        <EndedDetail connection={c} />
                      </span>
                    </td>
                    <td className="whitespace-nowrap p-100">{formatWhen(c.createdAt)}</td>
                    <td className="whitespace-nowrap p-100">{formatWhen(c.lastUsedAt)}</td>
                    <td className="p-100">
                      {c.status === 'active' ? (
                        <Button onClick={() => setTarget(c)} size="sm" variant="danger">
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
                    <Badge variant="outline">{c.client.host}</Badge>
                  </p>
                  <p>Osoba: {c.user.displayName}</p>
                  <p>Jedná jako: {actingAdminLabel(c)}</p>
                  <p>Přístup: {accessSummary(c)}</p>
                  <p className="flex flex-wrap items-center gap-100">
                    Zápis: <Badge variant={writePolicyBadge[c.writePolicy]}>{writePolicyLabel[c.writePolicy]}</Badge>
                  </p>
                  <div className="grid gap-50">
                    <p className="flex flex-wrap items-center gap-100">
                      Stav: <Badge variant={statusBadge[c.status]}>{statusLabel[c.status]}</Badge>
                    </p>
                    <EndedDetail connection={c} />
                  </div>
                  <p>Připojeno: {formatWhen(c.createdAt)}</p>
                  <p>Naposledy použito: {formatWhen(c.lastUsedAt)}</p>
                  {c.status === 'active' ? (
                    <Button onClick={() => setTarget(c)} size="sm" variant="danger">
                      Odpojit
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <Dialog
        actions={
          <>
            <Button onClick={closeRevoke} size="sm" theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <Button disabled={busy} onClick={submitRevoke} size="sm" variant="danger">
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
        <div className="grid gap-150">
          <label className={labelClass}>
            Důvod odpojení
            <textarea
              className="w-full rounded-md border border-border-primary bg-base p-100"
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              value={reason}
            />
          </label>
          {revokeError === '' ? null : (
            <StatusText aria-live="polite" showIcon status="error">
              {revokeError}
            </StatusText>
          )}
        </div>
      </Dialog>
    </div>
  );
};
