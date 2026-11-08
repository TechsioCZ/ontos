import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Table } from '@techsio/ui-kit/organisms/table';
import { useState } from 'react';

import { canSaveRolePreview, cellHasSelector, parseAmountCeiling, roleCellSlot, targetRecordKeys } from './model.ts';
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
  readonly cells: readonly RoleCellView[];
  readonly confirmations: readonly string[];
  readonly entries: readonly RoleCapabilityView[];
  readonly onAmount: (cell: RoleCellView, amount: string, currency: string) => void;
  readonly onConfirm: (id: string, checked: boolean) => void;
  readonly onLevel: (moduleKey: string, level: RoleLevel) => void;
  readonly onPreview: () => void;
  readonly onRefresh: () => void;
  readonly onSave: () => void;
  readonly onTemplate: (template: RoleTemplateView) => void;
  readonly onToggleCell: (cell: RoleCellView, enabled: boolean) => void;
  readonly preview: RolePreviewView | null;
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

const CellSummary = ({ cells }: { readonly cells: readonly RoleCellView[] }) => {
  const { t } = useModernI18n();
  return cells.length === 0 ? (
    <p>{t('shell.accessAdmin.common.none')}</p>
  ) : (
    <ul className="shell:grid shell:gap-2">
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
  onAmount,
}: {
  readonly cell: RoleCellView;
  readonly disabled: boolean;
  readonly existing: boolean;
  readonly onAmount: RoleEditorViewProps['onAmount'];
}) => {
  const { t } = useModernI18n();
  const [amount, setAmount] = useState(String(cell.amountCeiling?.limitMinor ?? ''));
  const [currency, setCurrency] = useState(cell.amountCeiling?.currency ?? '');
  const slot = roleCellSlot(cell);
  const invalid = parseAmountCeiling(amount, currency) === 'invalid';
  const editableHelp = invalid ? 'shell.accessAdmin.role.invalidAmount' : 'shell.accessAdmin.role.amountMinorHelp';
  const helpKey = existing ? 'shell.accessAdmin.role.existingAmountHelp' : editableHelp;
  return (
    <div className="shell:grid shell:gap-2 shell:md:grid-cols-2">
      <FormInput
        disabled={disabled}
        helpText={t(helpKey)}
        id={`${slot}-amount`}
        inputMode="numeric"
        label={[
          t('shell.accessAdmin.role.amountLimit'),
          cell.capabilityKey,
          t(`shell.accessAdmin.mode.${cell.mode}`),
        ].join(' · ')}
        min={0}
        onChange={(event) => {
          setAmount(event.currentTarget.value);
          onAmount(cell, event.currentTarget.value, currency);
        }}
        readOnly={existing}
        step={1}
        type="number"
        validateStatus={invalid ? 'error' : 'default'}
        value={amount}
      />
      <FormInput
        disabled={disabled}
        id={`${slot}-currency`}
        label={[
          t('shell.accessAdmin.role.currency'),
          cell.capabilityKey,
          t(`shell.accessAdmin.mode.${cell.mode}`),
        ].join(' · ')}
        maxLength={3}
        onChange={(event) => {
          setCurrency(event.currentTarget.value);
          onAmount(cell, amount, event.currentTarget.value);
        }}
        readOnly={existing}
        value={currency}
      />
    </div>
  );
};

const RoleCapabilityCells = ({
  disabled,
  entry,
  props,
}: {
  readonly disabled: boolean;
  readonly entry: RoleCapabilityView;
  readonly props: RoleEditorViewProps;
}) => {
  const { t } = useModernI18n();
  const selectors = entry.selectors.length === 0 ? ['all' as const] : entry.selectors;
  return (
    <fieldset className="shell:grid shell:gap-3" disabled={disabled}>
      <legend className="shell:text-title-sm">
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
          const current = props.cells.find((cell) => roleCellSlot(cell) === slot);
          const cell = current ?? emptyCell;
          const hasTargets = props.cells.some(
            (candidate) =>
              candidate.capabilityKey === entry.key &&
              candidate.mode === mode &&
              targetRecordKeys(candidate).length > 0,
          );
          return (
            <div className="shell:grid shell:gap-2" key={slot}>
              <FormCheckbox
                checked={current !== undefined}
                disabled={disabled || (selector === 'all' && hasTargets)}
                id={slot}
                label={[
                  entry.key,
                  t(`shell.accessAdmin.mode.${mode}`),
                  t(`shell.accessAdmin.role.${selectorKeys[selector]}`),
                ].join(' · ')}
                onCheckedChange={(checked) => props.onToggleCell(cell, checked)}
              />
              {current !== undefined && entry.amountInput !== undefined ? (
                <RoleAmountEditor
                  cell={cell}
                  disabled={disabled}
                  existing={props.role.cells.some((saved) => roleCellSlot(saved) === slot)}
                  onAmount={props.onAmount}
                />
              ) : null}
            </div>
          );
        }),
      )}
    </fieldset>
  );
};

export const RoleEditorView = (props: RoleEditorViewProps) => {
  const { t } = useModernI18n();
  const busy = props.status === 'loading' || props.status === 'saving';
  const blocked =
    busy || props.status === 'conflict' || props.status === 'forbidden' || props.status === 'unauthenticated';
  const modules = [...new Set(props.entries.map((entry) => entry.moduleKey))];
  const confirmations = new Set(props.confirmations);
  const unsupported = props.cells.filter(
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
  const statusKey = props.status === 'invalid' ? 'role.invalidEdit' : `common.${props.status}`;
  return (
    <section aria-label={props.role.name} className="shell:grid shell:gap-6">
      <h2 className="shell:text-title-lg">{props.role.name}</h2>
      <p>{t('shell.accessAdmin.role.description')}</p>
      <dl className="shell:grid shell:gap-2">
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
      {props.status === 'idle' ? null : (
        <StatusText aria-live="polite" status={props.status === 'saved' ? 'success' : 'warning'}>
          {t(`shell.accessAdmin.${statusKey}`)}
        </StatusText>
      )}
      <Button disabled={busy} onClick={props.onRefresh} type="button" variant="secondary">
        {t('shell.accessAdmin.common.refresh')}
      </Button>
      <fieldset className="shell:grid shell:gap-2" disabled={blocked}>
        <legend>{t('shell.accessAdmin.role.template')}</legend>
        <p>{t('shell.accessAdmin.role.fullAccessHelp')}</p>
        {props.templates.length === 0 ? (
          <p>{t('shell.accessAdmin.role.templateUnavailable')}</p>
        ) : (
          props.templates.map((template) => (
            <Button
              disabled={blocked || template.catalogSnapshotId !== props.catalogSnapshotId}
              key={template.templateKey}
              onClick={() => props.onTemplate(template)}
              type="button"
              variant="secondary"
            >
              {template.name}
            </Button>
          ))
        )}
      </fieldset>
      <div className="shell:overflow-x-auto">
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
                      onClick={() => props.onLevel(moduleKey, level)}
                      type="button"
                      variant="secondary"
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
        <RoleCapabilityCells disabled={blocked} entry={entry} key={entry.key} props={props} />
      ))}
      {unsupported.length === 0 ? null : (
        <fieldset className="shell:grid shell:gap-2" disabled={blocked}>
          <legend>{t('shell.accessAdmin.role.unsupportedCells')}</legend>
          {unsupported.map((cell) => (
            <FormCheckbox
              checked
              disabled={blocked}
              key={roleCellSlot(cell)}
              label={[
                cell.capabilityKey,
                t(`shell.accessAdmin.mode.${cell.mode}`),
                t(`shell.accessAdmin.role.${selectorKeys[cell.selector._tag]}`),
              ].join(' · ')}
              onCheckedChange={(checked) => props.onToggleCell(cell, checked)}
            />
          ))}
        </fieldset>
      )}
      <details>
        <summary>{t('shell.accessAdmin.role.cell')}</summary>
        <CellSummary cells={props.cells} />
      </details>
      <Button
        disabled={blocked || props.status === 'invalid'}
        isLoading={props.status === 'loading'}
        onClick={props.onPreview}
        type="button"
      >
        {t(previewLabelKey)}
      </Button>
      {props.preview === null ? null : (
        <section aria-label={t(previewLabelKey)} aria-live="polite" className="shell:grid shell:gap-4">
          <h3 className="shell:text-title-md">{t(previewLabelKey)}</h3>
          <p>
            {t('shell.accessAdmin.role.affectedPeople')}: {props.preview.affectedHumanCount}
          </p>
          <p>{t('shell.accessAdmin.role.affectedPeopleHelp')}</p>
          <ul aria-label={t('shell.accessAdmin.role.affectedPeople')}>
            {props.preview.affectedPeople.map((person) => (
              <li key={person}>
                <code>{person}</code>
              </li>
            ))}
          </ul>
          <div className="shell:grid shell:gap-4 shell:md:grid-cols-2">
            <section aria-label={t('shell.accessAdmin.common.beforeState')}>
              <h4>{t('shell.accessAdmin.common.beforeState')}</h4>
              <CellSummary cells={props.role.cells} />
            </section>
            <section aria-label={t('shell.accessAdmin.common.afterState')}>
              <h4>{t('shell.accessAdmin.common.afterState')}</h4>
              <CellSummary cells={props.cells} />
            </section>
          </div>
          {props.preview.dangerousEffects.map((effect) => (
            <FormCheckbox
              checked={confirmations.has(effect.id)}
              disabled={busy}
              helpText={t('shell.accessAdmin.role.dangerousCell')}
              id={`confirm-${effect.id}`}
              key={effect.id}
              label={t('shell.accessAdmin.role.dangerousConfirmEffect', { effect: effect.description })}
              onCheckedChange={(checked) => props.onConfirm(effect.id, checked)}
            />
          ))}
          <Button
            disabled={!canSaveRolePreview(props.preview, props.confirmations, props.status, props.writesAvailable)}
            isLoading={props.status === 'saving'}
            onClick={props.onSave}
            type="button"
          >
            {t('shell.accessAdmin.role.confirmSave')}
          </Button>
        </section>
      )}
    </section>
  );
};
