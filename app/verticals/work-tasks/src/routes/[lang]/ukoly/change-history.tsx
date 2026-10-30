import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { DateTime } from 'effect';
import type { HistoryEntry } from '../../../../shared/apis/records.ts';
import { surfaceTileClassName } from '@app/admin-ui';

const actionLabels = {
  archived: 'Skryto ze seznamu',
  created: 'Založeno',
  restored: 'Vráceno do seznamu',
  updated: 'Změněno',
} satisfies Record<HistoryEntry['action'], string>;

const timestamp = new Intl.DateTimeFormat('cs-CZ', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Prague',
});

export const formatTimestamp = (at: DateTime.Utc) => timestamp.format(DateTime.toDateUtc(at));

/**
 * Historie změn: newest first, each entry with who, when and every changed field as before → after. The caller names
 * fields and values (ids become people, customers, objects), so this list stays the same for tasks and projects.
 */
export const ChangeHistory = ({
  actorName,
  createdAt,
  entries,
  fieldLabel,
  formatValue,
  updatedAt,
}: {
  readonly actorName: (principalId: string, displayName?: string) => string;
  readonly createdAt: DateTime.Utc;
  readonly entries: readonly HistoryEntry[] | undefined;
  readonly fieldLabel: (field: string) => string;
  readonly formatValue: (field: string, value: string | undefined) => string;
  readonly updatedAt: DateTime.Utc;
}) => {
  const { t } = useModernI18n();
  const newestFirst = (entries ?? []).toReversed();
  return (
    <section
      aria-label={t('work-tasks.history.title')}
      className="flex flex-col gap-100 border-t border-border-primary pt-200"
    >
      <h3 className="font-semibold">Historie změn</h3>
      {newestFirst.length === 0 && (
        <p className="text-sm text-fg-secondary">
          Zatím bez zaznamenaných změn. Založeno {formatTimestamp(createdAt)}, naposledy uloženo{' '}
          {formatTimestamp(updatedAt)}.
        </p>
      )}
      <ol className="flex flex-col gap-100">
        {newestFirst.map((entry, index) => (
          <li
            className={`${surfaceTileClassName} flex flex-col gap-50 p-150`}
            key={`${DateTime.toEpochMillis(entry.at)}-${index}`}
          >
            <p className="text-sm">
              <span className="font-medium">{actionLabels[entry.action]}</span>
              <span className="text-fg-secondary">
                {' '}
                · {actorName(entry.actorPrincipalRef.principalId, entry.actorDisplayName)} · {formatTimestamp(entry.at)}
              </span>
            </p>
            {entry.changes.length > 0 && (
              <ul className="flex flex-col gap-25 text-sm">
                {entry.changes.map((change) => (
                  <li key={change.field}>
                    <span className="text-fg-secondary">{fieldLabel(change.field)}:</span>{' '}
                    {entry.action === 'created' ? (
                      formatValue(change.field, change.after)
                    ) : (
                      <>
                        <span className="line-through decoration-fg-secondary">
                          {formatValue(change.field, change.before)}
                        </span>{' '}
                        → {formatValue(change.field, change.after)}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
};
