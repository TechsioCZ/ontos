import { assignableSalespeople, salespersonName } from '../../../../crm/records.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { Effect } from 'effect';
// (Re)assign a client to a salesperson — Správce / Vedoucí only (demo.crm.assign, enforced by the reducer).
// The reason is stored in the assignment history; past visits keep their author (C00-03).
import { dialogCloseLabel } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { Client } from '../../../../../shared/domain/clients.ts';

const NONE = 'none';

export const AssignDialog = ({
  busy,
  client,
  onClose,
  records,
  run,
}: {
  readonly busy: boolean;
  readonly client: Client;
  readonly onClose: () => void;
  readonly records: RecordsResponse;
  readonly run: (command: CrmCommandInput, success: string) => Effect.Effect<boolean>;
}) => {
  const current = client.ownerSalespersonId ?? NONE;
  const [target, setTarget] = useState(current);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const reassign = client.ownerSalespersonId !== undefined;
  const reasonMissing = reassign && reason.trim() === '';
  const unchanged = target === current;
  const targetName = target === NONE ? 'bez obchodníka' : (salespersonName(records, target) ?? '');

  const save = () => {
    setTouched(true);
    if (unchanged || reasonMissing) {
      return;
    }
    const command: Extract<CrmCommandInput, { readonly _tag: 'AssignClient' }> = {
      _tag: 'AssignClient',
      clientId: client.id,
    };
    if (target !== NONE) {
      Object.assign(command, { toSalespersonId: target });
    }
    if (reason.trim() !== '') {
      Object.assign(command, { reason: reason.trim() });
    }
    browserRuntime.runFork(
      run(command, target === NONE ? 'Klient je nyní bez obchodníka' : `Klient přidělen: ${targetName}`).pipe(
        Effect.tap((ok) =>
          Effect.sync(() => {
            if (ok) {
              onClose();
            }
          }),
        ),
      ),
    );
  };

  return (
    <Dialog
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            Zrušit
          </Button>
          <Button disabled={unchanged} isLoading={busy} loadingText="Ukládám…" onClick={save} variant="primary">
            {reassign ? 'Převést klienta' : 'Přidělit'}
          </Button>
        </>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description={`Nyní: ${salespersonName(records, client.ownerSalespersonId) ?? 'bez obchodníka'}. Nový obchodník uvidí klienta i celou jeho historii; návštěvy zapsané dosavadním obchodníkem zůstanou s původním autorem.`}
      onOpenChange={({ open }) => {
        if (!open) {
          onClose();
        }
      }}
      open
      size="md"
      title={reassign ? `Převést klienta ${client.name}` : `Přidělit klienta ${client.name}`}
    >
      <div className="flex flex-col gap-200">
        <SelectTemplate
          items={[
            ...assignableSalespeople(records).map((person) => ({
              label: person.id === client.ownerSalespersonId ? `${person.name} (současný)` : person.name,
              value: person.id,
            })),
            { label: 'Bez obchodníka', value: NONE },
          ]}
          label="Nový obchodník"
          name="assign-target"
          onValueChange={(details) => setTarget(details.value[0] ?? current)}
          value={[target]}
        />
        <FormTextarea
          id="crm-assign-reason"
          label={reassign ? 'Důvod převodu (povinný)' : 'Poznámka k přidělení'}
          maxLength={4000}
          onChange={(event) => setReason(event.target.value)}
          placeholder={reassign ? 'např. Změna regionu, převzetí po kolegovi' : ''}
          rows={3}
          value={reason}
        />
        {touched && reasonMissing && (
          <StatusText showIcon status="error">
            Uveďte důvod převodu, zapíše se do historie klienta.
          </StatusText>
        )}
      </div>
    </Dialog>
  );
};
