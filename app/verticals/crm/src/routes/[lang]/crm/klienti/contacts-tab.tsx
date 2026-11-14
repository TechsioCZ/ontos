import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect } from 'effect';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

// "Kontakty" tab of the client card: contact persons with work role, phone, e-mail and note (C01). Add / edit
// inline; "Odebrat" archives the person (kept in history, never deleted). One person can be the main contact.
import { EmptyState, dialogCloseLabel } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { useState } from 'react';
import type { ContactPerson } from '../../../../../shared/domain/clients.ts';
import type { ClientCardTabProps } from './card-tab-props.ts';
import { activeContactsOf } from './clients-model.ts';
import { ContactCard } from './contact-card.tsx';
import { ContactForm } from './contact-form.tsx';

export const ContactsTab = ({
  busy,
  client,
  onRequestLeave,
  records,
  selectedContactId,
  submit,
  writable,
}: ClientCardTabProps & {
  /**
   * Leaves the open contact form through the unsaved-changes guards of the client card; leaves at once when the tab
   * is shown outside a card.
   */
  readonly onRequestLeave?: ((leave: () => void) => void) | undefined;
  readonly selectedContactId?: string | undefined;
  readonly writable: boolean;
}) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const requestLeave = onRequestLeave ?? ((leave: () => void) => leave());
  const [editing, setEditing] = useState<string | undefined>();
  const [removing, setRemoving] = useState<ContactPerson | undefined>();
  const [showRemoved, setShowRemoved] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const active = activeContactsOf(records, client.id);
  const removed = records.state.clients.contacts.filter(
    (contact) => contact.clientId === client.id && contact.status === 'archived',
  );

  const run = (command: Parameters<typeof submit>[0], success: string, done: () => void) => {
    setFailure(undefined);
    browserRuntime.runFork(
      submit(command).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            if (outcome.ok) {
              toaster.create({ title: success, type: 'success' });
              done();
            } else {
              setFailure(outcome.message ?? 'Uložení se nezdařilo.');
            }
          }),
        ),
      ),
    );
  };

  return (
    <div className="flex flex-col gap-200">
      {writable && editing === undefined && (
        <div>
          <Button
            icon="icon-[mdi--account-plus-outline]"
            onClick={() => requestLeave(() => setEditing('new'))}
            size="sm"
            variant="primary"
          >
            Přidat kontaktní osobu
          </Button>
        </div>
      )}
      {failure !== undefined && (
        <StatusText showIcon status="error">
          {failure}
        </StatusText>
      )}
      {editing === 'new' && (
        <ContactForm
          clientId={client.id}
          isFirst={active.length === 0}
          onClose={() => setEditing(undefined)}
          onSaved={(draft) => {
            toaster.create({
              title: `${t('crm.ciClientsVisits.contacts.added')}: ${draft.name.trim()}`,
              type: 'success',
            });
          }}
          submit={submit}
        />
      )}
      {active.length === 0 && editing !== 'new' ? (
        <EmptyState
          description={
            writable
              ? 'Přidejte první kontaktní osobu klienta.'
              : 'U klienta zatím není evidovaná žádná kontaktní osoba.'
          }
          title={t('crm.ciClientsVisits.contacts.empty')}
        />
      ) : (
        <ul className="grid grid-cols-1 gap-150">
          {active.map((contact) =>
            editing === contact.id ? (
              <li key={contact.id}>
                <ContactForm
                  clientId={client.id}
                  contact={contact}
                  isFirst={false}
                  onClose={() => setEditing(undefined)}
                  onSaved={() => {
                    toaster.create({ title: t('crm.ciClientsVisits.contacts.saved'), type: 'success' });
                  }}
                  submit={submit}
                />
              </li>
            ) : (
              <ContactCard
                contact={contact}
                key={contact.id}
                onEdit={() => requestLeave(() => setEditing(contact.id))}
                onRemove={() => setRemoving(contact)}
                selected={contact.id === selectedContactId}
                writable={writable}
              />
            ),
          )}
        </ul>
      )}
      {removed.length > 0 && (
        <div className="flex flex-col gap-150">
          <Button
            className="w-fit"
            icon={showRemoved ? 'icon-[mdi--chevron-up]' : 'icon-[mdi--chevron-down]'}
            onClick={() => setShowRemoved((value) => !value)}
            size="sm"
            theme="borderless"
            variant="secondary"
          >
            {showRemoved ? 'Skrýt odebrané osoby' : `Zobrazit odebrané osoby (${removed.length})`}
          </Button>
          {showRemoved && (
            <ul className="grid grid-cols-1 gap-150">
              {removed.map((contact) => (
                <ContactCard contact={contact} key={contact.id} writable={false} />
              ))}
            </ul>
          )}
        </div>
      )}
      <Dialog
        actions={
          <>
            <Button onClick={() => setRemoving(undefined)} theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <Button
              isLoading={busy}
              onClick={() => {
                if (removing !== undefined) {
                  run(
                    { _tag: 'RemoveContactPerson', contactId: removing.id },
                    `${removing.name} odebrán(a) z kontaktů`,
                    () => setRemoving(undefined),
                  );
                }
              }}
              variant="primary"
            >
              Odebrat
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description="Osoba zmizí z aktivních kontaktů klienta. Záznam zůstane v historii a mezi odebranými osobami."
        onOpenChange={({ open }) => {
          if (!open) {
            setRemoving(undefined);
          }
        }}
        open={removing !== undefined}
        size="sm"
        title={removing === undefined ? 'Odebrat osobu' : `Odebrat ${removing.name}?`}
      />
    </div>
  );
};
