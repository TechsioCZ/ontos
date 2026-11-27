import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useUnsavedChangesGuard } from '@app/admin-ui';
import type { SaveState } from '@app/admin-ui';
import {
  EntryTextField,
  FormBuilder,
  FormReact,
  FormRoot,
  MemberCheckboxField,
  SubmitButton,
  makeMemberCheckboxField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Accordion } from '@techsio/ui-kit/molecules/accordion';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Effect, Equal, Option, Schema } from 'effect';
import { AsyncResult } from 'effect/reactivity';

import { browserAtomRuntime } from '../../../runtime/browser-effect-runtime.ts';
import {
  addExactLevel,
  amountEntries,
  canSaveRolePreview,
  cellHasSelector,
  invalidAmountSlots,
  roleCellSlot,
  RoleCellViewSchema,
  targetRecordKeys,
  withAmountCeilings,
} from './model.ts';
import { roleSaveState, sameRoleCells, useRoleDraft } from './role-save.ts';
import type {
  RoleCapabilityView,
  RoleCellView,
  RoleEditorStatus,
  RoleLevel,
  RolePreviewView,
  RoleTemplateView,
  RoleView,
} from './model.ts';

export interface RoleEditorViewProps {
  readonly catalogSnapshotId: string;
  /** The cells the editor starts from; edits stay in the editor's form until a preview. */
  readonly cells: readonly RoleCellView[];
  readonly entries: readonly RoleCapabilityView[];
  /** Zahodit změny: the editor puts the saved cells back; the owner forgets the preview and its key. */
  readonly onDiscard: () => void;
  /** Previews the edited cells, each with the amount ceiling the person typed. */
  readonly onPreview: (cells: readonly RoleCellView[]) => void;
  readonly onRefresh: () => void;
  /**
   * Uložit: saves the preview once the person confirmed every named dangerous effect. Answers whether a
   * commit started; the commit calls `settle` when it ends.
   */
  readonly onSave: (confirmations: readonly string[], settle: (end: SaveState) => void) => boolean;
  readonly preview: RolePreviewView | null;
  /** The edited cells the preview is for; once the person edits them, the preview is stale. */
  readonly previewedCells: readonly RoleCellView[];
  readonly role: RoleView;
  readonly status: RoleEditorStatus;
  readonly templates: readonly RoleTemplateView[];
  readonly writesAvailable: boolean;
}

const previewLabelKey = 'shell.accessAdmin.common.preview';
const levels: readonly RoleLevel[] = ['basic', 'extended', 'manage'];
const levelKeys = { basic: 'levelBasic', extended: 'levelExtended', manage: 'levelManage' } as const;
const selectorKeys = {
  all: 'scopeAll',
  assigned: 'scopeAssigned',
  entrusted: 'scopeEntrusted',
  targets: 'scopeTargets',
  team: 'scopeTeam',
} as const;

const textEntries = Schema.Record(Schema.String, Schema.String);

/** The cells of the edited role and the amount ceiling typed per cell slot; its submit previews them. */
const roleEditForm = FormReact.make(
  FormBuilder.empty
    .addField('amounts', textEntries)
    .addField('cells', Schema.Array(RoleCellViewSchema))
    .addField('currencies', textEntries),
  {
    fields: {
      amounts: EntryTextField,
      cells: makeMemberCheckboxField(roleCellSlot),
      currencies: EntryTextField,
    },
    onSubmit: (_submit, { encoded }) =>
      Effect.succeed(withAmountCeilings(encoded.cells, encoded.amounts, encoded.currencies)),
    runtime: browserAtomRuntime,
  },
);

/** The dangerous effects of one preview the person confirmed by name; its submit saves the preview through Uložit. */
const rolePreviewForm = FormReact.make(FormBuilder.empty.addField('confirmations', Schema.Array(Schema.String)), {
  fields: { confirmations: MemberCheckboxField },
  onSubmit: (_submit, { decoded }) => Effect.succeed(decoded.confirmations),
  runtime: browserAtomRuntime,
});

const noConfirmations: readonly string[] = [];
const editedCells = roleEditForm.getFieldAtoms(roleEditForm.fields.cells);
const typedAmounts = roleEditForm.getFieldAtoms(roleEditForm.fields.amounts);
const typedCurrencies = roleEditForm.getFieldAtoms(roleEditForm.fields.currencies);
const confirmedEffects = rolePreviewForm.getFieldAtoms(rolePreviewForm.fields.confirmations).value;

const CellSummary = ({ cells }: { readonly cells: readonly RoleCellView[] }) => {
  const { t } = useModernI18n();
  return cells.length === 0 ? (
    <p>{t('shell.accessAdmin.common.none')}</p>
  ) : (
    <ul className="grid gap-150">
      {cells.map((cell) => (
        <li key={roleCellSlot(cell)}>
          <code>{cell.capabilityKey}</code> {t(`shell.accessAdmin.mode.${cell.mode}`)}{' '}
          {t(`shell.accessAdmin.role.${selectorKeys[cell.selector._tag]}`)}
          {targetRecordKeys(cell).length > 0 ? <span> ({targetRecordKeys(cell).join(', ')})</span> : null}
          {cell.amountCeiling === undefined ? null : (
            <span>
              {' '}
              ({cell.amountCeiling.limitMinor} {cell.amountCeiling.currency})
            </span>
          )}
        </li>
      ))}
    </ul>
  );
};

const RoleAmountEditor = ({
  cell,
  disabled,
  existing,
  invalid,
}: {
  readonly cell: RoleCellView;
  readonly disabled: boolean;
  readonly existing: boolean;
  readonly invalid: boolean;
}) => {
  const { t } = useModernI18n();
  const slot = roleCellSlot(cell);
  const editableHelp = invalid ? 'shell.accessAdmin.role.invalidAmount' : 'shell.accessAdmin.role.amountMinorHelp';
  const helpKey = existing ? 'shell.accessAdmin.role.existingAmountHelp' : editableHelp;
  return (
    <div className="grid gap-150 md:grid-cols-2">
      <roleEditForm.amounts
        disabled={disabled}
        entry={slot}
        helpText={t(helpKey)}
        id={`${slot}-amount`}
        inputMode="numeric"
        invalid={invalid}
        label={[
          t('shell.accessAdmin.role.amountLimit'),
          cell.capabilityKey,
          t(`shell.accessAdmin.mode.${cell.mode}`),
        ].join(' · ')}
        min={0}
        readOnly={existing}
        step={1}
        type="number"
      />
      <roleEditForm.currencies
        disabled={disabled}
        entry={slot}
        id={`${slot}-currency`}
        label={[
          t('shell.accessAdmin.role.currency'),
          cell.capabilityKey,
          t(`shell.accessAdmin.mode.${cell.mode}`),
        ].join(' · ')}
        maxLength={3}
        readOnly={existing}
      />
    </div>
  );
};

const RoleCapabilityCells = ({
  cells,
  disabled,
  entry,
  invalidSlots,
  savedCells,
}: {
  readonly cells: readonly RoleCellView[];
  readonly disabled: boolean;
  readonly entry: RoleCapabilityView;
  readonly invalidSlots: ReadonlySet<string>;
  readonly savedCells: readonly RoleCellView[];
}) => {
  const { t } = useModernI18n();
  const selectors = entry.selectors.length === 0 ? ['all' as const] : entry.selectors;
  return (
    <fieldset className="grid gap-150" disabled={disabled}>
      <legend className="text-lg">
        <code>{entry.key}</code>
      </legend>
      <p>{t(`shell.accessAdmin.risk.${entry.risk}`)}</p>
      {entry.fieldClass === undefined ? null : (
        <p>
          {t('shell.accessAdmin.role.fieldClass')}: {entry.fieldClass}
        </p>
      )}
      {entry.modes.flatMap((mode) =>
        selectors.map((selector) => {
          const emptyCell: RoleCellView = { capabilityKey: entry.key, mode, selector: { _tag: selector } };
          const slot = roleCellSlot(emptyCell);
          const current = cells.find((cell) => roleCellSlot(cell) === slot);
          const cell = current ?? emptyCell;
          const hasTargets = cells.some(
            (candidate) =>
              candidate.capabilityKey === entry.key &&
              candidate.mode === mode &&
              targetRecordKeys(candidate).length > 0,
          );
          return (
            <div className="grid gap-150" key={slot}>
              <roleEditForm.cells
                disabled={disabled || (selector === 'all' && hasTargets)}
                id={slot}
                label={[
                  entry.key,
                  t(`shell.accessAdmin.mode.${mode}`),
                  t(`shell.accessAdmin.role.${selectorKeys[selector]}`),
                ].join(' · ')}
                member={cell}
              />
              {current !== undefined && entry.amountInput !== undefined ? (
                <RoleAmountEditor
                  cell={cell}
                  disabled={disabled}
                  existing={savedCells.some((saved) => roleCellSlot(saved) === slot)}
                  invalid={invalidSlots.has(slot)}
                />
              ) : null}
            </div>
          );
        }),
      )}
    </fieldset>
  );
};

const RolePreviewConfirmation = ({
  busy,
  cells,
  onSave,
  preview,
  role,
}: {
  readonly busy: boolean;
  readonly cells: readonly RoleCellView[];
  /** The editor's one Uložit. */
  readonly onSave: () => void;
  readonly preview: RolePreviewView;
  readonly role: RoleView;
}) => {
  const { t } = useModernI18n();
  useAtomSubscribe(rolePreviewForm.submit, (result) => {
    if (AsyncResult.isSuccess(result) && !result.waiting) {
      onSave();
    }
  });
  return (
    <FormRoot
      aria-label={t(previewLabelKey)}
      aria-live="polite"
      className="grid gap-200"
      defaultValues={{ confirmations: [] }}
      form={rolePreviewForm}
      key={preview.previewToken}
      translateMessage={t}
    >
      <h3 className="text-xl">{t(previewLabelKey)}</h3>
      <p>
        {t('shell.accessAdmin.role.affectedPeople')}: {preview.affectedHumanCount}
      </p>
      <p>{t('shell.accessAdmin.role.affectedPeopleHelp')}</p>
      <ul aria-label={t('shell.accessAdmin.role.affectedPeople')}>
        {preview.affectedPeople.map((person) => (
          <li key={person}>
            <code>{person}</code>
          </li>
        ))}
      </ul>
      <div className="grid gap-200 md:grid-cols-2">
        <section aria-label={t('shell.accessAdmin.common.beforeState')}>
          <h4>{t('shell.accessAdmin.common.beforeState')}</h4>
          <CellSummary cells={role.cells} />
        </section>
        <section aria-label={t('shell.accessAdmin.common.afterState')}>
          <h4>{t('shell.accessAdmin.common.afterState')}</h4>
          <CellSummary cells={cells} />
        </section>
      </div>
      {preview.dangerousEffects.map((effect) => (
        <rolePreviewForm.confirmations
          disabled={busy}
          helpText={t('shell.accessAdmin.role.dangerousCell')}
          id={`confirm-${effect.id}`}
          key={effect.id}
          label={t('shell.accessAdmin.role.dangerousConfirmEffect', { effect: effect.description })}
          member={effect.id}
        />
      ))}
    </FormRoot>
  );
};

export const RoleEditorView = (props: RoleEditorViewProps) => {
  const { language, t } = useModernI18n();
  const values = useAtomValue(roleEditForm.values);
  const setCells = useAtomSet(editedCells.setValue);
  const setValues = useAtomSet(roleEditForm.setValues);
  const setAmounts = useAtomSet(typedAmounts.setValue);
  const setCurrencies = useAtomSet(typedCurrencies.setValue);
  // A removed unsaved cell takes its typed ceiling with it, so checking it again starts without one.
  useAtomSubscribe(roleEditForm.values, (edited) => {
    if (Option.isNone(edited)) {
      return;
    }
    const kept = new Set([...edited.value.cells, ...props.role.cells].map(roleCellSlot));
    const prune = (entries: Readonly<Record<string, string>>) =>
      Object.fromEntries(Object.entries(entries).filter(([slot]) => kept.has(slot)));
    if (Object.keys(edited.value.amounts).some((slot) => !kept.has(slot))) {
      setAmounts(prune);
    }
    if (Object.keys(edited.value.currencies).some((slot) => !kept.has(slot))) {
      setCurrencies(prune);
    }
  });
  const cells = Option.match(values, {
    onNone: () => props.cells,
    onSome: (draft) => withAmountCeilings(draft.cells, draft.amounts, draft.currencies),
  });
  const invalidSlots = new Set(
    Option.match(values, {
      onNone: () => [],
      onSome: (draft) => invalidAmountSlots(draft.cells, draft.amounts, draft.currencies),
    }),
  );
  const status = invalidSlots.size > 0 ? 'invalid' : props.status;
  const applyLevel = (moduleKey: string, level: RoleLevel) =>
    setCells((current: readonly RoleCellView[]) => addExactLevel(current, props.entries, moduleKey, level));
  // A preview, its confirmations and its idempotency key hold only for the exact cells it was asked for.
  const preview = status !== 'invalid' && Equal.equals(cells, props.previewedCells) ? props.preview : null;
  useAtomSubscribe(roleEditForm.submit, (result) => {
    if (AsyncResult.isSuccess(result) && !result.waiting) {
      props.onPreview(result.value);
    }
  });
  const confirmations = Option.getOrElse(useAtomValue(confirmedEffects), () => noConfirmations);
  // What Uložit would change: the edited cells, or the cells the server previewed for them.
  const changed =
    !sameRoleCells(cells, props.role.cells) || (preview !== null && !sameRoleCells(props.cells, props.role.cells));
  const savable = canSaveRolePreview(preview, confirmations, status, props.writesAvailable);
  const saveState = roleSaveState(status, changed, savable);
  const roleDraft = useRoleDraft({
    changed,
    onSave: (settle) => props.onSave(confirmations, settle),
    savable,
    saveState,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => roleDraft.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: roleDraft,
    navigation: blocker,
    onDiscard: () => {
      setValues({ ...amountEntries(props.role.cells), cells: props.role.cells });
      props.onDiscard();
    },
  });
  const handleSave = roleDraft.save;
  const labels = saveLabelsFor(language);
  const busy = props.status === 'loading' || props.status === 'saving';
  const blocked =
    busy || props.status === 'conflict' || props.status === 'forbidden' || props.status === 'unauthenticated';
  const modules = [...new Set(props.entries.map((entry) => entry.moduleKey))];
  const unsupported = cells.filter(
    (cell) =>
      !props.entries.some(
        (entry) =>
          entry.key === cell.capabilityKey &&
          entry.modes.includes(cell.mode) &&
          (entry.selectors.length === 0
            ? cellHasSelector(cell, 'all')
            : entry.selectors.some((selector) => cellHasSelector(cell, selector))),
      ),
  );
  const statusKey = status === 'invalid' ? 'role.invalidEdit' : `common.${status}`;
  return (
    <section aria-label={props.role.name} className="grid gap-300">
      <h2 className="text-2xl">{props.role.name}</h2>
      <p>{t('shell.accessAdmin.role.description')}</p>
      <dl className="grid gap-150">
        <div>
          <dt>{t('shell.accessAdmin.role.sourceRoleRevision')}</dt>
          <dd>
            {props.role.revision} <code>{props.role.revisionId}</code>
          </dd>
        </div>
        <div>
          <dt>{t('shell.accessAdmin.role.sourceRevision')}</dt>
          <dd>
            <code>{props.catalogSnapshotId}</code>
          </dd>
        </div>
        <div>
          <dt>{t('shell.accessAdmin.role.scopeVariant')}</dt>
          <dd>
            {props.role.legalEntityId === undefined
              ? t('shell.accessAdmin.common.tenantContext')
              : t('shell.accessAdmin.role.companyScope', { id: props.role.legalEntityId })}
          </dd>
        </div>
      </dl>
      <p>{t('shell.accessAdmin.role.assignmentExpiryHelp')}</p>
      {props.writesAvailable ? null : (
        <StatusText status="warning">{t('shell.accessAdmin.role.writesUnavailable')}</StatusText>
      )}
      {status === 'idle' ? null : (
        <StatusText aria-live="polite" status={status === 'saved' ? 'success' : 'warning'}>
          {t(`shell.accessAdmin.${statusKey}`)}
        </StatusText>
      )}
      <Button disabled={busy} onClick={props.onRefresh} severity="secondary" type="button">
        {t('shell.accessAdmin.common.refresh')}
      </Button>
      <FormRoot
        className="grid gap-300"
        defaultValues={{ ...amountEntries(props.cells), cells: props.cells }}
        form={roleEditForm}
        translateMessage={t}
      >
        <fieldset className="grid gap-150" disabled={blocked}>
          <legend>{t('shell.accessAdmin.role.template')}</legend>
          <p>{t('shell.accessAdmin.role.fullAccessHelp')}</p>
          {props.templates.length === 0 ? (
            <p>{t('shell.accessAdmin.role.templateUnavailable')}</p>
          ) : (
            props.templates.map((template) => (
              <Button
                disabled={blocked || template.catalogSnapshotId !== props.catalogSnapshotId}
                key={template.templateKey}
                onClick={() => setValues({ ...amountEntries(template.cells), cells: template.cells })}
                severity="secondary"
                type="button"
              >
                {template.name}
              </Button>
            ))
          )}
        </fieldset>
        <div className="overflow-x-auto">
          <Table>
            <Table.Caption>{t('shell.accessAdmin.role.level')}</Table.Caption>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader scope="col">{t('shell.accessAdmin.role.module')}</Table.ColumnHeader>
                {levels.map((level) => (
                  <Table.ColumnHeader key={level} scope="col">
                    {t(`shell.accessAdmin.role.${levelKeys[level]}`)}
                  </Table.ColumnHeader>
                ))}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {modules.map((moduleKey) => (
                <Table.Row key={moduleKey}>
                  <Table.ColumnHeader scope="row">{moduleKey}</Table.ColumnHeader>
                  {levels.map((level) => (
                    <Table.Cell key={level}>
                      <Button
                        aria-label={t('shell.accessAdmin.role.applyLevel', {
                          level: t(`shell.accessAdmin.role.${levelKeys[level]}`),
                          module: moduleKey,
                        })}
                        disabled={
                          blocked ||
                          !props.entries.some(
                            (entry) =>
                              entry.moduleKey === moduleKey &&
                              entry.placement.level === level &&
                              entry.modes.includes('run') &&
                              (entry.selectors.length === 0 || entry.selectors.includes('all')),
                          )
                        }
                        onClick={() => applyLevel(moduleKey, level)}
                        severity="secondary"
                        type="button"
                      >
                        {t(`shell.accessAdmin.role.${levelKeys[level]}`)}
                      </Button>
                    </Table.Cell>
                  ))}
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
        {props.entries.map((entry) => (
          <RoleCapabilityCells
            cells={cells}
            disabled={blocked}
            entry={entry}
            invalidSlots={invalidSlots}
            key={entry.key}
            savedCells={props.role.cells}
          />
        ))}
        {unsupported.length === 0 ? null : (
          <fieldset className="grid gap-150" disabled={blocked}>
            <legend>{t('shell.accessAdmin.role.unsupportedCells')}</legend>
            {unsupported.map((cell) => (
              <roleEditForm.cells
                disabled={blocked}
                key={roleCellSlot(cell)}
                label={[
                  cell.capabilityKey,
                  t(`shell.accessAdmin.mode.${cell.mode}`),
                  t(`shell.accessAdmin.role.${selectorKeys[cell.selector._tag]}`),
                ].join(' · ')}
                member={cell}
              />
            ))}
          </fieldset>
        )}
        <Accordion collapsible>
          <Accordion.Item value="cells">
            <Accordion.Header>
              <Accordion.Title>{t('shell.accessAdmin.role.cell')}</Accordion.Title>
              <Accordion.Indicator />
            </Accordion.Header>
            <Accordion.Content>
              <CellSummary cells={cells} />
            </Accordion.Content>
          </Accordion.Item>
        </Accordion>
        <SubmitButton disabled={blocked || status === 'invalid'}>{t(previewLabelKey)}</SubmitButton>
      </FormRoot>
      {preview === null ? null : (
        <RolePreviewConfirmation busy={busy} cells={cells} onSave={handleSave} preview={preview} role={props.role} />
      )}
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
      <SaveBar
        error={saveState === 'error' ? t(`shell.accessAdmin.common.${status}`) : null}
        labels={labels}
        onReloadLatest={props.onRefresh}
        onSave={handleSave}
        status={saveState}
      />
    </section>
  );
};
