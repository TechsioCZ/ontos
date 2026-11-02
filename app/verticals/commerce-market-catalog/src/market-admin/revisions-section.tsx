// "Revize" of the market detail: every definition revision, newest first, with what it changed.
import { SectionCard } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import type { RevisionRow } from './market-detail-model.ts';
import { definitionPeriodText } from './definition-text.ts';
import { useMarketText } from './market-ui.tsx';

export const RevisionsSection = ({
  currentRevision,
  rows,
}: {
  readonly currentRevision: number | undefined;
  readonly rows: readonly RevisionRow[];
}) => {
  const { text } = useMarketText();
  const summary = (row: RevisionRow) => {
    if (row.revision === 1) {
      return text('detail.revisions.created');
    }
    return row.changes.length === 0
      ? text('detail.revisions.unchanged')
      : text('detail.revisions.changed', {
          changes: row.changes.map((change) => text(`detail.revisions.change.${change}`)).join(', '),
        });
  };
  return (
    <SectionCard title={text('detail.revisions.title')}>
      <ol className="divide-y divide-border-primary/60">
        {rows.map((row) => (
          <li className="flex flex-col gap-50 py-150" key={row.revision}>
            <span className="flex flex-wrap items-center gap-100 font-medium text-sm">
              {text('detail.revisions.revision', { revision: row.revision })}
              {row.revision === currentRevision && (
                <Badge size="sm" variant="info">
                  {text('detail.revisions.current')}
                </Badge>
              )}
            </span>
            <span className="text-fg-secondary text-sm">{summary(row)}</span>
            <span className="text-sm">
              {row.definition.purpose} · {row.definition.channels.join(', ')} ·{' '}
              {row.definition.supportedLocales.join(', ')} · {definitionPeriodText(row.definition, text)}
            </span>
          </li>
        ))}
      </ol>
    </SectionCard>
  );
};
