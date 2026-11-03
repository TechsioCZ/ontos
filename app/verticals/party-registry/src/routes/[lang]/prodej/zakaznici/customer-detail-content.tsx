import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { AutosaveStatus, DetailList, formatDate, useAutosaveDraft } from '@app/admin-ui';
import type { AutosaveOutcome } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Effect, Option, Schema } from 'effect';

import type { CustomerListItem } from '../../../../api/customers-client.ts';
import type { Party } from '../../../../../shared/domain/identity-contracts.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { DiscardDialog } from './customer-discard-dialog.tsx';
import { customerDetailFailureKey, saveCustomerFact } from './customers-data.ts';
import type { CustomerDetailSnapshot, CustomerFactChange, useCustomerDetail } from './customers-data.ts';
import {
  contactFieldsInvalid,
  customerContactEditable,
  customerContactFieldLabel,
  customerContactFields,
  customerContactInput,
  customerContactRequiresAuthoritativeEdit,
  emptyCustomerContactFields,
  sameContactFields,
} from './customers-model.ts';
import type { CustomerContactFields, CustomerContactRow } from './customers-model.ts';

export const CUSTOMER_DETAIL_KEY = 'party-registry.pages.customers.detail';
const STATUS_KEY = 'party-registry.pages.customers.status';
const addressFields = ['addressLine1', 'addressLine2', 'city', 'postalCode', 'region', 'countryCode'] as const;

export type CustomerDetailModel = ReturnType<typeof useCustomerDetail>;

/** Everything the body shows about the record beside its owner sections. */
export type CustomerDetailSubject = Pick<
  CustomerListItem,
  'counterpartyId' | 'counterpartyRef' | 'createdAt' | 'displayName' | 'partyId' | 'status'
>;

export interface CustomerDetailContentProps {
  readonly detail: CustomerDetailModel;
  readonly failure?: 'forbidden' | 'unavailable' | undefined;
  readonly initialSnapshot?: CustomerDetailSnapshot | undefined;
  readonly onRetry: () => void;
  readonly subject: CustomerDetailSubject;
}

/** The detail while its first read runs or after it failed. A refusal is a plain notice and offers no second read. */
export const CustomerDetailLoadNotice = ({
  failure,
  onRetry,
}: Pick<CustomerDetailContentProps, 'failure' | 'onRetry'>) => {
  const { t } = useModernI18n();
  return (
    <>
      <StatusText status={failure === 'unavailable' ? 'error' : 'default'}>
        {t(`${CUSTOMER_DETAIL_KEY}.${failure ?? 'loading'}`)}
      </StatusText>
      {failure === 'unavailable' && (
        <Button onClick={onRetry} variant="secondary">
          {t(`${CUSTOMER_DETAIL_KEY}.reload`)}
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
      {t(`${CUSTOMER_DETAIL_KEY}.${forbidden ? 'forbidden' : 'unavailable'}`)}
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
  const filled = evidence.trim() !== '' && reason.trim() !== '';
  return (
    <>
      <p className="text-fg-secondary text-sm">{t(`${CUSTOMER_DETAIL_KEY}.separateSaves`)}</p>
      {!filled && (
        <StatusText showIcon size="sm" status="warning">
          Bez dokladu a důvodu se změny neukládají
        </StatusText>
      )}
      <FormInput
        id="customer-evidence"
        label={t(`${CUSTOMER_DETAIL_KEY}.evidence`)}
        maxLength={200}
        onChange={(event) => onEvidenceChange(event.target.value)}
        required
        value={evidence}
      />
      <FormInput
        id="customer-reason"
        label={t(`${CUSTOMER_DETAIL_KEY}.reason`)}
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
    isValid: (value) => value.trim() !== '' && basisFilled,
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
    isValid: (value) => basisFilled && !contactFieldsInvalid(type, value),
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
      {registeredAddress && <StatusText status="default">{t(`${CUSTOMER_DETAIL_KEY}.registeredAddress`)}</StatusText>}
      <AutosaveStatus onReloadLatest={handleReloadLatest} onRetry={handleRetry} status={autosave.status} />
    </>
  );
};

/** The identity's facts below the rename: official identifiers and contact points, each saving itself. */
const CustomerFacts = ({
  basisFilled,
  detail,
  saveFact,
  snapshot,
}: {
  readonly basisFilled: boolean;
  readonly detail: CustomerDetailModel;
  readonly saveFact: (build: (owner: Party) => CustomerFactChange) => Effect.Effect<AutosaveOutcome>;
  readonly snapshot: CustomerDetailSnapshot;
}) => {
  const { t } = useModernI18n();
  return (
    <>
      <h3 className="font-semibold">{t(`${CUSTOMER_DETAIL_KEY}.identifiers`)}</h3>
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
                    label={t(`${CUSTOMER_DETAIL_KEY}.${type === 'ICO' ? 'companyId' : 'vatId'}`)}
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
                    {t(`${CUSTOMER_DETAIL_KEY}.saveIdentifier`)}
                  </Button>
                </>
              ) : (
                <TextFactField
                  basisFilled={basisFilled}
                  id={key}
                  label={t(`${CUSTOMER_DETAIL_KEY}.${type === 'ICO' ? 'companyId' : 'vatId'}`)}
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
                  {t(`${CUSTOMER_DETAIL_KEY}.endIdentifier`)}
                </Button>
              )}
            </div>
          );
        })
      ) : (
        <StatusText status="error">{t(`${CUSTOMER_DETAIL_KEY}.${snapshot.identifiers.status}`)}</StatusText>
      )}
      <h3 className="font-semibold">{t(`${CUSTOMER_DETAIL_KEY}.contacts`)}</h3>
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
                {t(`${CUSTOMER_DETAIL_KEY}.contactTypes.${type}`)}{' '}
                {existing === undefined ? t(`${CUSTOMER_DETAIL_KEY}.newContact`) : ''}
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
                    <StatusText status="default">{t(`${CUSTOMER_DETAIL_KEY}.registeredAddress`)}</StatusText>
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
                    {t(`${CUSTOMER_DETAIL_KEY}.saveContact`)}
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
                  {t(`${CUSTOMER_DETAIL_KEY}.endContact`)}
                </Button>
              )}
            </div>
          );
        })
      ) : (
        <StatusText status="error">{t(`${CUSTOMER_DETAIL_KEY}.${snapshot.contacts.status}`)}</StatusText>
      )}
    </>
  );
};

/** The complete customer detail body. The side panel and the full page render this one component. */
export const CustomerDetailContent = ({
  detail,
  failure,
  initialSnapshot,
  onRetry,
  subject,
}: CustomerDetailContentProps) => {
  const { t } = useModernI18n();
  const location = useRouterState({ select: (state) => state.location.pathname });
  const language = location.split('/')[1] === 'en' ? 'en' : 'cs';
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
    requestNavigation,
    save,
    setDiscardOpen,
    setEvidence,
    setReason,
    snapshot,
    stale,
  } = detail;
  const partyName = party === undefined ? undefined : Option.getOrElse(party.displayName, () => '');
  const name = partyName ?? subject.displayName ?? '';
  const archived = party === undefined ? subject.status === 'ARCHIVED' : Option.isSome(party.archivedAt);
  const status = archived ? 'ARCHIVED' : 'ACTIVE';
  /** The same related-link contract the list uses, built from the validated subject instead of a list row. */
  const relatedHref = (path: string, invoices: boolean): string => {
    const params = new URLSearchParams({ partyId: subject.partyId });
    if (invoices) {
      params.set('counterpartyId', subject.counterpartyId);
      params.set('tenantId', subject.counterpartyRef.tenantId);
    }
    return `/${language}${path}?${params.toString()}`;
  };

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
                // The detail shows what the owner now has, so the next change builds on the confirmed facts.
                refresh();
                return 'saved';
              }),
          }),
        );

  return (
    <>
      <div className="flex flex-col gap-250 py-200">
        {notice !== null && (
          <StatusText showIcon status="error">
            {notice}
          </StatusText>
        )}
        {initialSnapshot === undefined && <CustomerDetailLoadNotice failure={failure} onRetry={onRetry} />}
        <DetailList
          items={[
            { label: t(`${CUSTOMER_DETAIL_KEY}.createdAt`), value: formatDate(subject.createdAt) },
            {
              label: t(`${CUSTOMER_DETAIL_KEY}.status`),
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
                {t(`${CUSTOMER_DETAIL_KEY}.reload`)}
              </Button>
            )}
            {party === undefined ? (
              <CustomerIdentityNotice forbidden={identity?.status === 'forbidden'} />
            ) : (
              <>
                <TextFactField
                  basisFilled={basisFilled}
                  id="customer-rename"
                  label={t(`${CUSTOMER_DETAIL_KEY}.rename`)}
                  original={name}
                  save={(next) => saveFact((owner) => ({ kind: 'name', party: owner, value: next }))}
                />
                <p className="text-fg-secondary text-sm">{t(`${CUSTOMER_DETAIL_KEY}.sharedIdentity`)}</p>
                <Button
                  disabled={busy || stale || dirty}
                  onClick={() => save({ kind: 'lifecycle', party }, [])}
                  theme="outlined"
                  variant="secondary"
                >
                  {t(`${CUSTOMER_DETAIL_KEY}.${Option.isSome(party.archivedAt) ? 'restore' : 'archive'}`)}
                </Button>
              </>
            )}
            <CustomerFacts basisFilled={basisFilled} detail={detail} saveFact={saveFact} snapshot={snapshot} />
            <h3 className="font-semibold">{t(`${CUSTOMER_DETAIL_KEY}.history`)}</h3>
            {history.map((item) => (
              <p key={item.id}>
                {item.label} · {t(`${CUSTOMER_DETAIL_KEY}.states.${item.state}`)} · {formatDate(item.recordedAt)}
              </p>
            ))}
            <h3 className="font-semibold">{t(`${CUSTOMER_DETAIL_KEY}.related`)}</h3>
            <p className="text-fg-secondary text-sm">{t(`${CUSTOMER_DETAIL_KEY}.relatedContext`)}</p>
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
                      ? `/${language}${path ?? ''}?counterpartyId=${encodeURIComponent(subject.counterpartyId)}#tenant`
                      : relatedHref(path ?? '', label === 'invoices')
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
                  {t(`${CUSTOMER_DETAIL_KEY}.relatedLinks.${label}`)}
                </Link>
              ))}
            </div>
          </>
        )}
      </div>
      <DiscardDialog
        copyKey={CUSTOMER_DETAIL_KEY}
        onCancel={() => setDiscardOpen(false)}
        onConfirm={confirmDiscard}
        onOpenChange={setDiscardOpen}
        open={discardOpen}
      />
    </>
  );
};
