// Explicit CRM assignment, independent of kind, affiliation or role names. The governed people directory
// supplies existing principals; account access remains in Lidé a role.
import { SidePanel, dialogCloseLabel, formatDate, formatNumber, surfaceTileClassName } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { useEffect, useState } from 'react';
import type { CrmCommand } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { CrmCommandOutcome } from '../../../../crm/records.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

const AccountSchema = Schema.Struct({
  displayName: Schema.String,
  kind: Schema.Literals(['human', 'agent']),
  principalRef: Schema.Struct({ principalId: Schema.String, tenantId: Schema.String }),
  principalStatus: Schema.Literals(['active', 'disabled', 'archived']),
  selectedCompanyMembership: Schema.NullOr(
    Schema.Struct({ status: Schema.Literals(['invited', 'active', 'disabled', 'departed']) }),
  ),
});
const AccountListSchema = Schema.Struct({
  items: Schema.Array(AccountSchema),
  nextOffset: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
type Account = typeof AccountSchema.Type;

type Accounts =
  | { readonly kind: 'loading' }
  | { readonly forbidden: boolean; readonly kind: 'unavailable' }
  | { readonly accounts: readonly Account[]; readonly kind: 'ready' };

const loadAccounts = Effect.gen(function* loadAccounts() {
  const client = yield* HttpClient.HttpClient;
  const accounts: Account[] = [];
  let offset = 0;
  while (true) {
    const request = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post('/shell-super-app-api/auth/identity/people/list').pipe(
        HttpClientRequest.setHeader('accept', 'application/json'),
      ),
      { limit: 100, offset },
    );
    const response = yield* client.execute(request);
    if (response.status !== 200) {
      return { forbidden: response.status === 403, kind: 'unavailable' } satisfies Accounts;
    }
    const list = yield* Schema.decodeUnknownEffect(AccountListSchema)(yield* response.json);
    accounts.push(...list.items);
    if (list.nextOffset === null) {
      break;
    }
    if (list.nextOffset <= offset) {
      return { forbidden: false, kind: 'unavailable' } satisfies Accounts;
    }
    offset = list.nextOffset;
  }
  return { accounts, kind: 'ready' } satisfies Accounts;
}).pipe(Effect.orElseSucceed((): Accounts => ({ forbidden: false, kind: 'unavailable' })));

export const TeamPanel = ({
  busy,
  onClose,
  records,
  submit,
}: {
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly records: RecordsResponse;
  readonly submit: (command: CrmCommand) => Promise<CrmCommandOutcome>;
}) => {
  const toaster = useToast();
  const [accounts, setAccounts] = useState<Accounts>({ kind: 'loading' });
  useEffect(() => {
    void browserRuntime.runPromise(loadAccounts).then(setAccounts);
  }, []);
  const run = (command: CrmCommand, success: string) =>
    void submit(command).then((outcome) =>
      toaster.create(
        outcome.ok
          ? { title: success, type: 'success' }
          : { description: outcome.message, title: 'Akce se nezdařila', type: 'error' },
      ),
    );
  const registered = new Set(records.state.salespeople.map((person) => person.principalId));
  const candidates =
    accounts.kind === 'ready'
      ? accounts.accounts.filter(
          (account) =>
            account.principalStatus === 'active' &&
            account.selectedCompanyMembership?.status === 'active' &&
            !registered.has(account.principalRef.principalId),
        )
      : [];
  const clientCount = (id: string) =>
    records.state.clients.items.filter((client) => client.status === 'active' && client.ownerSalespersonId === id)
      .length;

  return (
    <SidePanel
      actions={
        <Button onClick={onClose} theme="outlined" variant="secondary">
          Zavřít
        </Button>
      }
      closeLabel={dialogCloseLabel}
      description="Přiřazení do CRM je samostatné rozhodnutí. Lze zařadit člověka i agenta; druh přihlášení ani pracovní pozice nepřidělují práva."
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel="Změnit šířku panelu"
      size="md"
      title="Obchodníci"
    >
      <div className="flex flex-col gap-250 py-100">
        <ul className="flex flex-col gap-100">
          {records.state.salespeople.map((person) => {
            const owned = clientCount(person.id);
            return (
              <li
                className={`${surfaceTileClassName} flex flex-wrap items-center justify-between gap-100 p-150`}
                key={person.id}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-100 font-medium">
                    {person.name}
                    <Badge size="sm" variant={person.active ? 'success' : 'outline'}>
                      {person.active ? 'Aktivní' : 'Vyřazen'}
                    </Badge>
                  </span>
                  <span className="text-fg-secondary text-xs">
                    {[
                      person.email,
                      `${formatNumber(owned)} aktivních klientů`,
                      person.registeredAt === undefined ? undefined : `zařazen ${formatDate(person.registeredAt)}`,
                    ]
                      .filter((part) => part !== undefined)
                      .join(' · ')}
                  </span>
                </span>
                <Button
                  disabled={busy || (person.active && owned > 0)}
                  onClick={() =>
                    run(
                      { _tag: 'SetSalespersonActive', active: !person.active, salespersonId: person.id },
                      person.active ? `${person.name} vyřazen z obchodníků` : `${person.name} je opět aktivní`,
                    )
                  }
                  size="sm"
                  theme="outlined"
                  title={person.active && owned > 0 ? 'Nejprve převeďte jeho klienty jinému obchodníkovi' : undefined}
                  variant="secondary"
                >
                  {person.active ? 'Vyřadit' : 'Vrátit mezi aktivní'}
                </Button>
              </li>
            );
          })}
        </ul>
        <section className="flex flex-col gap-100">
          <h3 className="font-semibold text-sm">Aktivní lidé a agenti, kteří ještě nejsou zařazení</h3>
          {accounts.kind === 'loading' && <p className="text-fg-secondary text-sm">Načítám účty firmy…</p>}
          {accounts.kind === 'unavailable' && (
            <StatusText showIcon status="warning">
              {accounts.forbidden
                ? 'Seznam účtů firmy vidí jen správce. Nového obchodníka zařadí správce.'
                : 'Seznam účtů se nepodařilo načíst. Zkuste to prosím znovu.'}
            </StatusText>
          )}
          {accounts.kind === 'ready' && candidates.length === 0 && (
            <p className="text-fg-secondary text-sm">
              Všichni aktivní členové firmy jsou zařazení. Členství spravuje správce v Nastavení › Lidé a role.
            </p>
          )}
          {candidates.map((account) => (
            <div
              className="flex flex-wrap items-center justify-between gap-100 rounded-lg border border-border-primary border-dashed p-150"
              key={account.principalRef.principalId}
            >
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{account.displayName}</span>
                <span className="text-fg-secondary text-xs">{account.kind === 'agent' ? 'AI agent' : 'Člověk'}</span>
              </span>
              <Button
                disabled={busy}
                icon="icon-[mdi--account-plus-outline]"
                onClick={() =>
                  run(
                    {
                      _tag: 'RegisterSalesperson',
                      name: account.displayName,
                      principalId: account.principalRef.principalId,
                    },
                    `${account.displayName} zařazen mezi obchodníky`,
                  )
                }
                size="sm"
                variant="primary"
              >
                Zařadit mezi obchodníky
              </Button>
            </div>
          ))}
        </section>
      </div>
    </SidePanel>
  );
};
