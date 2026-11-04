import { DetailList, PageHeader, SectionCard, formatDate, formatDateTime } from '@app/admin-ui';
import { Match } from 'effect';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import type { Contract, Document } from '../../../../shared/apis/records.ts';
import type { AgreementDocumentFound, AgreementDocumentState, AgreementSelectorIssue } from './document-selection.ts';

interface DocumentDetailLabels {
  readonly archived: string;
  readonly back: string;
  readonly contractKind: string;
  readonly contractLifecycle: Readonly<Record<Contract['lifecycleState'], string>>;
  readonly contractStatus: string;
  readonly created: string;
  readonly document: string;
  readonly documentKind: string;
  readonly documentLifecycle: Readonly<Record<Document['lifecycleState'], string>>;
  readonly fileName: string;
  readonly forbidden: string;
  readonly invalidSelector: Readonly<Record<AgreementSelectorIssue, string>>;
  readonly kinds: Readonly<Record<Contract['kind'], string>>;
  readonly loading: string;
  readonly notFound: string;
  readonly notProvided: string;
  readonly openParent: string;
  readonly parent: string;
  readonly parentPeriod: string;
  readonly status: string;
  readonly unavailable: string;
  readonly unlinked: string;
  readonly updated: string;
  readonly version: string;
}

const czechLabels: DocumentDetailLabels = {
  archived: 'Archivováno',
  back: 'Zpět na smlouvy',
  contractKind: 'Typ smlouvy',
  contractLifecycle: {
    ACTIVE: 'Aktivní',
    DRAFT: 'Návrh',
    EXPIRED: 'Vypršelo',
    TERMINATED: 'Ukončeno',
  },
  contractStatus: 'Stav smlouvy',
  created: 'Vytvořeno',
  document: 'Dokument',
  documentKind: 'Typ dokumentu',
  documentLifecycle: {
    ARCHIVED: 'Archivováno',
    DRAFT: 'Návrh',
    FINAL: 'Finální',
  },
  fileName: 'Název souboru',
  forbidden: 'Pro tuto oblast nemáte oprávnění.',
  invalidSelector: {
    conflicting_selectors: 'Odkaz obsahuje dva různé záznamy. Otevřete prosím jeden z nich.',
    invalid_contract_id: 'Odkaz na smlouvu není platný.',
    invalid_document_id: 'Odkaz na dokument není platný.',
    invalid_selector: 'Odkaz není platný.',
  },
  kinds: {
    LEASE: 'Nájemní smlouva',
    OTHER: 'Obchodní smlouva',
  },
  loading: 'Načítání…',
  notFound: 'Dokument nebyl nalezen nebo k němu nemáte přístup.',
  notProvided: 'neuvedeno',
  openParent: 'Otevřít smlouvu',
  parent: 'Rodičovská smlouva',
  parentPeriod: 'Období smlouvy',
  status: 'Stav dokumentu',
  unavailable: 'Služba je dočasně nedostupná.',
  unlinked: 'Dokument není navázán na smlouvu.',
  updated: 'Aktualizováno',
  version: 'Aktuální verze',
};

const englishLabels: DocumentDetailLabels = {
  archived: 'Archived',
  back: 'Back to contracts',
  contractKind: 'Contract type',
  contractLifecycle: {
    ACTIVE: 'Active',
    DRAFT: 'Draft',
    EXPIRED: 'Expired',
    TERMINATED: 'Terminated',
  },
  contractStatus: 'Contract status',
  created: 'Created',
  document: 'Document',
  documentKind: 'Document type',
  documentLifecycle: {
    ARCHIVED: 'Archived',
    DRAFT: 'Draft',
    FINAL: 'Final',
  },
  fileName: 'File name',
  forbidden: 'You do not have permission for this area.',
  invalidSelector: {
    conflicting_selectors: 'The link names two different records. Open one of them instead.',
    invalid_contract_id: 'The contract link is not valid.',
    invalid_document_id: 'The document link is not valid.',
    invalid_selector: 'The link is not valid.',
  },
  kinds: {
    LEASE: 'Lease agreement',
    OTHER: 'Commercial agreement',
  },
  loading: 'Loading…',
  notFound: 'The document was not found or you do not have access to it.',
  notProvided: 'not provided',
  openParent: 'Open contract',
  parent: 'Parent contract',
  parentPeriod: 'Contract period',
  status: 'Document status',
  unavailable: 'The service is temporarily unavailable.',
  unlinked: 'The document is not linked to a contract.',
  updated: 'Updated',
  version: 'Current version',
};

export const documentDetailLabels = (language: string): DocumentDetailLabels =>
  language === 'en' ? englishLabels : czechLabels;

const contractPeriod = (parent: Contract, labels: DocumentDetailLabels): string => {
  const end = parent.endDate === null ? labels.notProvided : formatDate(parent.endDate);
  return `${formatDate(parent.startDate)} – ${end}`;
};

export interface AgreementDocumentDetailProps {
  readonly archived: boolean;
  readonly document: Document;
  readonly language: string;
  readonly parent?: Contract | undefined;
}

/**
 * The selected legal document as the owner currently records it. Only approved document metadata and the
 * parent contract already present in the same authorized response are shown: no signer, signature reference,
 * counterparty contact, note, OCR text or file bytes.
 */
export const AgreementDocumentDetail = ({ archived, document, language, parent }: AgreementDocumentDetailProps) => {
  const labels = documentDetailLabels(language);
  return (
    <>
      <div>
        <LinkButton
          href={`/${language}/smlouvy`}
          icon="icon-[mdi--arrow-left]"
          size="sm"
          theme="borderless"
          variant="secondary"
        >
          {labels.back}
        </LinkButton>
      </div>
      <PageHeader description={document.kind} title={document.title} />
      <div className="legalagreements:grid legalagreements:grid-cols-1 legalagreements:items-start legalagreements:gap-6 legalagreements:xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="legalagreements:min-w-0 legalagreements:space-y-6">
          <SectionCard title={labels.document}>
            <DetailList
              items={[
                { label: labels.documentKind, value: document.kind },
                { label: labels.fileName, value: document.fileName ?? labels.notProvided },
                { label: labels.version, value: formatDateTime(document.updatedAt) },
                { label: labels.created, value: formatDateTime(document.createdAt) },
              ]}
            />
          </SectionCard>
          <SectionCard title={labels.parent}>
            {parent === undefined ? (
              <p className="legalagreements:text-sm">{labels.unlinked}</p>
            ) : (
              <div className="legalagreements:space-y-4">
                <p className="legalagreements:text-sm legalagreements:font-medium">
                  {parent.subject ?? labels.kinds[parent.kind]}
                </p>
                <DetailList
                  items={[
                    { label: labels.contractKind, value: labels.kinds[parent.kind] },
                    {
                      label: labels.contractStatus,
                      value: labels.contractLifecycle[parent.lifecycleState],
                    },
                    { label: labels.parentPeriod, value: contractPeriod(parent, labels) },
                  ]}
                />
                <a
                  className="legalagreements:inline-flex legalagreements:items-center legalagreements:text-sm legalagreements:underline legalagreements:underline-offset-4"
                  href={`/${language}/smlouvy?resourceId=${parent.contractRef.resourceId}`}
                >
                  {labels.openParent}
                </a>
              </div>
            )}
          </SectionCard>
        </div>
        <div className="legalagreements:min-w-0 legalagreements:space-y-6">
          <SectionCard title={labels.status}>
            <div className="legalagreements:flex legalagreements:flex-wrap legalagreements:gap-2">
              <Badge size="sm" variant={document.lifecycleState === 'ARCHIVED' ? 'outline' : 'success'}>
                {labels.documentLifecycle[document.lifecycleState]}
              </Badge>
              {archived && (
                <Badge size="sm" variant="warning">
                  {labels.archived}
                </Badge>
              )}
            </div>
          </SectionCard>
        </div>
      </div>
    </>
  );
};

export interface AgreementDocumentStatusProps {
  readonly language: string;
  readonly state: Exclude<AgreementDocumentState, AgreementDocumentFound>;
}

/** Missing, forbidden, unavailable and malformed selections stay distinct without exposing a hidden record. */
export const AgreementDocumentStatus = ({ language, state }: AgreementDocumentStatusProps) => {
  const labels = documentDetailLabels(language);
  const message = Match.value(state).pipe(
    Match.tag('Invalid', ({ reason }) => labels.invalidSelector[reason]),
    Match.tag('Forbidden', () => labels.forbidden),
    Match.tag('Unavailable', () => labels.unavailable),
    Match.tag('Pending', () => labels.loading),
    Match.tag('NotFound', () => labels.notFound),
    Match.exhaustive,
  );
  return (
    <>
      <div>
        <LinkButton
          href={`/${language}/smlouvy`}
          icon="icon-[mdi--arrow-left]"
          size="sm"
          theme="borderless"
          variant="secondary"
        >
          {labels.back}
        </LinkButton>
      </div>
      <PageHeader title={labels.document} />
      <output aria-live="polite">{message}</output>
    </>
  );
};
