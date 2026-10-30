import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { EmptyState, SectionCard } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Skeleton } from '@techsio/ui-kit/atoms/skeleton';
import { useEffect } from 'react';
import type { ComponentProps } from 'react';
import { DateTime, Effect, Fiber, Option, Schedule, Schema } from 'effect';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { usePageData } from '../../../../runtime/use-page-data.ts';
import type { AiActivityEntry } from '../../../../../shared/apis/records.ts';
import { aiActivityData } from './employees-data.ts';

const key = 'workforce.pages.employees.aiActivity';
/** The list refreshes itself while the page is open, so an AI action appears without a reload. */
const REFRESH_INTERVAL = '10 seconds';

type BadgeVariant = Exclude<NonNullable<ComponentProps<typeof Badge>['variant']>, 'dynamic'>;

const outcomeVariant = new Map<string, BadgeVariant>([
  ['allowed', 'info'],
  ['denied', 'danger'],
  ['failed', 'warning'],
  ['succeeded', 'success'],
]);

/** Module part of an Action key or a target module, e.g. `work.tasks.apply-command` → `work.tasks`. */
const moduleOf = (entry: AiActivityEntry): string =>
  entry.targetModuleKey.pipe(
    Option.orElse(() => entry.actionKey.pipe(Option.map((action) => action.replace(/\.[a-z0-9-]+$/u, '')))),
    Option.getOrElse(() => ''),
  );

const LevelSchema = Schema.Literals(['A', 'B', 'C']);
type Level = typeof LevelSchema.Type;
const levelVariant = { A: 'info', B: 'warning', C: 'primary' } satisfies Readonly<Record<Level, BadgeVariant>>;

const levelOf = (entry: AiActivityEntry): Level | undefined => {
  const match = /AI agent (?<level>[ABC])\b/u.exec(entry.actorDisplayName);
  return Schema.decodeUnknownOption(LevelSchema)(match?.groups?.['level']).pipe(Option.getOrUndefined);
};

const timeFormatOptions = {
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  month: 'numeric',
  second: '2-digit',
  timeZone: 'Europe/Prague',
} satisfies Intl.DateTimeFormatOptions;
const timeFormats = {
  cs: new Intl.DateTimeFormat('cs-CZ', timeFormatOptions),
  en: new Intl.DateTimeFormat('en-GB', timeFormatOptions),
};

const noEntries: readonly AiActivityEntry[] = [];

/**
 * "AI aktivita": the latest Core audit events of non-human principals (AI agents A/B/C, integrations) in the selected
 * company — who, what, result, when. Read from the real Core audit, refreshed every 10 s. The page's `preloadPage`
 * starts the read with the page; it is secondary, so the card keeps its own skeleton until the read settles.
 */
export const AiActivityCard = ({ legalEntityId }: { readonly legalEntityId: string }) => {
  const { language, t } = useModernI18n();
  const feed = usePageData(aiActivityData, legalEntityId);
  // A refresh keeps the current entries on screen until the new read settles.
  const refresh = () => {
    browserRuntime.runFork(aiActivityData.refresh(legalEntityId));
  };

  // Delay the first tick; each later tick starts a read without waiting for the previous read.
  // Page-data owns in-flight reads, so unmount interrupts the ticker while a started read may settle.
  useEffect(() => {
    const timer = browserRuntime.runFork(
      Effect.suspend(() =>
        document.visibilityState === 'visible'
          ? aiActivityData.refresh(legalEntityId).pipe(Effect.forkDetach, Effect.asVoid)
          : Effect.void,
      ).pipe(Effect.repeat(Schedule.fixed(REFRESH_INTERVAL)), Effect.delay(REFRESH_INTERVAL)),
    );
    return () => {
      browserRuntime.runFork(Fiber.interrupt(timer));
    };
  }, [legalEntityId]);

  const timeFormat = language === 'en' ? timeFormats.en : timeFormats.cs;
  const label = (group: string, value: string, fallback: string) =>
    t(`${key}.${group}.${value.replaceAll('.', '_')}`, { defaultValue: fallback });

  const entries = feed.state === 'ready' ? feed.value : noEntries;
  const executed = entries.filter((entry) => entry.outcome === 'succeeded').length;
  const denied = entries.filter((entry) => entry.outcome === 'denied').length;

  return (
    <SectionCard
      actions={
        <>
          {feed.state === 'ready' && (
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
      {feed.state === 'pending' && (
        <Skeleton isLoaded={false}>
          <Skeleton.Rectangle className="h-40 w-full" />
        </Skeleton>
      )}
      {feed.state === 'failed' && <EmptyState title={t(`${key}.unavailable`)} />}
      {feed.state === 'ready' && entries.length === 0 && (
        <EmptyState description={t(`${key}.emptyDescription`)} title={t(`${key}.empty`)} />
      )}
      {feed.state === 'ready' && entries.length > 0 && (
        <div className="max-h-[28rem] overflow-auto">
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
                const moduleLabel = label('modules', moduleOf(entry), t(`${key}.otherModule`));
                const actionLabel = Option.isNone(entry.actionKey)
                  ? moduleLabel
                  : [moduleLabel, t(`${key}.write`)].join(' · ');
                return (
                  <tr className="border-border-primary border-b last:border-b-0" key={entry.auditEventId}>
                    <td className="whitespace-nowrap px-150 py-100 tabular-nums">
                      {DateTime.formatIntl(entry.occurredAt, timeFormat)}
                    </td>
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
                    <td className="px-150 py-100">{actionLabel}</td>
                    <td className="px-150 py-100">
                      <Badge size="sm" variant={outcomeVariant.get(entry.outcome) ?? 'outline'}>
                        {label('outcomes', entry.outcome, t(`${key}.otherOutcome`))}
                      </Badge>
                    </td>
                    <td className="px-150 py-100 text-fg-secondary">
                      {label('codes', entry.outcomeCode, t(`${key}.otherCode`))}
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
