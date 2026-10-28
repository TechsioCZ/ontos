// Public, self-contained S12/S14 panel for records in other verticals. Reads and writes retain the
// Nájempark operations gateway, legal-entity scope and restricted documents permission.
import { AgendaFrame } from './agenda-frame.tsx';
import { CommentThread } from './comment-thread.tsx';
import { PartyFinanceFiles } from './finance-files.tsx';
import { LinkedDocuments } from './linked-documents.tsx';
import { useAgendaRecords } from './use-agenda.ts';
import type { SubjectRef } from '../../shared/domain/documents.ts';

export { PropertyEquipment } from './property-equipment.tsx';

interface RecordDiscussionProps {
  readonly section?: 'documents' | 'comments' | undefined;
  readonly subject: SubjectRef;
}
const RecordDiscussionContent = ({ section, subject }: RecordDiscussionProps) => {
  const records = useAgendaRecords(['documents']);
  return (
    <>
      {section !== 'comments' && <LinkedDocuments hideWhenForbidden records={records} subject={subject} />}
      {section !== 'documents' && (
        <CommentThread hideWhenForbidden key={`${subject.kind}:${subject.id}`} records={records} subject={subject} />
      )}
    </>
  );
};

/** Mount only in an already-authorized source record detail, never in a cross-company list. */
export const RecordDiscussion = ({ section, subject }: RecordDiscussionProps) => (
  <AgendaFrame>
    <RecordDiscussionContent section={section} subject={subject} />
  </AgendaFrame>
);

/**
 * Files of one customer / counterparty (party registry id) for its dossier: Nájempark documents linked to the contact
 * (upload straight onto the contact, attach an existing one) plus, read-through, the files of its invoices uploaded
 * in Finance. Each part is shown only to people who may read it.
 */
export const PartyDocuments = ({
  counterpartyId,
  label,
  language,
}: {
  readonly counterpartyId: string;
  readonly label: string;
  readonly language: string;
}) => (
  <AgendaFrame>
    <div className="flex flex-col gap-200" data-testid="party-documents">
      <LinkedDocuments hideWhenForbidden subject={{ id: counterpartyId, kind: 'contact', label }} />
      <PartyFinanceFiles counterpartyId={counterpartyId} language={language} />
    </div>
  </AgendaFrame>
);
