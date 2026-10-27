import { DateTime } from 'effect';

interface TimelineEntry {
  readonly authorPrincipalId: string;
  readonly kind: string;
  readonly occurredAt: DateTime.Utc;
  readonly summary: string;
}

/** Append-only event occurrences retain their keys when newer or identical events arrive. */
export const timelineEntries = <Entry extends TimelineEntry>(entries: readonly Entry[]) => {
  const occurrences = new Map<string, number>();
  return entries
    .map((entry) => {
      const base = [DateTime.formatIso(entry.occurredAt), entry.authorPrincipalId, entry.kind, entry.summary]
        .map((value) => `${value.length}:${value}`)
        .join('');
      const occurrence = occurrences.get(base) ?? 0;
      occurrences.set(base, occurrence + 1);
      return { entry, key: `${base}:${occurrence}` };
    })
    .toReversed();
};
