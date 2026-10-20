import { Link } from '@techsio/ui-kit/atoms/link';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Table } from '@techsio/ui-kit/organisms/table';
import { useAgendaRecords } from './use-agenda.ts';
import { assetsAtLocation } from '../../shared/domain/asset-location.ts';

/** The property register and operations register have separate storage; never copy their asset rows. */
export const PropertyEquipment = ({
  propertyId,
  unitId,
  language = 'cs',
}: {
  readonly propertyId: string;
  readonly unitId?: string | undefined;
  readonly language?: string | undefined;
}) => {
  const records = useAgendaRecords(['assets']);
  const english = language === 'en';
  const agenda = records.data?.agendas.assets;
  const money = new Intl.NumberFormat(english ? 'en-GB' : 'cs-CZ', { style: 'currency', currency: 'CZK' });
  const title = english ? 'Registered equipment and assets' : 'Evidované vybavení a majetek';
  const rows = assetsAtLocation(agenda?.state.assets ?? [], propertyId, unitId);
  return (
    <section aria-label={title} style={{ minWidth: 0 }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>{title}</h2>
      {records.status === 'loading' ? (
        <p role="status">{english ? 'Loading equipment…' : 'Načítání vybavení…'}</p>
      ) : records.status === 'error' ? (
        <div role="status">
          <p>{english ? 'Equipment could not be loaded.' : 'Vybavení se nepodařilo načíst.'}</p>
          <Button onClick={() => void records.reload()} size="sm" theme="outlined" variant="secondary">
            {english ? 'Try again' : 'Zkusit znovu'}
          </Button>
        </div>
      ) : agenda === undefined ? (
        <p>{english ? 'You do not have permission to view equipment.' : 'Nemáte oprávnění zobrazit vybavení.'}</p>
      ) : rows.length === 0 ? (
        <p>
          {english ? 'No assets are registered at this location.' : 'V tomto umístění není evidován žádný majetek.'}
        </p>
      ) : (
        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
          <Table size="sm" variant="outline">
            <Table.Header>
              <Table.Row>
                {[
                  english ? 'Inventory no.' : 'Inventární číslo',
                  english ? 'Name' : 'Název',
                  english ? 'Location' : 'Umístění',
                  english ? 'Current value' : 'Aktuální hodnota',
                  english ? 'Status' : 'Stav',
                ].map((label) => (
                  <Table.ColumnHeader key={label}>{label}</Table.ColumnHeader>
                ))}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((asset) => (
                <Table.Row key={asset.id}>
                  <Table.Cell>
                    <Link
                      href={`/${english ? 'en' : 'cs'}/siampark/provoz/majetek?asset=${encodeURIComponent(asset.id)}`}
                    >
                      {asset.inventoryNumber}
                    </Link>
                  </Table.Cell>
                  <Table.Cell>{asset.name}</Table.Cell>
                  <Table.Cell>{asset.location?.label ?? (english ? 'Not provided' : 'Neuvedeno')}</Table.Cell>
                  <Table.Cell>
                    {asset.currentValueMinor === undefined
                      ? english
                        ? 'Not provided'
                        : 'Neuvedeno'
                      : money.format(asset.currentValueMinor / 100)}
                  </Table.Cell>
                  <Table.Cell>
                    {asset.status === 'disposed'
                      ? english
                        ? 'Disposed · history retained'
                        : 'Vyřazeno · historie zachována'
                      : english
                        ? 'Active'
                        : 'Aktivní'}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
    </section>
  );
};
