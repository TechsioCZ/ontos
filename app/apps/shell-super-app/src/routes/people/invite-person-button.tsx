import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Effect, Option, Schema } from 'effect';
import { useState } from 'react';

import { InvitePeopleRequestSchema } from '../../../shared/people-api.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { invitePerson } from './people-client.ts';
import type { PendingPeopleChange } from './people-model.ts';

const InvitePersonForm = ({
  onClose,
  onCommitted,
}: {
  readonly onClose: () => void;
  readonly onCommitted: (change: PendingPeopleChange) => void;
}) => {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [affiliation, setAffiliation] = useState<'employee' | 'external'>('external');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = () => {
    if (busy) {
      return;
    }
    const payload = Schema.decodeOption(InvitePeopleRequestSchema)({ affiliation, displayName, email });
    if (Option.isNone(payload)) {
      setError('Vyplňte jméno a platnou e-mailovou adresu.');
      return;
    }
    setBusy(true);
    setError('');
    void browserRuntime.runPromise(
      invitePerson(payload.value).pipe(
        Effect.andThen((outcome) =>
          Effect.sync(() => {
            setBusy(false);
            if (outcome.status === 'failed') {
              setError(outcome.message);
              return;
            }
            onCommitted({
              kind: 'membership',
              result: { membership: outcome.value.membership, projection: 'pending' },
            });
            onClose();
          }),
        ),
      ),
    );
  };
  return (
    <Dialog
      actions={
        <>
          <Button disabled={busy} onClick={onClose} theme="outlined" variant="secondary">
            Zrušit
          </Button>
          <Button disabled={busy} onClick={submit} variant="primary">
            {busy ? 'Odesílám…' : 'Vytvořit pozvánku'}
          </Button>
        </>
      }
      closeLabel="Zavřít"
      customTrigger
      onOpenChange={(details) => {
        if (!details.open && !busy) onClose();
      }}
      open
      title="Pozvat člověka"
    >
      <div className="grid gap-200">
        <p>
          Vytvoříme přihlášení a pozvánku do vybrané firmy. Člověk dostane e-mailem odkaz k nastavení vlastního hesla.
          Pozvánka nepřiděluje role ani neaktivuje členství.
        </p>
        <FormInput
          autoComplete="name"
          label="Jméno a příjmení"
          maxLength={200}
          onChange={(event) => setDisplayName(event.target.value)}
          required
          value={displayName}
        />
        <FormInput
          autoComplete="email"
          label="E-mail"
          maxLength={254}
          onChange={(event) => setEmail(event.target.value)}
          required
          type="email"
          value={email}
        />
        <label className="grid gap-50">
          Zařazení ve firmě
          <select
            className="rounded-md border border-border-primary bg-base p-100"
            onChange={(event) => setAffiliation(event.target.value === 'employee' ? 'employee' : 'external')}
            value={affiliation}
          >
            <option value="employee">Zaměstnanec</option>
            <option value="external">Externí osoba</option>
          </select>
        </label>
        <p className="text-fg-secondary text-sm">
          Zařazení určuje pouze vztah k firmě, nikoli oprávnění. AI agenta přidejte na kartě AI agenti na této stránce.
        </p>
        {error === '' ? null : (
          <StatusText role="alert" status="error">
            {error}
          </StatusText>
        )}
      </div>
    </Dialog>
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
      <Button onClick={() => setOpen(true)} variant="primary">
        Pozvat člověka
      </Button>
      {open ? <InvitePersonForm onClose={() => setOpen(false)} onCommitted={onCommitted} /> : null}
    </>
  );
};
