import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Option, Schema } from 'effect';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { AutosaveStatus, DetailList, SidePanel, formatDate, useAutosaveDraft } from '@app/admin-ui';
import type { AutosaveOutcome } from '@app/admin-ui';
import type { CustomerListItem } from '../../../../api/customers-client.ts';
import { DiscardDialog } from './customer-discard-dialog.tsx';
import { customerDetailFailureKey, saveCustomerFact, useCustomerDetail } from './customers-data.ts';
import type { CustomerDetailSnapshot, CustomerFactChange } from './customers-data.ts';
import type { Party } from '../../../../../shared/domain/identity-contracts.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import {
  contactFieldsInvalid,
  customerContactFields,
  customerContactInput,
  customerIdentitySummary,
  emptyCustomerContactFields,
  customerContactEditable,
  customerContactFieldLabel,
  customerContactRequiresAuthoritativeEdit,
  relatedCustomerUrl,
  sameContactFields,
} from './customers-model.ts';
import type { CustomerContactFields, CustomerContactRow } from './customers-model.ts';

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

/** The detail while its first read runs or after it failed. A refusal is a plain notice and offers no second read. */
const CustomerDetailLoadNotice = ({ failure, onRetry }: Pick<CustomerDetailDialogProps, 'failure' | 'onRetry'>) => {
  const { t } = useModernI18n();
  return (
    <>
      <StatusText status={failure === 'unavailable' ? 'error' : 'default'}>
        {t(`${KEY}.${failure ?? 'loading'}`)}
      </StatusText>
      {failure === 'unavailable' && (
        <Button onClick={onRetry} variant="secondary">
          {t(`${KEY}.reload`)}
        </Button>
      )}
    </>
  );
};

/** Why the identity cannot be edited: no access reads as a plain notice, anything else as an unavailable read. */
const CustomerIdentityNotice = ({ forbidden }: { readonly forbidden: boolean }) => {
  const { t } = useModernI18n();
  return (
    <StatusText status={forbidden ? 'default' : 'error'}>
      {t(`${KEY}.${forbidden ? 'forbidden' : 'unavailable'}`)}
    </StatusText>
  );
};

interface CustomerChangeBasisProps {
  readonly evidence: string;
  readonly onEvidenceChange: (next: string) => void;
  readonly onReasonChange: (next: string) => void;
  readonly reason: string;
}

/** Evidence and reason every save of the panel records. */
const CustomerChangeBasis = ({ evidence, onEvidenceChange, onReasonChange, reason }: CustomerChangeBasisProps) => {
  const { t } = useModernI18n();
  return (
    <>
      <p className="text-fg-secondary text-sm">{t(`${KEY}.separateSaves`)}</p>
      <FormInput
        id="customer-evidence"
        label={t(`${KEY}.evidence`)}
        maxLength={200}
        onChange={(event) => onEvidenceChange(event.target.value)}
        required
        value={evidence}
      />
      <FormInput
        id="customer-reason"
        label={t(`${KEY}.reason`)}
        maxLength={500}
        onChange={(event) => onReasonChange(event.target.value)}
        required
        value={reason}
      />
    </>
  );
};

/** One text fact of the identity. It saves itself, and only while the change basis (evidence + reason) is filled in. */
const TextFactField = ({
  basisFilled,
  id,
  label,
  original,
  save,
}: {
  readonly basisFilled: boolean;
  readonly id: string;
  readonly label: string;
  readonly original: string;
  readonly save: (value: string) => Effect.Effect<AutosaveOutcome>;
}) => {
  const autosave = useAutosaveDraft<string, never>({
    equals: (left, right) => left.trim() === right.trim(),
    isValid: (value) => value.trim() !== '' && value.trim() !== original.trim() && basisFilled,
    runtime: browserRuntime,
    save: (value) => save(value.trim()),
    server: original,
  });
  const handleChange = (event: { target: { value: string } }) => autosave.setDraft(event.target.value);
  const handleReloadLatest = autosave.reloadLatest;
  const handleRetry = autosave.retry;
  return (
    <div className="flex flex-col gap-100">
      <FormInput id={id} label={label} onChange={handleChange} required value={autosave.draft} />
      <AutosaveStatus onReloadLatest={handleReloadLatest} onRetry={handleRetry} status={autosave.status} />
    </div>
  );
};

/** The contact point of one row. Same autosave, field by field, plus the registry-owned address notice. */
const ContactFactFields = ({
  basisFilled,
  id,
  registeredAddress,
  save,
  server,
  type,
}: {
  readonly basisFilled: boolean;
  readonly id: string;
  readonly registeredAddress: boolean;
  readonly save: (value: CustomerContactFields) => Effect.Effect<AutosaveOutcome>;
  readonly server: CustomerContactFields;
  readonly type: CustomerContactRow['type'];
}) => {
  const { t } = useModernI18n();
  const autosave = useAutosaveDraft<CustomerContactFields, never>({
    equals: sameContactFields,
    isValid: (value) => basisFilled && !sameContactFields(value, server) && !contactFieldsInvalid(type, value),
    runtime: browserRuntime,
    save: (value) => save(value),
    server,
  });
  const handleReloadLatest = autosave.reloadLatest;
  const handleRetry = autosave.retry;
  return (
    <>
      <div className="grid grid-cols-1 gap-150 md:grid-cols-2">
        {(type === 'ADDRESS' ? addressFields : (['value'] as const)).map((field) => (
          <FormInput
            helpText={
              type === 'EMAIL' && field === 'value' && contactFieldsInvalid(type, autosave.draft)
                ? 'Zadejte platný e-mail'
                : undefined
            }
            id={`${id}-${field}`}
            key={field}
            label={t(customerContactFieldLabel(type, field))}
            onChange={(event) => autosave.setDraft((current) => ({ ...current, [field]: event.target.value }))}
            value={autosave.draft[field] ?? ''}
          />
        ))}
      </div>
      {registeredAddress && <StatusText status="default">{t(`${KEY}.registeredAddress`)}</StatusText>}
      <AutosaveStatus onReloadLatest={handleReloadLatest} onRetry={handleRetry} status={autosave.status} />
    </>
  );
};

type CustomerDetail = ReturnType<typeof useCustomerDetail>;

/** The identity's facts below the rename: official identifiers and contact points, each saving itself. */
const CustomerFacts = ({
  basisFilled,
  detail,
  saveFact,
  snapshot,
}: {
  readonly basisFilled: boolean;
  readonly detail: CustomerDetail;
  readonly saveFact: (build: (owner: Party) => CustomerFactChange) => Effect.Effect<AutosaveOutcome>;
  readonly snapshot: CustomerDetailSnapshot;
}) => {
  const { t } = useModernI18n();
  return (
    <>
      <h3 className="font-semibold">{t(`${KEY}.identifiers`)}</h3>
      {snapshot.identifiers.status === 'ready' ? (
        detail.identifierRows.map(({ existing, id, type }) => {
          const key = `identifier-${id}`;
          const original = existing?.normalizedValue ?? '';
          return (
            <div className="flex flex-col gap-150" key={key}>
              {existing === undefined || detail.party === undefined ? (
                <>
                  <FormInput
                    disabled={detail.party === undefined}
                    id={key}
                    label={t(`${KEY}.${type === 'ICO' ? 'companyId' : 'vatId'}`)}
                    onChange={(event) => detail.changeDraft(key, event.target.value, original)}
                    value={detail.value(key, original)}
                  />
                  <Button
                    disabled={
                      detail.busy || detail.stale || detail.party === undefined || detail.draft[key] === undefined
                    }
                    onClick={() =>
                      detail.save(
                        {
                          existing,
                          identifierType: type,
                          kind: 'identifier',
                          value: detail.value(key, original),
                        },
                        [key],
                      )
                    }
                    variant="primary"
                  >
                    {t(`${KEY}.saveIdentifier`)}
                  </Button>
                </>
              ) : (
                <TextFactField
                  basisFilled={basisFilled}
                  id={key}
                  label={t(`${KEY}.${type === 'ICO' ? 'companyId' : 'vatId'}`)}
                  original={original}
                  save={(next) => saveFact(() => ({ existing, identifierType: type, kind: 'identifier', value: next }))}
                />
              )}
              {existing !== undefined && (
                <Button
                  disabled={
                    detail.busy || detail.stale || detail.party === undefined || detail.draft[key] !== undefined
                  }
                  onClick={() => detail.save({ existing, kind: 'endIdentifier' }, [])}
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
        detail.contactRows.map(({ existing, id, type }) => {
          const fields = existing === undefined ? emptyCustomerContactFields(type) : customerContactFields(existing);
          const keys = Object.keys(fields).map((field) => `${id}-${field}`);
          const editable = customerContactEditable(existing, detail.party !== undefined);
          const values = Object.fromEntries(
            Object.entries(fields).map(([field, original]) => [field, detail.value(`${id}-${field}`, original)]),
          );
          return (
            <div className="flex flex-col gap-150" key={id}>
              <p className="font-medium">
                {t(`${KEY}.contactTypes.${type}`)} {existing === undefined ? t(`${KEY}.newContact`) : ''}
              </p>
              {existing !== undefined && editable ? (
                <ContactFactFields
                  basisFilled={basisFilled}
                  id={id}
                  registeredAddress={customerContactRequiresAuthoritativeEdit(existing)}
                  save={(next) =>
                    saveFact(() => ({
                      existing,
                      kind: 'contact',
                      value: customerContactInput(type, next, existing),
                    }))
                  }
                  server={fields}
                  type={type}
                />
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-150 md:grid-cols-2">
                    {(type === 'ADDRESS' ? addressFields : ['value']).map((field) => (
                      <FormInput
                        disabled={!editable}
                        id={`${id}-${field}`}
                        key={field}
                        label={t(customerContactFieldLabel(type, field))}
                        onChange={(event) =>
                          detail.changeDraft(`${id}-${field}`, event.target.value, fields[field] ?? '')
                        }
                        value={values[field] ?? ''}
                      />
                    ))}
                  </div>
                  {customerContactRequiresAuthoritativeEdit(existing) && (
                    <StatusText status="default">{t(`${KEY}.registeredAddress`)}</StatusText>
                  )}
                  <Button
                    disabled={
                      detail.busy || detail.stale || !editable || !keys.some((key) => detail.draft[key] !== undefined)
                    }
                    onClick={() =>
                      detail.save(
                        { existing, kind: 'contact', value: customerContactInput(type, values, existing) },
                        keys,
                      )
                    }
                    variant="primary"
                  >
                    {t(`${KEY}.saveContact`)}
                  </Button>
                </>
              )}
              {existing !== undefined && (
                <Button
                  disabled={
                    detail.busy || detail.stale || !editable || keys.some((key) => detail.draft[key] !== undefined)
                  }
                  onClick={() => detail.save({ existing, kind: 'endContact' }, [])}
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
    </>
  );
};

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
  const detail = useCustomerDetail(
    customer,
    initialSnapshot,
    onOpenChange,
    onRenamed,
    () => {
      toaster.create({ title: t(`${KEY}.toastRenamed`), type: 'success' });
    },
    t,
  );
  const {
    busy,
    confirmDiscard,
    dirty,
    discardOpen,
    evidence,
    history,
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
  } = detail;

  const { name, status } = customerIdentitySummary(customer, party);

  /** Evidence and a reason are the change basis of a governed identity change: nothing is sent without them. */
  const basisFilled = reason.trim() !== '' && evidence.trim() !== '';
  const saveFact = (build: (owner: Party) => CustomerFactChange): Effect.Effect<AutosaveOutcome> =>
    party === undefined
      ? Effect.succeed<AutosaveOutcome>('failed')
      : saveCustomerFact(party.partyRef, build(party), reason.trim(), evidence.trim()).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.sync<AutosaveOutcome>(() =>
                customerDetailFailureKey(error) === 'conflict' ? 'conflict' : 'failed',
              ),
            onSuccess: (result) =>
              Effect.sync<AutosaveOutcome>(() => {
                if (Schema.is(Schema.Struct({ outcome: Schema.Literal('BLOCKED') }))(result)) {
                  return 'failed';
                }
                // The panel shows what the owner now has, so the next change builds on the confirmed facts.
                refresh();
                return 'saved';
              }),
          }),
        );

  return (
    <>
      <SidePanel
        actions={
          <Button disabled={busy} onClick={() => requestClose(false)} theme="outlined" variant="secondary">
            {t(`${KEY}.cancel`)}
          </Button>
        }
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
          {initialSnapshot === undefined && <CustomerDetailLoadNotice failure={failure} onRetry={onRetry} />}
          <DetailList
            items={[
              { label: t(`${KEY}.createdAt`), value: formatDate(customer.createdAt) },
              {
                label: t(`${KEY}.status`),
                value: t(`${STATUS_KEY}.${status}`),
              },
            ]}
          />
          {snapshot !== undefined && (
            <>
              {/* Every save needs the identity; without it (a refused or unavailable read) the panel is read-only. */}
              {party !== undefined && (
                <CustomerChangeBasis
                  evidence={evidence}
                  onEvidenceChange={setEvidence}
                  onReasonChange={setReason}
                  reason={reason}
                />
              )}
              {stale && (
                <Button disabled={busy} onClick={refresh} variant="secondary">
                  {t(`${KEY}.reload`)}
                </Button>
              )}
              {party === undefined ? (
                <CustomerIdentityNotice forbidden={identity?.status === 'forbidden'} />
              ) : (
                <>
                  <TextFactField
                    basisFilled={basisFilled}
                    id="customer-rename"
                    label={t(`${KEY}.rename`)}
                    original={name}
                    save={(next) => saveFact((owner) => ({ kind: 'name', party: owner, value: next }))}
                  />
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
              <CustomerFacts basisFilled={basisFilled} detail={detail} saveFact={saveFact} snapshot={snapshot} />
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
                  ['tasks', '/ukoly'],
                  ['invoices', '/finance'],
                  ['documents', '/najmy'],
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
