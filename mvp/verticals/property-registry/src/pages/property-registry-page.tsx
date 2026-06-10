import type { ModuleActivationState } from '@mvp/shared-contracts';
import { propertyRegistryBoundaryMarker } from '../boundary-marker.ts';

interface PropertyRegistryPageProps {
  readonly state: ModuleActivationState;
}

export const PropertyRegistryPage = ({ state }: PropertyRegistryPageProps) => {
  const marker = propertyRegistryBoundaryMarker;

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
      <p style={{ color: '#047857', fontSize: '12px', fontWeight: 800, margin: 0 }}>
        MicroVertical placeholder
      </p>
      <h1 style={{ color: '#1c1917', fontSize: '32px', margin: '12px 0' }}>Property Registry</h1>
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
    </section>
  );
};
