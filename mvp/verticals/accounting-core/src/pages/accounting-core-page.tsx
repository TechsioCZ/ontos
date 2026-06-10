import type { ModuleActivationState, PublicComponentDescriptor } from '@mvp/shared-contracts';
import { FederatedPublicComponent } from '@mvp/shared-contracts/federated-public-component';
import { accountingCoreBoundaryMarker } from '../boundary-marker.ts';

interface AccountingCorePageProps {
  readonly state: ModuleActivationState;
  readonly propertyUnitCard?: PublicComponentDescriptor | undefined;
}

export const AccountingCorePage = ({ propertyUnitCard, state }: AccountingCorePageProps) => {
  const marker = accountingCoreBoundaryMarker;

  return (
    <section
      data-folder-name={marker.folderName}
      data-module-id={marker.moduleId}
      data-module-state={state}
      data-rendered-from={marker.renderedFrom}
      style={{
        background: '#ffffff',
        border: '1px solid rgba(28, 25, 23, 0.14)',
        borderRadius: '8px',
        boxShadow: '0 16px 40px rgba(28, 25, 23, 0.08)',
        margin: '48px auto 0',
        maxWidth: '880px',
        padding: '32px',
      }}
    >
      <p style={{ color: '#0369a1', fontSize: '12px', fontWeight: 800, margin: 0 }}>
        MicroVertical placeholder
      </p>
      <h1 style={{ color: '#1c1917', fontSize: '32px', margin: '12px 0' }}>Accounting Core</h1>
      <dl style={{ display: 'grid', gap: '12px', margin: 0 }}>
        <div>
          <dt>module id</dt>
          <dd>{marker.moduleId}</dd>
        </div>
        <div>
          <dt>filesystem folder</dt>
          <dd>{marker.folderName}</dd>
        </div>
        <div>
          <dt>tenant module state</dt>
          <dd>{state}</dd>
        </div>
        <div>
          <dt>rendered from</dt>
          <dd>{marker.renderedFrom}</dd>
        </div>
      </dl>
      {propertyUnitCard === undefined ? undefined : (
        <div style={{ marginTop: '24px' }}>
          <FederatedPublicComponent
            descriptor={propertyUnitCard}
            fallback={<p>Loading property registry card...</p>}
            props={{
              displayName: 'Accounting view of Unit A-101',
              source: 'accounting.core',
              unitId: 'unit-a-101',
            }}
          />
        </div>
      )}
    </section>
  );
};
