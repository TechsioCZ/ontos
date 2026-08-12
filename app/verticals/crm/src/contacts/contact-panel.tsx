/* eslint-disable promise/prefer-await-to-then -- React event handlers settle caller-owned promises without introducing async Effect lint violations. */
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Table } from '@techsio/ui-kit/organisms/table';
import { useRef, useState } from 'react';
import type { MouseEvent, RefObject } from 'react';
import {
  CrudStatePanel,
  crudMutationMessage,
  useCrudDeleteState,
  useCrudFormState,
} from '../customers/customer-workspace.tsx';
import {
  contactFieldNames,
  contactFormValuesFromDetail,
  emptyContactFormValues,
  formatContactDisplayName,
  validateContactForm,
} from './contact-view-model.ts';
import type {
  ContactDetailModel,
  ContactFieldName,
  ContactFormIssue,
  ContactFormValues,
  ContactMutationResult,
  ContactPanelCopy,
  ContactPanelModel,
  ContactPanelProps,
} from './contact-view-model.ts';

interface ContactFormDialogProps {
  readonly contact?: ContactDetailModel;
  readonly copy: ContactPanelCopy;
  readonly finalFocusRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
  readonly onSubmit: (values: ContactFormValues) => Promise<ContactMutationResult>;
  readonly onSuccess: () => void;
  readonly open: boolean;
}

const contactInputAttributes = (field: ContactFieldName) => {
  switch (field) {
    case 'email': {
      return { autoComplete: 'email', type: 'email' } as const;
    }
    case 'firstName': {
      return { autoComplete: 'given-name', type: 'text' } as const;
    }
    case 'jobTitle': {
      return { autoComplete: 'organization-title', type: 'text' } as const;
    }
    case 'lastName': {
      return { autoComplete: 'family-name', type: 'text' } as const;
    }
    case 'phone': {
      return { autoComplete: 'tel', type: 'tel' } as const;
    }
    default: {
      return field satisfies never;
    }
  }
};

const ContactFormDialog = ({
  contact,
  copy,
  finalFocusRef,
  onClose,
  onSubmit,
  onSuccess,
  open,
}: ContactFormDialogProps) => {
  const {
    failure,
    formId,
    handleSubmit,
    issueFor,
    issues,
    pending,
    setFieldElement,
    setSummaryElement,
    setValues,
    values,
  } = useCrudFormState<
    ContactFormValues,
    ContactFieldName,
    ContactFormIssue,
    Extract<ContactMutationResult, { state: 'success' }>
  >({
    initialValues:
      contact === undefined ? emptyContactFormValues : contactFormValuesFromDetail(contact),
    mutationMessage: (result) => crudMutationMessage(result, copy),
    onSubmit,
    onSuccess,
    validate: validateContactForm,
  });

  return (
    <Dialog
      closeOnEscape={!pending}
      closeOnInteractOutside={!pending}
      customTrigger
      finalFocusEl={() => finalFocusRef.current}
      hideCloseButton
      onOpenChange={({ open: nextOpen }) => {
        if (!nextOpen && !pending) {
          onClose();
        }
      }}
      open={open}
      size="lg"
      title={contact === undefined ? copy.form.createTitle : copy.form.editTitle}
    >
      <form className="crm:grid crm:gap-5" id={formId} onSubmit={handleSubmit}>
        {(issues.length > 0 || failure !== undefined) && (
          <div ref={setSummaryElement} tabIndex={-1}>
            <StatusText aria-live="assertive" showIcon status="error">
              {failure ?? copy.form.summary}
            </StatusText>
          </div>
        )}
        <div className="crm:grid crm:gap-4 crm:sm:grid-cols-2">
          {contactFieldNames.map((field) => {
            const issue = issueFor(field);
            const issueId = issue === undefined ? undefined : `${formId}-${field}-issue`;
            const inputAttributes = contactInputAttributes(field);
            return (
              <FormInput
                aria-describedby={issueId}
                aria-invalid={issue === undefined ? undefined : true}
                autoComplete={inputAttributes.autoComplete}
                disabled={pending}
                helpText={
                  issue === undefined ? undefined : (
                    <span id={issueId}>{copy.issues[issue.code]}</span>
                  )
                }
                id={`${formId}-${field}`}
                key={field}
                label={copy.fields[field]}
                name={field}
                onChange={(event) => {
                  const nextValue = event.currentTarget.value;
                  setValues((current) => ({ ...current, [field]: nextValue }));
                }}
                ref={(element) => {
                  setFieldElement(field, element);
                }}
                type={inputAttributes.type}
                validateStatus={issue === undefined ? 'default' : 'error'}
                value={values[field]}
              />
            );
          })}
        </div>
        <div className="crm:flex crm:flex-wrap crm:justify-end crm:gap-3">
          <Button
            disabled={pending}
            onClick={onClose}
            theme="outlined"
            type="button"
            variant="secondary"
          >
            {copy.actions.cancel}
          </Button>
          <Button
            isLoading={pending}
            loadingText={copy.form.pending}
            type="submit"
            variant="primary"
          >
            {contact === undefined ? copy.actions.create : copy.actions.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

interface ContactReadStateProps {
  readonly copy: ContactPanelCopy;
  readonly model: ContactPanelModel;
  readonly onNavigate: (href: string) => void;
  readonly onRetry: () => void;
}

const ContactReadState = ({ copy, model, onNavigate, onRetry }: ContactReadStateProps) => {
  switch (model.state) {
    case 'loading': {
      return <CrudStatePanel>{copy.states.loading}</CrudStatePanel>;
    }
    case 'forbidden': {
      return <CrudStatePanel status="error">{copy.states.forbidden}</CrudStatePanel>;
    }
    case 'not_found': {
      return <CrudStatePanel status="warning">{copy.states.notFound}</CrudStatePanel>;
    }
    case 'conflict': {
      return (
        <div className="crm:grid crm:gap-4 crm:bg-(--color-surface) crm:p-5">
          <StatusText aria-live="polite" showIcon status="warning">
            {copy.states.conflict}
          </StatusText>
          <Button onClick={onRetry} theme="outlined" variant="secondary">
            {copy.actions.retry}
          </Button>
        </div>
      );
    }
    case 'validation': {
      return (
        <div className="crm:grid crm:gap-4 crm:bg-(--color-surface) crm:p-5">
          <StatusText aria-live="polite" showIcon status="error">
            {copy.states.validation[model.reason]}
          </StatusText>
          <Link
            href={model.resetHref}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(model.resetHref);
            }}
          >
            {copy.actions.retry}
          </Link>
        </div>
      );
    }
    case 'unavailable': {
      return (
        <div className="crm:grid crm:gap-4 crm:bg-(--color-surface) crm:p-5">
          <StatusText aria-live="polite" showIcon status="error">
            {copy.states.unavailable}
          </StatusText>
          <Button onClick={onRetry} theme="outlined" variant="secondary">
            {copy.actions.retry}
          </Button>
        </div>
      );
    }
    case 'empty':
    case 'resolved': {
      return null;
    }
    default: {
      return model satisfies never;
    }
  }
};

export const ContactPanel = ({
  copy,
  model,
  onCreate,
  onDelete,
  onEdit,
  onMutationSuccess,
  onNavigate,
  onRetry,
  writable,
}: ContactPanelProps) => {
  const toast = useToast();
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const editTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const [formMode, setFormMode] = useState<'create' | 'edit'>();
  const selected = model.state === 'resolved' ? model.detail : undefined;
  const selectedDisplayName =
    selected === undefined ? undefined : formatContactDisplayName(selected, copy.nameFallback);
  const deletion = useCrudDeleteState({
    failureMessage: (result) => crudMutationMessage(result, copy),
    onDelete,
    onSuccess: () => {
      toast.create({ title: copy.toast.deleted, type: 'success' });
      requestAnimationFrame(onMutationSuccess);
    },
    selected,
  });

  const navigate = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    event.preventDefault();
    onNavigate(href);
  };

  const announceSuccess = (title: string) => {
    setFormMode(undefined);
    toast.create({ title, type: 'success' });
    requestAnimationFrame(onMutationSuccess);
  };

  return (
    <section aria-labelledby="contact-panel-heading" className="crm:grid crm:gap-5">
      <div className="crm:flex crm:flex-wrap crm:items-center crm:justify-between crm:gap-3">
        <h2 className="crm:break-words crm:text-xl crm:font-semibold" id="contact-panel-heading">
          {copy.heading(model.customerName)}
        </h2>
        {writable && (model.state === 'empty' || model.state === 'resolved') && (
          <Button onClick={() => setFormMode('create')} ref={createTriggerRef} variant="primary">
            {copy.actions.create}
          </Button>
        )}
      </div>
      {!writable && (
        <StatusText aria-live="polite" showIcon status="warning">
          {copy.states.readOnly}
        </StatusText>
      )}
      <ContactReadState copy={copy} model={model} onNavigate={onNavigate} onRetry={onRetry} />
      {(model.state === 'empty' || model.state === 'resolved') && (
        <div className="crm:grid crm:gap-6 crm:lg:grid-cols-[minmax(0,3fr)_minmax(18rem,2fr)]">
          <section aria-labelledby="contact-list-heading" className="crm:min-w-0 crm:space-y-4">
            <h3 className="crm:text-lg crm:font-semibold" id="contact-list-heading">
              {copy.list.caption}
            </h3>
            {model.state === 'empty' ? (
              <CrudStatePanel>{copy.states.empty}</CrudStatePanel>
            ) : (
              <>
                <div className="crm:hidden crm:overflow-x-auto crm:sm:block">
                  <Table interactive variant="line">
                    <Table.Caption>{copy.list.caption}</Table.Caption>
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeader scope="col">{copy.list.name}</Table.ColumnHeader>
                        <Table.ColumnHeader scope="col">{copy.list.email}</Table.ColumnHeader>
                        <Table.ColumnHeader scope="col">{copy.list.phone}</Table.ColumnHeader>
                        <Table.ColumnHeader scope="col">{copy.list.jobTitle}</Table.ColumnHeader>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {model.rows.map((row) => (
                        <Table.Row key={row.contactId} selected={row.selected}>
                          <Table.Cell className="crm:max-w-72 crm:whitespace-normal crm:break-words">
                            <Link href={row.href} onClick={(event) => navigate(event, row.href)}>
                              {formatContactDisplayName(row, copy.nameFallback)}
                            </Link>
                          </Table.Cell>
                          <Table.Cell className="crm:break-all">
                            {row.email ?? copy.detail.notProvided}
                          </Table.Cell>
                          <Table.Cell className="crm:break-all">
                            {row.phone ?? copy.detail.notProvided}
                          </Table.Cell>
                          <Table.Cell className="crm:break-words">
                            {row.jobTitle ?? copy.detail.notProvided}
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table>
                </div>
                <ul className="crm:grid crm:gap-3 crm:sm:hidden">
                  {model.rows.map((row) => (
                    <li className="crm:bg-(--color-surface) crm:p-4" key={row.contactId}>
                      <Link
                        className="crm:block crm:break-words crm:font-semibold"
                        href={row.href}
                        onClick={(event) => navigate(event, row.href)}
                      >
                        {formatContactDisplayName(row, copy.nameFallback)}
                      </Link>
                      <dl className="crm:mt-2 crm:grid crm:gap-1 crm:text-sm">
                        <div className="crm:flex crm:flex-wrap crm:gap-2">
                          <dt className="crm:font-medium">{copy.list.email}</dt>
                          <dd className="crm:break-all">{row.email ?? copy.detail.notProvided}</dd>
                        </div>
                        <div className="crm:flex crm:flex-wrap crm:gap-2">
                          <dt className="crm:font-medium">{copy.list.phone}</dt>
                          <dd className="crm:break-all">{row.phone ?? copy.detail.notProvided}</dd>
                        </div>
                        <div className="crm:flex crm:flex-wrap crm:gap-2">
                          <dt className="crm:font-medium">{copy.list.jobTitle}</dt>
                          <dd className="crm:break-words">
                            {row.jobTitle ?? copy.detail.notProvided}
                          </dd>
                        </div>
                      </dl>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <nav
              aria-label={copy.list.page(model.pagination.page)}
              className="crm:flex crm:items-center crm:justify-between crm:gap-4"
            >
              <span>{copy.list.page(model.pagination.page)}</span>
              {model.pagination.nextHref !== undefined && (
                <Link
                  href={model.pagination.nextHref}
                  onClick={(event) => navigate(event, model.pagination.nextHref ?? '')}
                >
                  {copy.actions.nextPage}
                </Link>
              )}
            </nav>
          </section>
          <aside
            aria-labelledby="contact-detail-heading"
            className="crm:min-w-0 crm:bg-(--color-surface) crm:p-5"
          >
            <h3 className="crm:text-lg crm:font-semibold" id="contact-detail-heading">
              {copy.detail.heading}
            </h3>
            {selected === undefined ? (
              <p className="crm:mt-4">{copy.detail.selectPrompt}</p>
            ) : (
              <div className="crm:mt-4 crm:grid crm:gap-5">
                <h4 className="crm:break-words crm:text-lg crm:font-semibold">
                  {selectedDisplayName}
                </h4>
                <dl className="crm:grid crm:gap-3">
                  {(['email', 'phone', 'jobTitle'] as const).map((field) => (
                    <div key={field}>
                      <dt className="crm:font-medium">{copy.fields[field]}</dt>
                      <dd className="crm:break-words">
                        {selected[field] ?? copy.detail.notProvided}
                      </dd>
                    </div>
                  ))}
                </dl>
                {writable && (
                  <div className="crm:flex crm:flex-wrap crm:gap-3">
                    <Button
                      onClick={() => setFormMode('edit')}
                      ref={editTriggerRef}
                      theme="outlined"
                      variant="secondary"
                    >
                      {copy.actions.edit}
                    </Button>
                    <Button
                      onClick={() => deletion.setOpen(true)}
                      ref={deleteTriggerRef}
                      theme="outlined"
                      variant="danger"
                    >
                      {copy.actions.delete}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>
      )}
      {formMode === 'create' && (
        <ContactFormDialog
          copy={copy}
          finalFocusRef={createTriggerRef}
          onClose={() => setFormMode(undefined)}
          onSubmit={onCreate}
          onSuccess={() => announceSuccess(copy.toast.created)}
          open
        />
      )}
      {formMode === 'edit' && selected !== undefined && (
        <ContactFormDialog
          contact={selected}
          copy={copy}
          finalFocusRef={editTriggerRef}
          onClose={() => setFormMode(undefined)}
          onSubmit={(values) => onEdit(selected, values)}
          onSuccess={() => announceSuccess(copy.toast.updated)}
          open
        />
      )}
      {selected !== undefined && (
        <Dialog
          closeOnEscape={!deletion.pending}
          closeOnInteractOutside={!deletion.pending}
          customTrigger
          description={copy.deleteDialog.description(selectedDisplayName ?? copy.nameFallback)}
          finalFocusEl={() => deleteTriggerRef.current}
          hideCloseButton
          onOpenChange={({ open }) => deletion.onOpenChange(open)}
          open={deletion.open}
          role="alertdialog"
          title={copy.deleteDialog.title}
          actions={
            <div className="crm:flex crm:flex-wrap crm:justify-end crm:gap-3">
              <Button
                disabled={deletion.pending}
                onClick={() => deletion.setOpen(false)}
                theme="outlined"
                type="button"
                variant="secondary"
              >
                {copy.actions.cancel}
              </Button>
              <Button
                isLoading={deletion.pending}
                loadingText={copy.deleteDialog.pending}
                onClick={deletion.handleDelete}
                type="button"
                variant="danger"
              >
                {copy.actions.delete}
              </Button>
            </div>
          }
        >
          {deletion.failure !== undefined && (
            <StatusText aria-live="assertive" showIcon status="error">
              {deletion.failure}
            </StatusText>
          )}
        </Dialog>
      )}
    </section>
  );
};
