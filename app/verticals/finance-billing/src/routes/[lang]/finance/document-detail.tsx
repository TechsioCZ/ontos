import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import {
  DetailList,
  dialogCloseLabel,
  formatDate,
  formatDateTime,
  formatMoney,
  PageHeader,
  SectionCard,
  StatusBadge,
} from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { DateTime, Effect, Option, Result, Schema } from 'effect';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { FinanceDocument, Invoice } from '../../../../shared/apis/records.ts';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import {
  financeDocumentDetailState,
  financeDocumentInvoiceLink,
  financeDocumentReadLifetime,
} from './finance-document-detail.ts';
import type { FinanceDocumentDetailState, FinanceDocumentInvoiceLink } from './finance-document-detail.ts';
import { downloadBase64, formatBytes, previewUrl } from './finance-ui.tsx';
import type { FinanceViewModel } from './finance-ui.tsx';
import { customerDisplayName, customerOf, invoiceStatusBadge } from './invoice-view.ts';
import { InvoiceDocuments } from './invoice-extras.tsx';
import { InvoiceLifecycleCard } from './invoice-workflow.tsx';

const ns = 'finance-billing.financeUi.documentDetail';

const FileActionSchema = Schema.Literals(['download', 'preview']);
type FileAction = typeof FileActionSchema.Type;
const FileErrorSchema = Schema.Literals(['contentError', 'previewUnavailable']);
type FileError = typeof FileErrorSchema.Type;

interface Preview {
  readonly mimeType: string;
  readonly name: string;
  readonly url: string;
}

const at = (value: DateTime.Utc) => formatDateTime(DateTime.formatIso(value));

const previewable = (mimeType: string) => mimeType === 'application/pdf' || mimeType.startsWith('image/');

const invoiceDetailHref = (invoiceId: string) => {
  const url = new URL(window.location.href);
  url.searchParams.delete('documentId');
  url.searchParams.set('resourceId', invoiceId);
  return `${url.pathname}${url.search}`;
};

const loadDocument = Effect.fn('Finance.documentDetailLoad')(function* loadFinanceDocument(
  vm: FinanceViewModel,
  documentId: string,
  mode: FileAction,
  update: {
    readonly isCurrent: () => boolean;
    readonly setError: (error: FileError | undefined) => void;
    readonly setPending: (pending: boolean) => void;
    readonly setPreview: (preview: Preview | undefined) => void;
  },
) {
  const { isCurrent, setError, setPending, setPreview } = update;
  setError(undefined);
  setPending(true);
  const loaded = yield* Effect.result(vm.fetchDocument(documentId)).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (isCurrent()) {
          setPending(false);
        }
      }),
    ),
  );
  if (!isCurrent()) {
    return;
  }
  if (Result.isFailure(loaded) || Option.isNone(loaded.success)) {
    setError('contentError');
    return;
  }
  const content = loaded.success.value;
  if (mode === 'download') {
    downloadBase64(content.contentBase64, content.mimeType, content.fileName);
    return;
  }
  if (!previewable(content.mimeType)) {
    setError('previewUnavailable');
    return;
  }
  setPreview({
    mimeType: content.mimeType,
    name: content.fileName,
    url: previewUrl(content.contentBase64, content.mimeType),
  });
});

const DocumentBack = ({ onBack }: { readonly onBack: () => void }) => {
  const { t } = useModernI18n();
  return (
    <div className="print:hidden">
      <Button
        className="whitespace-nowrap"
        icon="icon-[mdi--arrow-left]"
        onClick={onBack}
        size="sm"
        theme="borderless"
        variant="secondary"
      >
        {t(`${ns}.back`)}
      </Button>
    </div>
  );
};

const DocumentError = ({ error }: { readonly error: FileError | undefined }) => {
  const { t } = useModernI18n();
  if (error === undefined) {
    return null;
  }
  return (
    <StatusText aria-live="polite" showIcon status="error">
      {t(`${ns}.${error}`)}
    </StatusText>
  );
};

type ClosedDocumentDetail = Exclude<FinanceDocumentDetailState, { readonly state: 'ready' }>;

const ClosedDocument = ({
  detail,
  onBack,
  onRetry,
}: {
  readonly detail: ClosedDocumentDetail;
  readonly onBack: () => void;
  readonly onRetry: () => void;
}) => {
  const { t } = useModernI18n();
  return (
    <section className="flex min-w-0 flex-col gap-250">
      <DocumentBack onBack={onBack} />
      {detail.state === 'loading' ? (
        <StatusText aria-live="polite" showIcon status="default">
          {t(`${ns}.loading`)}
        </StatusText>
      ) : (
        <StatusText aria-live="polite" showIcon status={detail.state === 'missing' ? 'warning' : 'error'}>
          {t(`${ns}.${detail.state}`)}
        </StatusText>
      )}
      {detail.state === 'missing' || detail.state === 'unavailable' ? (
        <Button className="self-start" onClick={onRetry} size="sm" theme="outlined" variant="secondary">
          {t(`${ns}.retry`)}
        </Button>
      ) : null}
    </section>
  );
};

const DocumentMeta = ({
  invoice,
  referenceDate,
}: {
  readonly invoice: Invoice | undefined;
  readonly referenceDate: string;
}) => (invoice === undefined ? null : <StatusBadge {...invoiceStatusBadge(invoice, referenceDate)} />);

const DocumentDescription = ({
  link,
  number,
}: {
  readonly link: FinanceDocumentInvoiceLink;
  readonly number: string | undefined;
}) => {
  const { t } = useModernI18n();
  if (link.kind === 'missing') {
    return t(`${ns}.invoiceUnavailable`);
  }
  if (link.kind === 'none' || number === undefined) {
    return t(`${ns}.withoutInvoice`);
  }
  return t(`${ns}.description`, { number });
};

const DocumentActions = ({
  mimeType,
  onLoad,
  pending,
}: {
  readonly mimeType: string;
  readonly onLoad: (mode: FileAction) => void;
  readonly pending: FileAction | undefined;
}) => {
  const { t } = useModernI18n();
  return (
    <div className="flex flex-wrap gap-100">
      <Button
        disabled={pending !== undefined || !previewable(mimeType)}
        icon="icon-[mdi--eye-outline]"
        isLoading={pending === 'preview'}
        loadingText={t(`${ns}.loadingFile`)}
        onClick={() => onLoad('preview')}
        size="sm"
        theme="outlined"
        variant="secondary"
      >
        {t(`${ns}.preview`)}
      </Button>
      <Button
        disabled={pending !== undefined}
        icon="icon-[mdi--download]"
        isLoading={pending === 'download'}
        loadingText={t(`${ns}.loadingFile`)}
        onClick={() => onLoad('download')}
        size="sm"
        variant="primary"
      >
        {t(`${ns}.download`)}
      </Button>
    </div>
  );
};

const DocumentMetadata = ({
  document,
  link,
  number,
}: {
  readonly document: FinanceDocument;
  readonly link: FinanceDocumentInvoiceLink;
  readonly number: string | undefined;
}) => {
  const { t } = useModernI18n();
  let linkedValue: ReactNode = t(`${ns}.noLinkedInvoice`);
  if (link.kind === 'missing') {
    linkedValue = t(`${ns}.invoiceUnavailable`);
  } else if (link.kind === 'linked' && number !== undefined) {
    linkedValue = (
      <a className="font-medium underline" href={invoiceDetailHref(link.invoice.ref.resourceId)}>
        {number}
      </a>
    );
  }
  return (
    <SectionCard title={t(`${ns}.title`)}>
      <DetailList
        items={[
          { label: t(`${ns}.file`), value: document.fileName },
          { label: t(`${ns}.fileType`), value: document.mimeType },
          { label: t(`${ns}.size`), value: formatBytes(document.sizeBytes) },
          { label: t(`${ns}.uploadedAt`), value: at(document.uploadedAt) },
          { label: t(`${ns}.uploadedBy`), value: document.actorLabel ?? t(`${ns}.unknownActor`) },
          { label: t(`${ns}.linkedInvoice`), value: linkedValue },
        ]}
      />
    </SectionCard>
  );
};

const LinkedInvoice = ({ link, vm }: { readonly link: FinanceDocumentInvoiceLink; readonly vm: FinanceViewModel }) => {
  const { t } = useModernI18n();
  if (link.kind === 'none') {
    return (
      <SectionCard title={t(`${ns}.linkedInvoice`)}>
        <p className="text-fg-secondary text-sm">{t(`${ns}.noLinkedInvoice`)}</p>
      </SectionCard>
    );
  }
  if (link.kind === 'missing') {
    return (
      <SectionCard title={t(`${ns}.linkedInvoice`)}>
        <StatusText showIcon status="warning">
          {t(`${ns}.invoiceUnavailable`)}
        </StatusText>
      </SectionCard>
    );
  }
  const { invoice } = link;
  const customer = customerOf(vm.references.customerById, invoice);
  const number = invoice.number ?? invoice.documentNumber;
  const href = invoiceDetailHref(invoice.ref.resourceId);
  return (
    <SectionCard
      actions={
        <a className="text-sm underline" href={href}>
          {t(`${ns}.openInvoice`)}
        </a>
      }
      title={t(`${ns}.linkedInvoice`)}
    >
      <DetailList
        items={[
          {
            label: t(`${ns}.invoiceNumber`),
            value: (
              <a className="font-medium underline" href={href}>
                {number}
              </a>
            ),
          },
          {
            label: t(`${ns}.invoiceCustomer`),
            value: customerDisplayName(
              customer,
              invoice.counterpartyName ?? t('finance-billing.faktury.unknownCustomer'),
            ),
          },
          { label: t(`${ns}.invoiceTotal`), value: formatMoney(invoice.totalMinor) },
          { label: t(`${ns}.invoiceDue`), value: formatDate(invoice.dueDate) },
        ]}
      />
    </SectionCard>
  );
};

const DocumentHistory = ({
  document,
  linkedInvoice,
  number,
  vm,
}: {
  readonly document: FinanceDocument;
  readonly linkedInvoice: Invoice | undefined;
  readonly number: string | undefined;
  readonly vm: FinanceViewModel;
}) => {
  const { t } = useModernI18n();
  return (
    <>
      <SectionCard title={t(`${ns}.history`)}>
        <ol className="flex flex-col gap-100 text-sm">
          <li>
            <time dateTime={DateTime.formatIso(document.uploadedAt)}>{at(document.uploadedAt)}</time>{' '}
            {t(`${ns}.uploadedEvent`)}
          </li>
          {linkedInvoice === undefined || number === undefined ? null : (
            <li>
              {t(`${ns}.linkedEvent`)}{' '}
              <a className="underline" href={invoiceDetailHref(linkedInvoice.ref.resourceId)}>
                {number}
              </a>
            </li>
          )}
        </ol>
        {linkedInvoice === undefined ? null : (
          <div className="mt-150">
            <InvoiceLifecycleCard invoice={linkedInvoice} vm={vm} />
          </div>
        )}
      </SectionCard>
      {linkedInvoice === undefined ? null : <InvoiceDocuments invoice={linkedInvoice} vm={vm} />}
    </>
  );
};

const DocumentPreviewBody = ({ preview }: { readonly preview: Preview | undefined }) => {
  if (preview === undefined) {
    return null;
  }
  if (preview.mimeType === 'application/pdf') {
    return (
      <iframe
        className="h-[70vh] w-full rounded-md border border-border-primary"
        sandbox="allow-same-origin"
        src={preview.url}
        title={preview.name}
      />
    );
  }
  return <img alt={preview.name} className="max-h-[70vh] w-full object-contain" src={preview.url} />;
};

const DocumentPreviewDialog = ({
  onClose,
  preview,
}: {
  readonly onClose: () => void;
  readonly preview: Preview | undefined;
}) => (
  <Dialog
    closeLabel={dialogCloseLabel}
    customTrigger
    onOpenChange={(details) => {
      if (!details.open) {
        onClose();
      }
    }}
    open={preview !== undefined}
    placement="center"
    size="xl"
    title={preview?.name ?? ''}
  >
    <DocumentPreviewBody preview={preview} />
  </Dialog>
);

const ReadyFinanceDocumentDetail = ({
  document,
  vm,
}: {
  readonly document: FinanceDocument;
  readonly vm: FinanceViewModel;
}) => {
  const [error, setError] = useState<FileError>();
  const [pending, setPending] = useState<FileAction>();
  const [preview, setPreview] = useState<Preview>();
  const readLifetime = useRef<ReturnType<typeof financeDocumentReadLifetime> | null>(null);
  useEffect(() => {
    const lifetime = financeDocumentReadLifetime();
    readLifetime.current = lifetime;
    return () => {
      lifetime.invalidate();
      if (readLifetime.current === lifetime) {
        readLifetime.current = null;
      }
    };
  }, []);
  useEffect(
    () => () => {
      if (preview !== undefined) {
        URL.revokeObjectURL(preview.url);
      }
    },
    [preview],
  );
  const linked = financeDocumentInvoiceLink(vm.invoices, document);
  const linkedInvoice = linked.kind === 'linked' ? linked.invoice : undefined;
  const number = linkedInvoice?.number ?? linkedInvoice?.documentNumber;
  const load = (mode: FileAction) => {
    const isCurrent = readLifetime.current?.begin();
    if (isCurrent === undefined) {
      return;
    }
    void financeBrowserRuntime.runPromise(
      loadDocument(vm, document.id, mode, {
        isCurrent,
        setError,
        setPending: (next) => setPending(next ? mode : undefined),
        setPreview,
      }),
    );
  };
  return (
    <section className="flex min-w-0 flex-col gap-250 text-fg-primary">
      <DocumentBack onBack={() => vm.closeDocumentDetail()} />
      <PageHeader
        actions={<DocumentActions mimeType={document.mimeType} onLoad={(mode) => load(mode)} pending={pending} />}
        description={<DocumentDescription link={linked} number={number} />}
        meta={<DocumentMeta invoice={linkedInvoice} referenceDate={vm.referenceDate} />}
        title={document.fileName}
      />
      <DocumentError error={error} />
      <DocumentMetadata document={document} link={linked} number={number} />
      <LinkedInvoice link={linked} vm={vm} />
      <DocumentHistory document={document} linkedInvoice={linkedInvoice} number={number} vm={vm} />
      <DocumentPreviewDialog onClose={() => setPreview(undefined)} preview={preview} />
    </section>
  );
};

export const FinanceDocumentDetail = ({
  documentId,
  vm,
}: {
  readonly documentId: string;
  readonly vm: FinanceViewModel;
}) => {
  const detail = financeDocumentDetailState({
    documentId,
    documents: vm.snapshot?.state.documents,
    feedback: vm.feedback,
  });
  if (detail.state !== 'ready') {
    return <ClosedDocument detail={detail} onBack={() => vm.closeDocumentDetail()} onRetry={() => vm.reload()} />;
  }
  return <ReadyFinanceDocumentDetail document={detail.document} key={documentId} vm={vm} />;
};
