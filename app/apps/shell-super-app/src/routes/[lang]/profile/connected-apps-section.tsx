/* eslint-disable no-negated-condition, unicorn/no-negated-condition -- Closed view states read most clearly as error-versus-ready branches. expires: 2026-12-31. */
// @effect-diagnostics globalDate:off -- Browser UI boundary: formats server timestamps for display. expires: 2027-03-31.
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import type { ConnectionListResponse, ConnectionSummary } from '@app/shared-contracts/agent-access';
import { type ReactNode, useEffect, useEffectEvent, useState } from 'react';

import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { loadMyConnections, revokeConnection } from './connected-apps-client.ts';
import {
  accessSummary,
  actingLabel,
  clientKindLabel,
  failureText,
  formatWhen,
  isStale,
  writePolicyBadge,
  writePolicyLabel,
} from './connected-apps-model.ts';
import { ConnectedAppsEditPanel } from './connected-apps-edit-panel.tsx';
import { ConnectedAppsGuide } from './connected-apps-guide.tsx';

type ListView =
  | { readonly status: 'failed'; readonly text: string }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: ConnectionListResponse };

const AppIdentity = ({ connection: c }: { readonly connection: ConnectionSummary }) => (
  <div className="flex min-w-0 items-center gap-150">
    {c.client.logoUri === null ? (
      <span aria-hidden className="icon-[mdi--application-outline] size-400 shrink-0 text-fg-secondary" />
    ) : (
      <img alt="" className="size-400 shrink-0 rounded" src={c.client.logoUri} />
    )}
    <div className="grid min-w-0 gap-50">
      <span className="font-medium">{c.client.name}</span>
      <div className="flex flex-wrap gap-100">
        <Badge size="sm" variant="outline">
          {c.client.host}
        </Badge>
        <Badge size="sm" variant="outline">
          {clientKindLabel[c.client.kind]}
        </Badge>
      </div>
    </div>
  </div>
);

const ActingText = ({ connection: c }: { readonly connection: ConnectionSummary }) => (
  <div className="grid gap-50">
    <span>{actingLabel(c)}</span>
    {c.acting.kind === 'agent' ? (
      <span className="text-fg-secondary text-xs">{`připojil(a) ${c.delegatedBy?.displayName ?? c.user.displayName}`}</span>
    ) : null}
  </div>
);

const RowActions = ({
  connection,
  onEdit,
  onRevoke,
}: {
  readonly connection: ConnectionSummary;
  readonly onEdit: (c: ConnectionSummary) => void;
  readonly onRevoke: (c: ConnectionSummary) => void;
}) => (
  <div className="flex flex-wrap justify-end gap-100 [&_button]:whitespace-nowrap">
    <Button onClick={() => onEdit(connection)} size="sm" theme="outlined" variant="secondary">
      Upravit přístup
    </Button>
    <Button onClick={() => onRevoke(connection)} size="sm" variant="danger">
      Odpojit
    </Button>
  </div>
);

const Field = ({ children, label }: { readonly children: ReactNode; readonly label: string }) => (
  <div className="grid min-w-0 gap-50 text-sm">
    <span className="text-fg-secondary text-xs">{label}</span>
    <div className="min-w-0">{children}</div>
  </div>
);

const RevokeDialog = ({
  connection,
  onCancel,
  onRevoked,
  onStale,
}: {
  readonly connection: ConnectionSummary;
  readonly onCancel: () => void;
  readonly onRevoked: (name: string) => void;
  readonly onStale: (notice: string) => void;
}) => {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const name = connection.client.name;

  const revoke = () => {
    setBusy(true);
    setFailure(undefined);
    void browserRuntime.runPromise(revokeConnection({ grantId: connection.grantId })).then((outcome) => {
      if (outcome.status === 'ok') {
        onRevoked(name);
        return;
      }
      if (isStale(outcome.reason)) {
        onStale(failureText(outcome.reason, outcome.detail));
        return;
      }
      setBusy(false);
      setFailure(failureText(outcome.reason, outcome.detail));
    });
  };

  return (
    <Dialog
      actions={
        <>
          <Button onClick={onCancel} theme="outlined" variant="secondary">
            Zrušit
          </Button>
          <Button disabled={busy} onClick={revoke} variant="danger">
            Odpojit
          </Button>
        </>
      }
      closeLabel="Zavřít dialog"
      customTrigger
      description={`Aplikace ztratí přístup hned při dalším požadavku. Znovu ji připojíte v ${name}.`}
      onOpenChange={(details) => {
        if (!details.open) {
          onCancel();
        }
      }}
      open
      role="alertdialog"
      size="sm"
      title={`Odpojit ${name}?`}
    >
      {failure === undefined ? null : (
        <StatusText showIcon status="error">
          {failure}
        </StatusText>
      )}
    </Dialog>
  );
};

/** "Připojené aplikace" of the signed-in person: their AI connections, narrowing access, and disconnecting. */
export const ConnectedAppsSection = () => {
  const [view, setView] = useState<ListView>({ status: 'loading' });
  const [notice, setNotice] = useState<{ readonly text: string; readonly tone: 'success' | 'warning' } | undefined>(
    undefined,
  );
  const [editing, setEditing] = useState<ConnectionSummary | undefined>(undefined);
  const [revoking, setRevoking] = useState<ConnectionSummary | undefined>(undefined);

  const reload = (): Promise<void> =>
    browserRuntime.runPromise(loadMyConnections).then((outcome) => {
      setView(
        outcome.status === 'ok'
          ? { status: 'ready', value: outcome.value }
          : { status: 'failed', text: failureText(outcome.reason, outcome.detail) },
      );
    });
  const loadOnMount = useEffectEvent(() => {
    void reload();
  });
  useEffect(() => {
    loadOnMount();
  }, []);

  const connectionsView = view.status === 'ready' ? view.value : undefined;
  const connections = connectionsView?.connections ?? [];

  return (
    <section className="ontos-card rounded-lg border border-border-primary/60 bg-base [&_.ontos-card]:border-0 [&_.ontos-card]:bg-transparent [&_.ontos-card]:p-0 grid w-full min-w-0 max-w-6xl gap-200 p-300">
      <div className="grid min-w-0 gap-100">
        <h2 className="font-semibold text-lg">Připojené aplikace</h2>
        <p className="text-fg-secondary text-sm">
          Aplikace, které jste připojil(a) k OntOS (ChatGPT, Claude a další). Každé připojení platí jen pro jednu firmu
          a jen v rozsahu, který jste povolil(a).
        </p>
      </div>

      {notice === undefined ? null : (
        <StatusText aria-live="polite" showIcon status={notice.tone}>
          {notice.text}
        </StatusText>
      )}

      {view.status === 'loading' ? <p className="text-fg-secondary text-sm">Načítám připojené aplikace…</p> : null}
      {view.status === 'failed' ? (
        <StatusText showIcon status="error">
          {view.text}
        </StatusText>
      ) : null}

      {view.status === 'ready' && connections.length === 0 ? (
        <div className="grid justify-items-center gap-100 py-300 text-center">
          <p className="font-semibold">Zatím nemáte připojenou žádnou aplikaci</p>
          <p className="text-fg-secondary text-sm">Připojte ChatGPT, Claude nebo jinou aplikaci podle návodu níže.</p>
        </div>
      ) : null}

      {connections.length === 0 ? null : (
        <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="whitespace-nowrap border-border-primary/60 border-b text-left text-fg-secondary text-xs">
                  <th className="py-100 pr-150 font-medium" scope="col">
                    Aplikace
                  </th>
                  <th className="py-100 pr-150 font-medium" scope="col">
                    Firma
                  </th>
                  <th className="py-100 pr-150 font-medium" scope="col">
                    Jako
                  </th>
                  <th className="py-100 pr-150 font-medium" scope="col">
                    Přístup
                  </th>
                  <th className="py-100 pr-150 font-medium" scope="col">
                    Zápis
                  </th>
                  <th className="py-100 pr-150 font-medium" scope="col">
                    Připojeno
                  </th>
                  <th className="py-100 pr-150 font-medium" scope="col">
                    Naposledy použito
                  </th>
                  <th className="py-100 font-medium" scope="col">
                    <span className="sr-only">Akce</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {connections.map((c) => (
                  <tr key={c.grantId} className="border-border-primary/60 border-b align-top">
                    <td className="py-150 pr-150">
                      <AppIdentity connection={c} />
                    </td>
                    <td className="py-150 pr-150">{c.legalName}</td>
                    <td className="py-150 pr-150">
                      <ActingText connection={c} />
                    </td>
                    <td className="py-150 pr-150">{accessSummary(c)}</td>
                    <td className="whitespace-nowrap py-150 pr-150">
                      <Badge size="sm" variant={writePolicyBadge[c.writePolicy]}>
                        {writePolicyLabel[c.writePolicy]}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap py-150 pr-150">{formatWhen(c.createdAt)}</td>
                    <td className="whitespace-nowrap py-150 pr-150">{formatWhen(c.lastUsedAt)}</td>
                    <td className="py-150">
                      <RowActions connection={c} onEdit={setEditing} onRevoke={setRevoking} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="grid gap-150 md:hidden">
            {connections.map((c) => (
              <li key={c.grantId} className="ontos-tile grid min-w-0 gap-150 rounded-md bg-surface p-200">
                <AppIdentity connection={c} />
                <Field label="Firma">{c.legalName}</Field>
                <Field label="Jako">
                  <ActingText connection={c} />
                </Field>
                <Field label="Přístup">{accessSummary(c)}</Field>
                <Field label="Zápis">
                  <Badge size="sm" variant={writePolicyBadge[c.writePolicy]}>
                    {writePolicyLabel[c.writePolicy]}
                  </Badge>
                </Field>
                <Field label="Připojeno">{formatWhen(c.createdAt)}</Field>
                <Field label="Naposledy použito">{formatWhen(c.lastUsedAt)}</Field>
                <RowActions connection={c} onEdit={setEditing} onRevoke={setRevoking} />
              </li>
            ))}
          </ul>
        </>
      )}

      {connectionsView === undefined ? null : <ConnectedAppsGuide mcpUrl={connectionsView.mcpUrl} />}

      {editing === undefined ? null : (
        <ConnectedAppsEditPanel
          connection={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(name) => {
            setNotice({ text: `Přístup pro ${name} je upravený.`, tone: 'success' });
            void reload();
          }}
          onStale={(text) => {
            setNotice({ text: `${text} Seznam je znovu načtený.`, tone: 'warning' });
            void reload();
          }}
        />
      )}

      {revoking === undefined ? null : (
        <RevokeDialog
          connection={revoking}
          onCancel={() => setRevoking(undefined)}
          onRevoked={(name) => {
            setRevoking(undefined);
            setNotice({ text: `Aplikace ${name} je odpojená.`, tone: 'success' });
            void reload();
          }}
          onStale={(text) => {
            setRevoking(undefined);
            setNotice({ text: `${text} Seznam je znovu načtený.`, tone: 'warning' });
            void reload();
          }}
        />
      )}
    </section>
  );
};
