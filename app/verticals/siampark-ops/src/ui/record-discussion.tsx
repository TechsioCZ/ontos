// Public, self-contained S12/S14 panel for records in other verticals. Reads and writes retain the
// Siampark operations gateway, legal-entity scope and restricted documents permission.
export { PropertyEquipment } from './property-equipment.tsx';
import { AgendaFrame } from './agenda-frame.tsx';
import { CommentThread } from './comment-thread.tsx';
import { LinkedDocuments } from './linked-documents.tsx';
import { useAgendaRecords } from './use-agenda.ts';
import type { SubjectRef } from '../../shared/domain/documents.ts';

const RecordDiscussionContent = ({ subject }: { readonly subject: SubjectRef }) => {
  const records = useAgendaRecords(['documents']);
  return (
    <>
      <LinkedDocuments hideWhenForbidden records={records} subject={subject} />
      <CommentThread hideWhenForbidden key={`${subject.kind}:${subject.id}`} records={records} subject={subject} />
    </>
  );
};

/** Mount only in an already-authorized source record detail, never in a cross-company list. */
export const RecordDiscussion = ({ subject }: { readonly subject: SubjectRef }) => (
  <AgendaFrame>
    <RecordDiscussionContent subject={subject} />
  </AgendaFrame>
);
