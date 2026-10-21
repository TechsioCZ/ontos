import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { EmptyState, SectionCard } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Skeleton } from '@techsio/ui-kit/atoms/skeleton';
import { Effect } from 'effect';
import { useCallback, useEffect, useState } from 'react';
import { executeRecords } from '../../../../api/records-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { AiActivityEntry } from '../../../../../shared/apis/records.ts';
import { newRequestToken } from './employee-model.ts';

const key = 'workforce.pages.employees.aiActivity';
/** The list refreshes itself while the page is open, so an AI action appears without a reload. */
const REFRESH_MS = 10_000;

type Feed =
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable' }
  | { readonly entries: readonly AiActivityEntry[]; readonly status: 'ready' };

type BadgeVariant = 'danger' | 'info' | 'outline' | 'secondary' | 'success' | 'warning';

const outcomeVariant: Readonly<Record<string, BadgeVariant>> = {
  allowed: 'info',
  denied: 'danger',
  failed: 'warning',
  succeeded: 'success',
};

/** Module part of an Action key or a target module, e.g. `siampark.work.apply-command` → `siampark.work`. */
const moduleOf = (entry: AiActivityEntry): string =>
  entry.targetModuleKey ?? entry.actionKey?.replace(/\.[a-z0-9-]+$/u, '') ?? '';

type Level = 'A' | 'B' | 'C';
const levelVariant: Readonly<Record<Level, BadgeVariant>> = { A: 'info', B: 'warning', C: 'secondary' };

const levelOf = (entry: AiActivityEntry): Level | undefined => {
  const match = /AI agent (?<level>[ABC])\b/u.exec(entry.actorDisplayName);
  const level = match?.groups?.['level'];
  return level === 'A' || level === 'B' || level === 'C' ? level : undefined;
};

const loadFeed = (onLoaded: (feed: Feed) => void) => {
  void browserRuntime.runPromise(
    newRequestToken.pipe(
      Effect.flatMap((token) => executeRecords({ includeAiActivity: true }, `workforce:ai-activity:${token}`)),
      Effect.match({
        onFailure: (): Feed => ({ status: 'unavailable' }),
        onSuccess: (data): Feed =>
          data.aiActivity === undefined ? { status: 'unavailable' } : { entries: data.aiActivity, status: 'ready' },
      }),
      Effect.map(onLoaded),
    ),
  );
};

/**
 * "AI aktivita": the latest Core audit events of non-human principals (AI agents A/B/C, integrations) in the selected
 * company — who, what, result, when. Read from the real Core audit, refreshed every 10 s.
 */
export const AiActivityCard = () => {
  const { language, t } = useModernI18n();
  const [feed, setFeed] = useState<Feed>({ status: 'loading' });
  const refresh = useCallback(() => loadFeed(setFeed), []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        refresh();
      }
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const timeFormat = new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'cs-CZ', {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'numeric',
    second: '2-digit',
    timeZone: 'Europe/Prague',
  });
  const time = (iso: string) => timeFormat.format(Date.parse(iso));
  const label = (group: string, value: string, fallback: string) =>
    t(`${key}.${group}.${value.replaceAll('.', '_')}`, { defaultValue: fallback });

  const entries = feed.status === 'ready' ? feed.entries : [];
  const executed = entries.filter((entry) => entry.outcome === 'succeeded').length;
  const denied = entries.filter((entry) => entry.outcome === 'denied').length;

  return (
    <SectionCard
      actions={
        <>
          {feed.status === 'ready' && (
            <>
              <Badge size="sm" variant="success">
                {t(`${key}.executed`, { count: executed })}
              </Badge>
              <Badge size="sm" variant="danger">
                {t(`${key}.denied`, { count: denied })}
              </Badge>
            </>
          )}
          <Button icon="icon-[mdi--refresh]" onClick={refresh} size="sm" theme="outlined" variant="secondary">
            {t(`${key}.refresh`)}
          </Button>
        </>
      }
      title={t(`${key}.title`)}
    >
      <p className="-mt-100 text-fg-secondary text-sm">{t(`${key}.description`)}</p>
      {feed.status === 'loading' && (
        <Skeleton isLoaded={false}>
          <Skeleton.Rectangle className="h-40 w-full" />
        </Skeleton>
      )}
      {feed.status === 'unavailable' && <EmptyState title={t(`${key}.unavailable`)} />}
      {feed.status === 'ready' && entries.length === 0 && (
        <EmptyState description={t(`${key}.emptyDescription`)} title={t(`${key}.empty`)} />
      )}
      {feed.status === 'ready' && entries.length > 0 && (
        <div className="max-h-[28rem] overflow-auto rounded-md border border-border-primary">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="sticky top-0 bg-surface">
              <tr className="border-border-primary border-b">
                <th className="px-150 py-100 font-medium">{t(`${key}.columns.time`)}</th>
                <th className="px-150 py-100 font-medium">{t(`${key}.columns.actor`)}</th>
                <th className="px-150 py-100 font-medium">{t(`${key}.columns.action`)}</th>
                <th className="px-150 py-100 font-medium">{t(`${key}.columns.result`)}</th>
                <th className="px-150 py-100 font-medium">{t(`${key}.columns.reason`)}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const level = levelOf(entry);
                return (
                  <tr className="border-border-primary border-b last:border-b-0" key={entry.auditEventId}>
                    <td className="whitespace-nowrap px-150 py-100 tabular-nums">{time(entry.occurredAt)}</td>
                    <td className="px-150 py-100">
                      <span className="flex items-center gap-100">
                        {level !== undefined && (
                          <Badge size="sm" variant={levelVariant[level]}>
                            {t(`${key}.level`, { level })}
                          </Badge>
                        )}
                        <span className="truncate">{entry.actorDisplayName}</span>
                      </span>
                    </td>
                    <td className="px-150 py-100">
                      {entry.actionKey === null
                        ? label('modules', moduleOf(entry), moduleOf(entry) || '—')
                        : `${label('modules', moduleOf(entry), moduleOf(entry))} · ${t(`${key}.write`)}`}
                    </td>
                    <td className="px-150 py-100">
                      <Badge size="sm" variant={outcomeVariant[entry.outcome] ?? 'outline'}>
                        {label('outcomes', entry.outcome, entry.outcome)}
                      </Badge>
                    </td>
                    <td className="px-150 py-100 text-fg-secondary">
                      {label('codes', entry.outcomeCode, entry.outcomeCode)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
};
