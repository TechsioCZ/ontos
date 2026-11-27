import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';

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
  readonly confirmedItemIds: readonly string[];
  readonly hasMore: boolean;
  readonly items: readonly ChangeItemView[];
  readonly notice: ChangesNotice | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly onConfirmEffect: (id: string, confirmed: boolean) => void;
  readonly onLoadMore: () => void;
  readonly onPreview: (ids: readonly string[], decision: ChangeDecision) => void;
  readonly onRefresh: () => void;
  readonly onSelect: (id: string, selected: boolean) => void;
  readonly preview: ChangePreviewView | undefined;
  readonly receipt: ChangeReceiptView | undefined;
  readonly requiresRefresh: boolean;
  readonly selectedIds: readonly string[];
  readonly writesAvailable: boolean;
}

const ChangeDetails = ({ item }: { readonly item: ChangeItemView }) => {
  const { t } = useModernI18n();
  const unavailable = t('shell.accessAdmin.common.notAvailable');
  const none = t('shell.accessAdmin.common.none');
  return (
    <dl className="shell:grid shell:gap-2 shell:text-body-sm">
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

export const ChangesView = (props: ChangesViewProps) => {
  const { t } = useModernI18n();
  const selectedIds = new Set(props.selectedIds);
  const confirmedIds = new Set(props.confirmedItemIds);
  const selected = props.items.filter((item) => selectedIds.has(item.id));
  const disabled = props.busy || props.requiresRefresh;
  return (
    <section
      aria-busy={props.busy}
      aria-label={t('shell.accessAdmin.changes.title')}
      className="shell:grid shell:gap-6"
    >
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
      <div className="shell:flex shell:flex-wrap shell:gap-2">
        <Button disabled={props.busy} onClick={props.onRefresh} type="button" variant="secondary">
          {t('shell.accessAdmin.common.refresh')}
        </Button>
        <Button
          disabled={disabled || !canPreviewDecision(selected, 'adopt')}
          onClick={() =>
            props.onPreview(
              selected.map((item) => item.id),
              'adopt',
            )
          }
          type="button"
        >
          {t('shell.accessAdmin.changes.previewBatch')}
        </Button>
      </div>
      {props.items.length === 0 ? (
        <StatusText status="default">{t('shell.accessAdmin.changes.empty')}</StatusText>
      ) : (
        <ul aria-label={t('shell.accessAdmin.accessible.changeList')} className="shell:grid shell:gap-6">
          {props.items.map((item) => (
            <li className="shell:grid shell:gap-3" key={item.id}>
              <h3 className="shell:text-title-md">{item.capabilityKey}</h3>
              <div className="shell:flex shell:flex-wrap shell:gap-2">
                <Badge variant="outline">{t(`shell.accessAdmin.changes.kind.${item.kind}`)}</Badge>
                <Badge variant="outline">{t(`shell.accessAdmin.changes.status.${item.status}`)}</Badge>
                <Badge variant={item.risk === 'routine' ? 'info' : 'warning'}>
                  {t(`shell.accessAdmin.risk.${item.risk}`)}
                </Badge>
              </div>
              <ChangeDetails item={item} />
              {item.widening === true && (
                <StatusText status="warning">{t('shell.accessAdmin.changes.wideningWarning')}</StatusText>
              )}
              {isBatchEligible(item) && (
                <FormCheckbox
                  checked={selectedIds.has(item.id)}
                  disabled={disabled}
                  id={`change-select-${item.id}`}
                  label={t('shell.accessAdmin.changes.selectItem', { item: item.capabilityKey })}
                  onCheckedChange={(checked) => props.onSelect(item.id, checked)}
                />
              )}
              {item.status === 'pending' && (
                <div className="shell:flex shell:flex-wrap shell:gap-2">
                  <Button disabled={disabled} onClick={() => props.onPreview([item.id], 'adopt')} type="button">
                    {t('shell.accessAdmin.changes.previewAdopt')}
                  </Button>
                  <Button
                    disabled={disabled}
                    onClick={() => props.onPreview([item.id], 'decline')}
                    type="button"
                    variant="secondary"
                  >
                    {t('shell.accessAdmin.changes.previewDecline')}
                  </Button>
                </div>
              )}
              {item.status === 'adopted' && (
                <Button
                  disabled={disabled}
                  onClick={() => props.onPreview([item.id], 'undo')}
                  type="button"
                  variant="secondary"
                >
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
        <Button disabled={props.busy} onClick={props.onLoadMore} type="button" variant="secondary">
          {t('shell.accessAdmin.changes.loadMore')}
        </Button>
      )}
      {props.receipt !== undefined && props.receipt.skipped.length > 0 && (
        <section aria-label={t('shell.accessAdmin.changes.undo')} className="shell:grid shell:gap-2">
          <p>{t('shell.accessAdmin.changes.undoHelp')}</p>
          <p>{t('shell.accessAdmin.changes.noRevocationRestore')}</p>
          <ChangeSkips skipped={props.receipt.skipped} />
        </section>
      )}
      {props.preview !== undefined && (
        <section aria-labelledby="access-changes-preview" className="shell:grid shell:gap-3">
          <h3 className="shell:text-title-md" id="access-changes-preview">
            {t('shell.accessAdmin.common.preview')}
          </h3>
          <p>
            {props.preview.affectedHumanCount === null
              ? t('shell.accessAdmin.common.notAvailable')
              : t('shell.accessAdmin.changes.affectedPeopleCount', { count: props.preview.affectedHumanCount })}
          </p>
          {props.preview.items.map((item) => (
            <div key={item.id}>
              <h4>{item.capabilityKey}</h4>
              <ChangeDetails item={item} />
            </div>
          ))}
          <ChangeRoleDiff changes={props.preview.roleChanges} />
          {props.preview.decision === 'undo' && (
            <>
              <p>{t('shell.accessAdmin.changes.undoHelp')}</p>
              <p>{t('shell.accessAdmin.changes.noRevocationRestore')}</p>
              <ChangeSkips skipped={props.preview.undoSkips} />
            </>
          )}
          {props.preview.effects.map((effect) => (
            <FormCheckbox
              checked={confirmedIds.has(effect.itemId)}
              disabled={disabled}
              id={`confirm-change-${effect.itemId}`}
              key={effect.itemId}
              label={t('shell.accessAdmin.changes.confirmItem', { effect: effect.description })}
              onCheckedChange={(checked) => props.onConfirmEffect(effect.itemId, checked)}
            />
          ))}
          <div className="shell:flex shell:flex-wrap shell:gap-2">
            <Button
              disabled={disabled || !props.writesAvailable || !canConfirmPreview(props.preview, props.confirmedItemIds)}
              onClick={props.onConfirm}
              type="button"
            >
              {t(`shell.accessAdmin.changes.${props.preview.decision}`)}
            </Button>
            <Button disabled={props.busy} onClick={props.onCancel} type="button" variant="secondary">
              {t('shell.accessAdmin.common.cancel')}
            </Button>
          </div>
        </section>
      )}
    </section>
  );
};
