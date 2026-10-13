import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { BulkTagDialog } from '@app/tagging/components/tag-controls';
import { Option } from 'effect';
import type { Opportunity } from '../../../../../shared/model/opportunity.ts';
import type { PipelineCommand } from './pipeline-api.ts';
import { BulkByTagDialog } from './pipeline-bulk-by-tag.tsx';
import type { BulkByTagResult } from './pipeline-bulk-by-tag.tsx';
import type { FormCommand } from './pipeline-dialogs.tsx';
import { OpportunityFormDialog, OwnerDialog, StageDialog } from './pipeline-dialogs.tsx';
import type { EmployeeId, OpportunityStage } from './pipeline-model.ts';
import { toSubjectIds } from './pipeline-references.ts';
import type { CustomerOption, EmployeeOption, LoadState, ProductOption } from './pipeline-references.ts';

const K = 'sales-pipeline.pages.records';

type OpportunityId = Opportunity['id'];

/** Dialog target: one row from the row menu, or the bulk selection. */
export type Target = { mode: 'row'; opportunity: Opportunity } | { ids: readonly OpportunityId[]; mode: 'bulk' };

export type DialogState =
  | { kind: 'form'; opportunity?: Opportunity }
  | { kind: 'stage'; target: Target }
  | { kind: 'owner'; target: Target }
  | { ids: readonly OpportunityId[]; kind: 'tags' }
  | { kind: 'bulkByTag' };

export const requestedCount = (target: Target) => (target.mode === 'row' ? 1 : target.ids.length);

export const targetIds = (target: Target): OpportunityId[] =>
  target.mode === 'row' ? [target.opportunity.id] : [...target.ids];

export const stageCommand = (target: Target, stage: OpportunityStage, note: string | undefined): PipelineCommand => {
  if (target.mode === 'bulk') {
    return { _tag: 'BulkUpdateOpportunities', ids: targetIds(target), patch: { stage } };
  }
  const base = { _tag: 'ChangeOpportunityStage' as const, id: target.opportunity.id, toStage: stage };
  return note === undefined ? base : { ...base, note };
};

export const ownerCommand = (target: Target, owner: EmployeeId | null): PipelineCommand => {
  const ownerOption: Option.Option<EmployeeId> = owner === null ? Option.none() : Option.some(owner);
  if (target.mode === 'bulk') {
    return { _tag: 'BulkUpdateOpportunities', ids: targetIds(target), patch: { ownerEmployeeId: ownerOption } };
  }
  return { _tag: 'AssignOpportunity', id: target.opportunity.id, ownerEmployeeId: ownerOption };
};

interface PipelineDialogHostProps {
  readonly activeEmployees: readonly EmployeeOption[];
  readonly busy: boolean;
  readonly customerLabel: (partyId: string) => string;
  readonly customers: LoadState<readonly CustomerOption[]>;
  readonly dialog: DialogState | undefined;
  readonly employees: LoadState<readonly EmployeeOption[]>;
  readonly error: string | undefined;
  readonly onBulkByTagDone: (result: BulkByTagResult) => void;
  readonly onBulkTagsDone: () => void;
  readonly onClose: () => void;
  readonly onFormSubmit: (command: FormCommand) => void;
  readonly onOwnerSubmit: (owner: EmployeeId | null) => void;
  readonly onStageSubmit: (stage: OpportunityStage, note: string | undefined) => void;
  readonly products: LoadState<readonly ProductOption[]>;
}

/** Renders the one dialog that is open, if any. */
export const PipelineDialogHost = ({
  activeEmployees,
  busy,
  customerLabel,
  customers,
  dialog,
  employees,
  error,
  onBulkByTagDone,
  onBulkTagsDone,
  onClose,
  onFormSubmit,
  onOwnerSubmit,
  onStageSubmit,
  products,
}: PipelineDialogHostProps) => {
  const { t } = useModernI18n();
  const close = (open: boolean) => {
    if (!open) {
      onClose();
    }
  };

  if (dialog === undefined) {
    return null;
  }
  if (dialog.kind === 'form') {
    return (
      <OpportunityFormDialog
        busy={busy}
        customers={customers}
        employees={employees}
        initial={dialog.opportunity}
        onOpenChange={close}
        onSubmit={onFormSubmit}
        products={products}
        serverError={error}
      />
    );
  }
  if (dialog.kind === 'bulkByTag') {
    return (
      <BulkByTagDialog
        activeEmployees={activeEmployees}
        customerLabel={customerLabel}
        onDone={onBulkByTagDone}
        onOpenChange={close}
      />
    );
  }
  if (dialog.kind === 'tags') {
    return (
      <BulkTagDialog
        kind="opportunity"
        onDone={onBulkTagsDone}
        onOpenChange={close}
        open
        size="lg"
        subjectIds={toSubjectIds(dialog.ids)}
      />
    );
  }
  const { target } = dialog;
  const description =
    target.mode === 'row' ? target.opportunity.title : t(`${K}.bulk.selected`, { total: target.ids.length });
  if (dialog.kind === 'stage') {
    return (
      <StageDialog
        busy={busy}
        currentStage={target.mode === 'row' ? target.opportunity.stage : undefined}
        description={description}
        onOpenChange={close}
        onSubmit={onStageSubmit}
        serverError={error}
        showNote={target.mode === 'row'}
      />
    );
  }
  return (
    <OwnerDialog
      busy={busy}
      currentOwner={target.mode === 'row' ? target.opportunity.ownerEmployeeId : undefined}
      description={description}
      employees={activeEmployees}
      onOpenChange={close}
      onSubmit={onOwnerSubmit}
      serverError={error}
    />
  );
};
