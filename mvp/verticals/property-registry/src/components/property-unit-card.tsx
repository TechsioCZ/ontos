export interface PropertyUnitCardProps {
  readonly unitId: string;
  readonly displayName: string;
  readonly source: 'shell' | 'accounting.core';
}

export const PropertyUnitCard = ({ displayName, source, unitId }: PropertyUnitCardProps) => (
  <article
    data-federated-component="property.registry.PropertyUnitCard"
    data-federated-source={source}
    style={{
      background: '#ecfdf5',
      border: '1px solid rgba(4, 120, 87, 0.28)',
      borderRadius: '8px',
      color: '#064e3b',
      display: 'grid',
      gap: '8px',
      padding: '16px',
    }}
  >
    <p style={{ fontSize: '12px', fontWeight: 800, margin: 0 }}>Federated public component</p>
    <h2 style={{ fontSize: '20px', margin: 0 }}>{displayName}</h2>
    <dl style={{ display: 'grid', gap: '6px', margin: 0 }}>
      <div>
        <dt>component owner</dt>
        <dd>property.registry</dd>
      </div>
      <div>
        <dt>unit id</dt>
        <dd>{unitId}</dd>
      </div>
      <div>
        <dt>rendered by</dt>
        <dd>{source}</dd>
      </div>
    </dl>
  </article>
);
