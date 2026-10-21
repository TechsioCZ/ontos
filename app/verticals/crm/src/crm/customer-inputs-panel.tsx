// Register of customer inputs R01–R08 (CRM.md §6): what is missing, who asked and when, what it blocks, evidence and
// state; a delivered sample keeps its schema version and approval date. Správce / vedoucí edit, everybody reads.
import { SidePanel, dialogCloseLabel, formatDate, formatDateTime } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { CrmCommand } from '../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import type {
  CustomerInput,
  CustomerInputDefinition,
  CustomerInputStatus,
} from '../../shared/domain/customer-inputs.ts';
import {
  customerInputDefinitions,
  customerInputStatusLabels,
  customerInputsOf,
} from '../../shared/domain/customer-inputs.ts';
import type { CrmCommandOutcome } from './records.ts';

const statusVariant: Record<CustomerInputStatus, 'success' | 'warning' | 'info' | 'outline'> = {
  approved: 'success',
  not_needed: 'outline',
  received: 'info',
  requested: 'warning',
};

const statuses: readonly CustomerInputStatus[] = ['requested', 'received', 'approved', 'not_needed'];

const Row = ({ label, children }: { readonly label: string; readonly children: React.ReactNode }) => (
  <div className="grid grid-cols-1 gap-25 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-150">
    <dt className="text-fg-secondary">{label}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </div>
);

const InputEditor = ({
  busy,
  input,
  onDone,
  submit,
}: {
  readonly busy: boolean;
  readonly input: CustomerInput;
  readonly onDone: () => void;
  readonly submit: (command: CrmCommand) => Promise<CrmCommandOutcome>;
}) => {
  const toaster = useToast();
  const [status, setStatus] = useState<CustomerInputStatus>(input.status);
  const [requestedBy, setRequestedBy] = useState(input.requestedBy);
  const [requestedAt, setRequestedAt] = useState(input.requestedAt.slice(0, 10));
  const [evidence, setEvidence] = useState(input.evidence);
  const [sampleVersion, setSampleVersion] = useState(input.sampleVersion ?? '');
  const [sampleApprovedAt, setSampleApprovedAt] = useState(input.sampleApprovedAt?.slice(0, 10) ?? '');
  const [note, setNote] = useState('');
  const save = () =>
    void submit({
      _tag: 'UpdateCustomerInput',
      evidence: evidence.trim(),
      id: input.id,
      requestedAt,
      requestedBy: requestedBy.trim(),
      status,
      ...(note.trim() === '' ? {} : { note: note.trim() }),
      ...(sampleVersion.trim() === '' ? {} : { sampleVersion: sampleVersion.trim() }),
      ...(sampleApprovedAt === '' || status !== 'approved' ? {} : { sampleApprovedAt }),
    }).then((outcome) => {
      toaster.create(
        outcome.ok
          ? { title: `${input.id}: ${customerInputStatusLabels[status]}`, type: 'success' }
          : { description: outcome.message, title: 'Změnu se nepodařilo uložit', type: 'error' },
      );
      if (outcome.ok) {
        onDone();
      }
    });
  return (
    <div className="flex flex-col gap-150 rounded-lg bg-surface-secondary p-150">
      <SelectTemplate
        items={statuses.map((value) => ({ label: customerInputStatusLabels[value], value }))}
        label="Stav"
        name={`input-status-${input.id}`}
        onValueChange={(details) => {
          const next = details.value[0];
          if (next === 'requested' || next === 'received' || next === 'approved' || next === 'not_needed') {
            setStatus(next);
          }
        }}
        size="sm"
        value={[status]}
      />
      <div className="grid grid-cols-1 gap-150 sm:grid-cols-2">
        <FormInput
          id={`input-by-${input.id}`}
          label="Kdo požádal"
          onChange={(event) => setRequestedBy(event.target.value)}
          size="sm"
          value={requestedBy}
        />
        <FormInput
          id={`input-at-${input.id}`}
          label="Datum požadavku"
          onChange={(event) => setRequestedAt(event.target.value)}
          size="sm"
          type="date"
          value={requestedAt}
        />
        <FormInput
          id={`input-version-${input.id}`}
          label="Verze schématu / vzorku"
          onChange={(event) => setSampleVersion(event.target.value)}
          placeholder="např. crm-orders-csv-v1"
          size="sm"
          value={sampleVersion}
        />
        <FormInput
          disabled={status !== 'approved'}
          id={`input-approved-${input.id}`}
          label="Datum odsouhlasení"
          onChange={(event) => setSampleApprovedAt(event.target.value)}
          size="sm"
          type="date"
          value={sampleApprovedAt}
        />
      </div>
      <FormTextarea
        id={`input-evidence-${input.id}`}
        label="Důkaz požadavku"
        maxLength={4000}
        onChange={(event) => setEvidence(event.target.value)}
        rows={2}
        value={evidence}
      />
      <FormTextarea
        id={`input-note-${input.id}`}
        label="Poznámka ke změně (zapíše se do historie)"
        maxLength={4000}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        value={note}
      />
      <div className="flex flex-wrap gap-100">
        <Button
          disabled={evidence.trim() === '' || requestedBy.trim() === ''}
          isLoading={busy}
          onClick={save}
          size="sm"
          variant="primary"
        >
          Uložit
        </Button>
        <Button onClick={onDone} size="sm" theme="outlined" variant="secondary">
          Zrušit
        </Button>
      </div>
    </div>
  );
};

const InputCard = ({
  busy,
  definition,
  editable,
  input,
  submit,
}: {
  readonly busy: boolean;
  readonly definition: CustomerInputDefinition;
  readonly editable: boolean;
  readonly input: CustomerInput;
  readonly submit: (command: CrmCommand) => Promise<CrmCommandOutcome>;
}) => {
  const [editing, setEditing] = useState(false);
  return (
    <li className="flex flex-col gap-150 rounded-lg border border-border-primary p-200">
      <div className="flex flex-wrap items-start justify-between gap-100">
        <h3 className="font-semibold text-sm">
          {definition.id} · {definition.title}
        </h3>
        <Badge size="sm" variant={statusVariant[input.status]}>
          {customerInputStatusLabels[input.status]}
        </Badge>
      </div>
      <dl className="flex flex-col gap-75 text-sm">
        <Row label="Co je blokováno">{definition.blocks}</Row>
        <Row label="Do té doby předvádíme">{definition.demoFallback}</Row>
        <Row label="Kdo požádal, kdy">{`${input.requestedBy}, ${formatDate(input.requestedAt)}`}</Row>
        <Row label="Důkaz požadavku">{input.evidence}</Row>
        <Row label="Verze vzorku / schématu">
          {input.sampleVersion === undefined ? (
            <span className="text-fg-secondary">vzorek nedodán</span>
          ) : (
            <>
              <code className="rounded-sm bg-surface-secondary px-50 text-xs">{input.sampleVersion}</code>
              {input.sampleApprovedAt === undefined
                ? ' · neodsouhlaseno'
                : ` · odsouhlaseno ${formatDate(input.sampleApprovedAt)}`}
            </>
          )}
        </Row>
        {input.note !== undefined && <Row label="Poznámka">{input.note}</Row>}
        {input.history.length > 0 && (
          <Row label="Historie">
            <ul className="flex flex-col gap-25">
              {input.history.toReversed().map((change) => (
                <li key={`${change.at}-${change.status}`}>
                  {`${formatDateTime(change.at)} · ${customerInputStatusLabels[change.status]}${change.note === undefined ? '' : ` · ${change.note}`}`}
                </li>
              ))}
            </ul>
          </Row>
        )}
      </dl>
      {editable &&
        (editing ? (
          <InputEditor busy={busy} input={input} onDone={() => setEditing(false)} submit={submit} />
        ) : (
          <div>
            <Button
              icon="icon-[mdi--pencil-outline]"
              onClick={() => setEditing(true)}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              Změnit stav
            </Button>
          </div>
        ))}
    </li>
  );
};

export const CustomerInputsPanel = ({
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
  const inputs = customerInputsOf(records.state.customerInputs);
  const open = inputs.filter((input) => input.status === 'requested' || input.status === 'received').length;
  return (
    <SidePanel
      actions={
        <Button onClick={onClose} theme="outlined" variant="secondary">
          Zavřít
        </Button>
      }
      closeLabel={dialogCloseLabel}
      description={`Co musí zákazník dodat nebo rozhodnout (zadání kap. 6). Otevřené: ${open} z ${inputs.length}. Blokované části se nikdy nevydávají za hotové.`}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open
      resizeLabel="Změnit šířku panelu"
      size="lg"
      title="Vstupy od zákazníka (R01–R08)"
    >
      <ul className="flex flex-col gap-150 py-100">
        {customerInputDefinitions.map((definition) => (
          <InputCard
            busy={busy}
            definition={definition}
            editable={records.viewer.writeAll}
            input={inputs.find((entry) => entry.id === definition.id) ?? inputs[0]!}
            key={definition.id}
            submit={submit}
          />
        ))}
      </ul>
    </SidePanel>
  );
};
