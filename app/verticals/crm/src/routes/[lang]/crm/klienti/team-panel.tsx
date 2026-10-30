import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { pipe, Effect } from 'effect';
import { orderDateText } from '../../../../../shared/domain/imports.ts';
// Explicit CRM assignment, independent of kind, affiliation or role names. The governed people directory
// supplies existing principals; account access remains in Lidé a role.
import { SidePanel, dialogCloseLabel, formatDate, formatNumber, surfaceTileClassName } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { useToast } from '@techsio/ui-kit/molecules/toast';

import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

const REQUEST_TIMEOUT = '30 seconds';

export const TeamPanel = ({
  busy,
  onClose,
  records,
  submit,
}: {
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly records: RecordsResponse;
  readonly submit: CrmCommandSubmit;
}) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const run = (command: CrmCommandInput, success: string) => {
    browserRuntime.runFork(
      submit(command).pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.andThen((outcome) =>
          Effect.sync(() => {
            toaster.create(
              outcome.ok
                ? { title: success, type: 'success' }
                : { description: outcome.message, title: 'Akce se nezdařila', type: 'error' },
            );
          }),
        ),
      ),
    );
  };
  const registered = new Set(records.state.salespeople.map((person) => person.principalId));
  const candidates = records.assignmentCandidates.filter(
    (account) => !registered.has(account.principalRef.principalId),
  );
  const departed = new Set(records.departedPrincipalIds);
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
      description="Zařaďte člověka nebo agenta s aktivním přístupem do CRM této firmy. Odchod z firmy zachovává historii; klienty převeďte jinému obchodníkovi."
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel="Změnit šířku panelu"
      size="md"
      title={t('crm.ciClientsVisits.clients.salespeople')}
    >
      <div className="flex flex-col gap-250 py-100">
        <ul className="flex flex-col gap-100">
          {records.state.salespeople.map((person) => {
            const owned = clientCount(person.id);
            const hasDeparted = person.principalId !== undefined && departed.has(person.principalId);
            const activeLabel = person.active ? 'Aktivní' : 'Vyřazen';
            return (
              <li
                className={`${surfaceTileClassName} flex flex-wrap items-center justify-between gap-100 p-150`}
                key={person.id}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-100 font-medium">
                    {person.name}
                    <Badge size="sm" variant={person.active ? 'success' : 'outline'}>
                      {hasDeparted ? 'Odešel – přeřadit' : activeLabel}
                    </Badge>
                  </span>
                  <span className="text-fg-secondary text-xs">
                    {[
                      person.email,
                      `${formatNumber(owned)} aktivních klientů`,
                      person.registeredAt === undefined
                        ? undefined
                        : `zařazen ${pipe(person.registeredAt, orderDateText, formatDate)}`,
                    ]
                      .filter((part) => part !== undefined)
                      .join(' · ')}
                  </span>
                </span>
                <Button
                  disabled={busy || (person.active && owned > 0) || (!person.active && hasDeparted)}
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
          {candidates.length === 0 ? (
            <p className="text-fg-secondary text-sm">
              Všichni dostupní obchodníci už jsou zařazení. Přístup do CRM spravuje správce v Nastavení › Lidé a role.
            </p>
          ) : null}
          {candidates.map((account) => (
            <div
              className="flex flex-wrap items-center justify-between gap-100 rounded-lg border border-border-primary border-dashed p-150"
              key={account.principalRef.principalId}
            >
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{account.displayName}</span>
                <span className="text-fg-secondary text-xs">Přístup do CRM ověřen</span>
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
