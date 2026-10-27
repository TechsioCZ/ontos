import { pipe, DateTime, Effect } from 'effect';
import { orderDateText, isOpenDuplicate } from '../../../../../shared/domain/imports.ts';
import type { ImportedOrder, PairingChange } from '../../../../../shared/domain/imports.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

// AREA: imports — owned by the crm-imports lane. Order detail side panel (state history, lines, pairing history,
// review decisions) and the manual pairing form (C03/C04). Every action is a governed CRM command.
import { DetailList, SidePanel, formatDateTime, surfaceTileClassName } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { ReactNode } from 'react';

import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';

import { salespersonName } from '../../../../crm/records.ts';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';

import { orderStatusLabel, statusReviewReasonLabel } from '../../../../crm/order-status-presentation.ts';
import {
  NOT_PROVIDED,
  RESIZE_LABEL,
  clientLabel,
  useFormatAmount,
  orderDate,
  orderLineDisplayRows,
  orderQueueState,
  orderTitle,
  pairingMeta,
  principalLabel,
} from './order-model.ts';

type Submit = CrmCommandSubmit;

const pairingChangeLabel = (records: RecordsResponse, change: PairingChange) => {
  if (change.toClientId === undefined) {
    return `Zrušeno přiřazení k ${clientLabel(records, change.fromClientId) ?? '—'}`;
  }
  if (change.fromClientId === undefined) {
    return `Přiřazeno: ${clientLabel(records, change.toClientId) ?? '—'}`;
  }
  return `${clientLabel(records, change.fromClientId) ?? '—'} → ${clientLabel(records, change.toClientId) ?? '—'}`;
};

const useRunner = (submit: Submit) => {
  const toaster = useToast();
  return (command: CrmCommandInput, success: string, after?: () => void) => {
    browserRuntime.runFork(
      submit(command).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            toaster.create(
              outcome.ok
                ? { title: success, type: 'success' }
                : { description: outcome.message, title: 'Uložení se nezdařilo', type: 'error' },
            );
            if (outcome.ok) {
              after?.();
            }
          }),
        ),
      ),
    );
  };
};

const Section = ({ children, title }: { readonly children: ReactNode; readonly title: string }) => (
  <section className="flex flex-col gap-150 border-border-primary border-t pt-200">
    <h3 className="font-semibold text-sm">{title}</h3>
    {children}
  </section>
);

const ReasonField = ({
  id,
  label = 'Důvod (uloží se do historie)',
  onChange,
  value,
}: {
  readonly id: string;
  readonly label?: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) => (
  <FormTextarea
    autoComplete="off"
    id={id}
    label={label}
    maxLength={2000}
    onChange={(event) => onChange(event.target.value)}
    required
    rows={2}
    size="sm"
    value={value}
  />
);

export const PairingStateBadge = ({ order }: { readonly order: ImportedOrder }) => {
  const meta = pairingMeta[orderQueueState(order)];
  return (
    <Badge size="sm" variant={meta.variant}>
      {meta.label}
    </Badge>
  );
};

export const RawStatusBadge = ({ status }: { readonly status: string }) => (
  <Badge size="sm" variant="outline">
    {orderStatusLabel(status)}
  </Badge>
);

/** Manual pairing / re-pairing of one order with a reason (C04-03). Candidates are suggestions only. */
export const PairingForm = ({
  busy,
  onDone,
  order,
  records,
  submit,
}: {
  readonly busy: boolean;
  readonly onDone?: () => void;
  readonly order: ImportedOrder;
  readonly records: RecordsResponse;
  readonly submit: Submit;
}) => {
  const run = useRunner(submit);
  const [clientId, setClientId] = useState(order.candidates?.[0]?.clientId ?? '');
  const [reason, setReason] = useState('');
  const [approve, setApprove] = useState(false);
  const linkExists =
    order.externalCustomerId !== undefined &&
    records.state.imports.customerLinks.some(
      (link) => link.source === order.source && link.externalCustomerId === order.externalCustomerId,
    );
  const clients = records.state.clients.items
    .filter((client) => client.status === 'active' && client.id !== order.clientId)
    .toSorted((left, right) => left.name.localeCompare(right.name, 'cs'));
  const candidates = order.candidates ?? [];
  const save = () => {
    const command: Extract<CrmCommandInput, { readonly _tag: 'PairOrder' }> = {
      _tag: 'PairOrder',
      clientId,
      orderId: order.id,
      reason: reason.trim(),
    };
    if (approve) {
      Object.assign(command, { approveCustomerLink: true });
    }
    run(command, order.clientId === undefined ? 'Objednávka napárována' : 'Přiřazení opraveno', () => {
      setReason('');
      setApprove(false);
      onDone?.();
    });
  };
  return (
    <div className="flex flex-col gap-150">
      {candidates.length > 0 && (
        <div className="flex flex-col gap-100 rounded-lg bg-bg-light-warning-base p-150">
          <span className="font-medium text-sm">Možní kandidáti – nepotvrzeno</span>
          <span className="text-fg-secondary text-xs">
            Shoda IČO, e-mailu nebo názvu není důkaz identity. Systém je sám nepřiřadí; vyberte klienta až po ověření.
          </span>
          <div className="flex flex-wrap gap-100">
            {candidates.map((candidate) => (
              <button
                className={`flex flex-col items-start gap-50 rounded-lg border px-150 py-100 text-left text-sm ${clientId === candidate.clientId ? 'border-primary bg-surface' : 'border-border-primary bg-base'}`}
                key={candidate.clientId}
                onClick={() => setClientId(candidate.clientId)}
                type="button"
              >
                <span className="flex items-center gap-50 font-medium">
                  {clientId === candidate.clientId && (
                    <span aria-hidden="true" className="icon-[mdi--check-circle] size-200 text-success" />
                  )}
                  {clientLabel(records, candidate.clientId) ?? candidate.clientId}
                </span>
                <span className="text-fg-secondary text-xs">{candidate.reason}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <SelectTemplate
        items={clients.map((client) => ({
          label: `${client.name} · ${salespersonName(records, client.ownerSalespersonId) ?? 'nepřiděleno'}`,
          value: client.id,
        }))}
        label="Cílový klient"
        name="pairing-client"
        onValueChange={(details) => setClientId(details.value[0] ?? '')}
        placeholder="Vyberte klienta"
        size="sm"
        value={clientId === '' ? [] : [clientId]}
      />
      <ReasonField
        id={`pairing-reason-${order.id}`}
        label="Důvod přiřazení a zdroj ověření"
        onChange={setReason}
        value={reason}
      />
      {order.externalCustomerId !== undefined && !linkExists && (
        <FormCheckbox
          checked={approve}
          id={`pairing-approve-${order.id}`}
          label={`Schválit vazbu: zákazník ${order.externalCustomerId} (${order.source}) je tento klient – další objednávky se napárují samy`}
          onCheckedChange={(checked) => setApprove(checked)}
          size="sm"
        />
      )}
      <div className="flex justify-end">
        <Button
          disabled={clientId === '' || reason.trim().length < 3}
          icon="icon-[mdi--link-variant]"
          isLoading={busy}
          loadingText="Ukládám…"
          onClick={save}
          size="sm"
          variant="primary"
        >
          {order.clientId === undefined ? 'Napárovat' : 'Přiřadit jinému klientovi'}
        </Button>
      </div>
    </div>
  );
};

const DecisionForm = ({
  actions,
  busy,
  id,
  intro,
}: {
  readonly actions: readonly { free?: boolean; label: string; primary?: boolean; run: (reason: string) => void }[];
  readonly busy: boolean;
  readonly id: string;
  readonly intro: ReactNode;
}) => {
  const [reason, setReason] = useState('');
  return (
    <div className="flex flex-col gap-150 rounded-lg bg-bg-light-warning-base p-150">
      <div className="text-sm">{intro}</div>
      <ReasonField id={id} onChange={setReason} value={reason} />
      <div className="flex flex-wrap justify-end gap-100">
        {actions.map((action) => (
          <Button
            disabled={action.free !== true && reason.trim().length < 3}
            isLoading={action.free !== true && busy}
            key={action.label}
            onClick={() => {
              action.run(reason.trim());
              setReason('');
            }}
            size="sm"
            theme={action.primary === true ? 'solid' : 'outlined'}
            variant={action.primary === true ? 'primary' : 'secondary'}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  );
};

const StatusTimeline = ({
  busy,
  canDecide,
  order,
  records,
  run,
}: {
  readonly busy: boolean;
  readonly canDecide: boolean;
  readonly order: ImportedOrder;
  readonly records: RecordsResponse;
  readonly run: ReturnType<typeof useRunner>;
}) => {
  const batchName = (batchId: string) => records.state.imports.batches.find((batch) => batch.id === batchId)?.fileName;
  const events = order.statusHistory.map((event, index) => ({ event, index })).toReversed();
  return (
    <ol className="flex flex-col gap-100">
      {events.map(({ event, index }) => {
        const flagged = event.review === true;
        const open = flagged && event.resolution === undefined;
        const current =
          !flagged &&
          event.rawStatus === order.rawStatus &&
          (event.eventAt === undefined
            ? order.lastEventAt === undefined
            : order.lastEventAt !== undefined && DateTime.Equivalence(event.eventAt, order.lastEventAt));
        return (
          <li
            className={`flex flex-col gap-100 p-150 ${open ? 'rounded-lg bg-bg-light-warning-base' : surfaceTileClassName}`}
            key={`${event.batchId}-${String(index)}`}
          >
            <div className="flex flex-wrap items-center gap-100">
              <RawStatusBadge status={event.rawStatus} />
              <span className="font-medium text-sm">
                {event.eventAt === undefined
                  ? 'čas události neposkytnut'
                  : pipe(event.eventAt, orderDateText, formatDateTime)}
              </span>
              {current && (
                <Badge size="sm" variant="success">
                  Aktuální stav
                </Badge>
              )}
              {open && (
                <Badge size="sm" variant="warning">
                  Vyžaduje kontrolu
                </Badge>
              )}
              {event.resolution !== undefined && (
                <Badge size="sm" variant={event.resolution.decision === 'applied' ? 'info' : 'outline'}>
                  {event.resolution.decision === 'applied' ? 'Ručně použito' : 'Ručně ponecháno beze změny'}
                </Badge>
              )}
            </div>
            <span className="text-fg-secondary text-xs">
              {[
                `Importováno ${pipe(event.importedAt, orderDateText, formatDateTime)}`,
                event.source,
                batchName(event.batchId),
                event.row === undefined ? undefined : `řádek ${String(event.row)}`,
                event.eventId === undefined ? undefined : `událost ${event.eventId}`,
              ]
                .filter((part) => part !== undefined)
                .join(' · ')}
            </span>
            {flagged && event.reviewReason !== undefined && (
              <span className="text-sm">{statusReviewReasonLabel(event.reviewReason)}</span>
            )}
            {event.resolution !== undefined && (
              <span className="text-fg-secondary text-xs">
                {`Rozhodl(a) ${principalLabel(records, event.resolution.by)}, ${pipe(event.resolution.at, orderDateText, formatDateTime)}: ${event.resolution.reason}`}
              </span>
            )}
            {open && canDecide && (
              <DecisionForm
                actions={[
                  {
                    label: 'Ponechat stávající stav',
                    run: (reason) => {
                      run(
                        {
                          _tag: 'ResolveOrderStatusEvent',
                          decision: 'dismiss',
                          eventIndex: index,
                          orderId: order.id,
                          reason,
                        },
                        'Rozhodnutí uloženo',
                      );
                    },
                  },
                  {
                    label: 'Použít jako aktuální stav',
                    primary: true,
                    run: (reason) => {
                      run(
                        {
                          _tag: 'ResolveOrderStatusEvent',
                          decision: 'apply',
                          eventIndex: index,
                          orderId: order.id,
                          reason,
                        },
                        'Stav aktualizován',
                      );
                    },
                  },
                ]}
                busy={busy}
                id={`resolve-${order.id}-${String(index)}`}
                intro="Starší nebo sporná zpráva nepřepsala novější stav. Rozhodněte ručně:"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
};

const LinesTable = ({ order }: { readonly order: ImportedOrder }) => {
  const formatAmount = useFormatAmount();
  if (order.lines === undefined || order.lines.length === 0) {
    return (
      <span className="text-fg-secondary text-sm">Položky neposkytnuty – zdroj je u této objednávky neposlal.</span>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead className="text-fg-secondary text-xs">
        <tr>
          <th className="py-50 pr-100 text-left font-normal">SKU</th>
          <th className="py-50 pr-100 text-left font-normal">Název</th>
          <th className="py-50 pr-200 text-right font-normal">Množství</th>
          <th className="py-50 text-right font-normal">Částka</th>
        </tr>
      </thead>
      <tbody>
        {orderLineDisplayRows(order.lines).map(({ key, row: line }) => (
          <tr className="border-border-primary border-t" key={key}>
            <td className="py-50 pr-100 font-mono text-xs">{line.sku ?? '—'}</td>
            <td className="py-50 pr-100">{line.name}</td>
            <td className="py-50 pr-200 text-right tabular-nums">{line.quantity.replace('.', ',')}</td>
            <td className="py-50 text-right tabular-nums">{formatAmount(line.amount, order.currency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/** Read-only detail of an imported order with its state history; decision forms for read_all + write_all. */
const UnpairButton = ({
  busy,
  order,
  run,
}: {
  readonly busy: boolean;
  readonly order: ImportedOrder;
  readonly run: ReturnType<typeof useRunner>;
}) => {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} size="sm" theme="borderless" variant="secondary">
        Zrušit přiřazení
      </Button>
    );
  }
  return (
    <div className="w-full">
      <DecisionForm
        actions={[
          { free: true, label: 'Zpět', run: () => setOpen(false) },
          {
            label: 'Vrátit do fronty k napárování',
            primary: true,
            run: (reason) => {
              run({ _tag: 'UnpairOrder', orderId: order.id, reason }, 'Přiřazení zrušeno', () => setOpen(false));
            },
          },
        ]}
        busy={busy}
        id={`unpair-${order.id}`}
        intro="Původní přiřazení zůstane v historii s vaším jménem a důvodem."
      />
    </div>
  );
};

const renderOrderFacts = (
  order: ImportedOrder,
  records: RecordsResponse,
  formatAmount: ReturnType<typeof useFormatAmount>,
) => {
  const customer = [
    order.customerName,
    order.externalCustomerId,
    order.customerRegNo === undefined || order.customerRegNo === '' ? undefined : `IČO ${order.customerRegNo}`,
    order.customerEmail,
  ]
    .filter((part) => part !== undefined && part !== '')
    .join(' · ');
  return (
    <>
      <div className="flex flex-wrap items-center gap-100">
        <PairingStateBadge order={order} />
        <RawStatusBadge status={order.rawStatus} />
        {isOpenDuplicate(order) && (
          <Badge size="sm" variant="warning">
            Možná duplicita
          </Badge>
        )}
        {order.duplicateOf !== undefined && !isOpenDuplicate(order) && (
          <Badge size="sm" variant="outline">
            Potvrzená duplicita – mimo souhrny
          </Badge>
        )}
        <Badge size="sm" variant="outline">
          Importováno z CSV
        </Badge>
      </div>
      <DetailList
        items={[
          { label: 'Klient v CRM', value: clientLabel(records, order.clientId) ?? 'nenapárováno' },
          { label: 'Datum objednávky', value: orderDate(order) },
          { label: 'Částka', value: formatAmount(order.amount, order.currency) },
          { label: 'Stav ve zdroji (surový)', value: order.rawStatus },
          {
            label: 'Poslední událost ve zdroji',
            value:
              order.lastEventAt === undefined ? NOT_PROVIDED : pipe(order.lastEventAt, orderDateText, formatDateTime),
          },
          { label: 'Poprvé načteno do CRM', value: pipe(order.receivedAt, orderDateText, formatDateTime) },
          { label: 'Zákazník podle zdroje', value: customer === '' ? NOT_PROVIDED : customer },
          { label: 'Číslo / ID ve zdroji', value: `${order.number ?? NOT_PROVIDED} / ${order.externalId}` },
        ]}
      />
    </>
  );
};

export const OrderDetailPanel = ({
  busy,
  onClose,
  order,
  records,
  submit,
}: {
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly order: ImportedOrder | undefined;
  readonly records: RecordsResponse;
  readonly submit: Submit;
}) => {
  const formatAmount = useFormatAmount();
  const run = useRunner(submit);
  const [repairOpen, setRepairOpen] = useState(false);
  const canDecide = records.viewer.writeAll;
  if (order === undefined) {
    return null;
  }
  const twin =
    order.duplicateOf === undefined
      ? undefined
      : records.state.imports.orders.find((entry) => entry.id === order.duplicateOf);
  const history = records.state.imports.pairingHistory.filter((change) => change.orderId === order.id).toReversed();

  return (
    <SidePanel
      actions={
        <Button onClick={onClose} theme="outlined" variant="secondary">
          Zavřít
        </Button>
      }
      description={`${order.source} · ID ve zdroji ${order.externalId}`}
      onOpenChange={(open) => {
        if (!open) {
          setRepairOpen(false);
          onClose();
        }
      }}
      open
      resizeLabel={RESIZE_LABEL}
      size="lg"
      title={`Objednávka ${orderTitle(order)}`}
    >
      <div className="flex flex-col gap-250">
        {renderOrderFacts(order, records, formatAmount)}
        {order.duplicateOf !== undefined && (
          <Section title="Duplicita mezi zdroji">
            <span className="text-sm">
              {order.reviewReason ?? 'Stejná objednávka z jiného zdroje.'}
              {twin === undefined
                ? null
                : ` Původní záznam: ${orderTitle(twin)} (${twin.source}, ID ${twin.externalId}).`}
            </span>
            {(order.decisions ?? []).map((decision) => (
              <span className="text-fg-secondary text-xs" key={DateTime.formatIso(decision.at)}>
                {`${decision.decision === 'distinct' ? 'Samostatná objednávka' : 'Potvrzená duplicita'} – ${principalLabel(records, decision.by)}, ${pipe(decision.at, orderDateText, formatDateTime)}: ${decision.reason}`}
              </span>
            ))}
            {isOpenDuplicate(order) && canDecide && (
              <DecisionForm
                actions={[
                  {
                    label: 'Jde o samostatnou objednávku',
                    run: (reason) => {
                      run(
                        { _tag: 'ResolveOrderDuplicate', decision: 'distinct', orderId: order.id, reason },
                        'Rozhodnutí uloženo',
                      );
                    },
                  },
                  {
                    label: 'Potvrdit duplicitu',
                    primary: true,
                    run: (reason) => {
                      run(
                        { _tag: 'ResolveOrderDuplicate', decision: 'confirmed_duplicate', orderId: order.id, reason },
                        'Duplicita potvrzena',
                      );
                    },
                  },
                ]}
                busy={busy}
                id={`duplicate-${order.id}`}
                intro="Bez potvrzené korelace se objednávka nezapočítává do potvrzených souhrnů. Potvrzená duplicita zůstane mimo souhrny trvale."
              />
            )}
          </Section>
        )}
        {order.reviewReason !== undefined && order.duplicateOf === undefined && (order.decisions ?? []).length > 0 && (
          <Section title="Duplicita mezi zdroji">
            {(order.decisions ?? []).map((decision) => (
              <span className="text-fg-secondary text-xs" key={DateTime.formatIso(decision.at)}>
                {`Samostatná objednávka – ${principalLabel(records, decision.by)}, ${pipe(decision.at, orderDateText, formatDateTime)}: ${decision.reason}`}
              </span>
            ))}
          </Section>
        )}
        <Section title={`Historie stavů (${String(order.statusHistory.length)})`}>
          <StatusTimeline busy={busy} canDecide={canDecide} order={order} records={records} run={run} />
        </Section>
        <Section title="Položky">
          <LinesTable order={order} />
        </Section>
        <Section title="Přiřazení ke klientovi">
          {history.length === 0 ? (
            <span className="text-fg-secondary text-sm">Zatím bez přiřazení.</span>
          ) : (
            <ol className="flex flex-col gap-100">
              {history.map((change) => (
                <li className="flex flex-col gap-50 text-sm" key={change.id}>
                  <span>
                    <span className="font-medium">{pairingChangeLabel(records, change)}</span>
                    {' · '}
                    {change.via === 'manual' ? 'ručně' : 'schválená vazba ID zákazníka'}
                  </span>
                  <span className="text-fg-secondary text-xs">
                    {`${principalLabel(records, change.by)}, ${pipe(change.at, orderDateText, formatDateTime)} – ${change.reason}`}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {canDecide && (
            <div className="flex flex-col gap-150">
              {order.clientId === undefined || repairOpen ? (
                <PairingForm
                  busy={busy}
                  onDone={() => setRepairOpen(false)}
                  order={order}
                  records={records}
                  submit={submit}
                />
              ) : (
                <div className="flex flex-wrap gap-100">
                  <Button onClick={() => setRepairOpen(true)} size="sm" theme="outlined" variant="secondary">
                    Opravit přiřazení
                  </Button>
                  <UnpairButton busy={busy} order={order} run={run} />
                </div>
              )}
            </div>
          )}
        </Section>
      </div>
    </SidePanel>
  );
};
