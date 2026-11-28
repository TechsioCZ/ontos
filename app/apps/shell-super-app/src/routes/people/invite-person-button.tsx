import { SaveBar, UnsavedChangesDialog, requiredLabelFor, saveLabelsFor } from '@app/admin-ui';
import { ChoiceField, FormReact, FormRoot, TextField, fromPayload } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Effect, Option, Schema, Struct } from 'effect';
import { constVoid } from 'effect/Function';
import { useState } from 'react';

import { InvitePeopleRequestSchema } from '../../../shared/people-api.ts';
import { browserAtomRuntime } from '../../runtime/browser-effect-runtime.ts';
import { invitePerson } from './people-client.ts';
import { acceptedValue, incompleteChange, peopleSubmitErrors, usePeopleDialogSave } from './people-dialog-save.ts';
import type { PendingPeopleChange } from './people-model.ts';

const sendInvitation = Effect.fn('InvitePerson.send')(function* sendInvitation(values: {
  readonly affiliation: string;
  readonly displayName: string;
  readonly email: string;
}) {
  const affiliation = yield* Schema.decodeUnknownEffect(InvitePeopleRequestSchema.fields.affiliation)(
    values.affiliation,
  ).pipe(Effect.catchTag('SchemaError', () => Effect.fail(incompleteChange)));
  const invited = yield* invitePerson({ ...values, affiliation }).pipe(Effect.flatMap(acceptedValue));
  const change: PendingPeopleChange = {
    kind: 'membership',
    result: { membership: invited.membership, projection: 'pending' },
  };
  return change;
});

/** The invitation as the Action takes it: name and email from its payload, the affiliation picked from a list. */
const inviteForm = FormReact.make(
  fromPayload(InvitePeopleRequestSchema.mapFields(Struct.pick(['displayName', 'email']))).addField(
    'affiliation',
    Schema.String,
  ),
  {
    fields: { affiliation: ChoiceField, displayName: TextField, email: TextField },
    onSubmit: (_submit, { decoded }) => sendInvitation(decoded),
    runtime: browserAtomRuntime,
    submitErrors: peopleSubmitErrors,
  },
);

const emptyInvite: typeof inviteForm.schema.Encoded = { affiliation: 'external', displayName: '', email: '' };
const affiliations = [
  { label: 'Zaměstnanec', value: 'employee' },
  { label: 'Externí osoba', value: 'external' },
];

/**
 * Invites a person: typing changes only the form; the shared Uložit sends the invitation once and closes the dialog;
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
  const requiredLabel = requiredLabelFor(language);
  const { guard, record, refusal } = usePeopleDialogSave({
    form: inviteForm,
    onSaved: (change) => {
      onCommitted(change);
      onClose();
    },
    opened: emptyInvite,
    valid: (values) => Option.isSome(Schema.decodeUnknownOption(InvitePeopleRequestSchema)(values)),
  });
  const busy = record.status === 'saving';
  const requestClose = () => guard.request(onClose);
  const handleSave = record.save;
  return (
    <>
      <Dialog
        actions={
          <>
            <Button appearance="outline" disabled={busy} onClick={requestClose} severity="secondary">
              Zrušit
            </Button>
            <SaveBar
              error={refusal}
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
        <FormRoot
          className="grid gap-200"
          defaultValues={emptyInvite}
          form={inviteForm}
          translateMessage={(message) => t(message, { defaultValue: message })}
        >
          <p>
            Vytvoříme přihlášení a pozvánku do vybrané firmy. Člověk dostane e-mailem odkaz k nastavení vlastního hesla.
            Pozvánka nepřiděluje role ani neaktivuje členství.
          </p>
          <inviteForm.displayName
            autoComplete="name"
            label={t('shell.people.fullName')}
            maxLength={200}
            required
            requiredLabel={requiredLabel}
          />
          <inviteForm.email
            autoComplete="email"
            label={t('shell.auth.identity.email')}
            maxLength={254}
            required
            requiredLabel={requiredLabel}
            type="email"
          />
          <inviteForm.affiliation items={affiliations} label="Zařazení ve firmě" />
          <p className="text-fg-secondary text-sm">
            Zařazení určuje pouze vztah k firmě, nikoli oprávnění. AI agenta přidejte na kartě AI agenti na této
            stránce.
          </p>
          {record.status === 'invalid' ? (
            <StatusText role="alert" status="warning">
              Vyplňte jméno a platnou e-mailovou adresu.
            </StatusText>
          ) : null}
        </FormRoot>
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
      <Button icon="icon-[mdi--account-plus-outline]" onClick={() => setOpen(true)} severity="primary" size="sm">
        Pozvat člověka
      </Button>
      {open ? <InvitePersonForm onClose={() => setOpen(false)} onCommitted={onCommitted} /> : null}
    </>
  );
};
