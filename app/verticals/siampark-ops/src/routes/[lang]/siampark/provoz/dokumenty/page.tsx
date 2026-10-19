// Siampark provoz — documents. OWNED BY THE `documents` LANE: replace this scaffold page freely.
// Data: useAgendaRecords(['documents']) / ScaffoldRecordView; commands: shared/commands/documents.ts.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { OpsCommand } from '../../../../../../shared/agendas.ts';
import type { DocumentRecord, DocumentsState } from '../../../../../../shared/domain/documents.ts';
import { AgendaFrame } from '../../../../../ui/agenda-frame.tsx';
import { ScaffoldRecordView, locationLabel } from '../../../../../ui/scaffold-record-page.tsx';
import { UltramodernRouteHead } from '../../../../ultramodern-route-head';

const DocumentsView = () => {
  const { t } = useModernI18n();
  return (
    <ScaffoldRecordView<DocumentRecord>
      agenda="documents"
      columns={[
      { cell: (row) => row.title ?? t('siampark-ops.common.notProvided'), header: t('siampark-ops.documents.fields.title'), id: 'title' },
      { cell: (row) => row.category ?? t('siampark-ops.common.notProvided'), header: t('siampark-ops.documents.fields.category'), id: 'category' },
      { cell: (row) => locationLabel(row.related, t('siampark-ops.common.noData')), header: t('siampark-ops.common.location'), id: 'location' },
      ]}
      fields={[
      { kind: 'text', label: t('siampark-ops.documents.fields.title'), name: 'title', required: true },
      { kind: 'text', label: t('siampark-ops.documents.fields.category'), name: 'category', required: true },
      ]}
      rowLabel={(row) => row.title}
      rows={(state) => (state as DocumentsState).documents}
      toCommand={(values, location) => ({
        _tag: 'DocumentCreate',
        title: values['title'] ?? '',
        category: values['category'] ?? '',
        ...(location === undefined ? {} : { related: location }),
      }) as OpsCommand}
    />
  );
};

export const DocumentsPage = () => (
  <AgendaFrame>
    <UltramodernRouteHead titleKey="siampark-ops.documents.title" />
    <DocumentsView />
  </AgendaFrame>
);

export default DocumentsPage;
