import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { DetailList, SaveBar, UnsavedChangesDialog, formatDate, requiredLabelFor, saveLabelsFor } from '@app/admin-ui';
import {
  EntryTextField,
  FormReact,
  FormRoot,
  TextField,
  fromPayload,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Option, Schema, Struct } from 'effect';
import { Atom } from 'effect/reactivity';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { EndContactPointPayloadSchema } from '../../../../../shared/actions/end-contact-point.ts';
import { UpdatePartyPayloadSchema } from '../../../../../shared/actions/update-party.ts';
import type { CustomerListItem } from '../../../../api/customers-client.ts';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { NAME_KEY, contactDraftKey, contactFieldNames, identifierDraftKey } from './customer-detail-draft.ts';
import type { CustomerDetailSnapshot, useCustomerDetail } from './customers-data.ts';
import {
  contactFieldsInvalid,
  customerContactEditable,
  customerContactFieldLabel,
  customerContactFields,
  customerContactRequiresAuthoritativeEdit,
  emptyCustomerContactFields,
} from './customers-model.ts';

export const CUSTOMER_DETAIL_KEY = 'party-registry.pages.customers.detail';
const STATUS_KEY = 'party-registry.pages.customers.status';

/**
 * The editable customer detail: the change basis every save records (the reason and evidence the fact Actions take)
 * and the text of every editable fact, keyed like the detail's one draft. The detail's Uložit and its one-click
 * commands send them, so the form itself is never submitted.
 */
const customerDetailForm = FormReact.make(
  fromPayload(EndContactPointPayloadSchema.mapFields(Struct.pick(['reason'])))
    .addField('evidence', UpdatePartyPayloadSchema.fields.provenanceSource)
    .addField('facts', Schema.Record(Schema.String, Schema.String)),
  {
    fields: { evidence: TextField, facts: EntryTextField, reason: TextField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

/** A detail opens with no change basis; its facts come from the record. */
const emptyCustomerDetailValues = { evidence: '', facts: {}, reason: '' };

/** The change basis typed in the detail: the evidence and reason every save and one-click command records. */
export const customerDetailBasis: Atom.Atom<{ readonly evidence: string; readonly reason: string }> =
  customerDetailForm.values.pipe(
    Atom.map(
      Option.match({
        onNone: () => emptyCustomerDetailValues,
        onSome: ({ evidence, reason }) => ({ evidence, reason }),
      }),
    ),
  );

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
  /**
   * The page's save bar, shown directly under the editable fields and above the history and related records. The
   * side panel leaves it out: its save bar is the last control of the panel footer.
   */
  readonly saveBar?: ReactNode;
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
        <Button onClick={onRetry} severity="secondary">
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
  readonly reason: string;
}

/** Evidence and reason every save of the panel records. */
const CustomerChangeBasis = ({ evidence, reason }: CustomerChangeBasisProps) => {
  const { language, t } = useModernI18n();
  const requiredLabel = requiredLabelFor(language);
  const filled = evidence.trim() !== '' && reason.trim() !== '';
  return (
    <>
      <p className="text-fg-secondary text-sm">{t(`${CUSTOMER_DETAIL_KEY}.separateSaves`)}</p>
      {!filled && (
        <StatusText showIcon size="sm" status="warning">
          {t(`${CUSTOMER_DETAIL_KEY}.basisRequired`)}
        </StatusText>
      )}
      <customerDetailForm.evidence
        id="customer-evidence"
        label={t(`${CUSTOMER_DETAIL_KEY}.evidence`)}
        maxLength={200}
        required
        requiredLabel={requiredLabel}
      />
      <customerDetailForm.reason
        id="customer-reason"
        label={t(`${CUSTOMER_DETAIL_KEY}.reason`)}
        maxLength={500}
        required
        requiredLabel={requiredLabel}
      />
    </>
  );
};

type ShownFacts = Readonly<Record<string, string>>;

/** What every fact field shows: the draft's text where the draft holds the field, the record's value elsewhere. */
const shownFactsOf = (detail: CustomerDetailModel, name: string) => ({
  [NAME_KEY]: name,
  ...Object.fromEntries(
    detail.identifierRows.map(({ existing, id }) => [identifierDraftKey(id), existing?.normalizedValue ?? '']),
  ),
  ...Object.fromEntries(
    detail.contactRows.flatMap(({ existing, id, type }) => {
      const fields = existing === undefined ? emptyCustomerContactFields(type) : customerContactFields(existing);
      return contactFieldNames(type).map((field) => [contactDraftKey(id, field), fields[field] ?? '']);
    }),
  ),
  ...detail.record.draft.fields,
});

const sameFacts = (left: ShownFacts, right: ShownFacts) =>
  [...new Set([...Object.keys(left), ...Object.keys(right)])].every((key) => left[key] === right[key]);

const factsField = customerDetailForm.getFieldAtoms(customerDetailForm.fields.facts);

/**
 * The fact fields and the detail's one draft move together: typing changes the draft, and a draft that changed
 * without typing (the record's newer version, Zahodit změny, the latest version) shows in the fields.
 */
const FactsFollowDraft = ({ detail, shown }: { readonly detail: CustomerDetailModel; readonly shown: ShownFacts }) => {
  const facts = useAtomValue(factsField.value);
  const setFacts = useAtomSet(factsField.setValue);
  const { setDraft } = detail.record;
  useAtomSubscribe(
    factsField.value,
    (next) => {
      if (Option.isNone(next)) {
        return;
      }
      const typed = next.value;
      // Only the fields the draft holds are editable; the others show the record's value.
      setDraft((current) => {
        const fields = Object.fromEntries(
          Object.entries(current.fields).map(([key, text]) => [key, typed[key] ?? text]),
        );
        return sameFacts(fields, current.fields) ? current : { ...current, fields };
      });
    },
    { immediate: false },
  );
  const pushed = useRef<ShownFacts | null>(null);
  useEffect(() => {
    if (pushed.current !== null && sameFacts(pushed.current, shown)) {
      return;
    }
    pushed.current = shown;
    if (Option.exists(facts, (current) => !sameFacts(current, shown))) {
      setFacts(shown);
    }
  }, [facts, setFacts, shown]);
  return null;
};

/** The identity's facts below the name: official identifiers and contact points, all part of the one draft. */
const CustomerFacts = ({
  detail,
  shown,
  snapshot,
}: {
  readonly detail: CustomerDetailModel;
  readonly shown: ShownFacts;
  readonly snapshot: CustomerDetailSnapshot;
}) => {
  const { t } = useModernI18n();
  const hasParty = detail.party !== undefined;
  return (
    <>
      <h3 className="font-semibold">{t(`${CUSTOMER_DETAIL_KEY}.identifiers`)}</h3>
      {snapshot.identifiers.status === 'ready' ? (
        detail.identifierRows.map(({ existing, id, type }) => {
          const key = identifierDraftKey(id);
          return (
            <div className="flex flex-col gap-150" key={key}>
              <customerDetailForm.facts
                disabled={!hasParty}
                entry={key}
                id={key}
                label={t(`${CUSTOMER_DETAIL_KEY}.${type === 'ICO' ? 'companyId' : 'vatId'}`)}
              />
              {existing !== undefined && (
                <Button
                  appearance="outline"
                  disabled={detail.busy || detail.stale || !hasParty || detail.draft[key] !== undefined}
                  onClick={() => detail.runCommand({ existing, kind: 'endIdentifier' })}
                  severity="secondary"
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
          const names = contactFieldNames(type);
          const keys = names.map((field) => contactDraftKey(id, field));
          const editable = customerContactEditable(existing, hasParty);
          const values = Object.fromEntries(names.map((field) => [field, shown[contactDraftKey(id, field)] ?? '']));
          const emailInvalid =
            editable &&
            type === 'EMAIL' &&
            keys.some((key) => detail.draft[key] !== undefined) &&
            contactFieldsInvalid(type, values);
          return (
            <div className="flex flex-col gap-150" key={id}>
              <p className="font-medium">
                {t(`${CUSTOMER_DETAIL_KEY}.contactTypes.${type}`)}{' '}
                {existing === undefined ? t(`${CUSTOMER_DETAIL_KEY}.newContact`) : ''}
              </p>
              <div className="grid grid-cols-1 gap-150 md:grid-cols-2">
                {names.map((field) => (
                  <customerDetailForm.facts
                    disabled={!editable}
                    entry={contactDraftKey(id, field)}
                    helpText={emailInvalid && field === 'value' ? t(`${CUSTOMER_DETAIL_KEY}.invalidEmail`) : undefined}
                    id={contactDraftKey(id, field)}
                    key={field}
                    label={t(customerContactFieldLabel(type, field))}
                  />
                ))}
              </div>
              {customerContactRequiresAuthoritativeEdit(existing) && (
                <StatusText status="default">{t(`${CUSTOMER_DETAIL_KEY}.registeredAddress`)}</StatusText>
              )}
              {existing !== undefined && (
                <Button
                  appearance="outline"
                  disabled={
                    detail.busy || detail.stale || !editable || keys.some((key) => detail.draft[key] !== undefined)
                  }
                  onClick={() => detail.runCommand({ existing, kind: 'endContact' })}
                  severity="secondary"
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

/**
 * The one Save button of the customer detail with the draft's status. The side panel puts it last in its footer,
 * the page directly under the editable fields (`CustomerDetailContent`'s `saveBar`).
 */
export const CustomerDetailSaveBar = ({ detail }: { readonly detail: CustomerDetailModel }) => {
  const { language } = useModernI18n();
  const handleSave = detail.save;
  const handleReloadLatest = detail.record.reloadLatest;
  return (
    <SaveBar
      error={detail.saveError}
      labels={saveLabelsFor(language)}
      onReloadLatest={handleReloadLatest}
      onSave={handleSave}
      status={detail.status}
    />
  );
};

/** The complete customer detail body. The side panel and the full page render this one component. */
export const CustomerDetailContent = ({
  detail,
  failure,
  initialSnapshot,
  onRetry,
  saveBar,
  subject,
}: CustomerDetailContentProps) => {
  const { language: i18nLanguage, t } = useModernI18n();
  const location = useRouterState({ select: (state) => state.location.pathname });
  const language = location.split('/')[1] === 'en' ? 'en' : 'cs';
  const {
    busy,
    dirty,
    evidence,
    guard,
    history,
    identity,
    notice,
    party,
    reason,
    refresh,
    requestNavigation,
    runCommand,
    snapshot,
    stale,
  } = detail;
  // A withheld Party name (no identity capability) leaves the name of the reader's own Counterparty read.
  const partyName = party?.displayName === undefined ? undefined : Option.getOrElse(party.displayName, () => '');
  const name = partyName ?? subject.displayName ?? '';
  const archived = party === undefined ? subject.status === 'ARCHIVED' : Option.isSome(party.archivedAt);
  const status = archived ? 'ARCHIVED' : 'ACTIVE';
  const shown = shownFactsOf(detail, name);
  /** The same related-link contract the list uses, built from the validated subject instead of a list row. */
  const relatedHref = (path: string, invoices: boolean): string => {
    const params = new URLSearchParams({ partyId: subject.partyId });
    if (invoices) {
      params.set('counterpartyId', subject.counterpartyId);
      params.set('tenantId', subject.counterpartyRef.tenantId);
    }
    return `/${language}${path}?${params.toString()}`;
  };

  return (
    <>
      {/* The form has no submit button, so Enter sends nothing: only Uložit and the one-click commands write. */}
      <FormRoot
        className="flex flex-col gap-250 py-200"
        defaultValues={{ ...emptyCustomerDetailValues, facts: shown }}
        form={customerDetailForm}
        translateMessage={(message) => t(message)}
      >
        <FactsFollowDraft detail={detail} shown={shown} />
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
            {party !== undefined && <CustomerChangeBasis evidence={evidence} reason={reason} />}
            {stale && (
              <Button disabled={busy} onClick={refresh} severity="secondary">
                {t(`${CUSTOMER_DETAIL_KEY}.reload`)}
              </Button>
            )}
            {party === undefined ? (
              <CustomerIdentityNotice forbidden={identity?.status === 'forbidden'} />
            ) : (
              <>
                <customerDetailForm.facts
                  entry={NAME_KEY}
                  id="customer-rename"
                  label={t(`${CUSTOMER_DETAIL_KEY}.rename`)}
                  required
                  requiredLabel={requiredLabelFor(i18nLanguage)}
                />
                <p className="text-fg-secondary text-sm">{t(`${CUSTOMER_DETAIL_KEY}.sharedIdentity`)}</p>
                <Button
                  appearance="outline"
                  disabled={busy || stale || dirty}
                  onClick={() => runCommand({ kind: 'lifecycle', party })}
                  severity="secondary"
                >
                  {t(`${CUSTOMER_DETAIL_KEY}.${Option.isSome(party.archivedAt) ? 'restore' : 'archive'}`)}
                </Button>
              </>
            )}
            <CustomerFacts detail={detail} shown={shown} snapshot={snapshot} />
            {saveBar}
            {/* A dated list only: with no ended fact the panel and the page render no empty section title. */}
            {history.length > 0 && (
              <>
                <h3 className="font-semibold">{t(`${CUSTOMER_DETAIL_KEY}.history`)}</h3>
                {history.map((item) => (
                  <p key={item.id}>
                    {item.label} · {t(`${CUSTOMER_DETAIL_KEY}.states.${item.state}`)} · {formatDate(item.recordedAt)}
                  </p>
                ))}
              </>
            )}
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
      </FormRoot>
      <UnsavedChangesDialog labels={saveLabelsFor(i18nLanguage)} prompt={guard.prompt} />
    </>
  );
};
