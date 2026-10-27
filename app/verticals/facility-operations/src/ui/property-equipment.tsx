import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Table } from '@techsio/ui-kit/organisms/table';
import { LoadingSkeleton } from './loading-skeleton.tsx';
import { useAgendaRecords } from './use-agenda.ts';
import { assetsAtLocation } from '../../shared/domain/asset-location.ts';

const equipmentLabels = {
  cs: {
    active: 'Aktivní',
    columns: ['Inventární číslo', 'Název', 'Umístění', 'Aktuální hodnota', 'Stav'],
    disposed: 'Vyřazeno · historie zachována',
    empty: 'V tomto umístění není evidován žádný majetek.',
    failed: 'Vybavení se nepodařilo načíst.',
    forbidden: 'Nemáte oprávnění zobrazit vybavení.',
    loading: 'Načítání vybavení…',
    notProvided: 'Neuvedeno',
    retry: 'Zkusit znovu',
    title: 'Evidované vybavení a majetek',
  },
  en: {
    active: 'Active',
    columns: ['Inventory no.', 'Name', 'Location', 'Current value', 'Status'],
    disposed: 'Disposed · history retained',
    empty: 'No assets are registered at this location.',
    failed: 'Equipment could not be loaded.',
    forbidden: 'You do not have permission to view equipment.',
    loading: 'Loading equipment…',
    notProvided: 'Not provided',
    retry: 'Try again',
    title: 'Registered equipment and assets',
  },
} as const;

const currencyFormatters = {
  cs: new Intl.NumberFormat('cs-CZ', { currency: 'CZK', style: 'currency' }),
  en: new Intl.NumberFormat('en-GB', { currency: 'CZK', style: 'currency' }),
};

const equipmentState = (status: ReturnType<typeof useAgendaRecords>['status'], hasAgenda: boolean, count: number) => {
  if (status === 'loading' || status === 'error') {
    return status;
  }
  if (!hasAgenda) {
    return 'forbidden';
  }
  return count === 0 ? 'empty' : 'ready';
};

/** The property register and operations register have separate storage; never copy their asset rows. */
export const PropertyEquipment = ({
  language = 'cs',
  propertyId,
  unitId,
}: {
  readonly language?: string | undefined;
  readonly propertyId: string;
  readonly unitId?: string | undefined;
}) => {
  const records = useAgendaRecords(['assets']);
  const locale = language === 'en' ? 'en' : 'cs';
  const labels = equipmentLabels[locale];
  const agenda = records.data?.agendas.assets;
  const money = currencyFormatters[locale];
  const { title } = labels;
  const rows = assetsAtLocation(agenda?.state.assets ?? [], propertyId, unitId);
  const state = equipmentState(records.status, agenda !== undefined, rows.length);
  return (
    <section aria-label={title} style={{ minWidth: 0 }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>{title}</h2>
      {state === 'loading' && <LoadingSkeleton label={labels.loading} rows={3} />}
      {state === 'error' && (
        <output>
          <p>{labels.failed}</p>
          <Button
            onClick={() => {
              browserRuntime.runFork(records.reload());
            }}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {labels.retry}
          </Button>
        </output>
      )}
      {state === 'forbidden' && <p>{labels.forbidden}</p>}
      {state === 'empty' && <p>{labels.empty}</p>}
      {state === 'ready' && (
        <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
          <Table size="sm" variant="line">
            <Table.Header>
              <Table.Row>
                {labels.columns.map((label) => (
                  <Table.ColumnHeader key={label}>{label}</Table.ColumnHeader>
                ))}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((asset) => (
                <Table.Row key={asset.id}>
                  <Table.Cell>
                    <Link href={`/${locale}/provoz/majetek?asset=${encodeURIComponent(asset.id)}`}>
                      {asset.inventoryNumber}
                    </Link>
                  </Table.Cell>
                  <Table.Cell>{asset.name}</Table.Cell>
                  <Table.Cell>{asset.location?.label ?? labels.notProvided}</Table.Cell>
                  <Table.Cell>
                    {asset.currentValueMinor === undefined
                      ? labels.notProvided
                      : money.format(asset.currentValueMinor / 100)}
                  </Table.Cell>
                  <Table.Cell>{asset.status === 'disposed' ? labels.disposed : labels.active}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
    </section>
  );
};
