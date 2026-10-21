// @effect-diagnostics asyncFunction:off
// @effect-diagnostics newPromise:off
import { dialogCloseLabel, EmptyState, formatMoney, SectionCard } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { PriceListItem, VatRate } from '../../../../../shared/apis/records.ts';
import { lineDiscountMinor } from '../../../../../shared/domain/invoice-totals.ts';
import { minorToInput, outcomeMessage, parseAmountMinor } from './finance-ui.tsx';
import type { FinanceViewModel } from './finance-ui.tsx';
import { FinanceTableScroll } from './finance-table-scroll.tsx';

interface ItemDraft {
  readonly code: string;
  readonly id: string | undefined;
  readonly name: string;
  readonly price: string;
  readonly unit: string;
  readonly vatRate: VatRate;
}

const VAT_CHOICES: readonly VatRate[] = [21, 12, 0];

const emptyItem: ItemDraft = { code: '', id: undefined, name: '', price: '', unit: 'měsíc', vatRate: 21 };

/** S07.R4: the company price list; invoice lines copy a snapshot of an item, discounts are approved per line. */
export const PriceListPanel = ({ vm }: { readonly vm: FinanceViewModel }) => {
  const items = [...(vm.snapshot?.state.priceList ?? [])].sort(
    (left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name, 'cs'),
  );
  const [draft, setDraft] = useState<ItemDraft>();
  const [error, setError] = useState<string>();
  const discounted = (vm.snapshot?.state.invoices ?? [])
    .filter((invoice) => invoice.businessState !== 'VOIDED')
    .flatMap((invoice) =>
      (invoice.lines ?? []).flatMap((line) =>
        line.discount === undefined ? [] : [{ invoice, line, minor: lineDiscountMinor(line) }],
      ),
    )
    .slice(0, 12);

  const save = async () => {
    if (draft === undefined) {
      return;
    }
    const price = parseAmountMinor(draft.price);
    if (draft.name.trim() === '' || price === undefined) {
      setError('Vyplňte název a cenu bez DPH (např. 1 500 nebo 1 500,50).');
      return;
    }
    const existing = items.find((item) => item.id === draft.id);
    const outcome = await vm.execute(
      {
        _tag: 'UpsertPriceListItem',
        ...(vm.actorLabel === undefined ? {} : { actorLabel: vm.actorLabel }),
        active: existing?.active ?? true,
        ...(draft.code.trim() === '' ? {} : { code: draft.code.trim() }),
        ...(draft.id === undefined ? {} : { id: draft.id }),
        name: draft.name.trim(),
        ...(draft.unit.trim() === '' ? {} : { unit: draft.unit.trim() }),
        unitPriceMinor: price,
        vatRate: draft.vatRate,
      },
      draft.id === undefined ? 'Položka ceníku přidána' : 'Položka ceníku uložena',
    );
    if (outcome.ok) {
      setDraft(undefined);
      setError(undefined);
    } else {
      setError(outcomeMessage(vm, outcome));
    }
  };

  const toggle = (item: PriceListItem) =>
    void vm.execute(
      {
        _tag: 'UpsertPriceListItem',
        active: !item.active,
        ...(item.code === undefined ? {} : { code: item.code }),
        id: item.id,
        name: item.name,
        ...(item.unit === undefined ? {} : { unit: item.unit }),
        unitPriceMinor: item.unitPriceMinor,
        vatRate: item.vatRate,
      },
      item.active ? 'Položka vyřazena z nabídky' : 'Položka znovu v nabídce',
    );

  return (
    <div className="flex flex-col gap-500">
      <SectionCard
        actions={
          vm.canWrite ? (
            <Button
              icon="icon-[mdi--plus]"
              onClick={() => {
                setError(undefined);
                setDraft(emptyItem);
              }}
              size="sm"
              variant="primary"
            >
              Nová položka ceníku
            </Button>
          ) : undefined
        }
        flush
        title="Ceník služeb"
      >
        <p className="px-250 pb-150 text-fg-secondary text-sm">
          Položku ceníku vyberete na řádku faktury (Z ceníku). Řádek si uloží kopii ceny – pozdější změna ceníku už
          vystavené doklady nemění. Slevu schvalujete na řádku dokladu i s důvodem.
        </p>
        {items.length === 0 ? (
          <div className="px-250 pb-250">
            <EmptyState description="Přidejte první službu, kterou fakturujete." title="Ceník je prázdný" />
          </div>
        ) : (
          <FinanceTableScroll label="Ceník služeb">
            <Table size="sm" variant="line">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Položka</Table.ColumnHeader>
                  <Table.ColumnHeader>Jednotka</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">Cena bez DPH</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">DPH</Table.ColumnHeader>
                  <Table.ColumnHeader>Stav</Table.ColumnHeader>
                  <Table.ColumnHeader align="end" />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {items.map((item) => (
                  <Table.Row key={item.id}>
                    <Table.Cell>
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium">{item.name}</span>
                        {item.code !== undefined && <span className="text-fg-secondary text-xs">{item.code}</span>}
                      </span>
                    </Table.Cell>
                    <Table.Cell>{item.unit ?? '—'}</Table.Cell>
                    <Table.Cell align="end" className="whitespace-nowrap tabular-nums">
                      {formatMoney(item.unitPriceMinor)}
                    </Table.Cell>
                    <Table.Cell align="end" className="tabular-nums">
                      {item.vatRate} %
                    </Table.Cell>
                    <Table.Cell>
                      <Badge size="sm" variant={item.active ? 'success' : 'warning'}>
                        {item.active ? 'V nabídce' : 'Vyřazeno'}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell align="end">
                      {vm.canWrite && (
                        <span className="flex justify-end gap-50">
                          <Button
                            aria-label={`Upravit ${item.name}`}
                            icon="icon-[mdi--pencil-outline]"
                            onClick={() => {
                              setError(undefined);
                              setDraft({
                                code: item.code ?? '',
                                id: item.id,
                                name: item.name,
                                price: minorToInput(item.unitPriceMinor),
                                unit: item.unit ?? '',
                                vatRate: item.vatRate,
                              });
                            }}
                            size="sm"
                            theme="borderless"
                            variant="secondary"
                          />
                          <Button
                            className="whitespace-nowrap"
                            onClick={() => toggle(item)}
                            size="sm"
                            theme="borderless"
                            variant="secondary"
                          >
                            {item.active ? 'Vyřadit' : 'Obnovit'}
                          </Button>
                        </span>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </FinanceTableScroll>
        )}
      </SectionCard>
      <SectionCard flush title="Schválené slevy na dokladech">
        {discounted.length === 0 ? (
          <p className="px-250 pb-250 text-fg-secondary text-sm">Zatím žádný doklad nemá schválenou slevu.</p>
        ) : (
          <FinanceTableScroll label="Schválené slevy na dokladech">
            <Table size="sm" variant="line">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Doklad</Table.ColumnHeader>
                  <Table.ColumnHeader>Položka</Table.ColumnHeader>
                  <Table.ColumnHeader>Sleva</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">Částka slevy</Table.ColumnHeader>
                  <Table.ColumnHeader>Důvod</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {discounted.map(({ invoice, line, minor }, index) => (
                  <Table.Row key={`${invoice.ref.resourceId}-${index}`}>
                    <Table.Cell className="whitespace-nowrap">
                      <a className="underline" href={`?resourceId=${encodeURIComponent(invoice.ref.resourceId)}`}>
                        {invoice.number ?? invoice.documentNumber}
                      </a>
                    </Table.Cell>
                    <Table.Cell>{line.description}</Table.Cell>
                    <Table.Cell className="whitespace-nowrap">
                      {line.discount?.kind === 'PERCENT' ? `${line.discount.value} %` : 'částkou'}
                    </Table.Cell>
                    <Table.Cell align="end" className="whitespace-nowrap tabular-nums">
                      − {formatMoney(minor)}
                    </Table.Cell>
                    <Table.Cell className="max-w-64">{line.discount?.reason}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </FinanceTableScroll>
        )}
      </SectionCard>
      <Dialog
        actions={
          <>
            <Button onClick={() => setDraft(undefined)} theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <Button isLoading={vm.busy} onClick={() => void save()} variant="primary">
              Uložit
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description="Cena za jednotku bez DPH v Kč."
        onOpenChange={(details) => {
          if (!details.open) {
            setDraft(undefined);
          }
        }}
        open={draft !== undefined}
        placement="center"
        size="md"
        title={draft?.id === undefined ? 'Nová položka ceníku' : 'Upravit položku ceníku'}
      >
        {draft !== undefined && (
          <div className="flex flex-col gap-150">
            {error !== undefined && (
              <StatusText showIcon size="sm" status="error">
                {error}
              </StatusText>
            )}
            <FormInput
              id="price-name"
              label="Název služby"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="např. Parkovací místo – kryté stání"
              size="sm"
              value={draft.name}
            />
            <div className="grid grid-cols-1 gap-150 sm:grid-cols-2">
              <FormInput
                id="price-code"
                label="Kód (nepovinné)"
                onChange={(event) => setDraft({ ...draft, code: event.target.value })}
                size="sm"
                value={draft.code}
              />
              <FormInput
                id="price-unit"
                label="Jednotka"
                onChange={(event) => setDraft({ ...draft, unit: event.target.value })}
                placeholder="měsíc, m², ks, hod"
                size="sm"
                value={draft.unit}
              />
            </div>
            <div className="grid grid-cols-1 gap-150 sm:grid-cols-2">
              <FormInput
                id="price-amount"
                inputMode="decimal"
                label="Cena bez DPH (Kč)"
                onChange={(event) => setDraft({ ...draft, price: event.target.value })}
                size="sm"
                value={draft.price}
              />
              <SelectTemplate
                items={VAT_CHOICES.map((rate) => ({ displayValue: `${rate} %`, label: `${rate} %`, value: String(rate) }))}
                label="Sazba DPH"
                labelProps={{ className: 'font-label text-label-md' }}
                onValueChange={({ value }) => {
                  const rate = VAT_CHOICES.find((entry) => String(entry) === value[0]);
                  if (rate !== undefined) {
                    setDraft({ ...draft, vatRate: rate });
                  }
                }}
                size="sm"
                value={[String(draft.vatRate)]}
              />
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
};
