import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { DetailList, PageHeader, SectionCard, formatDate, formatDateTime, formatNumber } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { DateTime, Schema } from 'effect';

import { PARTY_IDENTITY_KEY } from './party-identity-data.ts';
import type {
  PartyContactView,
  PartyIdentityInput,
  PartyIdentityReadView,
  PartyIdentitySection,
  PartyIdentityView,
  PartyIdentifierView,
} from './party-identity-data.ts';

const INVALID_REF = 'invalid-ref';
const FORBIDDEN = 'forbidden';
const LOADING = 'loading';
const NOT_FOUND = 'not-found';
const SCOPE_MISSING = 'scope-missing';
const UNAVAILABLE = 'unavailable';

const NoticeStatusSchema = Schema.Literals([FORBIDDEN, INVALID_REF, LOADING, NOT_FOUND, SCOPE_MISSING, UNAVAILABLE]);
type NoticeStatus = typeof NoticeStatusSchema.Type;

const SectionStatusSchema = Schema.Literals([FORBIDDEN, LOADING, NOT_FOUND, UNAVAILABLE]);
type SectionStatus = typeof SectionStatusSchema.Type;

const formatInstant = (instant: DateTime.Utc): string => formatDate(DateTime.formatIso(instant));
const formatInstantDateTime = (instant: DateTime.Utc): string => formatDateTime(DateTime.formatIso(instant));

const noticeKey = (status: NoticeStatus): string => {
  if (status === NOT_FOUND) {
    return `${PARTY_IDENTITY_KEY}.notFound`;
  }
  if (status === SCOPE_MISSING) {
    return `${PARTY_IDENTITY_KEY}.scopeMissing`;
  }
  if (status === INVALID_REF) {
    return `${PARTY_IDENTITY_KEY}.invalidRef`;
  }
  return `${PARTY_IDENTITY_KEY}.${status}`;
};

const sectionNoticeKey = (section: 'contacts' | 'identifiers', status: SectionStatus): string =>
  `${PARTY_IDENTITY_KEY}.${section}.${status === NOT_FOUND ? 'notFound' : status}`;

const PageNotice = ({ onBack, status }: { readonly onBack: () => void; readonly status: NoticeStatus }) => {
  const { t } = useModernI18n();
  return (
    <SectionCard>
      <div className="flex flex-col items-start gap-150">
        <StatusText
          aria-live={status === LOADING ? undefined : 'polite'}
          status={status === FORBIDDEN || status === LOADING ? 'default' : 'error'}
        >
          {t(noticeKey(status))}
        </StatusText>
        <div className="flex flex-wrap gap-100">
          <Button onClick={onBack} size="sm" theme="outlined" variant="secondary">
            {t(`${PARTY_IDENTITY_KEY}.backToSearch`)}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
};

const SectionNotice = ({
  onRetry,
  section,
  status,
}: {
  readonly onRetry: () => void;
  readonly section: 'contacts' | 'identifiers';
  readonly status: SectionStatus;
}) => {
  const { t } = useModernI18n();
  return (
    <div className="flex flex-col items-start gap-100">
      <StatusText
        aria-live={status === LOADING ? undefined : 'polite'}
        status={status === UNAVAILABLE || status === NOT_FOUND ? 'error' : 'default'}
      >
        {t(sectionNoticeKey(section, status))}
      </StatusText>
      {status === UNAVAILABLE && (
        <Button onClick={onRetry} size="sm" theme="outlined" variant="secondary">
          {t(`${PARTY_IDENTITY_KEY}.reload`)}
        </Button>
      )}
    </div>
  );
};

const IdentitySummary = ({ identity }: { readonly identity: PartyIdentityView }) => {
  const { t } = useModernI18n();
  return (
    <>
      <DetailList
        items={[
          {
            label: t(`${PARTY_IDENTITY_KEY}.fields.displayName`),
            value: identity.displayName ?? t(`${PARTY_IDENTITY_KEY}.unnamed`),
          },
          {
            label: t(`${PARTY_IDENTITY_KEY}.fields.partyType`),
            value: t(`${PARTY_IDENTITY_KEY}.partyTypes.${identity.partyType}`),
          },
          {
            label: t(`${PARTY_IDENTITY_KEY}.fields.status`),
            value: t(`${PARTY_IDENTITY_KEY}.statuses.${identity.archived ? 'ARCHIVED' : 'ACTIVE'}`),
          },
          { label: t(`${PARTY_IDENTITY_KEY}.fields.createdAt`), value: formatInstant(identity.createdAt) },
          {
            label: t(`${PARTY_IDENTITY_KEY}.fields.updatedAt`),
            value: formatInstantDateTime(identity.updatedAt),
          },
          { label: t(`${PARTY_IDENTITY_KEY}.fields.revision`), value: formatNumber(identity.revision) },
        ]}
      />
      {identity.aliasResolved && <StatusText status="default">{t(`${PARTY_IDENTITY_KEY}.aliasResolved`)}</StatusText>}
      {identity.facts.length > 0 && (
        <>
          <h3 className="font-semibold">{t(`${PARTY_IDENTITY_KEY}.sections.facts`)}</h3>
          <ul className="flex flex-col gap-100">
            {identity.facts.map((fact) => (
              <li className="flex flex-col gap-50" key={`${fact.factKind}:${DateTime.formatIso(fact.validFrom)}`}>
                <p className="text-sm">
                  {t(`${PARTY_IDENTITY_KEY}.facts.${fact.factKind}`)}:{' '}
                  {fact.factKind === 'PARTY_TYPE' ? t(`${PARTY_IDENTITY_KEY}.partyTypes.${fact.value}`) : fact.value}
                </p>
                <p className="text-fg-secondary text-sm">
                  {t(`${PARTY_IDENTITY_KEY}.fields.validFrom`)}: {formatInstant(fact.validFrom)} ·{' '}
                  {t(`${PARTY_IDENTITY_KEY}.fields.recordedAt`)}: {formatInstant(fact.recordedAt)}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
};

const IdentifierList = ({ identifiers }: { readonly identifiers: readonly PartyIdentifierView[] }) => {
  const { t } = useModernI18n();
  if (identifiers.length === 0) {
    return <p className="text-sm">{t(`${PARTY_IDENTITY_KEY}.identifiers.empty`)}</p>;
  }
  return (
    <ul className="flex flex-col gap-150">
      {identifiers.map((identifier) => (
        <li
          className="flex flex-col gap-50"
          key={`${identifier.identifierType}:${identifier.value}:${DateTime.formatIso(identifier.validFrom)}`}
        >
          <p className="font-medium">
            {t(`${PARTY_IDENTITY_KEY}.identifierTypes.${identifier.identifierType}`)}: {identifier.value}
          </p>
          <p className="text-fg-secondary text-sm">
            {t(`${PARTY_IDENTITY_KEY}.verification.${identifier.verification}`)} ·{' '}
            {t(`${PARTY_IDENTITY_KEY}.identifierStates.${identifier.state}`)} ·{' '}
            {t(`${PARTY_IDENTITY_KEY}.${identifier.current ? 'current' : 'ended'}`)}
          </p>
          <p className="text-fg-secondary text-sm">
            {t(`${PARTY_IDENTITY_KEY}.fields.validFrom`)}: {formatInstant(identifier.validFrom)} ·{' '}
            {t(`${PARTY_IDENTITY_KEY}.fields.recordedAt`)}: {formatInstant(identifier.recordedAt)}
          </p>
        </li>
      ))}
    </ul>
  );
};

const ContactList = ({ contacts }: { readonly contacts: readonly PartyContactView[] }) => {
  const { t } = useModernI18n();
  if (contacts.length === 0) {
    return <p className="text-sm">{t(`${PARTY_IDENTITY_KEY}.contacts.empty`)}</p>;
  }
  return (
    <ul className="flex flex-col gap-150">
      {contacts.map((contact) => {
        const extensionLabel =
          contact.extension === undefined
            ? undefined
            : t(`${PARTY_IDENTITY_KEY}.phoneExtension`, { extension: contact.extension });
        const extensionText = extensionLabel === undefined ? '' : ` · ${extensionLabel}`;
        const preferredLabel = contact.preferred ? t(`${PARTY_IDENTITY_KEY}.preferred`) : undefined;
        const preferredText = preferredLabel === undefined ? '' : ` · ${preferredLabel}`;
        return (
          <li className="flex flex-col gap-50" key={`${contact.contactType}:${contact.displayValue}`}>
            <p className="font-medium">{t(`${PARTY_IDENTITY_KEY}.contactTypes.${contact.contactType}`)}</p>
            <p className="break-words text-sm">
              {contact.displayValue}
              {extensionText}
            </p>
            {contact.purposes.length > 0 && (
              <p className="text-fg-secondary text-sm">
                {t(`${PARTY_IDENTITY_KEY}.purposesLabel`)}:{' '}
                {contact.purposes.map((purpose) => t(`${PARTY_IDENTITY_KEY}.addressPurposes.${purpose}`)).join(', ')}
              </p>
            )}
            <p className="text-fg-secondary text-sm">
              {t(`${PARTY_IDENTITY_KEY}.verification.${contact.verification}`)}
              {preferredText}
            </p>
          </li>
        );
      })}
    </ul>
  );
};

const IdentifiersSection = ({
  identifiers,
  onRetry,
}: {
  readonly identifiers: PartyIdentitySection<readonly PartyIdentifierView[]> | undefined;
  readonly onRetry: () => void;
}) => {
  if (identifiers === undefined) {
    return <SectionNotice onRetry={onRetry} section="identifiers" status={LOADING} />;
  }
  if (identifiers.status === 'ready') {
    return <IdentifierList identifiers={identifiers.value} />;
  }
  return <SectionNotice onRetry={onRetry} section="identifiers" status={identifiers.status} />;
};

const ContactsSection = ({
  contacts,
  onRetry,
}: {
  readonly contacts: PartyIdentitySection<readonly PartyContactView[]> | undefined;
  readonly onRetry: () => void;
}) => {
  if (contacts === undefined) {
    return <SectionNotice onRetry={onRetry} section="contacts" status={LOADING} />;
  }
  if (contacts.status === 'ready') {
    return <ContactList contacts={contacts.value} />;
  }
  return <SectionNotice onRetry={onRetry} section="contacts" status={contacts.status} />;
};

const IdentityBody = ({
  onBack,
  onRetry,
  read,
}: {
  readonly onBack: () => void;
  readonly onRetry: () => void;
  readonly read: Extract<PartyIdentityReadView, { readonly status: 'identity' }>;
}) => {
  const { t } = useModernI18n();
  if (read.identity.status !== 'ready') {
    return <PageNotice onBack={onBack} status={read.identity.status} />;
  }
  return (
    <>
      <SectionCard title={t(`${PARTY_IDENTITY_KEY}.sections.identity`)}>
        <IdentitySummary identity={read.identity.value} />
      </SectionCard>
      <SectionCard title={t(`${PARTY_IDENTITY_KEY}.sections.identifiers`)}>
        <IdentifiersSection identifiers={read.identifiers} onRetry={onRetry} />
      </SectionCard>
      <SectionCard title={t(`${PARTY_IDENTITY_KEY}.sections.contacts`)}>
        <ContactsSection contacts={read.contacts} onRetry={onRetry} />
      </SectionCard>
    </>
  );
};

export interface PartyIdentityPageViewProps {
  readonly input: PartyIdentityInput;
  readonly onBack: () => void;
  readonly onReload: () => void;
  readonly read: PartyIdentityReadView;
}

/** The complete Party identity page body. Every state comes from one exact read of the route identity. */
export const PartyIdentityPageView = ({ input, onBack, onReload, read }: PartyIdentityPageViewProps) => {
  const { t } = useModernI18n();
  const identity = read.status === 'identity' && read.identity.status === 'ready' ? read.identity.value : undefined;
  const reloadable =
    read.status === 'identity' && (read.identity.status === 'ready' || read.identity.status === 'unavailable');
  return (
    <>
      <PageHeader
        actions={
          <>
            {reloadable && (
              <Button onClick={onReload} theme="outlined" variant="secondary">
                {t(`${PARTY_IDENTITY_KEY}.reload`)}
              </Button>
            )}
            <Button onClick={onBack} theme="outlined" variant="secondary">
              {t(`${PARTY_IDENTITY_KEY}.backToSearch`)}
            </Button>
          </>
        }
        description={t(`${PARTY_IDENTITY_KEY}.description`)}
        title={identity?.displayName ?? t(`${PARTY_IDENTITY_KEY}.title`)}
      />
      <div className="flex flex-col gap-250">
        {input.status === SCOPE_MISSING && <PageNotice onBack={onBack} status={SCOPE_MISSING} />}
        {input.status === 'invalid-ref' && <PageNotice onBack={onBack} status={INVALID_REF} />}
        {input.status === 'ready' && read.status === LOADING && <PageNotice onBack={onBack} status={LOADING} />}
        {input.status === 'ready' && read.status === INVALID_REF && <PageNotice onBack={onBack} status={INVALID_REF} />}
        {input.status === 'ready' && read.status === 'identity' && (
          <IdentityBody onBack={onBack} onRetry={onReload} read={read} />
        )}
      </div>
    </>
  );
};
