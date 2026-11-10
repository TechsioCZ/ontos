import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import type { HttpClient } from 'effect/http';
import { useState } from 'react';

import { InvitePeopleRequestSchema } from '../../../shared/people-api.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { invitePerson } from './people-client.ts';
import type { PendingPeopleChange } from './people-model.ts';

interface InviteDraft {
  readonly affiliation: 'employee' | 'external';
  readonly displayName: string;
  readonly email: string;
}
const emptyInvite: InviteDraft = { affiliation: 'external', displayName: '', email: '' };
const inviteRequestOf = Schema.decodeOption(InvitePeopleRequestSchema);

/**
 * Invites a person: typing changes only the draft; the shared Uložit sends the invitation once and closes the dialog;
 * Zrušit, the close button and leaving the page with typed input ask first; an untouched dialog closes at once.
 */
const InvitePersonForm = ({
  onClose,
  onCommitted,
}: {
  readonly onClose: () => void;
  readonly onCommitted: (change: PendingPeopleChange) => void;
}) => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const [draft, setDraft] = useState(emptyInvite);
  const [error, setError] = useState<string | null>(null);
  const record = useDraftSave<InviteDraft, HttpClient.HttpClient>({
    initial: emptyInvite,
    isValid: (value) => Option.isSome(inviteRequestOf(value)),
    runtime: browserRuntime,
    save: (value) =>
      Option.match(inviteRequestOf(value), {
        onNone: () => Effect.succeed<SaveOutcome>('failed'),
        onSome: (payload) =>
          invitePerson(payload).pipe(
            Effect.map((outcome): SaveOutcome => {
              if (outcome.status === 'failed') {
                setError(outcome.message);
                return 'failed';
              }
              setError(null);
              onCommitted({
                kind: 'membership',
                result: { membership: outcome.value.membership, projection: 'pending' },
              });
              return 'saved';
            }),
          ),
      }),
    value: draft,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => {
      setError(null);
      setDraft(emptyInvite);
    },
  });
  const busy = record.status === 'saving';
  const requestClose = () => guard.request(onClose);
  const handleSave = () => {
    record.save();
    record.afterSave((status) => {
      if (status === 'saved') {
        onClose();
      }
    });
  };
  const change = (patch: Partial<InviteDraft>) => setDraft((current) => ({ ...current, ...patch }));
  return (
    <>
      <Dialog
        actions={
          <>
            <Button disabled={busy} onClick={requestClose} theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <SaveBar
              error={error}
              labels={labels}
              onReloadLatest={constVoid}
              onSave={handleSave}
              status={record.status}
            />
          </>
        }
        closeLabel="Zavřít"
        customTrigger
        onOpenChange={(details) => {
          if (!details.open && !busy) {
            requestClose();
          }
        }}
        open
        title={t('shell.people.invite')}
      >
        <div className="grid gap-200">
          <p>
            Vytvoříme přihlášení a pozvánku do vybrané firmy. Člověk dostane e-mailem odkaz k nastavení vlastního hesla.
            Pozvánka nepřiděluje role ani neaktivuje členství.
          </p>
          <FormInput
            autoComplete="name"
            label={t('shell.people.fullName')}
            maxLength={200}
            onChange={(event) => change({ displayName: event.target.value })}
            required
            value={draft.displayName}
          />
          <FormInput
            autoComplete="email"
            label={t('shell.auth.identity.email')}
            maxLength={254}
            onChange={(event) => change({ email: event.target.value })}
            required
            type="email"
            value={draft.email}
          />
          <label className="grid gap-50">
            Zařazení ve firmě
            <select
              className="rounded-md border border-border-primary bg-base p-100"
              onChange={(event) => change({ affiliation: event.target.value === 'employee' ? 'employee' : 'external' })}
              value={draft.affiliation}
            >
              <option value="employee">Zaměstnanec</option>
              <option value="external">Externí osoba</option>
            </select>
          </label>
          <p className="text-fg-secondary text-sm">
            Zařazení určuje pouze vztah k firmě, nikoli oprávnění. AI agenta přidejte na kartě AI agenti na této
            stránce.
          </p>
          {record.status === 'invalid' ? (
            <StatusText role="alert" status="warning">
              Vyplňte jméno a platnou e-mailovou adresu.
            </StatusText>
          ) : null}
        </div>
      </Dialog>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

export const InvitePersonButton = ({
  onCommitted,
}: {
  readonly onCommitted: (change: PendingPeopleChange) => void;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon="icon-[mdi--account-plus-outline]" onClick={() => setOpen(true)} size="sm" variant="primary">
        Pozvat člověka
      </Button>
      {open ? <InvitePersonForm onClose={() => setOpen(false)} onCommitted={onCommitted} /> : null}
    </>
  );
};
