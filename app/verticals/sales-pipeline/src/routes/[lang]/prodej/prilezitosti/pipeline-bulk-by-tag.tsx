import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  saveLabelsFor,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import {
  ChoiceField,
  FormBuilder,
  FormReact,
  FormRoot,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { TagIdSchema } from '@app/tagging/contracts/records';
import type { TagId } from '@app/tagging/contracts/records';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Effect, Match, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { Atom } from 'effect/reactivity';
import { useRef, useState } from 'react';
import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { applyPipelineCommand } from './pipeline-api.ts';
import type { PipelineCommand } from './pipeline-api.ts';
import {
  ActionSchema,
  BULK_LIMIT,
  BulkByTagPreview,
  K,
  KindSchema,
  NONE,
  SELECT_PLACEHOLDER,
  patchOf,
  previewOf,
} from './pipeline-bulk-by-tag-fields.tsx';
import type { Action, BulkByTagResult, Kind } from './pipeline-bulk-by-tag-fields.tsx';
import { TagChoice } from './pipeline-filters.tsx';
import { isOpportunityStage, opportunityStages, pipelineConflictKey, skipTally } from './pipeline-model.ts';
import type { OpportunityStage } from './pipeline-model.ts';
import { useAllOpportunities, useSubjectIdsWithTag } from './pipeline-references.ts';
import type { EmployeeOption } from './pipeline-references.ts';

export type { BulkByTagResult } from './pipeline-bulk-by-tag-fields.tsx';

interface BulkByTagDialogProps {
  /** Active employees for the owner picker. */
  readonly activeEmployees: readonly EmployeeOption[];
  readonly customerLabel: (partyId: string) => string;
  readonly onDone: (result: BulkByTagResult) => void;
  readonly onOpenChange: (open: boolean) => void;
}

interface BulkSend {
  readonly command: PipelineCommand;
  readonly requested: number;
  readonly revision: number;
}

/**
 * The bulk change by tag: which tag picks the opportunities and what changes on them. Uložit sends it through the
 * dialog's draft save, so the form itself is never submitted.
 */
const bulkByTagForm = FormReact.make(
  FormBuilder.empty
    .addField('bulkAction', Schema.String)
    .addField('owner', Schema.String)
    .addField('stage', Schema.String)
    .addField('tagId', Schema.OptionFromNullOr(Schema.toType(TagIdSchema)))
    .addField('tagKind', Schema.String),
  {
    fields: { bulkAction: ChoiceField, owner: ChoiceField, stage: ChoiceField, tagId: TagChoice, tagKind: ChoiceField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

type BulkByTagValues = typeof bulkByTagForm.schema.Encoded;

const emptyBulkValues: BulkByTagValues = {
  bulkAction: 'stage',
  owner: '',
  stage: '',
  tagId: null,
  tagKind: 'customer',
};

interface BulkByTagDraft {
  readonly action: Action;
  readonly kind: Kind;
  readonly owner: string;
  readonly stage: OpportunityStage | '';
  readonly tagId: TagId | null;
}

/** The choice the form shows; anything it does not offer reads as its default. */
const bulkDraftOf = (values: BulkByTagValues): BulkByTagDraft => ({
  action: Schema.is(ActionSchema)(values.bulkAction) ? values.bulkAction : 'stage',
  kind: Schema.is(KindSchema)(values.tagKind) ? values.tagKind : 'customer',
  owner: values.owner,
  stage: isOpportunityStage(values.stage) ? values.stage : '',
  tagId: values.tagId,
});

interface BulkByTagValueProps {
  readonly action: Action;
  readonly activeEmployees: readonly EmployeeOption[];
  readonly valueMissing: boolean;
}

/** Action choice and the value for it: a stage or an owner (`Nepřiřazeno` clears it). */
const BulkByTagValueFields = ({ action, activeEmployees, valueMissing }: BulkByTagValueProps) => {
  const { t } = useModernI18n();
  const actionItems = [
    { label: t(`${K}.bulkByTag.actions.stage`), value: 'stage' },
    { label: t(`${K}.bulkByTag.actions.owner`), value: 'owner' },
  ];
  const stageItems = opportunityStages.map((candidate) => ({
    label: t(`sales-pipeline.status.opportunity.${candidate}`),
    value: candidate,
  }));
  const ownerItems = [
    { label: t(`${K}.owner.none`), value: NONE },
    ...activeEmployees.map((employee) => ({ label: employee.fullName, value: employee.id })),
  ];

  return (
    <>
      <bulkByTagForm.bulkAction
        items={actionItems}
        label={t(`${K}.bulkByTag.action`)}
        placeholder={t(SELECT_PLACEHOLDER)}
      />
      {action === 'stage' ? (
        <bulkByTagForm.stage items={stageItems} label={t(`${K}.bulkByTag.stage`)} placeholder={t(SELECT_PLACEHOLDER)} />
      ) : (
        <bulkByTagForm.owner items={ownerItems} label={t(`${K}.bulkByTag.owner`)} placeholder={t(SELECT_PLACEHOLDER)} />
      )}
      {valueMissing && (
        <StatusText showIcon status="error">
          {t(`${K}.bulkByTag.valueRequired`)}
        </StatusText>
      )}
    </>
  );
};

const emptyBulkDraft = bulkDraftOf(emptyBulkValues);
const tagField = bulkByTagForm.getFieldAtoms(bulkByTagForm.fields.tagId);
/**
 * The kind as plain text. It changes only when the kind does: the field's own value atom reports every change of the
 * form, so dropping the tag on it would drop every tag picked.
 */
const shownKind = bulkByTagForm
  .getFieldAtoms(bulkByTagForm.fields.tagKind)
  .value.pipe(Atom.map(Option.getOrElse(() => '')));

/**
 * Bulk change of open opportunities selected by a tag. The preview lists exactly what will change, and the
 * population is the whole visible set, so table filters never narrow it. Picking changes only the draft; the shared
 * Save button ("Uložit", last in the footer) sends the one bulk command, and leaving a started choice asks first.
 */
export const BulkByTagDialog = ({ activeEmployees, customerLabel, onDone, onOpenChange }: BulkByTagDialogProps) => {
  const { language, t } = useModernI18n();
  const population = useAllOpportunities();
  const draft = Option.match(useAtomValue(bulkByTagForm.values), { onNone: () => emptyBulkDraft, onSome: bulkDraftOf });
  const { action, kind, owner, stage, tagId } = draft;
  const setTag = useAtomSet(tagField.setValue);
  // Tags belong to a kind: another kind starts without a tag.
  useAtomSubscribe(shownKind, () => setTag(null), { immediate: false });
  const [submitError, setSubmitError] = useState<string>();
  /** What the last save changed, for `onDone` once the save bar reports it saved. */
  const done = useRef<BulkByTagResult | null>(null);
  const members = useSubjectIdsWithTag(kind, tagId, 0);

  const preview = previewOf(population, members, kind);
  const tooMany = preview.length > BULK_LIMIT;
  /** The bulk command for `value` with the revision of the previewed set; none while the choice is incomplete. */
  const commandOf = (value: BulkByTagDraft): Option.Option<BulkSend> => {
    const patch = patchOf(value.action, value.stage, value.owner, activeEmployees);
    if (population.status !== 'ready' || preview.length === 0 || tooMany || patch === undefined) {
      return Option.none();
    }
    const ids = preview.map((opportunity) => opportunity.id);
    return Option.some({
      command: { _tag: 'BulkUpdateOpportunities', ids, patch },
      requested: ids.length,
      revision: population.items.revision,
    });
  };
  const send = ({ command, requested, revision }: BulkSend) =>
    applyPipelineCommand(command, revision).pipe(
      Effect.match({
        onFailure: (error): SaveOutcome => {
          setSubmitError(
            Match.value(error).pipe(
              Match.tag('ApplyCommandActionConflictProblem', (problem) => t(pipelineConflictKey(problem.code))),
              Match.tag('ApplyCommandActionForbiddenProblem', () => t(`${K}.errors.forbidden`)),
              Match.orElse(() => t(`${K}.errors.generic`)),
            ),
          );
          return 'failed';
        },
        onSuccess: (result): SaveOutcome => {
          setSubmitError(undefined);
          const skipped = skipTally(requested, result);
          done.current = { changed: requested - skipped.total, skipped };
          return 'saved';
        },
      }),
    );
  const record = useDraftSave<BulkByTagDraft, never>({
    isValid: (value) => Option.isSome(commandOf(value)),
    runtime: browserRuntime,
    save: (value) =>
      Option.match(commandOf(value), {
        onNone: () => Effect.succeed<SaveOutcome>('failed'),
        onSome: send,
      }),
    value: draft,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: constVoid });
  const labels = saveLabelsFor(language);
  const handleReloadLatest = constVoid;
  const handleSave = () => {
    record.save();
    record.afterSave((status) => {
      const result = done.current;
      if (status === 'saved' && result !== null) {
        done.current = null;
        onDone(result);
      }
    });
  };

  const kindItems = [
    { label: t(`${K}.bulkByTag.kinds.customer`), value: 'customer' },
    { label: t(`${K}.bulkByTag.kinds.opportunity`), value: 'opportunity' },
  ];

  return (
    <>
      <SidePanel
        actions={
          <>
            <Button
              appearance="outline"
              onClick={() => guard.request(() => onOpenChange(false))}
              severity="secondary"
              type="button"
            >
              {t(`${K}.bulkByTag.cancel`)}
            </Button>
            <SaveBar
              error={submitError}
              labels={labels}
              onReloadLatest={handleReloadLatest}
              onSave={handleSave}
              status={record.status}
            />
          </>
        }
        description={t(`${K}.bulkByTag.description`)}
        guard={guard}
        onOpenChange={onOpenChange}
        open
        resizeLabel={t('sales-pipeline.sidePanel.resize')}
        size="lg"
        title={t(`${K}.bulkByTag.title`)}
      >
        {/* The form submits nothing: only Uložit runs the change. */}
        <FormRoot
          className="flex flex-col gap-200 py-200"
          defaultValues={emptyBulkValues}
          form={bulkByTagForm}
          translateMessage={(message) => t(message, { defaultValue: message })}
        >
          <bulkByTagForm.tagKind
            items={kindItems}
            label={t(`${K}.bulkByTag.kind`)}
            placeholder={t(SELECT_PLACEHOLDER)}
          />
          <bulkByTagForm.tagId kind={kind} />
          <BulkByTagPreview
            customerLabel={customerLabel}
            members={members}
            population={population}
            preview={preview}
            tagChosen={tagId !== null}
            tooMany={tooMany}
          />
          <BulkByTagValueFields
            action={action}
            activeEmployees={activeEmployees}
            valueMissing={record.status === 'invalid' && patchOf(action, stage, owner, activeEmployees) === undefined}
          />
        </FormRoot>
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
