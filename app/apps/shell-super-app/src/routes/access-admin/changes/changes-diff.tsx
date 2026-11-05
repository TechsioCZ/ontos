import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Match } from 'effect';

import type { ChangeCellView, ChangeReceiptView, RoleChangeView } from './changes-model.ts';

const scopeKeys = {
  all: 'shell.accessAdmin.role.scopeAll',
  assigned: 'shell.accessAdmin.role.scopeAssigned',
  entrusted: 'shell.accessAdmin.role.scopeEntrusted',
  targets: 'shell.accessAdmin.role.scopeTargets',
  team: 'shell.accessAdmin.role.scopeTeam',
} as const;

export const ChangeCells = ({ cells }: { readonly cells: readonly ChangeCellView[] }) => {
  const { t } = useModernI18n();
  if (cells.length === 0) {
    return <p>{t('shell.accessAdmin.common.none')}</p>;
  }
  return (
    <ul className="shell:grid shell:gap-2">
      {cells.map((cell) => (
        <li className="shell:grid shell:gap-1" key={`${cell.capabilityKey}:${cell.mode}:${cell.selector._tag}`}>
          <span>{cell.capabilityKey}</span>
          <span>{t(`shell.accessAdmin.mode.${cell.mode}`)}</span>
          <span>{t(scopeKeys[cell.selector._tag])}</span>
          {Match.value(cell.selector).pipe(
            Match.tag('targets', (selector) => <span>{selector.recordKeys.join(', ')}</span>),
            Match.tag('all', 'assigned', 'entrusted', 'team', () => null),
            Match.exhaustive,
          )}
          {cell.amountCeiling !== undefined && (
            <span>
              {t('shell.accessAdmin.changes.amountCeiling', {
                amount: cell.amountCeiling.limitMinor,
                currency: cell.amountCeiling.currency,
              })}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
};

export const ChangeRoleDiff = ({ changes }: { readonly changes: readonly RoleChangeView[] | null }) => {
  const { t } = useModernI18n();
  if (changes === null) {
    return <p>{t('shell.accessAdmin.common.notAvailable')}</p>;
  }
  if (changes.length === 0) {
    return <p>{t('shell.accessAdmin.changes.noRoleChanges')}</p>;
  }
  return (
    <div className="shell:grid shell:gap-4">
      {changes.map((change) => (
        <section className="shell:grid shell:gap-2" key={change.roleId}>
          <h4>{change.roleName}</h4>
          <dl>
            <dt>{t('shell.accessAdmin.changes.roleRevision')}</dt>
            <dd>{change.expectedRevisionId}</dd>
          </dl>
          <div className="shell:grid shell:gap-4 shell:md:grid-cols-2">
            <div>
              <h5>{t('shell.accessAdmin.common.beforeState')}</h5>
              <ChangeCells cells={change.before} />
            </div>
            <div>
              <h5>{t('shell.accessAdmin.common.afterState')}</h5>
              <ChangeCells cells={change.after} />
            </div>
          </div>
        </section>
      ))}
    </div>
  );
};

export const ChangeSkips = ({ skipped }: { readonly skipped: ChangeReceiptView['skipped'] | null }) => {
  const { t } = useModernI18n();
  if (skipped === null || skipped.length === 0) {
    return (
      <p>
        {t('shell.accessAdmin.changes.undoSkips', {
          items: t(skipped === null ? 'shell.accessAdmin.common.notAvailable' : 'shell.accessAdmin.common.none'),
        })}
      </p>
    );
  }
  return (
    <ul className="shell:grid shell:gap-2">
      {skipped.map((skip) => (
        <li key={`${skip.roleId}:${skip.capabilityKey}:${skip.slot}`}>
          {t('shell.accessAdmin.changes.undoSkippedItem', {
            item: skip.capabilityKey,
            reason: t(`shell.accessAdmin.changes.skipReason.${skip.reason}`),
            role: skip.roleId,
          })}
        </li>
      ))}
    </ul>
  );
};
