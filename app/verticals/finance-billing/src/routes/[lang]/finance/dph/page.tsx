import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { EmptyState, formatDate, PageHeader, SectionCard, Toaster } from '@app/admin-ui';
import { documentNavigationModules } from '@app/shared-contracts';
import { modulePagePreload, pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { DateTime, Effect } from 'effect';
import { useEffect, useState, useSyncExternalStore } from 'react';
import csResource from '../../../../../locales/cs/finance-billing.json';
import enResource from '../../../../../locales/en/finance-billing.json';
import { classificationLabelKey } from '../../../../../shared/domain/line-vat.ts';
import '../../../index.css';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import { financePageScope } from '../finance-page-scope.ts';
import { RateDialog, RegimeDialog, WithdrawDialog } from './vat-dialogs.tsx';
import { changeRegime, planNewRate, setFirstRate, vatSettingsData, withdrawPlannedRate } from './vat-settings-data.ts';
import type { VatRegimeView, VatSettings } from './vat-settings-data.ts';
import type { VatChangeRights } from './tax-access.ts';
import type { ClassificationView, RateRevision, RegimePeriod } from './vat-settings-model.ts';

const resources = {
  cs: { 'finance-billing': csResource },
  en: { 'finance-billing': enResource },
} as const;

const ns = 'finance-billing.vatSettings';
const TAX_MODULE = 'commerce.tax';

const day = (instant: DateTime.Utc) => formatDate(DateTime.formatIso(instant));
/** Periods are half-open: the last day shown is the day before the next period starts. */
const lastDay = (end: DateTime.Utc) => day(DateTime.subtract(end, { milliseconds: 1 }));

type ReadyClassification = Extract<ClassificationView, { readonly state: 'ready' }>;
type ReadySettings = Extract<VatSettings, { readonly state: 'ready' }>;

const RegimeRow = ({ period }: { readonly period: RegimePeriod }) => {
  const { t } = useModernI18n();
  return (
    <li className="flex flex-wrap items-center gap-100 text-sm">
      <span className="tabular-nums">
        {period.to === undefined
          ? t(`${ns}.since`, { date: day(period.from) })
          : t(`${ns}.between`, { from: day(period.from), to: lastDay(period.to) })}
      </span>
      <span className="font-medium">{t(`${ns}.regime.${period.regime}`)}</span>
      {period.state !== 'past' && (
        <Badge size="sm" variant={period.state === 'current' ? 'success' : 'info'}>
          {t(`${ns}.state.${period.state}`)}
        </Badge>
      )}
    </li>
  );
};

const RegimeCard = ({ canDeclare, regime }: { readonly canDeclare: boolean; readonly regime: VatRegimeView }) => {
  const { t } = useModernI18n();
  const [open, setOpen] = useState(false);
  return (
    <SectionCard
      actions={
        canDeclare && (
          <Button
            icon="icon-[mdi--pencil-outline]"
            onClick={() => setOpen(true)}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {t(`${ns}.regimeChange`)}
          </Button>
        )
      }
      title={t(`${ns}.regimeTitle`)}
    >
      <p className="font-semibold text-lg">{t(`${ns}.regime.${regime.current}`)}</p>
      {regime.timeline === undefined ? (
        <p className="text-fg-secondary text-sm">{t(`${ns}.regimeHistoryHidden`)}</p>
      ) : (
        <ul className="flex flex-col gap-75">
          {regime.timeline.toReversed().map((period) => (
            <RegimeRow key={DateTime.formatIso(period.from)} period={period} />
          ))}
        </ul>
      )}
      {open && <RegimeDialog onClose={() => setOpen(false)} send={(input) => changeRegime(regime, input)} />}
    </SectionCard>
  );
};

const RateRow = ({
  onWithdraw,
  revision,
}: {
  readonly onWithdraw?: (() => void) | undefined;
  readonly revision: RateRevision;
}) => {
  const { t } = useModernI18n();
  return (
    <li className="flex flex-wrap items-center gap-100 text-sm">
      <span className="tabular-nums">
        {revision.to === undefined
          ? t(`${ns}.since`, { date: day(revision.from) })
          : t(`${ns}.between`, { from: day(revision.from), to: lastDay(revision.to) })}
      </span>
      <span className="font-medium tabular-nums">{t(`${ns}.rate`, { rate: revision.ratePercent })}</span>
      {onWithdraw !== undefined && (
        <Button onClick={onWithdraw} size="sm" theme="borderless" variant="secondary">
          {t(`${ns}.withdraw`)}
        </Button>
      )}
    </li>
  );
};

const RateList = ({
  empty,
  onWithdraw,
  revisions,
  title,
}: {
  readonly empty: string;
  readonly onWithdraw?: ((revision: RateRevision) => void) | undefined;
  readonly revisions: readonly RateRevision[];
  readonly title: string;
}) => (
  <div className="flex flex-col gap-75">
    <h3 className="font-medium text-sm">{title}</h3>
    {revisions.length === 0 ? (
      <p className="text-fg-secondary text-sm">{empty}</p>
    ) : (
      <ul className="flex flex-col gap-75">
        {revisions.map((revision) => (
          <RateRow
            key={revision.revisionRef.resourceId}
            onWithdraw={onWithdraw === undefined ? undefined : () => onWithdraw(revision)}
            revision={revision}
          />
        ))}
      </ul>
    )}
  </div>
);

const ReadyClassificationCard = ({
  now,
  rights,
  view,
}: {
  readonly now: DateTime.Utc;
  readonly rights: VatChangeRights;
  readonly view: ReadyClassification;
}) => {
  const { t } = useModernI18n();
  const [planning, setPlanning] = useState(false);
  const [withdrawing, setWithdrawing] = useState<RateRevision>();
  const name = t(classificationLabelKey(view.code));
  return (
    <SectionCard
      actions={
        // A new rate ends the one it follows, so planning needs both changes.
        rights.createRevision &&
        rights.endRevision && (
          <Button icon="icon-[mdi--calendar-plus]" onClick={() => setPlanning(true)} size="sm" variant="primary">
            {t(`${ns}.plan`)}
          </Button>
        )
      }
      title={name}
    >
      <p className="font-semibold text-lg tabular-nums">
        {view.current === undefined
          ? t(`${ns}.noCurrentRate`)
          : t(`${ns}.currentRate`, { date: day(view.current.from), rate: view.current.ratePercent })}
      </p>
      {view.undecided && (
        <StatusText showIcon size="sm" status="warning">
          {t(`${ns}.undecided`)}
        </StatusText>
      )}
      <RateList
        empty={t(`${ns}.noPlans`)}
        onWithdraw={rights.endRevision ? setWithdrawing : undefined}
        revisions={view.scheduled}
        title={t(`${ns}.planned`)}
      />
      <RateList empty={t(`${ns}.noPast`)} revisions={view.past} title={t(`${ns}.past`)} />
      {planning && (
        <RateDialog
          description={t(`${ns}.planDescription`, { name })}
          onClose={() => setPlanning(false)}
          send={(input) => planNewRate(view, input, now)}
          submitLabel={t(`${ns}.planSave`)}
          title={t(`${ns}.planTitle`, { name })}
        />
      )}
      {withdrawing !== undefined && (
        <WithdrawDialog
          label={t(`${ns}.planLabel`, { date: day(withdrawing.from), rate: withdrawing.ratePercent })}
          onClose={() => setWithdrawing(undefined)}
          send={(reason) => withdrawPlannedRate(view, withdrawing, reason)}
        />
      )}
    </SectionCard>
  );
};

const MissingClassificationCard = ({
  canCreate,
  view,
}: {
  readonly canCreate: boolean;
  readonly view: ClassificationView;
}) => {
  const { t } = useModernI18n();
  const [open, setOpen] = useState(false);
  const name = t(classificationLabelKey(view.code));
  return (
    <SectionCard title={name}>
      <EmptyState
        action={
          canCreate ? (
            <Button icon="icon-[mdi--plus]" onClick={() => setOpen(true)} size="sm" variant="primary">
              {t(`${ns}.firstRate`)}
            </Button>
          ) : undefined
        }
        description={t(`${ns}.missingDescription`)}
        title={t(`${ns}.missing`)}
      />
      {open && (
        <RateDialog
          description={t(`${ns}.firstRateDescription`, { name })}
          onClose={() => setOpen(false)}
          send={(input) => setFirstRate(view.code, input)}
          submitLabel={t(`${ns}.firstRateSave`)}
          title={t(`${ns}.firstRateTitle`, { name })}
        />
      )}
    </SectionCard>
  );
};

const ReadyVatSettings = ({ settings }: { readonly settings: ReadySettings }) => (
  <>
    <RegimeCard canDeclare={settings.rights.declareRegime} regime={settings.regime} />
    {settings.classifications.map((view) =>
      view.state === 'ready' ? (
        <ReadyClassificationCard key={view.code} now={settings.now} rights={settings.rights} view={view} />
      ) : (
        <MissingClassificationCard canCreate={settings.rights.createRule} key={view.code} view={view} />
      ),
    )}
  </>
);

const pendingSnapshot = () => pageDataPending;

/** The page body for one verified scope: Tax's answer, or a plain reason why there is none. */
const VatSettingsBody = ({ scope }: { readonly scope: string }) => {
  const { t } = useModernI18n();
  const snapshot = useSyncExternalStore(
    vatSettingsData.subscribe,
    () => vatSettingsData.snapshot(scope),
    pendingSnapshot,
  );
  useEffect(() => {
    vatSettingsData.ensure(scope);
  }, [scope]);
  if (snapshot.state !== 'ready') {
    return (
      <StatusText aria-live="polite" showIcon status="default">
        {t(`${ns}.loading`)}
      </StatusText>
    );
  }
  const settings = snapshot.value;
  if (settings.state === 'forbidden') {
    return <EmptyState description={t(`${ns}.forbiddenDescription`)} title={t(`${ns}.forbidden`)} />;
  }
  if (settings.state === 'unavailable') {
    return (
      <StatusText showIcon status="error">
        {t(`${ns}.unavailable`)}
      </StatusText>
    );
  }
  return <ReadyVatSettings settings={settings} />;
};

/** Whether the company runs Tax, from the Shell's per-document hint; without the hint Tax answers for itself. */
const taxInstalled = () => {
  const modules = documentNavigationModules();
  return modules === undefined || modules.has(TAX_MODULE);
};

const VatSettingsContent = ({ scope }: { readonly scope: string | undefined }) => {
  const { t } = useModernI18n();
  let body = <VatSettingsBody scope={scope ?? ''} />;
  if (!taxInstalled()) {
    body = <EmptyState description={t(`${ns}.notInstalledDescription`)} title={t(`${ns}.notInstalled`)} />;
  } else if (scope === undefined) {
    body = (
      <StatusText showIcon status="error">
        {t(`${ns}.unavailable`)}
      </StatusText>
    );
  }
  return (
    <>
      <UltramodernRouteHead />
      <Toaster />
      <section className="flex min-w-0 flex-col gap-250 text-fg-primary">
        <PageHeader description={t(`${ns}.description`)} title={t(`${ns}.title`)} />
        {body}
      </section>
    </>
  );
};

/** The Shell runs this before it reveals the page, so the first paint already shows the company's VAT. */
export const preloadPage = modulePagePreload((props) => {
  const scope = financePageScope(props.context);
  return scope === undefined || !taxInstalled() ? Effect.void : vatSettingsData.preload(scope);
});

/** "DPH": the company's VAT regime and the rates Finance uses on invoices, managed in Tax by people with Tax rights. */
export const VatPage = (props: Partial<ModulePageProps>) => {
  const scope = financePageScope(props.context);
  return (
    <FederatedI18nBoundary
      defaultNamespace="finance-billing"
      fallbackLanguage="en"
      resources={resources}
      supportedLanguages={['en', 'cs']}
    >
      <VatSettingsContent key={scope ?? ''} scope={scope} />
    </FederatedI18nBoundary>
  );
};
export default VatPage;
