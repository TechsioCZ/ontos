# Page recipes (copy, then adapt)

These were checked against the `@techsio/ui-kit` source at new-engine `d02c18118`. If the installed
0.56.0 types disagree, the types win: open the matching `techsio-ui-kit/<component>-usage/SKILL.md`.

Shared assumptions in every recipe:
- `fmt` comes from `src/ui/format.ts`, `tableCs` from `src/ui/table-cs.ts`, and the status maps plus
  `StateBadge` from `src/ui/status.ts`. All three are defined in `czech-copy-and-formatting.md` and
  `status-vocabulary.md`.
- `useXxxRecords()` stands for the vertical's records read, using the vertical's existing pattern
  (`browserRuntime` + `executeRecords` in `src/api/records-client.ts`). Wrap it so it returns
  `{ status: 'loading' | 'error' | 'ready'; rows; revision; reload }`.
- `applyCommand(cmd)` stands for the vertical's single `<module>.apply-command` action
  (`executeApplyCommand`). Always send `expectedRevision`.
- Czech strings are inline here. Move them to `locales/cs|en/<vertical>.json` and read them with `t()`.
- Class syntax is unprefixed ui-kit tokens. See `styling-tokens-and-design-rules.md` §1 if the shell
  does not `@source` the verticals.

---

## A. List page: DataTable + bulk bar + three empty states

```tsx
import { useMemo, useState } from 'react';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { BulkActionBar, EmptyState, PageHeader, TagBadge } from '@app/admin-ui';
import { intlLocale, makeFormat } from '../../ui/format';
import { tableCs } from '../../ui/table-cs';
import { opportunityStage, StateBadge } from '../../ui/status';

type Row = {
  id: string; title: string; customerName: string; stage: keyof typeof opportunityStage;
  ownerName?: string; valueMinor: number; expectedClose?: string; tags: { id: string; label: string }[];
};

export function OpportunitiesPage() {
  const { language, t } = useModernI18n();
  const fmt = useMemo(() => makeFormat(intlLocale(language)), [language]);
  const records = useOpportunityRecords();
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  const [globalFilter, setGlobalFilter] = useState('');
  const [columnFilters, setColumnFilters] = useState<{ id: string; value: unknown }[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const selectedIds = Object.keys(selection).filter((id) => selection[id]);
  const filtered = globalFilter !== '' || columnFilters.length > 0;

  const columns = useMemo<ColumnDef<Row, unknown>[]>(() => [
    {
      accessorKey: 'title', header: 'Příležitost', meta: { type: 'string', width: 280 },
      cell: (info) => (
        <div className="flex min-w-0 flex-col gap-50">
          <div className="truncate font-medium">{info.row.original.title}</div>
          <div className="truncate text-fg-secondary text-xs">{info.row.original.customerName}</div>
        </div>
      ),
    },
    {
      accessorKey: 'stage', header: 'Fáze',
      meta: { type: 'enum', width: 140, options: Object.keys(opportunityStage).map((v) => ({ value: v, label: t(`status.opportunity.${v}`) })) },
      cell: (info) => <StateBadge meta={opportunityStage[info.row.original.stage]} />,
    },
    { accessorKey: 'ownerName', header: 'Obchodník', meta: { type: 'string', width: 160 },
      cell: (info) => fmt.dash(info.row.original.ownerName ?? 'Nepřiřazeno') },
    {
      accessorKey: 'valueMinor', header: 'Hodnota', meta: { type: 'number', align: 'end', width: 130 },
      cell: (info) => <span className="tabular-nums">{fmt.money(info.getValue<number>())}</span>,
    },
    { accessorKey: 'expectedClose', header: 'Očekávané uzavření', meta: { type: 'date', width: 150 },
      cell: (info) => (info.row.original.expectedClose ? fmt.date(info.row.original.expectedClose) : '—') },
    {
      id: 'tags', accessorFn: (row) => row.tags.map((tag) => tag.id), header: 'Štítky', enableSorting: false,
      meta: { type: 'multiEnum', width: 200, options: tagOptions /* from tagging public read */ },
      cell: (info) => (
        <div className="flex flex-wrap gap-50">
          {info.row.original.tags.slice(0, 3).map((tag) => <TagBadge key={tag.id} tag={tag} />)}
        </div>
      ),
    },
  ], [fmt, t]);

  return (
    <>
      <PageHeader
        title="Příležitosti"
        description="Obchodní případy napříč zákazníky. Výhra automaticky vystaví fakturu."
        actions={<Button size="sm" variant="primary" icon="icon-[mdi--plus]" onClick={() => setCreateOpen(true)}>Nová příležitost</Button>}
      />

      <BulkActionBar count={selectedIds.length} onClear={() => setSelection({})}>
        <Button size="sm" variant="primary" icon="icon-[mdi--swap-horizontal]" onClick={() => openBulkStage(selectedIds)}>Změnit fázi</Button>
        <Button size="sm" variant="secondary" theme="outlined" icon="icon-[mdi--tag-plus-outline]" onClick={() => openBulkTag(selectedIds)}>Přiřadit štítek</Button>
      </BulkActionBar>

      <DataTable
        columns={columns}
        data={records.status === 'ready' ? records.rows : []}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.original.title}
        size="sm"
        stickyHeader
        maxHeight="calc(100dvh - 15rem)"
        tableLayout="fixed"
        enableColumnPinning
        columnPinning={{ start: ['title'], end: [] }}
        enableSorting
        enableGlobalFilter
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        enableColumnFilters
        columnFilters={columnFilters}
        onColumnFiltersChange={setColumnFilters}
        enableRowSelection
        rowSelection={selection}
        onRowSelectionChange={setSelection}
        enablePagination
        pageSizeOptions={[50, 100, 200]}
        loading={records.status === 'loading'}
        loadingRowCount={12}
        onRowClick={(row) => openDetail(row.original.id)}
        rowActions={[
          { id: 'edit', label: 'Upravit příležitost', icon: 'icon-[mdi--pencil-outline]', onAction: (row) => openEdit(row.original) },
          { id: 'won', label: 'Označit jako vyhranou', icon: 'icon-[mdi--trophy-outline]',
            hidden: (row) => row.original.stage === 'WON' || row.original.stage === 'LOST', onAction: (row) => markWon(row.original) },
        ]}
        translations={tableCs('Hledat příležitosti nebo zákazníky…')}
        renderEmpty={() =>
          records.status === 'error' ? (
            <EmptyState icon="icon-[mdi--alert-circle-outline]" title="Data se nepodařilo načíst."
              description="Zkontrolujte připojení a zkuste to znovu."
              action={<Button size="sm" variant="secondary" theme="outlined" onClick={records.reload}>Zkusit znovu</Button>} />
          ) : filtered ? (
            <EmptyState icon="icon-[mdi--filter-off-outline]" title="Filtrům neodpovídá žádná příležitost."
              action={<Button size="sm" variant="secondary" theme="outlined" onClick={() => { setGlobalFilter(''); setColumnFilters([]); }}>Zrušit filtry</Button>} />
          ) : (
            <EmptyState title="Zatím tu nejsou žádné příležitosti."
              description="Založte první příležitost a sledujte ji až do výhry."
              action={<Button size="sm" variant="secondary" theme="outlined" onClick={() => setCreateOpen(true)}>Nová příležitost</Button>} />
          )
        }
      />

      <CreateOpportunityDrawer open={createOpen} onOpenChange={setCreateOpen} onCreated={records.reload} />
    </>
  );
}
```

Notes:
- DataTable sits directly in the page column. It draws its own border, so do not wrap it in SectionCard.
- `pageSizeOptions[0]` is the default page size. `[50, 100, 200]` gives 50 per page. The kit default is 10.
- A pinned column needs a numeric `meta.width`. Use `tableLayout="fixed"` when there are enum filters,
  otherwise the filter selects stretch the columns (Akros orders gotcha).
- Optional saved views for recurring questions: `Tabs variant="line"` above the bulk bar, each trigger with
  a count Badge (`Moje`, `Bez obchodníka`, `Ve vyjednávání`). Reset the selection when the tab changes.
- Mobile (390px): hide secondary columns with
  `columnVisibility={narrow ? { ownerName: false, expectedClose: false, tags: false } : {}}`, where
  `narrow = useMediaQuery('(max-width: 639px)')`. A 10-line `useSyncExternalStore` hook over `matchMedia` is enough.
- `Toaster` is mounted once by the shell. Do not mount another one in a vertical page. Use `useToast()`.

---

## B. Create drawer: `Dialog placement="right"`

The kit's CRUD reference uses `Dialog placement="right"` for create, edit and read. Use `Drawer` only for
mobile filters or cart-like panels.

```tsx
import { useState } from 'react';
import { Button } from '@techsio/ui-kit/atoms/button';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';

type Draft = { title: string; partyId: string | null; valueCzk: number; stage: string; ownerId: string | null; expectedClose: string };
const EMPTY: Draft = { title: '', partyId: null, valueCzk: 0, stage: 'LEAD', ownerId: null, expectedClose: '' };

export function CreateOpportunityDrawer({ open, onOpenChange, onCreated, customers, employees, stageItems, revision }: Props) {
  const toaster = useToast();
  const [draft, setDraft] = useState(EMPTY);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const errors = {
    title: draft.title.trim() === '' ? 'Vyplňte název příležitosti.' : undefined,
    partyId: draft.partyId === null ? 'Vyberte zákazníka.' : undefined,
    valueCzk: draft.valueCzk <= 0 ? 'Zadejte částku větší než 0 Kč.' : undefined,
  };
  const show = (key: keyof typeof errors) =>
    submitted && errors[key] ? { validateStatus: 'error' as const, helpText: errors[key] } : {};

  const submit = async () => {
    setSubmitted(true);
    if (Object.values(errors).some(Boolean)) return;
    setBusy(true);
    setServerError(null);
    const result = await applyCommand({
      _tag: 'CreateOpportunity', expectedRevision: revision, title: draft.title.trim(), partyId: draft.partyId!,
      valueMinor: Math.round(draft.valueCzk * 100), currency: 'CZK', stage: draft.stage,
      ownerEmployeeId: draft.ownerId ?? undefined, expectedCloseDate: draft.expectedClose || undefined,
    });
    setBusy(false);
    if (result.ok) {
      toaster.create({ type: 'success', title: 'Příležitost vytvořena', description: draft.title.trim() });
      setDraft(EMPTY); setSubmitted(false); onOpenChange(false); onCreated();
    } else {
      setServerError(result.kind === 'conflict'
        ? 'Záznam mezitím upravil někdo jiný. Načtěte ho znovu a změnu zopakujte.'
        : 'Příležitost se nepodařilo vytvořit. Zkuste to znovu.');
    }
  };

  return (
    <Dialog
      customTrigger open={open} onOpenChange={(d) => onOpenChange(d.open)}
      placement="right" size="md"
      title="Nová příležitost"
      description="Bez vybrané fáze se příležitost založí jako Lead."
      actions={<>
        <Button theme="outlined" variant="secondary" onClick={() => onOpenChange(false)}>Zrušit</Button>
        <Button variant="primary" isLoading={busy} loadingText="Vytvářím…" onClick={() => void submit()}>Vytvořit příležitost</Button>
      </>}
    >
      <form className="flex flex-col gap-200 py-200" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {serverError && <StatusText status="error" showIcon>{serverError}</StatusText>}
        <FormInput id="opp-title" name="title" label="Název" required value={draft.title}
          onChange={(e) => set({ title: e.target.value })} {...show('title')} />
        <Combobox label="Zákazník" name="partyId" placeholder="Začněte psát název nebo IČO…"
          items={customers.map((c) => ({ id: c.id, label: c.name, value: c.id }))}
          value={draft.partyId ?? undefined} onChange={(values) => set({ partyId: values[0] ?? null })}
          noResultsMessage="Žádný zákazník neodpovídá." {...show('partyId')} />
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          <FormNumericInput id="opp-value" name="valueCzk" label="Hodnota (Kč)" locale="cs-CZ" min={0} step={1000}
            value={draft.valueCzk} onChange={(v) => set({ valueCzk: v })} {...show('valueCzk')}>
            <NumericInput.Control><NumericInput.Input /></NumericInput.Control>
          </FormNumericInput>
          <SelectTemplate label="Fáze" name="stage" items={stageItems} value={[draft.stage]}
            onValueChange={(d) => { const [next] = d.value; if (next) set({ stage: next }); }} />
        </div>
        <Combobox label="Obchodník" name="ownerId" placeholder="Nepřiřazeno" clearable
          items={employees.map((e) => ({ id: e.id, label: e.name, value: e.id }))}
          value={draft.ownerId ?? undefined} onChange={(values) => set({ ownerId: values[0] ?? null })} />
        <FormInput id="opp-close" name="expectedClose" type="date" label="Očekávané uzavření"
          value={draft.expectedClose} onChange={(e) => set({ expectedClose: e.target.value })} />
      </form>
    </Dialog>
  );
}
```

Rules: validate on submit, then live. Errors go on the field (`validateStatus` + `helpText`), never in a
toast. The submit button stays enabled and shows `isLoading` while busy. Form field order: identity →
relation → money → state → assignment → dates. Use `size="md"` for forms and `size="sm"` for a read-only
quick view. For a dirty close, ask with an alertdialog `Zahodit neuložené změny?` →
`[Pokračovat v úpravách] [Zahodit změny]`. Money is entered in CZK and stored as `Math.round(czk * 100)`
minor units.

Edit uses the same component with title `Upravit příležitost`, submit `Uložit změny`, and a
`Update…` command with `expectedRevision`.

---

## C. Detail page: header with status, main column + side column

```tsx
<PageHeader
  breadcrumb={[{ label: 'Faktury', href: invoicesHref }, { label: invoice.number }]}
  title={`Faktura ${invoice.number}`}
  description={`Vystaveno ${fmt.date(invoice.issuedAt)} · splatnost ${fmt.date(invoice.dueDate)}`}
  meta={<>
    <StateBadge meta={invoiceStatus[invoice.status]} />
    <StateBadge meta={paymentStatus[effectivePayment(invoice.payment, invoice.dueDate)]} />
  </>}
  actions={<>
    <Button size="sm" variant="secondary" theme="outlined" icon="icon-[mdi--cancel]" onClick={askVoid}
      disabled={invoice.status === 'VOIDED'}>Stornovat</Button>
    <Button size="sm" variant="primary" icon="icon-[mdi--cash-check]" onClick={recordPayment}
      disabled={invoice.payment === 'PAID' || invoice.status !== 'CONFIRMED'}>Zaznamenat úhradu</Button>
  </>}
/>

{isOverdue && (
  <StatusText status="error" showIcon>Faktura je {fmt.plural(daysOverdue, { one: 'den', few: 'dny', many: 'dne', other: 'dní' })} po splatnosti.</StatusText>
)}

<div className="grid grid-cols-1 items-start gap-250 xl:grid-cols-3">
  <div className="flex flex-col gap-250 xl:col-span-2">
    <SectionCard flush title="Položky" description="Ceny jsou uložené ke dni vystavení. Pozdější změna ceníku fakturu nemění.">
      <Table size="sm" variant="line">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>Produkt</Table.ColumnHeader>
            <Table.ColumnHeader align="end">Množství</Table.ColumnHeader>
            <Table.ColumnHeader align="end">Cena za kus</Table.ColumnHeader>
            <Table.ColumnHeader align="end">DPH</Table.ColumnHeader>
            <Table.ColumnHeader align="end">Celkem</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {invoice.lines.map((line) => (
            <Table.Row key={line.id}>
              <Table.Cell>{line.productName}</Table.Cell>
              <Table.Cell align="end" className="tabular-nums">{fmt.count(line.quantity)} ks</Table.Cell>
              <Table.Cell align="end" className="tabular-nums">{fmt.moneyExact(line.unitPriceMinor)}</Table.Cell>
              <Table.Cell align="end" className="tabular-nums">{fmt.percent(line.vatRate)}</Table.Cell>
              <Table.Cell align="end" className="tabular-nums">{fmt.moneyExact(line.totalMinor)}</Table.Cell>
            </Table.Row>
          ))}
          <Table.Row>
            <Table.Cell className="font-semibold">Celkem k úhradě</Table.Cell>
            <Table.Cell /><Table.Cell /><Table.Cell />
            <Table.Cell align="end" className="font-semibold tabular-nums">{fmt.moneyExact(invoice.totalMinor)}</Table.Cell>
          </Table.Row>
        </Table.Body>
      </Table>
    </SectionCard>
    <SectionCard title="Historie" description="Co se s fakturou dělo, nejnovější nahoře.">{/* timeline list */}</SectionCard>
  </div>
  <div className="flex flex-col gap-250">
    <SectionCard title="Odběratel">
      <DetailList items={[
        { term: 'Zákazník', value: invoice.customerName },
        { term: 'IČO', value: fmt.dash(invoice.customerIco) },
        { term: 'Zdroj', value: invoice.opportunityId ? 'Vyhraná příležitost' : 'Ručně' },
        { term: 'Uhrazeno', value: <span className="tabular-nums">{fmt.money(invoice.paidMinor)}</span> },
      ]} />
    </SectionCard>
    <SectionCard title="Štítky">{/* TagBadge list + "Upravit štítky" borderless button */}</SectionCard>
  </div>
</div>
```

Rules: the problem comes first (overdue, failed sync), then the data. The header holds at most one
primary action. Destructive actions such as `Stornovat` or `Smazat` open a `Dialog role="alertdialog"`
whose title names the record (`Stornovat fakturu FV-2026-0042?`), with
`[Zrušit] [Stornovat fakturu]` and the danger button last. A loading detail shows `Skeleton` blocks in
the same grid. Not found or forbidden shows `EmptyState` with a link back to the list.

---

## D. KPI row + chart (dashboard / Statistiky)

```tsx
import { Skeleton } from '@techsio/ui-kit/atoms/skeleton';
import { Chart } from '@techsio/ui-kit/molecules/chart';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { EmptyState, SectionCard, StatCard, StatRow } from '@app/admin-ui';

<StatRow>
  <StatCard label="Hodnota pipeline" value={fmt.money(kpi.pipelineMinor)} delta={fmt.delta(kpi.pipelineDelta)}
    trend={kpi.pipelineDelta > 0 ? 'up' : kpi.pipelineDelta < 0 ? 'down' : 'flat'} hint="Otevřené příležitosti" />
  <StatCard label="Vyhráno tento měsíc" value={fmt.money(kpi.wonMinor)} hint={fmt.plural(kpi.wonCount, { one: 'příležitost', few: 'příležitosti', many: 'příležitosti', other: 'příležitostí' })} />
  <StatCard label="Neuhrazené faktury" value={fmt.money(kpi.unpaidMinor)} hint={`z toho po splatnosti ${fmt.money(kpi.overdueMinor)}`} />
  <StatCard label="Otevřené úkoly" value={fmt.count(kpi.openTasks)} hint={`${fmt.count(kpi.highPriority)} s vysokou prioritou`} />
</StatRow>

<SectionCard flush title="Tržby podle měsíců" description="Součet vystavených faktur bez DPH.">
  <Tabs defaultValue="revenue" variant="line">
    <Tabs.List className="px-250">
      <Tabs.Trigger value="revenue">Tržby</Tabs.Trigger>
      <Tabs.Trigger value="won">Vyhrané příležitosti</Tabs.Trigger>
      <Tabs.Indicator />
    </Tabs.List>
    <Tabs.Content className="p-250" value="revenue">
      {series.status === 'loading' ? (
        <Skeleton isLoaded={false}><Skeleton.Rectangle /></Skeleton>
      ) : series.status === 'error' ? (
        <EmptyState icon="icon-[mdi--alert-circle-outline]" title="Graf se nepodařilo načíst." action={<Button size="sm" variant="secondary" theme="outlined" onClick={series.reload}>Zkusit znovu</Button>} />
      ) : series.rows.length === 0 ? (
        <EmptyState icon="icon-[mdi--chart-bar]" title="Za zvolené období nejsou žádné tržby." />
      ) : (
        <Chart
          type="bar" data={series.rows} x="label" y="czk" series="segment" legendLabel="Segment"
          yLabel="Tržby (Kč)" height={280}
          formatValue={(v) => fmt.moneyCompact(v * 100)}
          ariaLabel="Tržby podle měsíců a segmentů"
        />
      )}
    </Tabs.Content>
    {/* won tab: type="line" points, y = count */}
  </Tabs>
</SectionCard>
```

Chart rules:
- `x` must be a pre-formatted, chronologically sorted label (`fmt.month(date)` → `zář 2026`). Chart has
  no x-axis formatter, so a raw `Date` gets English/ISO ticks. `formatValue` formats y values and
  tooltips only.
- `y` is a plain number in major units (CZK, not haléře) for readable ticks.
- One measure per chart and never dual axes. Several measures go into separate charts or `Tabs`.
- At most 6 series or slices; fold the rest into `Ostatní`. A donut fits a share of ≤5 parts. Rankings
  (top customers, top products) use `bar-horizontal`.
- `ariaLabel` is required. The title states metric + period (`Tržby, posledních 30 dní`).
- Do not use status colours in series. Do not override `--color-chart-series-*`.
- A period selector (`SelectTemplate` size `sm` or `DatePicker selectionMode="range" locale="cs-CZ"`) sits in
  `PageHeader actions` and scopes every widget on the page.
