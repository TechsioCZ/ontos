/* eslint-disable promise/prefer-await-to-then -- React event handlers settle caller-owned promises without introducing async Effect lint violations. */
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Toaster, useToast } from '@techsio/ui-kit/molecules/toast';
import { Table } from '@techsio/ui-kit/organisms/table';
import { useId, useRef, useState } from 'react';
import type { FormEvent, MouseEvent, RefObject } from 'react';
import {
  customerFieldNames,
  customerFormValuesFromDetail,
  emptyCustomerFormValues,
  validateCustomerForm,
} from './customer-view-model.ts';
import type {
  CustomerDetailModel,
  CustomerFieldName,
  CustomerFormIssue,
  CustomerFormValues,
  CustomerMutationResult,
  CustomerWorkspaceCopy,
  CustomerWorkspaceProps,
} from './customer-view-model.ts';

interface CrudFailureCopy {
  readonly issues: { readonly server_validation: string };
  readonly states: {
    readonly conflict: string;
    readonly forbidden: string;
    readonly notFound: string;
    readonly unavailable: string;
  };
}

type CrudFailure<Issue> =
  | { readonly issues: readonly Issue[]; readonly state: 'validation' }
  | { readonly state: 'conflict' | 'forbidden' | 'not_found' | 'unavailable' };

export const crudMutationMessage = <Issue,>(result: CrudFailure<Issue>, copy: CrudFailureCopy) => {
  switch (result.state) {
    case 'conflict': {
      return copy.states.conflict;
    }
    case 'forbidden': {
      return copy.states.forbidden;
    }
    case 'not_found': {
      return copy.states.notFound;
    }
    case 'unavailable': {
      return copy.states.unavailable;
    }
    case 'validation': {
      return copy.issues.server_validation;
    }
    default: {
      return result satisfies never;
    }
  }
};

interface CrudFormStateOptions<
  Values,
  Field extends string,
  Issue extends { readonly field?: Field },
  Success extends { readonly state: 'success' },
> {
  readonly initialValues: Values;
  readonly mutationMessage: (failure: CrudFailure<Issue>) => string;
  readonly onSubmit: (values: Values) => Promise<Success | CrudFailure<Issue>>;
  readonly onSuccess: (result: Success) => void;
  readonly validate: (values: Values) => readonly Issue[];
}

export const useCrudFormState = <
  Values,
  Field extends string,
  Issue extends { readonly field?: Field },
  Success extends { readonly state: 'success' },
>({
  initialValues,
  mutationMessage,
  onSubmit,
  onSuccess,
  validate,
}: CrudFormStateOptions<Values, Field, Issue, Success>) => {
  const formId = useId();
  const [values, setValues] = useState(initialValues);
  const [issues, setIssues] = useState<readonly Issue[]>([]);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [failure, setFailure] = useState<string>();
  const fieldRefs = useRef<Partial<Record<Field, HTMLInputElement | null>>>({});
  const summaryRef = useRef<HTMLDivElement>(null);
  const issueFor = (field: Field) => issues.find((issue) => issue.field === field);
  const setFieldElement = (field: Field, element: HTMLInputElement | null) => {
    fieldRefs.current[field] = element;
  };
  const setSummaryElement = (element: HTMLDivElement | null) => {
    summaryRef.current = element;
  };
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pendingRef.current) {
      return;
    }
    const clientIssues = validate(values);
    setIssues(clientIssues);
    setFailure(undefined);
    if (clientIssues.length > 0) {
      const firstField = clientIssues.find((issue) => issue.field !== undefined)?.field;
      requestAnimationFrame(() => {
        if (firstField === undefined) {
          summaryRef.current?.focus();
        } else {
          fieldRefs.current[firstField]?.focus();
        }
      });
      return;
    }
    pendingRef.current = true;
    setPending(true);
    void onSubmit(values)
      .then((result) => {
        if (result.state === 'success') {
          onSuccess(result);
          return;
        }
        setFailure(mutationMessage(result));
        if (result.state === 'validation') {
          setIssues(result.issues);
          requestAnimationFrame(() => summaryRef.current?.focus());
        }
      })
      .finally(() => {
        pendingRef.current = false;
        setPending(false);
      });
  };
  return {
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
  };
};

type CrudDeleteResult =
  | { readonly state: 'success' }
  | { readonly state: 'conflict' | 'forbidden' | 'not_found' | 'unavailable' };

interface CrudDeleteStateOptions<Selected> {
  readonly failureMessage: (failure: Exclude<CrudDeleteResult, { state: 'success' }>) => string;
  readonly onDelete: (selected: Selected) => Promise<CrudDeleteResult>;
  readonly onSuccess: () => void;
  readonly selected: Selected | undefined;
}

export const useCrudDeleteState = <Selected,>({
  failureMessage,
  onDelete,
  onSuccess,
  selected,
}: CrudDeleteStateOptions<Selected>) => {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [failure, setFailure] = useState<string>();
  const handleDelete = () => {
    if (selected === undefined || pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setFailure(undefined);
    void onDelete(selected)
      .then((result) => {
        if (result.state === 'success') {
          setOpen(false);
          onSuccess();
          return;
        }
        setFailure(failureMessage(result));
      })
      .finally(() => {
        pendingRef.current = false;
        setPending(false);
      });
  };
  const onOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !pending) {
      setOpen(false);
      setFailure(undefined);
    }
  };
  return { failure, handleDelete, onOpenChange, open, pending, setOpen };
};

interface CustomerFormDialogProps {
  readonly copy: CustomerWorkspaceCopy;
  readonly customer?: CustomerDetailModel;
  readonly finalFocusRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
  readonly onSubmit: (values: CustomerFormValues) => Promise<CustomerMutationResult>;
  readonly onSuccess: (result: Extract<CustomerMutationResult, { state: 'success' }>) => void;
  readonly open: boolean;
}

const CustomerFormDialog = ({
  copy,
  customer,
  finalFocusRef,
  onClose,
  onSubmit,
  onSuccess,
  open,
}: CustomerFormDialogProps) => {
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
    CustomerFormValues,
    CustomerFieldName,
    CustomerFormIssue,
    Extract<CustomerMutationResult, { state: 'success' }>
  >({
    initialValues:
      customer === undefined ? emptyCustomerFormValues : customerFormValuesFromDetail(customer),
    mutationMessage: (result) => crudMutationMessage(result, copy),
    onSubmit,
    onSuccess,
    validate: validateCustomerForm,
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
      title={customer === undefined ? copy.form.createTitle : copy.form.editTitle}
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
          {customerFieldNames.map((field) => {
            const issue = issueFor(field);
            const issueId = issue === undefined ? undefined : `${formId}-${field}-issue`;
            let inputType = 'text';
            if (field === 'email') {
              inputType = 'email';
            } else if (field === 'website') {
              inputType = 'url';
            }
            return (
              <FormInput
                aria-describedby={issueId}
                aria-invalid={issue === undefined ? undefined : true}
                autoComplete={field === 'name' ? 'organization' : 'off'}
                disabled={pending}
                helpText={
                  issue === undefined ? undefined : (
                    <span id={issueId}>{copy.issues[issue.code]}</span>
                  )
                }
                id={`${formId}-${field}`}
                key={field}
                label={copy.fields[field]}
                maxLength={field === 'website' ? 2048 : undefined}
                name={field}
                onChange={(event) => {
                  const nextValue = event.currentTarget.value;
                  setValues((current) => ({ ...current, [field]: nextValue }));
                }}
                ref={(element) => {
                  setFieldElement(field, element);
                }}
                required={field === 'name'}
                type={inputType}
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
            {customer === undefined ? copy.actions.create : copy.actions.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

export const CrudStatePanel = ({
  children,
  status = 'default',
}: {
  readonly children: string;
  readonly status?: 'default' | 'error' | 'warning';
}) => (
  <div className="crm:bg-(--color-surface) crm:p-6">
    <StatusText aria-live="polite" showIcon status={status}>
      {children}
    </StatusText>
  </div>
);

export const CustomerWorkspace = ({
  copy,
  model,
  onCreate,
  onDelete,
  onEdit,
  onNavigate,
  onRetry,
  writable,
}: CustomerWorkspaceProps) => {
  const toast = useToast();
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const editTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const [formMode, setFormMode] = useState<'create' | 'edit'>();
  const selected = model.state === 'resolved' ? model.detail : undefined;
  const deletion = useCrudDeleteState({
    failureMessage: (result) => crudMutationMessage(result, copy),
    onDelete,
    onSuccess: () => toast.create({ title: copy.toast.deleted, type: 'success' }),
    selected,
  });

  const navigate = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    event.preventDefault();
    onNavigate(href);
  };

  const announceSuccess = (title: string) => {
    setFormMode(undefined);
    toast.create({ title, type: 'success' });
  };

  return (
    <>
      <Toaster />
      {!writable && (
        <StatusText aria-live="polite" showIcon status="warning">
          {copy.states.readOnly}
        </StatusText>
      )}
      {model.state === 'loading' && <CrudStatePanel>{copy.states.loading}</CrudStatePanel>}
      {model.state === 'forbidden' && (
        <CrudStatePanel status="error">{copy.states.forbidden}</CrudStatePanel>
      )}
      {model.state === 'not_found' && (
        <CrudStatePanel status="warning">{copy.states.notFound}</CrudStatePanel>
      )}
      {model.state === 'validation' && (
        <section className="crm:grid crm:gap-4 crm:bg-(--color-surface) crm:p-6">
          <StatusText aria-live="polite" showIcon status="error">
            {copy.states.validation[model.reason]}
          </StatusText>
          <Link href={model.resetHref} onClick={(event) => navigate(event, model.resetHref)}>
            {copy.actions.retry}
          </Link>
        </section>
      )}
      {model.state === 'unavailable' && (
        <section className="crm:grid crm:gap-4 crm:bg-(--color-surface) crm:p-6">
          <StatusText aria-live="polite" showIcon status="error">
            {copy.states.unavailable}
          </StatusText>
          <Button onClick={onRetry} theme="outlined" variant="secondary">
            {copy.actions.retry}
          </Button>
        </section>
      )}
      {(model.state === 'empty' || model.state === 'resolved') && (
        <div className="crm:grid crm:gap-6 crm:lg:grid-cols-[minmax(0,3fr)_minmax(18rem,2fr)]">
          <section aria-labelledby="customer-list-heading" className="crm:min-w-0 crm:space-y-4">
            <div className="crm:flex crm:flex-wrap crm:items-center crm:justify-between crm:gap-3">
              <h2 className="crm:text-xl crm:font-semibold" id="customer-list-heading">
                {copy.list.caption}
              </h2>
              {writable && (
                <Button
                  onClick={() => setFormMode('create')}
                  ref={createTriggerRef}
                  variant="primary"
                >
                  {copy.actions.create}
                </Button>
              )}
            </div>
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
                        <Table.ColumnHeader scope="col">
                          {copy.list.companyRegistrationNumber}
                        </Table.ColumnHeader>
                        <Table.ColumnHeader scope="col">{copy.list.email}</Table.ColumnHeader>
                        <Table.ColumnHeader scope="col">{copy.list.city}</Table.ColumnHeader>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {model.rows.map((row) => (
                        <Table.Row key={row.customerId} selected={row.selected}>
                          <Table.Cell className="crm:max-w-72 crm:whitespace-normal crm:break-words">
                            <Link href={row.href} onClick={(event) => navigate(event, row.href)}>
                              {row.name}
                            </Link>
                          </Table.Cell>
                          <Table.Cell className="crm:break-all">
                            {row.companyRegistrationNumber ?? copy.detail.notProvided}
                          </Table.Cell>
                          <Table.Cell className="crm:break-all">
                            {row.email ?? copy.detail.notProvided}
                          </Table.Cell>
                          <Table.Cell className="crm:break-words">
                            {row.city ?? copy.detail.notProvided}
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table>
                </div>
                <ul className="crm:grid crm:gap-3 crm:sm:hidden">
                  {model.rows.map((row) => (
                    <li className="crm:bg-(--color-surface) crm:p-4" key={row.customerId}>
                      <Link
                        className="crm:block crm:break-words crm:font-semibold"
                        href={row.href}
                        onClick={(event) => navigate(event, row.href)}
                      >
                        {row.name}
                      </Link>
                      <dl className="crm:mt-2 crm:grid crm:gap-1 crm:text-sm">
                        <div className="crm:flex crm:flex-wrap crm:gap-2">
                          <dt className="crm:font-medium">{copy.list.companyRegistrationNumber}</dt>
                          <dd className="crm:break-all">
                            {row.companyRegistrationNumber ?? copy.detail.notProvided}
                          </dd>
                        </div>
                        <div className="crm:flex crm:flex-wrap crm:gap-2">
                          <dt className="crm:font-medium">{copy.list.email}</dt>
                          <dd className="crm:break-all">{row.email ?? copy.detail.notProvided}</dd>
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
            aria-labelledby="customer-detail-heading"
            className="crm:min-w-0 crm:bg-(--color-surface) crm:p-5"
          >
            <h2 className="crm:text-xl crm:font-semibold" id="customer-detail-heading">
              {copy.detail.heading}
            </h2>
            {selected === undefined ? (
              <p className="crm:mt-4">{copy.detail.selectPrompt}</p>
            ) : (
              <div className="crm:mt-4 crm:grid crm:gap-5">
                <h3 className="crm:break-words crm:text-lg crm:font-semibold">{selected.name}</h3>
                <dl className="crm:grid crm:gap-3">
                  {selected.fields.map((field) => (
                    <div key={field.key}>
                      <dt className="crm:font-medium">{copy.fields[field.key]}</dt>
                      <dd className="crm:break-words">{field.value ?? copy.detail.notProvided}</dd>
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
        <CustomerFormDialog
          copy={copy}
          finalFocusRef={createTriggerRef}
          onClose={() => setFormMode(undefined)}
          onSubmit={onCreate}
          onSuccess={() => announceSuccess(copy.toast.created)}
          open
        />
      )}
      {formMode === 'edit' && selected !== undefined && (
        <CustomerFormDialog
          copy={copy}
          customer={selected}
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
          description={copy.deleteDialog.description(selected.name)}
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
    </>
  );
};
