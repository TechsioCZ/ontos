import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { useNavigate } from '@modern-js/plugin-tanstack/runtime';
import { EmptyState, PageHeader, SectionCard, Toaster, useRecordDraft } from '@app/admin-ui';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { mainSourceProductsOnlyFor } from '@app/merchandise/domain/merchandise-model';
import type { StorefrontCatalogSettings } from '@app/merchandise/domain/merchandise-model';
import { modulePagePreload, pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageProps, PageData } from '@app/shared-contracts/page-data';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import {
  CheckboxSettingField,
  FormBuilder,
  FormReact,
  FormRoot,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { Effect, Option, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import csResource from '../../../../../locales/cs/commerce-market-catalog.json';
import enResource from '../../../../../locales/en/commerce-market-catalog.json';
import { eshopsOverview } from '../../../../market-admin/eshops-model.ts';
import type { EshopCard, MarketChip } from '../../../../market-admin/eshops-model.ts';
import {
  failureText,
  LoadFailure,
  MarketChipButton,
  NAMESPACE,
  useMarketText,
} from '../../../../market-admin/market-ui.tsx';
import { NewMarketDialog } from '../../../../market-admin/new-market-dialog.tsx';
import {
  creationGrantData,
  marketCatalogData,
  marketSettingsData,
  refreshAll,
  saveStorefrontCatalog,
  storefrontsData,
} from '../../../../market-admin/page-data.ts';
import type { WriteFailure } from '../../../../market-admin/page-data.ts';
import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
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

/** What the person is told once a market exists, by what happened to its price list. */
const createdMessage = {
  awaitingApproval: 'create.createdPricingAwaitingApproval',
  notSaved: 'create.createdWithoutPricing',
  saved: 'create.created',
} as const;
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

/**
 * The listing preference of one e-shop; every e-shop card has its own. Ticking changes only this form: the card's
 * Save sends it, so the form itself is never submitted.
 */
const listingFormOf = Atom.family((_appId: string) => {
  const form = FormReact.make(FormBuilder.empty.addField('mainSourceProductsOnly', Schema.Boolean), {
    fields: { mainSourceProductsOnly: CheckboxSettingField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  });
  return { form, preference: form.getFieldAtoms(form.fields.mainSourceProductsOnly) };
});

/**
 * Keeps the checkbox and the card's draft one value: a tick changes the draft, and a draft that moves without a tick
 * (a refresh, the latest version) moves the checkbox. Rendered inside the form, after it started.
 */
const ListingDraft = ({
  appId,
  draft,
  onTick,
}: {
  readonly appId: string;
  readonly draft: boolean;
  readonly onTick: (value: boolean) => void;
}) => {
  const { preference } = listingFormOf(appId);
  const ticked = useAtomValue(preference.value);
  const setTicked = useAtomSet(preference.setValue);
  useAtomSubscribe(
    preference.value,
    (next) => {
      if (Option.isSome(next)) {
        onTick(next.value);
      }
    },
    { immediate: false },
  );
  const shownDraft = useRef(draft);
  useEffect(() => {
    if (shownDraft.current === draft) {
      return;
    }
    shownDraft.current = draft;
    if (Option.exists(ticked, (value) => value !== draft)) {
      setTicked(draft);
    }
  }, [draft, setTicked, ticked]);
  return null;
};

/** Whether the e-shop lists only main source products; it needs the merchandise settings read, which may be refused. */
export const StorefrontListingSetting = ({
  appId,
  refresh,
  settings,
}: {
  readonly appId: string;
  readonly refresh: Effect.Effect<void>;
  readonly settings: {
    readonly canManageCatalog?: boolean;
    readonly revision: number;
    readonly storefrontCatalogSettings?: StorefrontCatalogSettings;
  };
}) => {
  const { text } = useMarketText();
  const toaster = useToast();
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const record = useRecordDraft<boolean, never>({
    isValid: () => settings.canManageCatalog === true,
    refresh,
    revision: settings.revision,
    runtime: browserRuntime,
    save: (value, revision) => {
      setFailure(null);
      return saveStorefrontCatalog(appId, value, revision).pipe(
        Effect.map((outcome) => {
          if (!outcome.ok) {
            setFailure(outcome.reason);
            return outcome.reason === 'conflict' ? ('conflict' as const) : ('failed' as const);
          }
          if (Schema.is(ActionProposalAcceptedSchema)(outcome.value)) {
            toaster.create({ title: text('eshops.listing.proposed'), type: 'warning' });
            return 'proposed' as const;
          }
          toaster.create({ title: text('eshops.listing.saved'), type: 'success' });
          refreshAll(refresh);
          return outcome.value.revision;
        }),
      );
    },
    server: mainSourceProductsOnlyFor(settings.storefrontCatalogSettings ?? {}, appId),
  });
  const saving = record.status === 'saving';
  const { form: listingForm } = listingFormOf(appId);
  const handleTick = record.setDraft;
  const handleSave = record.save;
  const handleReload = () => {
    setFailure(null);
    record.reloadLatest();
  };
  return (
    <div className="flex flex-col items-start gap-150 border-border-primary border-t pt-200">
      <FormRoot
        defaultValues={{ mainSourceProductsOnly: record.draft }}
        form={listingForm}
        translateMessage={(message) => text(message)}
      >
        <ListingDraft appId={appId} draft={record.draft} onTick={handleTick} />
        <listingForm.mainSourceProductsOnly
          disabled={saving}
          helpText={text('eshops.listing.help')}
          label={text('eshops.listing.label')}
          name={`main-source-products-${appId}`}
          readOnly={settings.canManageCatalog !== true}
        />
      </FormRoot>
      {settings.canManageCatalog === true && (
        <Button disabled={!record.canSave} onClick={handleSave} severity="primary" size="sm">
          {text(saving ? 'eshops.listing.saving' : 'eshops.listing.save')}
        </Button>
      )}
      {failure !== null && <StatusText status="error">{failureText(text, failure)}</StatusText>}
      {record.status === 'conflict' && (
        <Button appearance="outline" onClick={handleReload} severity="secondary" size="sm">
          {text('eshops.listing.reload')}
        </Button>
      )}
    </div>
  );
};

const EshopCardView = ({
  card,
  children,
  onOpenMarket,
}: {
  readonly card: EshopCard;
  readonly children?: ReactNode;
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
          <Badge severity={card.lifecycle === 'ACTIVE' ? 'success' : 'neutral'} size="sm">
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
      {children}
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
          <Button onClick={() => setCreating(true)} severity="primary">
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
    legalEntityId,
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
        <EshopCardView
          card={card}
          key={`${legalEntityId}:${card.appId}`}
          onOpenMarket={(chip) => openMarket(chip.marketId)}
        >
          {settingsValue !== undefined && (
            <StorefrontListingSetting
              appId={card.appId}
              refresh={marketSettingsData.refresh(legalEntityId)}
              settings={settingsValue}
            />
          )}
        </EshopCardView>
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
          onCreated={({ code, marketId, pricing }) => {
            setCreating(false);
            toaster.create({
              title: text(createdMessage[pricing], { code }),
              type: pricing === 'saved' ? 'success' : 'warning',
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
