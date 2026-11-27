import {
  FormBuilder,
  FormReact,
  FormRoot,
  MemberCheckboxField,
  SubmitButton,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Option, Schema } from 'effect';
import { AsyncResult } from 'effect/reactivity';

import { browserAtomRuntime } from '../../../runtime/browser-effect-runtime.ts';

import { ChangeCells, ChangeRoleDiff, ChangeSkips } from './changes-diff.tsx';
import { canConfirmPreview, canPreviewDecision, isBatchEligible } from './changes-model.ts';
import type {
  ChangeDecision,
  ChangeItemView,
  ChangePreviewView,
  ChangeReceiptView,
  ChangesNotice,
} from './changes-model.ts';

export interface ChangesViewProps {
  readonly busy: boolean;
  readonly hasMore: boolean;
  readonly items: readonly ChangeItemView[];
  readonly notice: ChangesNotice | null;
  readonly onCancel: () => void;
  /** Decides the previewed changes with the effects the person confirmed one by one. */
  readonly onConfirm: (confirmedItemIds: readonly string[]) => void;
  readonly onLoadMore: () => void;
  readonly onPreview: (ids: readonly string[], decision: ChangeDecision) => void;
  readonly onRefresh: () => void;
  /** The batch selection changed, so any preview of the previous selection is stale. */
  readonly onSelectionChange: () => void;
  readonly preview: ChangePreviewView | undefined;
  readonly receipt: ChangeReceiptView | undefined;
  readonly requiresRefresh: boolean;
  /** A new value starts an empty batch selection. */
  readonly selection: number;
  readonly writesAvailable: boolean;
}

/** The routine changes picked for one batch preview; its submit previews adopting all of them. */
const changeSelectionForm = FormReact.make(FormBuilder.empty.addField('selectedIds', Schema.Array(Schema.String)), {
  fields: { selectedIds: MemberCheckboxField },
  onSubmit: (_submit, { decoded }) => Effect.succeed(decoded.selectedIds),
  runtime: browserAtomRuntime,
});

/** The named effects of one preview the person confirmed; its submit decides the preview. */
const changeConfirmationForm = FormReact.make(
  FormBuilder.empty.addField('confirmedItemIds', Schema.Array(Schema.String)),
  {
    fields: { confirmedItemIds: MemberCheckboxField },
    onSubmit: (_submit, { decoded }) => Effect.succeed(decoded.confirmedItemIds),
    runtime: browserAtomRuntime,
  },
);

const selectedIdsValue = changeSelectionForm.getFieldAtoms(changeSelectionForm.fields.selectedIds).value;
const confirmedItemIdsValue = changeConfirmationForm.getFieldAtoms(
  changeConfirmationForm.fields.confirmedItemIds,
).value;
const noIds: readonly string[] = [];

const ChangeDetails = ({ item }: { readonly item: ChangeItemView }) => {
  const { t } = useModernI18n();
  const unavailable = t('shell.accessAdmin.common.notAvailable');
  const none = t('shell.accessAdmin.common.none');
  return (
    <dl className="grid gap-150 text-sm">
      <dt>{t('shell.accessAdmin.changes.sourceCatalog')}</dt>
      <dd>{item.catalogSnapshotId}</dd>
      <dt>{t('shell.accessAdmin.changes.provenance')}</dt>
      <dd>{item.provenance ?? unavailable}</dd>
      <dt>{t('shell.accessAdmin.changes.suggestedRoles')}</dt>
      <dd>{item.suggestedRoles.join(', ') || none}</dd>
      <dt>{t('shell.accessAdmin.changes.affectedHolders')}</dt>
      <dd>{item.affectedHolders.join(', ') || unavailable}</dd>
      <dt>{t('shell.accessAdmin.changes.lineage')}</dt>
      <dd>{item.lineage.join(', ') || none}</dd>
      <dt>{t('shell.accessAdmin.changes.addedCells')}</dt>
      <dd>
        {item.addedCells.length === 0
          ? none
          : item.addedCells.map(({ cell, roleId }) => (
              <div key={`${roleId}:${cell.capabilityKey}:${cell.mode}:${cell.selector._tag}`}>
                <h4>{item.roleNames[roleId] ?? roleId}</h4>
                <ChangeCells cells={[cell]} />
              </div>
            ))}
      </dd>
      <dt>{t('shell.accessAdmin.changes.removedCells')}</dt>
      <dd>
        {item.removedCells.length === 0
          ? none
          : item.removedCells.map(({ cell, roleId }) => (
              <div key={`${roleId}:${cell.capabilityKey}:${cell.mode}:${cell.selector._tag}`}>
                <h4>{item.roleNames[roleId] ?? roleId}</h4>
                <ChangeCells cells={[cell]} />
              </div>
            ))}
      </dd>
    </dl>
  );
};

const ChangePreview = ({
  busy,
  disabled,
  onCancel,
  onConfirm,
  preview,
  writesAvailable,
}: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (confirmedItemIds: readonly string[]) => void;
  readonly preview: ChangePreviewView;
  readonly writesAvailable: boolean;
}) => {
  const { t } = useModernI18n();
  const confirmedItemIds = Option.getOrElse(useAtomValue(confirmedItemIdsValue), () => noIds);
  useAtomSubscribe(changeConfirmationForm.submit, (result) => {
    if (AsyncResult.isSuccess(result) && !result.waiting) {
      onConfirm(result.value);
    }
  });
  return (
    <FormRoot
      aria-labelledby="access-changes-preview"
      className="grid gap-150"
      defaultValues={{ confirmedItemIds: [] }}
      form={changeConfirmationForm}
      key={preview.token}
      translateMessage={t}
    >
      <h3 className="text-xl" id="access-changes-preview">
        {t('shell.accessAdmin.common.preview')}
      </h3>
      <p>
        {preview.affectedHumanCount === null
          ? t('shell.accessAdmin.common.notAvailable')
          : t('shell.accessAdmin.changes.affectedPeopleCount', { count: preview.affectedHumanCount })}
      </p>
      {preview.items.map((item) => (
        <div key={item.id}>
          <h4>{item.capabilityKey}</h4>
          <ChangeDetails item={item} />
        </div>
      ))}
      <ChangeRoleDiff changes={preview.roleChanges} />
      {preview.decision === 'undo' && (
        <>
          <p>{t('shell.accessAdmin.changes.undoHelp')}</p>
          <p>{t('shell.accessAdmin.changes.noRevocationRestore')}</p>
          <ChangeSkips skipped={preview.undoSkips} />
        </>
      )}
      {preview.effects.map((effect) => (
        <changeConfirmationForm.confirmedItemIds
          disabled={disabled}
          id={`confirm-change-${effect.itemId}`}
          key={effect.itemId}
          label={t('shell.accessAdmin.changes.confirmItem', { effect: effect.description })}
          member={effect.itemId}
        />
      ))}
      <div className="flex flex-wrap gap-150">
        <SubmitButton disabled={disabled || !writesAvailable || !canConfirmPreview(preview, confirmedItemIds)}>
          {t(`shell.accessAdmin.changes.${preview.decision}`)}
        </SubmitButton>
        <Button disabled={busy} onClick={onCancel} severity="secondary" type="button">
          {t('shell.accessAdmin.common.cancel')}
        </Button>
      </div>
    </FormRoot>
  );
};

export const ChangesView = (props: ChangesViewProps) => {
  const { t } = useModernI18n();
  const selection = Option.getOrElse(useAtomValue(selectedIdsValue), () => noIds);
  const selectedIds = new Set(selection);
  const selected = props.items.filter((item) => selectedIds.has(item.id));
  const disabled = props.busy || props.requiresRefresh;
  // The field also notifies when a submit records its state; only a different selection is a change.
  useAtomSubscribe(
    selectedIdsValue,
    (next) => {
      const ids = Option.getOrElse(next, () => noIds);
      if (ids.length !== selection.length || ids.some((id, index) => id !== selection[index])) {
        props.onSelectionChange();
      }
    },
    { immediate: false },
  );
  useAtomSubscribe(changeSelectionForm.submit, (result) => {
    if (AsyncResult.isSuccess(result) && !result.waiting) {
      props.onPreview(result.value, 'adopt');
    }
  });
  return (
    <section aria-busy={props.busy} aria-label={t('shell.accessAdmin.changes.title')} className="grid gap-300">
      <p>{t('shell.accessAdmin.changes.description')}</p>
      <p>{t('shell.accessAdmin.changes.routineBatch')}</p>
      <p>{t('shell.accessAdmin.changes.individualOnly')}</p>
      {!props.writesAvailable && (
        <StatusText status="warning">{t('shell.accessAdmin.changes.writesUnavailable')}</StatusText>
      )}
      {props.notice !== null && (
        <StatusText aria-live="polite" status={props.notice === 'saved' ? 'success' : 'error'}>
          {t(`shell.accessAdmin.common.${props.notice}`)}
        </StatusText>
      )}
      <FormRoot
        className="grid gap-300"
        defaultValues={{ selectedIds: [] }}
        form={changeSelectionForm}
        key={props.selection}
        translateMessage={t}
      >
        <div className="flex flex-wrap gap-150">
          <Button disabled={props.busy} onClick={props.onRefresh} severity="secondary" type="button">
            {t('shell.accessAdmin.common.refresh')}
          </Button>
          <SubmitButton disabled={disabled || !canPreviewDecision(selected, 'adopt')}>
            {t('shell.accessAdmin.changes.previewBatch')}
          </SubmitButton>
        </div>
        {props.items.length === 0 ? (
          <StatusText status="default">{t('shell.accessAdmin.changes.empty')}</StatusText>
        ) : (
          <ul aria-label={t('shell.accessAdmin.accessible.changeList')} className="grid gap-300">
            {props.items.map((item) => (
              <li className="grid gap-150" key={item.id}>
                <h3 className="text-xl">{item.capabilityKey}</h3>
                <div className="flex flex-wrap gap-150">
                  <Badge appearance="outline" severity="neutral">
                    {t(`shell.accessAdmin.changes.kind.${item.kind}`)}
                  </Badge>
                  <Badge appearance="outline" severity="neutral">
                    {t(`shell.accessAdmin.changes.status.${item.status}`)}
                  </Badge>
                  <Badge severity={item.risk === 'routine' ? 'info' : 'warning'}>
                    {t(`shell.accessAdmin.risk.${item.risk}`)}
                  </Badge>
                </div>
                <ChangeDetails item={item} />
                {item.widening === true && (
                  <StatusText status="warning">{t('shell.accessAdmin.changes.wideningWarning')}</StatusText>
                )}
                {isBatchEligible(item) && (
                  <changeSelectionForm.selectedIds
                    disabled={disabled}
                    id={`change-select-${item.id}`}
                    label={t('shell.accessAdmin.changes.selectItem', { item: item.capabilityKey })}
                    member={item.id}
                  />
                )}
                {item.status === 'pending' && (
                  <div className="flex flex-wrap gap-150">
                    <Button disabled={disabled} onClick={() => props.onPreview([item.id], 'adopt')} type="button">
                      {t('shell.accessAdmin.changes.previewAdopt')}
                    </Button>
                    <Button
                      disabled={disabled}
                      onClick={() => props.onPreview([item.id], 'decline')}
                      severity="secondary"
                      type="button"
                    >
                      {t('shell.accessAdmin.changes.previewDecline')}
                    </Button>
                  </div>
                )}
                {item.status === 'adopted' && (
                  <Button disabled={disabled} onClick={() => props.onPreview([item.id], 'undo')} type="button">
                    {t('shell.accessAdmin.changes.previewUndo')}
                  </Button>
                )}
                {item.status === 'undone' && (
                  <StatusText status="default">{t('shell.accessAdmin.changes.undoneTerminal')}</StatusText>
                )}
              </li>
            ))}
          </ul>
        )}
        {props.hasMore && (
          <Button disabled={props.busy} onClick={props.onLoadMore} severity="secondary" type="button">
            {t('shell.accessAdmin.changes.loadMore')}
          </Button>
        )}
      </FormRoot>
      {props.receipt !== undefined && props.receipt.skipped.length > 0 && (
        <section aria-label={t('shell.accessAdmin.changes.undo')} className="grid gap-150">
          <p>{t('shell.accessAdmin.changes.undoHelp')}</p>
          <p>{t('shell.accessAdmin.changes.noRevocationRestore')}</p>
          <ChangeSkips skipped={props.receipt.skipped} />
        </section>
      )}
      {props.preview !== undefined && (
        <ChangePreview
          busy={props.busy}
          disabled={disabled}
          onCancel={props.onCancel}
          onConfirm={props.onConfirm}
          preview={props.preview}
          writesAvailable={props.writesAvailable}
        />
      )}
    </section>
  );
};
