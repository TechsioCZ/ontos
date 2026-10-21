import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Option } from 'effect';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DetailList, SidePanel, formatDate } from '@app/admin-ui';
import type { CustomerListItem } from '../../../../api/customers-client.ts';
import { DiscardDialog } from './customer-discard-dialog.tsx';
import { useCustomerDetail } from './customers-data.ts';
import type { CustomerDetailSnapshot } from './customers-data.ts';
import {
  customerContactFields,
  customerContactInput,
  customerIdentitySummary,
  emptyCustomerContactFields,
  customerContactEditable,
  customerContactFieldLabel,
  customerContactRequiresAuthoritativeEdit,
  relatedCustomerUrl,
} from './customers-model.ts';

const KEY = 'party-registry.pages.customers.detail';
const STATUS_KEY = 'party-registry.pages.customers.status';
const addressFields = ['addressLine1', 'addressLine2', 'city', 'postalCode', 'region', 'countryCode'] as const;

export interface CustomerDetailDialogProps {
  readonly customer: CustomerListItem | null;
  readonly failure?: 'forbidden' | 'unavailable' | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRenamed: () => void;
  readonly onRetry: () => void;
  readonly snapshot?: CustomerDetailSnapshot | undefined;
}

type CustomerDetailViewProps = Omit<CustomerDetailDialogProps, 'customer'> & { readonly customer: CustomerListItem };

const CustomerDetailView = ({
  customer,
  failure,
  onOpenChange,
  onRenamed,
  onRetry,
  snapshot: initialSnapshot,
}: CustomerDetailViewProps) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const location = useRouterState({ select: (state) => state.location.pathname });
  const language = location.split('/')[1] === 'en' ? 'en' : 'cs';
  const {
    busy,
    changeDraft,
    confirmDiscard,
    contactRows,
    dirty,
    discardOpen,
    draft,
    evidence,
    history,
    identifierRows,
    identity,
    notice,
    party,
    reason,
    refresh,
    requestClose,
    requestNavigation,
    save,
    setDiscardOpen,
    setEvidence,
    setReason,
    snapshot,
    stale,
    value,
  } = useCustomerDetail(
    customer,
    initialSnapshot,
    onOpenChange,
    onRenamed,
    () => {
      toaster.create({ title: t(`${KEY}.toastRenamed`), type: 'success' });
    },
    t,
  );

  const { name, status } = customerIdentitySummary(customer, party);

  return (
    <>
      <SidePanel
        actions={
          <Button disabled={busy} onClick={() => requestClose(false)} theme="outlined" variant="secondary">
            {t(`${KEY}.cancel`)}
          </Button>
        }
        closeOnInteractOutside={false}
        onOpenChange={requestClose}
        open
        resizeLabel={t('party-registry.sidePanel.resize')}
        size="xl"
        title={name || t(`${KEY}.title`)}
      >
        <div className="flex flex-col gap-250 py-200">
          {notice !== null && (
            <StatusText showIcon status="error">
              {notice}
            </StatusText>
          )}
          {initialSnapshot === undefined && (
            <StatusText status={failure === undefined ? 'default' : 'error'}>
              {t(`${KEY}.${failure ?? 'loading'}`)}
            </StatusText>
          )}
          {failure !== undefined && (
            <Button onClick={onRetry} variant="secondary">
              {t(`${KEY}.reload`)}
            </Button>
          )}
          <DetailList
            items={[
              { label: t(`${KEY}.createdAt`), value: formatDate(customer.createdAt) },
              { label: t(`${KEY}.partyId`), value: customer.partyId },
              { label: t(`${KEY}.counterpartyId`), value: customer.counterpartyId },
              {
                label: t(`${KEY}.status`),
                value: t(`${STATUS_KEY}.${status}`),
              },
            ]}
          />
          {snapshot !== undefined && (
            <>
              <p className="text-fg-secondary text-sm">{t(`${KEY}.separateSaves`)}</p>
              <FormInput
                id="customer-evidence"
                label={t(`${KEY}.evidence`)}
                maxLength={200}
                onChange={(event) => setEvidence(event.target.value)}
                required
                value={evidence}
              />
              <FormInput
                id="customer-reason"
                label={t(`${KEY}.reason`)}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
                required
                value={reason}
              />
              {stale && (
                <Button disabled={busy} onClick={refresh} variant="secondary">
                  {t(`${KEY}.reload`)}
                </Button>
              )}
              {party === undefined ? (
                <StatusText status="error">{t(`${KEY}.${identity?.status ?? 'unavailable'}`)}</StatusText>
              ) : (
                <>
                  <FormInput
                    id="customer-rename"
                    label={t(`${KEY}.rename`)}
                    onChange={(event) => changeDraft('name', event.target.value, name)}
                    required
                    value={value('name', name)}
                  />
                  <Button
                    disabled={busy || stale || draft['name'] === undefined}
                    onClick={() => save({ kind: 'name', party, value: value('name', name) }, ['name'])}
                    variant="primary"
                  >
                    {t(`${KEY}.saveName`)}
                  </Button>
                  <p className="text-fg-secondary text-sm">{t(`${KEY}.sharedIdentity`)}</p>
                  <Button
                    disabled={busy || stale || dirty}
                    onClick={() => save({ kind: 'lifecycle', party }, [])}
                    theme="outlined"
                    variant="secondary"
                  >
                    {t(`${KEY}.${Option.isSome(party.archivedAt) ? 'restore' : 'archive'}`)}
                  </Button>
                </>
              )}
              <h3 className="font-semibold">{t(`${KEY}.identifiers`)}</h3>
              {snapshot.identifiers.status === 'ready' ? (
                identifierRows.map(({ existing, id, type }) => {
                  const key = `identifier-${id}`;
                  const original = existing?.normalizedValue ?? '';
                  return (
                    <div className="flex flex-col gap-150" key={key}>
                      <FormInput
                        disabled={party === undefined}
                        id={key}
                        label={t(`${KEY}.${type === 'ICO' ? 'companyId' : 'vatId'}`)}
                        onChange={(event) => changeDraft(key, event.target.value, original)}
                        value={value(key, original)}
                      />
                      <Button
                        disabled={busy || stale || party === undefined || draft[key] === undefined}
                        onClick={() =>
                          save({ existing, identifierType: type, kind: 'identifier', value: value(key, original) }, [
                            key,
                          ])
                        }
                        variant="primary"
                      >
                        {t(`${KEY}.saveIdentifier`)}
                      </Button>
                      {existing !== undefined && (
                        <Button
                          disabled={busy || stale || party === undefined || draft[key] !== undefined}
                          onClick={() => save({ existing, kind: 'endIdentifier' }, [])}
                          theme="outlined"
                          variant="secondary"
                        >
                          {t(`${KEY}.endIdentifier`)}
                        </Button>
                      )}
                    </div>
                  );
                })
              ) : (
                <StatusText status="error">{t(`${KEY}.${snapshot.identifiers.status}`)}</StatusText>
              )}
              <h3 className="font-semibold">{t(`${KEY}.contacts`)}</h3>
              {snapshot.contacts.status === 'ready' ? (
                contactRows.map(({ existing, id, type }) => {
                  const fields =
                    existing === undefined ? emptyCustomerContactFields(type) : customerContactFields(existing);
                  const keys = Object.keys(fields).map((field) => `${id}-${field}`);
                  const editable = customerContactEditable(existing, party !== undefined);
                  const values = Object.fromEntries(
                    Object.entries(fields).map(([field, original]) => [field, value(`${id}-${field}`, original)]),
                  );
                  return (
                    <div className="flex flex-col gap-150" key={id}>
                      <p className="font-medium">
                        {t(`${KEY}.contactTypes.${type}`)} {existing === undefined ? t(`${KEY}.newContact`) : ''}
                      </p>
                      <div className="grid grid-cols-1 gap-150 md:grid-cols-2">
                        {(type === 'ADDRESS' ? addressFields : ['value']).map((field) => (
                          <FormInput
                            disabled={!editable}
                            id={`${id}-${field}`}
                            key={field}
                            label={t(customerContactFieldLabel(type, field))}
                            onChange={(event) => changeDraft(`${id}-${field}`, event.target.value, fields[field] ?? '')}
                            value={values[field] ?? ''}
                          />
                        ))}
                      </div>
                      {customerContactRequiresAuthoritativeEdit(existing) && (
                        <StatusText status="default">{t(`${KEY}.registeredAddress`)}</StatusText>
                      )}
                      <Button
                        disabled={busy || stale || !editable || !keys.some((key) => draft[key] !== undefined)}
                        onClick={() =>
                          save({ existing, kind: 'contact', value: customerContactInput(type, values, existing) }, keys)
                        }
                        variant="primary"
                      >
                        {t(`${KEY}.saveContact`)}
                      </Button>
                      {existing !== undefined && (
                        <Button
                          disabled={busy || stale || !editable || keys.some((key) => draft[key] !== undefined)}
                          onClick={() => save({ existing, kind: 'endContact' }, [])}
                          theme="outlined"
                          variant="secondary"
                        >
                          {t(`${KEY}.endContact`)}
                        </Button>
                      )}
                    </div>
                  );
                })
              ) : (
                <StatusText status="error">{t(`${KEY}.${snapshot.contacts.status}`)}</StatusText>
              )}
              <h3 className="font-semibold">{t(`${KEY}.history`)}</h3>
              {history.map((item) => (
                <p key={item.id}>
                  {item.label} · {t(`${KEY}.states.${item.state}`)} · {formatDate(item.recordedAt)}
                </p>
              ))}
              <h3 className="font-semibold">{t(`${KEY}.related`)}</h3>
              <p className="text-fg-secondary text-sm">{t(`${KEY}.relatedContext`)}</p>
              <div className="flex flex-wrap gap-150">
                {[
                  ['opportunities', '/prodej/prilezitosti'],
                  ['tasks', '/siampark/work'],
                  ['invoices', '/siampark/finance'],
                  ['documents', '/siampark/occupancy'],
                ].map(([label, path]) => (
                  <Link
                    aria-disabled={busy}
                    className="text-primary underline"
                    href={
                      label === 'documents'
                        ? `/${language}${path ?? ''}?counterpartyId=${encodeURIComponent(customer.counterpartyId)}#tenant`
                        : relatedCustomerUrl(language, path ?? '', customer, label === 'invoices')
                    }
                    key={label}
                    onClick={(event) => {
                      if (!busy && !dirty) {
                        return;
                      }
                      if (
                        !busy &&
                        (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
                      ) {
                        return;
                      }
                      event.preventDefault();
                      requestNavigation(event.currentTarget.href);
                    }}
                  >
                    {t(`${KEY}.relatedLinks.${label}`)}
                  </Link>
                ))}
              </div>
            </>
          )}
        </div>
      </SidePanel>
      <DiscardDialog
        copyKey={KEY}
        onCancel={() => setDiscardOpen(false)}
        onConfirm={confirmDiscard}
        onOpenChange={setDiscardOpen}
        open={discardOpen}
      />
    </>
  );
};

export const CustomerDetailDialog = ({ customer, ...props }: CustomerDetailDialogProps) =>
  customer === null ? null : (
    <CustomerDetailView
      customer={customer}
      key={`${customer.counterpartyId}:${props.snapshot === undefined ? 'loading' : 'ready'}`}
      {...props}
    />
  );
