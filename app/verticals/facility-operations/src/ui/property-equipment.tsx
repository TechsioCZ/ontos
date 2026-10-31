import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { facilityOperationsI18nResources } from '../i18n/resources.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Table } from '@techsio/ui-kit/organisms/table';
import { LoadingSkeleton } from './loading-skeleton.tsx';
import { useAgendaRecords } from './use-agenda.ts';
import { assetsAtLocation } from '../../shared/domain/asset-location.ts';
import { langOf } from './ops-agenda/ui-bits.tsx';

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

interface PropertyEquipmentProps {
  readonly language?: string | undefined;
  readonly propertyId: string;
  readonly unitId?: string | undefined;
}

const PropertyEquipmentContent = ({ language = 'cs', propertyId, unitId }: PropertyEquipmentProps) => {
  const { t } = useModernI18n();
  const records = useAgendaRecords(['assets']);
  const locale = langOf(language);
  const equipmentLabel = (key: string) => t(`facility-operations.propertyEquipment.${key}`, { lng: locale });
  const labels = {
    active: equipmentLabel('active'),
    columns: ['inventoryNumber', 'name', 'location', 'currentValue', 'status'].map((key) =>
      equipmentLabel(`columns.${key}`),
    ),
    disposed: equipmentLabel('disposed'),
    empty: equipmentLabel('empty'),
    failed: equipmentLabel('failed'),
    forbidden: equipmentLabel('forbidden'),
    loading: equipmentLabel('loading'),
    notProvided: equipmentLabel('notProvided'),
    retry: equipmentLabel('retry'),
    title: equipmentLabel('title'),
  };
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

/** The property register and operations register have separate storage; never copy their asset rows. */
export const PropertyEquipment = (props: PropertyEquipmentProps) => (
  <FederatedI18nBoundary
    defaultNamespace="facility-operations"
    fallbackLanguage="en"
    resources={facilityOperationsI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <PropertyEquipmentContent {...props} />
  </FederatedI18nBoundary>
);
