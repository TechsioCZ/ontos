import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { useNavigate, useParams } from '@modern-js/plugin-tanstack/runtime';
import { DetailList, PageHeader, SectionCard, Toaster } from '@app/admin-ui';
import { modulePagePreload, pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageProps, PageData } from '@app/shared-contracts/page-data';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect, Fiber, Match, Option, Schedule, Schema } from 'effect';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import csResource from '../../../../../../../locales/cs/commerce-market-catalog.json';
import enResource from '../../../../../../../locales/en/commerce-market-catalog.json';
import { MarketHistoryNotFoundProblemSchema } from '../../../../../../../shared/apis/market-history.ts';
import type { MarketRetirementOutcome } from '../../../../../../../shared/domain/market-retirement-intent.ts';
import type { MarketLifecycle } from '../../../../../../../shared/market-contracts.ts';
import { AssortmentSection } from '../../../../../../market-admin/assortment-section.tsx';
import { definitionPeriodText } from '../../../../../../market-admin/definition-text.ts';
import { EditMarketDialog, LifecycleDialog, RetireDialog } from '../../../../../../market-admin/market-dialogs.tsx';
import {
  currentDefinition,
  lifecycleActions,
  marketAssociations,
  retirementView,
  revisionRows,
} from '../../../../../../market-admin/market-detail-model.ts';
import type { LifecycleAction, RetirementView } from '../../../../../../market-admin/market-detail-model.ts';
import type { CurrentMarket } from '../../../../../../market-admin/eshops-model.ts';
import { LifecycleBadge, LoadFailure, NAMESPACE, useMarketText } from '../../../../../../market-admin/market-ui.tsx';
import {
  administrationData,
  marketCatalogData,
  marketHistoryData,
  marketRefOf,
  marketSettingsData,
  refreshAll,
  storefrontsData,
} from '../../../../../../market-admin/page-data.ts';
import type { MarketInput } from '../../../../../../market-admin/page-data.ts';
import { RevisionsSection } from '../../../../../../market-admin/revisions-section.tsx';
import { StorefrontsSection } from '../../../../../../market-admin/storefronts-section.tsx';
import { browserRuntime } from '../../../../../../runtime/browser-effect-runtime.ts';
import { UltramodernRouteHead } from '../../../../../ultramodern-route-head';
import '../../../../../index.css';

const commerceMarketCatalogI18nResources = {
  cs: { 'commerce-market-catalog': csResource },
  en: { 'commerce-market-catalog': enResource },
} as const;

export const MarketDetailPageRouteParams = Schema.Struct({
  marketId: Schema.String.pipe(Schema.brand('MarketDetailPageMarketIdRouteParameter')),
});

/** A pending retirement is followed every few seconds until the owner worker completes or fails it. */
const RETIREMENT_POLL = Schedule.spaced('4 seconds');

/** The market of the route for the signed-in company; none outside the Shell or for an id no market can have. */
const marketInputOf = (context: ModulePageProps['context'], marketId: string): Option.Option<MarketInput> =>
  context === undefined
    ? Option.none()
    : marketRefOf({ marketId, tenantId: context.tenantId }).pipe(
        Option.map(() => ({ legalEntityId: context.legalEntityId, marketId, tenantId: context.tenantId })),
      );

/** The Shell prepares the market, its revisions, the e-shops and the price lists before it reveals the page. */
export const preloadPage = modulePagePreload(
  (props) =>
    Option.match(marketInputOf(props.context, props.routeParams['marketId'] ?? ''), {
      onNone: () => Effect.void,
      onSome: (input) =>
        Effect.all([marketHistoryData.preload(input), administrationData.preload(input)], {
          concurrency: 2,
          discard: true,
        }),
    }),
  (props) => marketCatalogData.preload(props.context?.legalEntityId ?? ''),
  (props) => storefrontsData.preload(props.context?.legalEntityId ?? ''),
  (props) => marketSettingsData.preload(props.context?.legalEntityId ?? ''),
);

/** One page-data entry, read synchronously (the Shell preloaded it); the effect loads it on a cold mount. */
const useSnapshot = <I, A, E>(store: Pick<PageData<I, A, E>, 'snapshot' | 'subscribe'>, input: I) =>
  useSyncExternalStore(
    store.subscribe,
    () => store.snapshot(input),
    () => pageDataPending,
  );

const NOT_FOUND = 'detail.notFound';
const isNotFound = Schema.is(MarketHistoryNotFoundProblemSchema);

/** The durable retirement of the market as one status line. */
const RetirementStatus = ({
  lifecycle,
  retirement,
}: {
  readonly lifecycle: MarketLifecycle;
  readonly retirement: RetirementView;
}) => {
  const { text } = useMarketText();
  return Match.value(retirement).pipe(
    Match.discriminatorsExhaustive('kind')({
      completed: () => (
        <StatusText showIcon status="success">
          {text('detail.retire.completed')}
        </StatusText>
      ),
      failed: ({ reason }) =>
        lifecycle === 'RETIRED' ? null : (
          <StatusText showIcon status="warning">
            {text('detail.retire.failed', { reason: text(`detail.retire.reasons.${reason}`) })}
          </StatusText>
        ),
      none: () => null,
      pending: ({ stage }) => (
        <StatusText showIcon status="default">
          {text('detail.retire.pending', { stage: text(`detail.retire.stage.${stage}`) })}
        </StatusText>
      ),
    }),
  );
};

/** The definition in force (or the newest one when none is in force now). */
const DefinitionCard = ({ inForce, market }: { readonly inForce: boolean; readonly market: CurrentMarket }) => {
  const { text } = useMarketText();
  const jurisdictions = market.jurisdictions.map((jurisdiction) => {
    const kind = text(`form.jurisdictionKind${jurisdiction.kind}`);
    return `${jurisdiction.code} (${kind})`;
  });
  return (
    <SectionCard>
      {!inForce && <p className="text-fg-secondary text-sm">{text('detail.notInForce')}</p>}
      <DetailList
        items={[
          { label: text('detail.purpose'), value: market.purpose },
          { label: text('detail.channels'), value: market.channels.join(', ') },
          { label: text('detail.locales'), value: market.supportedLocales.join(', ') },
          { label: text('detail.jurisdictions'), value: jurisdictions.join(', ') },
          { label: text('detail.period'), value: definitionPeriodText(market, text) },
        ]}
      />
    </SectionCard>
  );
};

/** Upravit / Aktivovat / Pozastavit / Vyřadit, only for people who may administer the market. */
const HeaderActions = ({
  actions,
  editable,
  onOpen,
}: {
  readonly actions: readonly LifecycleAction[];
  readonly editable: boolean;
  readonly onOpen: (dialog: LifecycleAction | 'edit') => void;
}) => {
  const { text } = useMarketText();
  const handleEdit = () => onOpen('edit');
  return (
    <>
      {editable && (
        <Button onClick={handleEdit} theme="outlined" variant="secondary">
          {text('detail.edit')}
        </Button>
      )}
      {actions.map((action) => {
        const handleClick = () => onOpen(action);
        return (
          <Button
            key={action}
            onClick={handleClick}
            theme={action === 'retire' ? 'outlined' : 'solid'}
            variant={action === 'retire' ? 'danger' : 'secondary'}
          >
            {text(`detail.${action}`)}
          </Button>
        );
      })}
    </>
  );
};

/** Loading, missing or failed market history: what happened and, after a failure, the way to try again. */
const HistoryUnavailable = ({
  back,
  error,
  onRetry,
}: {
  readonly back: ReactNode;
  readonly error: unknown;
  readonly onRetry: () => void;
}) => {
  const { text } = useMarketText();
  return (
    <div className="flex flex-col gap-300">
      {back}
      {error === undefined && <StatusText>{text('detail.loading')}</StatusText>}
      {error !== undefined &&
        (isNotFound(error) ? (
          <StatusText status="error">{text(NOT_FOUND)}</StatusText>
        ) : (
          <LoadFailure message={text('detail.loadFailed')} onRetry={onRetry} />
        ))}
    </div>
  );
};

const MarketDetailContent = ({ legalEntityId, marketId, tenantId }: MarketInput) => {
  const { language, text } = useMarketText();
  const navigate = useNavigate();
  const toaster = useToast();
  const input: MarketInput = { legalEntityId, marketId, tenantId };
  const history = useSnapshot(marketHistoryData, input);
  const administration = useSnapshot(administrationData, input);
  const catalog = useSnapshot(marketCatalogData, legalEntityId);
  const storefronts = useSnapshot(storefrontsData, legalEntityId);
  const settings = useSnapshot(marketSettingsData, legalEntityId);
  useEffect(() => {
    const market = { legalEntityId, marketId, tenantId };
    marketHistoryData.ensure(market);
    administrationData.ensure(market);
    marketCatalogData.ensure(legalEntityId);
    storefrontsData.ensure(legalEntityId);
    marketSettingsData.ensure(legalEntityId);
  }, [legalEntityId, marketId, tenantId]);
  const [dialog, setDialog] = useState<LifecycleAction | 'edit' | null>(null);
  const state = administration.state === 'ready' ? administration.value.market : undefined;
  const retirement = retirementView(state?.retirement);
  const pending = retirement.kind === 'pending';
  const reloadMarket = () =>
    refreshAll(
      marketHistoryData.refresh(input),
      administrationData.refresh(input),
      marketCatalogData.refresh(legalEntityId),
      marketSettingsData.refresh(legalEntityId),
    );
  // Follow a durable retirement (also one found again after a reload) until it completes or fails.
  useEffect(() => {
    const market = { legalEntityId, marketId, tenantId };
    const fiber = browserRuntime.runFork(
      pending ? Effect.repeat(administrationData.refresh(market), RETIREMENT_POLL) : Effect.void,
    );
    return () => {
      browserRuntime.runFork(Fiber.interrupt(fiber));
      if (pending) {
        // The retirement settled: the lifecycle and the revisions changed.
        refreshAll(marketHistoryData.refresh(market), marketCatalogData.refresh(legalEntityId));
      }
    };
  }, [pending, legalEntityId, marketId, tenantId]);
  const handleBack = () => {
    void navigate({ to: `/${language}/prodej/eshopy` });
  };
  const done = (message: string) => {
    setDialog(null);
    toaster.create({ title: message, type: 'success' });
    reloadMarket();
  };
  const closeDialog = () => setDialog(null);
  const backButton = (
    <Button onClick={handleBack} size="sm" theme="outlined" variant="secondary">
      {text('detail.back')}
    </Button>
  );
  if (history.state !== 'ready') {
    return (
      <HistoryUnavailable
        back={backButton}
        error={history.state === 'failed' ? history.error : undefined}
        onRetry={reloadMarket}
      />
    );
  }
  const catalogMarket =
    catalog.state === 'ready'
      ? catalog.value.markets.find((candidate) => candidate.marketRef.resourceId === marketId)
      : undefined;
  const market = currentDefinition(catalogMarket, history.value);
  if (market === undefined) {
    return (
      <div className="flex flex-col gap-300">
        {backButton}
        <StatusText status="error">{text(NOT_FOUND)}</StatusText>
      </div>
    );
  }
  const canAdminister = state?.canAdminister === true && !pending;
  const associations = catalog.state === 'ready' ? marketAssociations(catalog.value.associations, marketId) : [];
  const handleRequested = (outcome: MarketRetirementOutcome) => {
    setDialog(null);
    toaster.create({ title: text('detail.retire.requested', { code: market.marketCode }), type: 'info' });
    administrationData.update(input, (current) =>
      current.market === undefined ? current : { ...current, market: { ...current.market, retirement: outcome } },
    );
    reloadMarket();
  };
  return (
    <div className="flex flex-col gap-300">
      <PageHeader
        actions={
          <HeaderActions
            actions={canAdminister ? lifecycleActions(market.lifecycle, pending) : []}
            editable={canAdminister && market.lifecycle !== 'RETIRED'}
            onOpen={setDialog}
          />
        }
        breadcrumbs={<div>{backButton}</div>}
        description={market.purpose}
        meta={<LifecycleBadge lifecycle={market.lifecycle} />}
        title={market.marketCode}
      />
      <RetirementStatus lifecycle={market.lifecycle} retirement={retirement} />
      <DefinitionCard inForce={catalogMarket !== undefined} market={market} />
      <StorefrontsSection
        associations={associations}
        canAdminister={canAdminister}
        market={market}
        onDone={done}
        storefronts={storefronts.state === 'ready' ? storefronts.value.applications : []}
      />
      <AssortmentSection
        input={input}
        market={market}
        onDone={done}
        records={settings.state === 'ready' ? settings.value : undefined}
        recordsFailed={settings.state === 'failed'}
        refreshSettings={marketSettingsData.refresh(legalEntityId)}
      />
      <RevisionsSection currentRevision={market.revision} rows={revisionRows(history.value)} />
      {dialog === 'edit' && <EditMarketDialog market={market} onClose={closeDialog} onDone={done} />}
      {(dialog === 'activate' || dialog === 'suspend') && state !== undefined && (
        <LifecycleDialog action={dialog} market={market} onClose={closeDialog} onDone={done} state={state} />
      )}
      {dialog === 'retire' && state !== undefined && (
        <RetireDialog market={market} onClose={closeDialog} onDone={done} onRequested={handleRequested} state={state} />
      )}
      <Toaster />
    </div>
  );
};

interface MarketDetailPageProps {
  readonly context?: ModulePageProps['context'];
  readonly routeParams: { readonly marketId: string };
}

const MarketDetailBody = ({ context, routeParams }: MarketDetailPageProps) => {
  const { text } = useMarketText();
  return Option.match(marketInputOf(context, routeParams.marketId), {
    onNone: () => <StatusText status="error">{text(NOT_FOUND)}</StatusText>,
    onSome: (value) => (
      <MarketDetailContent
        key={`${value.legalEntityId}|${value.marketId}`}
        legalEntityId={value.legalEntityId}
        marketId={value.marketId}
        tenantId={value.tenantId}
      />
    ),
  });
};

export const MarketDetailPage = ({ context, routeParams }: MarketDetailPageProps) => (
  <FederatedI18nBoundary
    defaultNamespace={NAMESPACE}
    fallbackLanguage="en"
    resources={commerceMarketCatalogI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <UltramodernRouteHead />
    <MarketDetailBody context={context} routeParams={routeParams} />
  </FederatedI18nBoundary>
);

const MarketDetailRoute = ({ context, routeParams }: Partial<MarketDetailPageProps>) => {
  const params: unknown = useParams({ from: '/$lang/prodej/eshopy/trhy/$marketId', shouldThrow: false });
  const fromRoute = Schema.decodeUnknownOption(MarketDetailPageRouteParams)(params);
  const marketId =
    routeParams?.marketId ??
    fromRoute.pipe(
      Option.map((value) => value.marketId),
      Option.getOrElse(() => ''),
    );
  return <MarketDetailPage context={context} routeParams={{ marketId }} />;
};

export default MarketDetailRoute;
