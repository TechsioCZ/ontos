import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { useNavigate } from '@modern-js/plugin-tanstack/runtime';
import { EmptyState, PageHeader, SectionCard, Toaster } from '@app/admin-ui';
import { modulePagePreload, pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageProps, PageData } from '@app/shared-contracts/page-data';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { useEffect, useState, useSyncExternalStore } from 'react';
import csResource from '../../../../../locales/cs/commerce-market-catalog.json';
import enResource from '../../../../../locales/en/commerce-market-catalog.json';
import { eshopsOverview } from '../../../../market-admin/eshops-model.ts';
import type { EshopCard, MarketChip } from '../../../../market-admin/eshops-model.ts';
import { LoadFailure, MarketChipButton, NAMESPACE, useMarketText } from '../../../../market-admin/market-ui.tsx';
import { NewMarketDialog } from '../../../../market-admin/new-market-dialog.tsx';
import {
  creationGrantData,
  marketCatalogData,
  marketSettingsData,
  refreshAll,
  storefrontsData,
} from '../../../../market-admin/page-data.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import '../../../index.css';

const commerceMarketCatalogI18nResources = {
  cs: { 'commerce-market-catalog': csResource },
  en: { 'commerce-market-catalog': enResource },
} as const;

/** The page's signed-in company, absent outside the Shell. */
interface PageContextProps {
  readonly context: ModulePageProps['context'];
}

const legalEntityOf = (context: ModulePageProps['context']) => context?.legalEntityId ?? '';

/** The Shell prepares the market catalog, the e-shop list and the price lists before it reveals the page. */
export const preloadPage = modulePagePreload(
  (props) => marketCatalogData.preload(legalEntityOf(props.context)),
  (props) => storefrontsData.preload(legalEntityOf(props.context)),
  (props) => marketSettingsData.preload(legalEntityOf(props.context)),
  (props) => creationGrantData.preload(legalEntityOf(props.context)),
);

/** One company-wide dataset: read synchronously, loaded on a cold mount. */
const useCompanyData = <A, E>(
  store: Pick<PageData<string, A, E>, 'ensure' | 'snapshot' | 'subscribe'>,
  legalEntityId: string,
) => {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    () => store.snapshot(legalEntityId),
    () => pageDataPending,
  );
  useEffect(() => store.ensure(legalEntityId), [store, legalEntityId]);
  return snapshot;
};

const EshopCardView = ({
  card,
  onOpenMarket,
}: {
  readonly card: EshopCard;
  readonly onOpenMarket: (chip: MarketChip) => void;
}) => {
  const { text } = useMarketText();
  return (
    <SectionCard
      actions={
        card.url === undefined ? undefined : (
          <Link external href={card.url}>
            {text('eshops.open')}
          </Link>
        )
      }
      title={
        <span className="flex flex-wrap items-center gap-100">
          {card.name}
          <Badge size="sm" variant={card.lifecycle === 'ACTIVE' ? 'success' : 'outline'}>
            {text(`eshops.storefrontLifecycle.${card.lifecycle}`)}
          </Badge>
        </span>
      }
    >
      <p className="text-fg-secondary text-sm">{text('eshops.channels', { channels: card.channels.join(', ') })}</p>
      {card.markets.length === 0 ? (
        <p className="text-fg-secondary text-sm">{text('eshops.noMarkets')}</p>
      ) : (
        <div className="flex flex-wrap gap-100">
          {card.markets.map((chip) => (
            <MarketChipButton
              chip={chip}
              key={`${chip.marketId}|${chip.channel ?? ''}`}
              onOpen={() => onOpenMarket(chip)}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
};

const EshopsPageContent = ({ context }: PageContextProps) => {
  const { language, text } = useMarketText();
  const navigate = useNavigate();
  const toaster = useToast();
  const legalEntityId = legalEntityOf(context);
  const catalog = useCompanyData(marketCatalogData, legalEntityId);
  const storefronts = useCompanyData(storefrontsData, legalEntityId);
  const settings = useCompanyData(marketSettingsData, legalEntityId);
  const grant = useCompanyData(creationGrantData, legalEntityId);
  const [creating, setCreating] = useState(false);
  const openMarket = (marketId: string) => {
    void navigate({ to: `/${language}/prodej/eshopy/trhy/${encodeURIComponent(marketId)}` });
  };
  const reload = () =>
    refreshAll(
      marketCatalogData.refresh(legalEntityId),
      storefrontsData.refresh(legalEntityId),
      marketSettingsData.refresh(legalEntityId),
    );
  const canCreate = grant.state === 'ready' && grant.value.canCreateMarket && context !== undefined;
  const settingsValue = settings.state === 'ready' ? settings.value : undefined;
  const header = (
    <PageHeader
      actions={
        canCreate ? (
          <Button onClick={() => setCreating(true)} variant="primary">
            {text('eshops.newMarket')}
          </Button>
        ) : undefined
      }
      description={text('pages.eshops.description')}
      title={text('pages.eshops.title')}
    />
  );
  if (catalog.state !== 'ready') {
    return (
      <div className="flex flex-col gap-300">
        {header}
        {catalog.state === 'pending' ? (
          <StatusText>{text('eshops.loading')}</StatusText>
        ) : (
          <LoadFailure message={text('eshops.loadFailed')} onRetry={reload} />
        )}
      </div>
    );
  }
  const overview = eshopsOverview({
    associations: catalog.value.associations,
    markets: catalog.value.markets,
    settings: settingsValue?.markets ?? [],
    storefronts: storefronts.state === 'ready' ? storefronts.value.applications : [],
    unnamed: (position) => text('eshops.unnamed', { position }),
  });
  return (
    <div className="flex flex-col gap-300">
      {header}
      {storefronts.state === 'failed' && (
        <StatusText status="warning">{text('eshops.storefrontsUnavailable')}</StatusText>
      )}
      {storefronts.state === 'ready' && overview.eshops.length === 0 && <EmptyState title={text('eshops.noEshops')} />}
      {overview.eshops.map((card) => (
        <EshopCardView card={card} key={card.appId} onOpenMarket={(chip) => openMarket(chip.marketId)} />
      ))}
      <SectionCard title={text('eshops.unassigned.title')}>
        {overview.unassigned.length === 0 ? (
          <p className="text-fg-secondary text-sm">{text('eshops.unassigned.empty')}</p>
        ) : (
          <div className="flex flex-wrap gap-100">
            {overview.unassigned.map((chip) => (
              <MarketChipButton chip={chip} key={chip.marketId} onOpen={() => openMarket(chip.marketId)} />
            ))}
          </div>
        )}
      </SectionCard>
      {canCreate && creating && (
        <NewMarketDialog
          canConfigurePricing={settingsValue?.canManageMarkets === true}
          legalEntityId={legalEntityId}
          merchandiseRevision={settingsValue?.revision ?? 0}
          onClose={() => setCreating(false)}
          onCreated={({ code, marketId, priced }) => {
            setCreating(false);
            toaster.create({
              title: text(priced ? 'create.created' : 'create.createdWithoutPricing', { code }),
              type: priced ? 'success' : 'warning',
            });
            reload();
            openMarket(marketId);
          }}
          tenantId={context.tenantId}
        />
      )}
      <Toaster />
    </div>
  );
};

export const EshopsPage = ({ context }: Partial<Pick<ModulePageProps, 'context'>>) => (
  <FederatedI18nBoundary
    defaultNamespace={NAMESPACE}
    fallbackLanguage="en"
    resources={commerceMarketCatalogI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <UltramodernRouteHead />
    <EshopsPageContent context={context} />
  </FederatedI18nBoundary>
);

export default EshopsPage;
