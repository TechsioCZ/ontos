// The preview and value fields of the bulk change by tag, and the rules the dialog sends by.
import { StatusBadge, surfaceTileClassName } from '@app/admin-ui';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Option, Schema } from 'effect';
import type { BulkOpportunityPatch } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { Opportunity } from '../../../../../shared/model/opportunity.ts';
import { isOpenStage } from '../../../../../shared/model/opportunity.ts';
import { isOpportunityStage, opportunityCount, opportunityStages } from './pipeline-model.ts';
import type { OpportunityStage, SkipTally } from './pipeline-model.ts';
import type { EmployeeOption, LoadState } from './pipeline-references.ts';

export const SELECT_PLACEHOLDER = 'sales-pipeline.selectPlaceholder';

export const K = 'sales-pipeline.pages.records';
export const NONE = '__none__';
/** Server limit for one bulk command. */
export const BULK_LIMIT = 200;

export const KindSchema = Schema.Literals(['customer', 'opportunity']);
export const ActionSchema = Schema.Literals(['stage', 'owner']);
export type Kind = typeof KindSchema.Type;
export type Action = typeof ActionSchema.Type;

export type Members = LoadState<ReadonlySet<string>> | undefined;

export interface BulkByTagResult {
  readonly changed: number;
  readonly skipped: SkipTally;
}

/**
 * Open opportunities the tag selects. A customer tag selects the opportunities of tagged customers;
 * an opportunity tag selects the tagged opportunities.
 */
export const previewOf = (
  population: LoadState<RecordsResponse>,
  members: Members,
  kind: Kind,
): readonly Opportunity[] => {
  if (population.status !== 'ready' || members?.status !== 'ready') {
    return [];
  }
  const selected = members.items;
  return population.items.items.filter(
    (opportunity) =>
      isOpenStage(opportunity.stage) && selected.has(kind === 'customer' ? opportunity.partyId : opportunity.id),
  );
};

/** The change for the chosen action, or `undefined` while the value is missing or unknown. */
export const patchOf = (
  action: Action,
  stage: OpportunityStage | '',
  owner: string,
  employees: readonly EmployeeOption[],
): BulkOpportunityPatch | undefined => {
  if (action === 'stage') {
    return isOpportunityStage(stage) ? { stage } : undefined;
  }
  if (owner === NONE) {
    return { ownerEmployeeId: Option.none() };
  }
  const employee = employees.find((item) => item.id === owner);
  return employee === undefined ? undefined : { ownerEmployeeId: Option.some(employee.id) };
};

interface BulkByTagPreviewProps {
  readonly customerLabel: (partyId: string) => string;
  readonly members: Members;
  readonly population: LoadState<RecordsResponse>;
  readonly preview: readonly Opportunity[];
  readonly tagChosen: boolean;
  readonly tooMany: boolean;
}

/** Failure text key for the preview, or `undefined` when both reads are fine. */
const failureKeyOf = (members: Members, population: LoadState<RecordsResponse>): string | undefined => {
  if (members?.status === 'error') {
    return `${K}.bulkByTag.tagsFailed`;
  }
  return population.status === 'error' ? `${K}.bulkByTag.loadFailed` : undefined;
};

/** Hint key shown in place of the list: choose a tag, still loading, or nothing matches. */
const noticeKeyOf = (tagChosen: boolean, loading: boolean, empty: boolean): string | undefined => {
  if (!tagChosen) {
    return `${K}.bulkByTag.chooseTag`;
  }
  if (loading) {
    return `${K}.bulkByTag.loading`;
  }
  return empty ? `${K}.bulkByTag.previewEmpty` : undefined;
};

/** The affected opportunities, or why there are none yet. */
export const BulkByTagPreview = ({
  customerLabel,
  members,
  population,
  preview,
  tagChosen,
  tooMany,
}: BulkByTagPreviewProps) => {
  const { t } = useModernI18n();
  const counted = tagChosen && population.status === 'ready' && members?.status === 'ready';
  const failureKey = tagChosen ? failureKeyOf(members, population) : undefined;
  const loading = members?.status === 'loading' || population.status === 'loading';
  const noticeKey =
    failureKey === undefined ? noticeKeyOf(tagChosen, loading, counted && preview.length === 0) : undefined;

  return (
    <section className="flex flex-col gap-100">
      <div className="flex items-baseline justify-between gap-100">
        <span className="font-medium text-sm">{t(`${K}.bulkByTag.preview`)}</span>
        {counted && <span className="text-fg-secondary text-sm tabular-nums">{opportunityCount(preview.length)}</span>}
      </div>
      {failureKey !== undefined && (
        <StatusText showIcon status="error">
          {t(failureKey)}
        </StatusText>
      )}
      {noticeKey !== undefined && <p className="text-fg-secondary text-sm">{t(noticeKey)}</p>}
      {counted && preview.length > 0 && (
        <ul className={`${surfaceTileClassName} flex max-h-72 flex-col gap-50 overflow-y-auto p-100`}>
          {preview.map((opportunity) => (
            <li className="flex items-center justify-between gap-150 px-50 py-50 text-sm" key={opportunity.id}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{opportunity.title}</span>
                <span className="truncate text-fg-secondary text-xs">{customerLabel(opportunity.partyId)}</span>
              </span>
              <StatusBadge kind="opportunity" value={opportunity.stage} />
            </li>
          ))}
        </ul>
      )}
      {tooMany && (
        <StatusText showIcon status="error">
          {t(`${K}.bulkByTag.tooMany`, { limit: BULK_LIMIT })}
        </StatusText>
      )}
    </section>
  );
};

interface BulkByTagValueProps {
  readonly action: Action;
  readonly activeEmployees: readonly EmployeeOption[];
  readonly onAction: (action: Action) => void;
  readonly onOwner: (owner: string) => void;
  readonly onStage: (stage: OpportunityStage | '') => void;
  readonly owner: string;
  readonly stage: OpportunityStage | '';
  readonly valueMissing: boolean;
}

/** Action choice and the value for it: a stage or an owner (`Nepřiřazeno` clears it). */
export const BulkByTagValueFields = ({
  action,
  activeEmployees,
  onAction,
  onOwner,
  onStage,
  owner,
  stage,
  valueMissing,
}: BulkByTagValueProps) => {
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
      <SelectTemplate
        items={actionItems}
        label={t(`${K}.bulkByTag.action`)}
        name="bulkAction"
        onValueChange={({ value: [next] }) => onAction(Schema.is(ActionSchema)(next) ? next : 'stage')}
        placeholder={t(SELECT_PLACEHOLDER)}
        size="md"
        value={[action]}
      />
      {action === 'stage' ? (
        <SelectTemplate
          items={stageItems}
          label={t(`${K}.bulkByTag.stage`)}
          name="stage"
          onValueChange={({ value: [next] }) => onStage(isOpportunityStage(next) ? next : '')}
          placeholder={t(SELECT_PLACEHOLDER)}
          size="md"
          value={stage === '' ? [] : [stage]}
        />
      ) : (
        <SelectTemplate
          items={ownerItems}
          label={t(`${K}.bulkByTag.owner`)}
          name="owner"
          onValueChange={({ value: [next] }) => onOwner(next ?? '')}
          placeholder={t(SELECT_PLACEHOLDER)}
          size="md"
          value={owner === '' ? [] : [owner]}
        />
      )}
      {valueMissing && (
        <StatusText showIcon status="error">
          {t(`${K}.bulkByTag.valueRequired`)}
        </StatusText>
      )}
    </>
  );
};
