// S15 souhrn hodnoty majetku: by kind and by property, sold/disposed list and year-by-year comparison.
// Pure view over the (already filtered) asset rows of the register; every number is computed from stored records.
import { SectionCard, formatMoney, formatNumber } from '@app/admin-ui';
import { Table } from '@techsio/ui-kit/organisms/table';
import type { Asset } from '../../../../../shared/domain/assets.ts';
import { assetKinds, isActiveAsset } from '../../../../../shared/domain/assets.ts';
import { isoDateLabel } from './assets-model.ts';
import type { Translate } from './assets-model.ts';

const assetKindOrder = new Map<string, number>(assetKinds.map((kind, index) => [kind, index]));

interface Group {
  readonly acquisition: number;
  readonly active: number;
  readonly current: number;
  readonly disposed: number;
  readonly key: string;
  readonly label: string;
}

const groupBy = (rows: readonly Asset[], keyOf: (asset: Asset) => [string, string]): readonly Group[] => {
  const groups = new Map<
    string,
    { acquisition: number; active: number; current: number; disposed: number; label: string }
  >();
  for (const asset of rows) {
    const [key, label] = keyOf(asset);
    const group = groups.get(key) ?? { acquisition: 0, active: 0, current: 0, disposed: 0, label };
    if (isActiveAsset(asset)) {
      group.active += 1;
      group.acquisition += asset.acquisitionValueMinor ?? 0;
      group.current += asset.currentValueMinor ?? 0;
    } else {
      group.disposed += 1;
    }
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => ({ key, ...group }));
};

/** Evidenced value of one asset at the end of `year`: last value event on or before 31. 12., 0 once disposed. */
const valueAtYearEnd = (asset: Asset, year: number): number | undefined => {
  const end = `${year}-12-31`;
  if (asset.acquisitionDate !== undefined && asset.acquisitionDate > end) {
    return undefined;
  }
  if (asset.disposal !== undefined && asset.disposal.date <= end) {
    return 0;
  }
  const events = (asset.events ?? [])
    .filter((event) => event.newValueMinor !== undefined && event.date <= end)
    .toSorted((left, right) => left.date.localeCompare(right.date));
  const last = events.at(-1)?.newValueMinor;
  if (last !== undefined) {
    return last;
  }
  return asset.acquisitionDate === undefined ? undefined : asset.acquisitionValueMinor;
};

interface YearRow {
  readonly acquired: number;
  readonly acquiredValue: number;
  readonly disposed: number;
  readonly endCount: number;
  readonly endValue: number;
  readonly proceeds: number;
  readonly year: number;
}

export const yearComparison = (rows: readonly Asset[], currentYear: number): readonly YearRow[] => {
  const years = new Set<number>();
  for (const asset of rows) {
    if (asset.acquisitionDate !== undefined) {
      years.add(Number(asset.acquisitionDate.slice(0, 4)));
    }
    if (asset.disposal !== undefined) {
      years.add(Number(asset.disposal.date.slice(0, 4)));
    }
  }
  years.add(currentYear);
  const first = Math.max(Math.min(...years), currentYear - 5);
  const result: YearRow[] = [];
  for (let year = currentYear; year >= first; year -= 1) {
    const acquired = rows.filter((asset) => asset.acquisitionDate?.startsWith(String(year)) === true);
    const disposed = rows.filter((asset) => asset.disposal?.date.startsWith(String(year)) === true);
    const values = rows.map((asset) => valueAtYearEnd(asset, year)).filter((value) => value !== undefined);
    result.push({
      acquired: acquired.length,
      acquiredValue: acquired.reduce((sum, asset) => sum + (asset.acquisitionValueMinor ?? 0), 0),
      disposed: disposed.length,
      endCount: values.filter((value) => value > 0).length,
      endValue: values.reduce((sum, value) => sum + value, 0),
      proceeds: disposed.reduce((sum, asset) => sum + (asset.disposal?.proceedsMinor ?? 0), 0),
      year,
    });
  }
  return result;
};

const GroupTable = ({
  groups,
  k,
  title,
}: {
  readonly groups: readonly Group[];
  readonly k: Translate;
  readonly title: string;
}) => (
  <div className="overflow-x-auto">
    <Table size="sm" variant="line">
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeader>{title}</Table.ColumnHeader>
          <Table.ColumnHeader className="text-right">{k('summary.activeCount')}</Table.ColumnHeader>
          <Table.ColumnHeader className="text-right">{k('summary.disposedCount')}</Table.ColumnHeader>
          <Table.ColumnHeader className="text-right">{k('summary.acquisition')}</Table.ColumnHeader>
          <Table.ColumnHeader className="text-right">{k('summary.current')}</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {groups.map((group) => (
          <Table.Row key={group.key}>
            <Table.Cell className="font-medium">{group.label}</Table.Cell>
            <Table.Cell className="text-right tabular-nums">{formatNumber(group.active)}</Table.Cell>
            <Table.Cell className="text-right tabular-nums">{formatNumber(group.disposed)}</Table.Cell>
            <Table.Cell className="text-right tabular-nums">{formatMoney(group.acquisition)}</Table.Cell>
            <Table.Cell className="text-right font-medium tabular-nums">{formatMoney(group.current)}</Table.Cell>
          </Table.Row>
        ))}
        <Table.Row>
          <Table.Cell className="font-semibold">{k('summary.total')}</Table.Cell>
          <Table.Cell className="text-right font-semibold tabular-nums">
            {formatNumber(groups.reduce((sum, group) => sum + group.active, 0))}
          </Table.Cell>
          <Table.Cell className="text-right font-semibold tabular-nums">
            {formatNumber(groups.reduce((sum, group) => sum + group.disposed, 0))}
          </Table.Cell>
          <Table.Cell className="text-right font-semibold tabular-nums">
            {formatMoney(groups.reduce((sum, group) => sum + group.acquisition, 0))}
          </Table.Cell>
          <Table.Cell className="text-right font-semibold tabular-nums">
            {formatMoney(groups.reduce((sum, group) => sum + group.current, 0))}
          </Table.Cell>
        </Table.Row>
      </Table.Body>
    </Table>
  </div>
);

export const AssetSummary = ({
  filtered,
  k,
  onOpen,
  propertyName,
  rows,
  today,
}: {
  readonly filtered: boolean;
  readonly k: Translate;
  readonly onOpen: (asset: Asset) => void;
  readonly propertyName: (asset: Asset) => string;
  /** Rows of the register after every filter except the status filter. */
  readonly rows: readonly Asset[];
  readonly today: string;
}) => {
  const byKind = groupBy(rows, (asset) => {
    const kind = asset.kind ?? 'equipment';
    return [kind, k(`kind.${kind}`)];
  }).toSorted((left, right) => (assetKindOrder.get(left.key) ?? -1) - (assetKindOrder.get(right.key) ?? -1));
  const byProperty = groupBy(rows, (asset) => [asset.propertyId ?? 'none', propertyName(asset)]).toSorted(
    (left, right) => left.label.localeCompare(right.label, 'cs'),
  );
  const disposed = rows
    .filter((asset) => !isActiveAsset(asset))
    .toSorted((left, right) => (right.disposal?.date ?? '').localeCompare(left.disposal?.date ?? ''));
  const years = yearComparison(rows, Number(today.slice(0, 4)));
  return (
    <div className="flex flex-col gap-250">
      <p className="text-fg-secondary text-sm">{filtered ? k('summary.introFiltered') : k('summary.intro')}</p>
      <SectionCard title={k('summary.byKind')}>
        <GroupTable groups={byKind} k={k} title={k('fields.kind')} />
      </SectionCard>
      <SectionCard title={k('summary.byProperty')}>
        <GroupTable groups={byProperty} k={k} title={k('filters.property')} />
      </SectionCard>
      <SectionCard title={k('summary.years')}>
        <p className="text-fg-secondary text-xs">{k('summary.yearsHint')}</p>
        <div className="overflow-x-auto">
          <Table size="sm" variant="line">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>{k('summary.year')}</Table.ColumnHeader>
                <Table.ColumnHeader className="text-right">{k('summary.acquired')}</Table.ColumnHeader>
                <Table.ColumnHeader className="text-right">{k('summary.acquiredValue')}</Table.ColumnHeader>
                <Table.ColumnHeader className="text-right">{k('summary.disposedInYear')}</Table.ColumnHeader>
                <Table.ColumnHeader className="text-right">{k('summary.proceeds')}</Table.ColumnHeader>
                <Table.ColumnHeader className="text-right">{k('summary.endValue')}</Table.ColumnHeader>
                <Table.ColumnHeader className="text-right">{k('summary.endChange')}</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {years.map((row, index) => {
                const previous = years[index + 1];
                const change = previous === undefined ? undefined : row.endValue - previous.endValue;
                return (
                  <Table.Row key={row.year}>
                    <Table.Cell className="font-medium tabular-nums">{row.year}</Table.Cell>
                    <Table.Cell className="text-right tabular-nums">{formatNumber(row.acquired)}</Table.Cell>
                    <Table.Cell className="text-right tabular-nums">{formatMoney(row.acquiredValue)}</Table.Cell>
                    <Table.Cell className="text-right tabular-nums">{formatNumber(row.disposed)}</Table.Cell>
                    <Table.Cell className="text-right tabular-nums">{formatMoney(row.proceeds)}</Table.Cell>
                    <Table.Cell className="text-right font-medium tabular-nums">
                      {formatMoney(row.endValue)}
                      <span className="block text-fg-secondary text-xs">
                        {k('summary.endCount', { count: row.endCount })}
                      </span>
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {change === undefined ? '—' : `${change > 0 ? '+' : ''}${formatMoney(change)}`}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </div>
      </SectionCard>
      <SectionCard title={k('summary.disposedList', { count: disposed.length })}>
        {disposed.length === 0 ? (
          <p className="text-fg-secondary text-sm">{k('states.noDisposed')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table size="sm" variant="line">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>{k('fields.inventoryNumber')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('fields.name')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('summary.disposalKind')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('summary.disposalDate')}</Table.ColumnHeader>
                  <Table.ColumnHeader className="text-right">{k('summary.proceeds')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('summary.reason')}</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {disposed.map((asset) => (
                  <Table.Row
                    className="cursor-pointer hover:bg-surface-hover"
                    key={asset.id}
                    onClick={() => onOpen(asset)}
                  >
                    <Table.Cell className="tabular-nums">{asset.inventoryNumber}</Table.Cell>
                    <Table.Cell className="font-medium">{asset.name}</Table.Cell>
                    <Table.Cell>{k(`disposal.${asset.disposal?.kind ?? 'retirement'}`)}</Table.Cell>
                    <Table.Cell className="tabular-nums">{isoDateLabel(asset.disposal?.date)}</Table.Cell>
                    <Table.Cell className="text-right tabular-nums">
                      {asset.disposal?.proceedsMinor === undefined ? '—' : formatMoney(asset.disposal.proceedsMinor)}
                    </Table.Cell>
                    <Table.Cell className="max-w-[20rem] text-sm">{asset.disposal?.reason ?? ''}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </SectionCard>
    </div>
  );
};
