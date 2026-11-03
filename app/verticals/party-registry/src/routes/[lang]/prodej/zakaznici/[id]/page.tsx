import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useNavigate, useParams } from '@modern-js/plugin-tanstack/runtime';
import { PageHeader, SectionCard, Toaster } from '@app/admin-ui';
import { pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Option, Result, Schema } from 'effect';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { CustomerListItem } from '../../../../../api/customers-client.ts';
import { partyRegistryI18nResources } from '../../../../../i18n/resources.ts';
import { browserRuntime } from '../../../../../runtime/browser-effect-runtime.ts';
import type { CounterpartyRef } from '../../../../../../shared/resources/counterparty.ts';
import { UltramodernRouteHead } from '../../../../ultramodern-route-head';
import '../../../../index.css';
import { CUSTOMER_DETAIL_KEY, CustomerDetailContent } from '../customer-detail-content.tsx';
import type { CustomerDetailSubject } from '../customer-detail-content.tsx';
import {
  customerDetailPageData,
  customerDetailPageInput,
  customerDetailPageInputKey,
  customerDetailPageStatus,
} from '../customer-detail-page-data.ts';
import type {
  CustomerDetailPageInput,
  CustomerDetailPageRecord,
  CustomerDetailPageStatus,
} from '../customer-detail-page-data.ts';
import { useCustomerDetail } from '../customers-data.ts';

const KEY = 'party-registry.pages.customerDetail';

export const CustomerDetailPageRouteParams = Schema.Struct({
  id: Schema.String.pipe(Schema.brand('CustomerDetailPageIdRouteParameter')),
});
export type CustomerDetailPageRouteParameters = typeof CustomerDetailPageRouteParams.Type;
export const CustomerDetailPageRouteParamsStandardSchema = Schema.toStandardSchemaV1(CustomerDetailPageRouteParams);

const emptyRouteParams = Result.getOrThrow(Schema.decodeResult(CustomerDetailPageRouteParams)({ id: '' }));

export interface CustomerDetailPageProps {
  readonly context?: ModulePageContext | undefined;
  readonly routeParams: CustomerDetailPageRouteParameters;
}

export const PageNoticeStatusSchema = Schema.Literals(['forbidden', 'loading', 'not-found', 'unavailable']);
export type PageNoticeStatus = typeof PageNoticeStatusSchema.Type;

const pageTitle = (customerName: string | null | undefined, fallback: string): string =>
  customerName === undefined || customerName === null || customerName.length === 0 ? fallback : customerName;

export interface CustomerDetailPageNoticeProps {
  readonly customerName?: string | undefined;
  readonly onBack: () => void;
  readonly onRetry?: (() => void) | undefined;
  readonly status: PageNoticeStatus;
}

/** The honest state before a customer record is available, and for a refused or missing link. */
export const CustomerDetailPageNotice = ({ customerName, onBack, onRetry, status }: CustomerDetailPageNoticeProps) => {
  const { t } = useModernI18n();
  const messageKey = status === 'not-found' ? `${CUSTOMER_DETAIL_KEY}.notFound` : `${CUSTOMER_DETAIL_KEY}.${status}`;
  return (
    <>
      <PageHeader
        actions={
          <Button onClick={onBack} theme="outlined" variant="secondary">
            {t(`${CUSTOMER_DETAIL_KEY}.backToList`)}
          </Button>
        }
        title={pageTitle(customerName, t(`${KEY}.title`))}
      />
      <SectionCard>
        <StatusText status={status === 'loading' || status === 'forbidden' ? 'default' : 'error'}>
          {t(messageKey)}
        </StatusText>
        {status === 'unavailable' && onRetry !== undefined && (
          <Button onClick={onRetry} variant="secondary">
            {t(`${CUSTOMER_DETAIL_KEY}.reload`)}
          </Button>
        )}
      </SectionCard>
    </>
  );
};

/** Header and related links read only validated owner fields, never a list row or a synthesized revision. */
export const customerDetailPageSubject = (record: CustomerDetailPageRecord): CustomerDetailSubject => {
  const { counterparty } = record;
  const { identity } = record;
  const party = identity.status === 'ready' ? identity.value.party : undefined;
  const partyRef =
    identity.status === 'ready' ? identity.value.resolution.canonicalPartyRef : counterparty.party.canonicalPartyRef;
  const archived = party === undefined ? counterparty.party.archived : Option.isSome(party.archivedAt);
  const { counterpartyRef } = counterparty;
  return {
    counterpartyId: counterpartyRef.resourceId,
    counterpartyRef,
    createdAt: counterparty.createdAt,
    displayName: party === undefined ? counterparty.party.displayName : Option.getOrElse(party.displayName, () => null),
    partyId: partyRef.resourceId,
    status: archived ? 'ARCHIVED' : 'ACTIVE',
  };
};

/**
 * The shared editing model reads exactly `counterpartyRef` from its first argument: the initial read, the post-save
 * reload and `refresh` all go through that ref. The page passes the validated ref alone and never invents list
 * facets, a Party revision or an identity from the route.
 */
const editingCustomer = (counterpartyRef: CounterpartyRef): Pick<CustomerListItem, 'counterpartyRef'> => ({
  counterpartyRef,
});

export interface CustomerDetailPageRecordProps {
  readonly onChanged: () => void;
  readonly onRetry: () => void;
  readonly record: CustomerDetailPageRecord;
  readonly stale: boolean;
}

/** The complete record on a page. It reuses the side panel's body and its editing model. */
export const CustomerDetailPageRecordView = ({ onChanged, onRetry, record, stale }: CustomerDetailPageRecordProps) => {
  const { language, t } = useModernI18n();
  const navigate = useNavigate();
  const toaster = useToast();
  const subject = customerDetailPageSubject(record);
  const detailCustomer = editingCustomer(record.counterparty.counterpartyRef);
  const model = useCustomerDetail(
    detailCustomer,
    record,
    (open) => {
      if (!open) {
        void navigate({ to: `/${language ?? 'cs'}/prodej/zakaznici` });
      }
    },
    onChanged,
    () => {
      toaster.create({ title: t(`${CUSTOMER_DETAIL_KEY}.toastRenamed`), type: 'success' });
    },
    t,
    (href) => {
      void navigate({ to: href });
    },
  );
  /** A page reload refreshes both the editing model and the exact shared record. */
  const refresh = () => {
    model.refresh();
    onRetry();
  };
  const detail = { ...model, refresh, stale: stale || model.stale };
  const backHref = `/${language ?? 'cs'}/prodej/zakaznici`;
  return (
    <>
      <PageHeader
        actions={
          <Button onClick={() => detail.requestNavigation(backHref)} theme="outlined" variant="secondary">
            {t(`${CUSTOMER_DETAIL_KEY}.backToList`)}
          </Button>
        }
        description={t(`${KEY}.description`)}
        title={pageTitle(subject.displayName, t(`${CUSTOMER_DETAIL_KEY}.title`))}
      />
      <SectionCard>
        <CustomerDetailContent detail={detail} initialSnapshot={record} onRetry={refresh} subject={subject} />
      </SectionCard>
    </>
  );
};

interface HeldRecord {
  readonly key: string;
  readonly record: CustomerDetailPageRecord;
}

/** The Shell context, or nothing when any authorized scope field is missing. */
const pageContext = (
  displayName: string | undefined,
  legalEntityId: string | undefined,
  principalId: string | undefined,
  tenantId: string | undefined,
): ModulePageContext | undefined => {
  if (tenantId === undefined || legalEntityId === undefined || principalId === undefined) {
    return undefined;
  }
  return displayName === undefined
    ? { legalEntityId, principalId, tenantId }
    : { displayName, legalEntityId, principalId, tenantId };
};

/**
 * The last record of this exact scope. It survives only a transient unavailable read, and is dropped before paint
 * when the scope or Counterparty changes or an authorization refusal arrives.
 */
const useHeldRecord = (
  pageKey: string | undefined,
  status: CustomerDetailPageStatus,
  readyRecord: CustomerDetailPageRecord | undefined,
): CustomerDetailPageRecord | undefined => {
  const [held, setHeld] = useState<HeldRecord>();
  const [heldFor, setHeldFor] = useState<string | undefined>(pageKey);
  if (heldFor !== pageKey) {
    setHeldFor(pageKey);
    setHeld(undefined);
  }
  if ((status === 'forbidden' || status === 'not-found') && held !== undefined) {
    setHeld(undefined);
  }
  if (readyRecord !== undefined && (held === undefined || held.key !== pageKey || held.record !== readyRecord)) {
    setHeld({ key: pageKey ?? '', record: readyRecord });
  }
  return held !== undefined && held.key === pageKey ? held.record : undefined;
};

const CustomerDetailPageContent = ({ context, routeParams }: CustomerDetailPageProps) => {
  const { language } = useModernI18n();
  const navigate = useNavigate();
  const parsed = customerDetailPageInput(context, routeParams);
  const parsedInput = Option.getOrUndefined(parsed);
  const counterpartyId = parsedInput === undefined ? '' : parsedInput.counterpartyId;
  const { displayName, legalEntityId, principalId, tenantId } = context ?? {};
  const scopedContext = pageContext(displayName, legalEntityId, principalId, tenantId);
  const scopedInput: CustomerDetailPageInput | undefined =
    scopedContext === undefined || counterpartyId === '' ? undefined : { context: scopedContext, counterpartyId };
  const pageKey =
    scopedInput === undefined ? undefined : Option.getOrUndefined(customerDetailPageInputKey(scopedInput));
  const snapshot = useSyncExternalStore(
    (listener) =>
      scopedInput === undefined
        ? () => {
            // No authenticated scope, so there is no shared record to observe.
          }
        : customerDetailPageData.subscribe(listener, scopedInput),
    () => (scopedInput === undefined ? pageDataPending : customerDetailPageData.snapshot(scopedInput)),
    () => pageDataPending,
  );
  const status: CustomerDetailPageStatus = customerDetailPageStatus(parsed, snapshot);
  const readyRecord = snapshot.state === 'ready' && pageKey !== undefined ? snapshot.value : undefined;
  const usableHeld = useHeldRecord(pageKey, status, readyRecord);

  useEffect(() => {
    const ensuredContext = pageContext(displayName, legalEntityId, principalId, tenantId);
    if (ensuredContext === undefined || counterpartyId === '') {
      return;
    }
    customerDetailPageData.ensure({
      context: ensuredContext,
      counterpartyId,
    });
  }, [counterpartyId, displayName, legalEntityId, principalId, tenantId]);

  const live = snapshot.state === 'ready' ? snapshot.value : undefined;
  const reload = () => {
    if (scopedInput !== undefined) {
      void browserRuntime.runFork(customerDetailPageData.refresh(scopedInput));
    }
  };
  const back = () => {
    void navigate({ to: `/${language ?? 'cs'}/prodej/zakaznici` });
  };
  const pageBody = () => {
    if (status === 'ready' && live !== undefined) {
      return (
        <CustomerDetailPageRecordView key={pageKey} onChanged={reload} onRetry={reload} record={live} stale={false} />
      );
    }
    if ((status === 'unavailable' || status === 'loading') && usableHeld !== undefined) {
      return (
        <CustomerDetailPageRecordView key={pageKey} onChanged={reload} onRetry={reload} record={usableHeld} stale />
      );
    }
    return (
      <CustomerDetailPageNotice
        onBack={back}
        onRetry={status === 'unavailable' ? reload : undefined}
        status={status === 'ready' ? 'loading' : status}
      />
    );
  };

  return (
    <>
      <UltramodernRouteHead titleKey={`${KEY}.title`} />
      <Toaster />
      <section className="partyregistry:mx-auto partyregistry:flex partyregistry:w-full partyregistry:max-w-4xl partyregistry:flex-col partyregistry:gap-5 partyregistry:px-4 partyregistry:py-8 partyregistry:sm:px-8">
        {pageBody()}
      </section>
    </>
  );
};

export const CustomerDetailPage = ({ context, routeParams }: CustomerDetailPageProps) => (
  <FederatedI18nBoundary
    defaultNamespace="party-registry"
    fallbackLanguage="en"
    resources={partyRegistryI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <CustomerDetailPageContent context={context} routeParams={routeParams} />
  </FederatedI18nBoundary>
);

/** The Shell prepares the exact record before it reveals the page. */
export { preloadCustomerDetailPage as preloadPage } from '../customer-detail-page-data.ts';

const CustomerDetailRoute = ({ context, routeParams: suppliedParams }: Partial<CustomerDetailPageProps>) => {
  const params: unknown = useParams({ from: '/$lang/prodej/zakaznici/$id', shouldThrow: false });
  const routeParams = Schema.decodeUnknownOption(CustomerDetailPageRouteParams)(params);
  return (
    <CustomerDetailPage
      context={context}
      routeParams={suppliedParams ?? Option.getOrElse(routeParams, () => emptyRouteParams)}
    />
  );
};
export default CustomerDetailRoute;
