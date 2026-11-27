// An agent's rights: the company roles it holds (assigned and removed one at a time, under the People page's own rule)
// and what it can actually use of them. An agent never administers and never approves, so a role's administrative
// rights are never listed as the agent's; a change it may only propose is shown as "ke schválení".
import type { AgentEntity, AgentRoleOption, ManageAgentEntityRequest } from '@app/shared-contracts/agent-access';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { Effect } from 'effect';
import { useState } from 'react';
import { runAgentCommand } from './agent-entities-client.ts';
import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { newRequestToken } from './people-client.ts';

const rolesKey = 'shell.agents.roles';
const PEOPLE_ERROR_KEY = 'shell.agents.errors';

export interface AgentRolesBlockProps {
  readonly agent: AgentEntity;
  readonly onChanged: () => void;
  readonly onNotify: (title: string, description?: string) => void;
  readonly roles: readonly AgentRoleOption[];
  /** The People revision of the overview; a stale change is refused and the overview read again. */
  readonly rolesRevision: string;
}

export const AgentRolesBlock = ({ agent, onChanged, onNotify, roles, rolesRevision }: AgentRolesBlockProps) => {
  const { t } = useModernI18n();
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const held = new Set(agent.roles.map((role) => role.roleId));
  const assignable = roles.filter((role) => !held.has(role.roleId));

  const run = (request: ManageAgentEntityRequest, done: string) => {
    setBusy(true);
    setFailure(null);
    browserRuntime.runFork(
      newRequestToken.pipe(
        Effect.flatMap((token) => runAgentCommand(request, `agent-role-${token}`)),
        Effect.andThen((outcome) =>
          Effect.sync(() => {
            if (outcome.status === 'failed') {
              setFailure(outcome.detail ?? t(`${PEOPLE_ERROR_KEY}.${outcome.reason}`));
              if (outcome.reason === 'conflict') {
                onChanged();
              }
              return;
            }
            setChosen(null);
            onNotify(done);
            onChanged();
          }),
        ),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    );
  };

  const assign = () => {
    const role = assignable.find((candidate) => candidate.roleId === chosen);
    if (role === undefined) {
      return;
    }
    run(
      {
        expectedRevision: rolesRevision,
        expectedRoleRevisionId: role.roleRevisionId,
        operation: 'assign-role',
        principalId: agent.principalId,
        roleId: role.roleId,
      },
      t(`${rolesKey}.assigned`, { name: agent.displayName, role: role.name }),
    );
  };

  return (
    <section className="flex min-w-0 flex-col gap-150">
      <h3 className="font-semibold text-sm">{t(`${rolesKey}.title`)}</h3>
      {agent.roles.length === 0 ? (
        <StatusText showIcon status="warning">
          {t(`${rolesKey}.none`)}
        </StatusText>
      ) : (
        <ul className="flex flex-col gap-100">
          {agent.roles.map((role) => (
            <li className="flex flex-wrap items-center justify-between gap-100" key={role.assignmentId}>
              <span className="text-sm">{role.name}</span>
              <Button
                disabled={busy}
                onClick={() =>
                  run(
                    {
                      assignmentId: role.assignmentId,
                      expectedRevision: rolesRevision,
                      operation: 'remove-role',
                      principalId: agent.principalId,
                    },
                    t(`${rolesKey}.removed`, { name: agent.displayName, role: role.name }),
                  )
                }
                size="sm"
                theme="outlined"
                variant="danger"
              >
                {t(`${rolesKey}.remove`)}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {agent.status === 'active' && assignable.length > 0 && (
        <div className="flex flex-wrap items-end gap-100">
          <SelectTemplate
            id={`agent-role-${agent.principalId}`}
            items={assignable.map((role) => ({ displayValue: role.name, label: role.name, value: role.roleId }))}
            label={t(`${rolesKey}.add`)}
            labelProps={{ className: 'text-label-md' }}
            name="role"
            onValueChange={(details) => setChosen(details.value[0] ?? null)}
            placeholder={t('shell.agents.selectPlaceholder')}
            size="sm"
            value={chosen === null ? [] : [chosen]}
          />
          <Button disabled={busy || chosen === null} onClick={assign} size="sm" variant="primary">
            {t(`${rolesKey}.assign`)}
          </Button>
        </div>
      )}
      {failure !== null && (
        <StatusText showIcon status="error">
          {failure}
        </StatusText>
      )}
      <h4 className="font-medium text-sm">{t(`${rolesKey}.usableTitle`)}</h4>
      <p className="text-fg-secondary text-xs">{t(`${rolesKey}.usableHint`)}</p>
      {agent.usable.length === 0 ? (
        <p className="text-fg-secondary text-sm">{t(`${rolesKey}.usableNone`)}</p>
      ) : (
        <ul className="flex flex-col gap-50">
          {agent.usable.map((module) => (
            <li className="flex flex-wrap items-center gap-100" key={module.moduleId}>
              <span className="text-sm">{module.label}</span>
              {module.reads && (
                <Badge size="sm" variant="outline">
                  {t(`${rolesKey}.reads`)}
                </Badge>
              )}
              {module.writes !== 'none' && (
                <Badge size="sm" variant={module.writes === 'direct' ? 'info' : 'warning'}>
                  {t(`${rolesKey}.writes.${module.writes}`)}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
