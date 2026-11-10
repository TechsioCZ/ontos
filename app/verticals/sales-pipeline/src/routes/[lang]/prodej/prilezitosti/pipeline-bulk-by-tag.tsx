import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  saveLabelsFor,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { TagFilter } from '@app/tagging/components/tag-controls';
import type { TagId } from '@app/tagging/contracts/records';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Effect, Match, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { useRef, useState } from 'react';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { applyPipelineCommand } from './pipeline-api.ts';
import type { PipelineCommand } from './pipeline-api.ts';
import {
  BULK_LIMIT,
  BulkByTagPreview,
  BulkByTagValueFields,
  K,
  KindSchema,
  SELECT_PLACEHOLDER,
  patchOf,
  previewOf,
} from './pipeline-bulk-by-tag-fields.tsx';
import type { Action, BulkByTagResult, Kind } from './pipeline-bulk-by-tag-fields.tsx';
import { pipelineConflictKey, skipTally } from './pipeline-model.ts';
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

interface BulkByTagDraft {
  readonly action: Action;
  readonly kind: Kind;
  readonly owner: string;
  readonly stage: OpportunityStage | '';
  readonly tagId: TagId | null;
}

interface BulkSend {
  readonly command: PipelineCommand;
  readonly requested: number;
  readonly revision: number;
}

const emptyBulkDraft: BulkByTagDraft = { action: 'stage', kind: 'customer', owner: '', stage: '', tagId: null };

/**
 * Bulk change of open opportunities selected by a tag. The preview lists exactly what will change, and the
 * population is the whole visible set, so table filters never narrow it. Picking changes only the draft; the shared
 * Save button ("Uložit", last in the footer) sends the one bulk command, and leaving a started choice asks first.
 */
export const BulkByTagDialog = ({ activeEmployees, customerLabel, onDone, onOpenChange }: BulkByTagDialogProps) => {
  const { language, t } = useModernI18n();
  const population = useAllOpportunities();
  const [draft, setDraft] = useState<BulkByTagDraft>(emptyBulkDraft);
  const { action, kind, owner, stage, tagId } = draft;
  const [submitError, setSubmitError] = useState<string>();
  /** What the last save changed, for `onDone` once the save bar reports it saved. */
  const done = useRef<BulkByTagResult | null>(null);
  const members = useSubjectIdsWithTag(kind, tagId, 0);
  const patchDraft = (next: Partial<BulkByTagDraft>) => setDraft((current) => ({ ...current, ...next }));

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
              onClick={() => guard.request(() => onOpenChange(false))}
              theme="outlined"
              type="button"
              variant="secondary"
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
        {/* Enter never runs the change: only Uložit does. */}
        <form className="flex flex-col gap-200 py-200" onSubmit={(event) => event.preventDefault()}>
          <SelectTemplate
            items={kindItems}
            label={t(`${K}.bulkByTag.kind`)}
            name="tagKind"
            onValueChange={({ value: [next] }) =>
              patchDraft({ kind: Schema.is(KindSchema)(next) ? next : 'customer', tagId: null })
            }
            placeholder={t(SELECT_PLACEHOLDER)}
            size="md"
            value={[kind]}
          />
          <TagFilter kind={kind} onChange={(next) => patchDraft({ tagId: next })} value={tagId} />
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
            onAction={(next) => patchDraft({ action: next })}
            onOwner={(next) => patchDraft({ owner: next })}
            onStage={(next) => patchDraft({ stage: next })}
            owner={owner}
            stage={stage}
            valueMissing={record.status === 'invalid' && patchOf(action, stage, owner, activeEmployees) === undefined}
          />
        </form>
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
