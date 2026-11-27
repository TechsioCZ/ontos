import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Option, Schema } from 'effect';
import { useState } from 'react';

import { ShellContentLayout } from '../shell-content-layout.tsx';
import { SignInRedirect } from '../sign-in-redirect.tsx';
import { useShellControls } from '../use-shell-controls.ts';
import type { PeoplePageModel } from './people-page-model.ts';
import { AgentEntitiesSection } from './agent-entities-section.tsx';
import { DetailSearchSchema, peopleDetailQuery } from './people-detail-selection.ts';
import type { PeopleDetailSelection } from './people-detail-selection.ts';
import { PeoplePanel } from './people-panel.tsx';

const PeopleWorkspace = ({
  companyId,
  linkedAgent,
  linkedPerson,
  linkedPersonCompanyQualified,
  linkedPersonError,
}: {
  readonly companyId: string | undefined;
  readonly linkedAgent?: string | undefined;
  readonly linkedPerson?: string | undefined;
  readonly linkedPersonCompanyQualified?: boolean | undefined;
  readonly linkedPersonError?: string | undefined;
}) => {
  const { t } = useModernI18n();
  const [tab, setTab] = useState(linkedAgent === undefined ? 'people' : 'agents');
  const [notification, setNotification] = useState('');
  return (
    <div className="grid gap-250">
      <fieldset aria-label={t('shell.people.tabs')} className="flex gap-100">
        <Button
          aria-pressed={tab === 'people'}
          onClick={() => setTab('people')}
          theme={tab === 'people' ? 'solid' : 'outlined'}
          variant="secondary"
        >
          Lidé a role
        </Button>
        <Button
          aria-pressed={tab === 'agents'}
          onClick={() => setTab('agents')}
          theme={tab === 'agents' ? 'solid' : 'outlined'}
          variant="secondary"
        >
          AI agenti
        </Button>
      </fieldset>
      {notification === '' ? null : (
        <StatusText aria-live="polite" status="default">
          {notification}
        </StatusText>
      )}
      {tab === 'people' && (
        <PeoplePanel
          companyId={companyId}
          linkedPerson={linkedPerson}
          linkedPersonCompanyQualified={linkedPersonCompanyQualified}
          linkedPersonError={linkedPersonError}
        />
      )}
      {tab === 'agents' && companyId === undefined && (
        <StatusText status="warning">Pro správu agentů vyberte firmu.</StatusText>
      )}
      {tab === 'agents' && companyId !== undefined && (
        <AgentEntitiesSection
          legalEntityId={companyId}
          onNotify={(title, description) => setNotification([title, description].filter(Boolean).join(' '))}
        />
      )}
    </div>
  );
};

const linkedPersonError = (selection: PeopleDetailSelection, t: (key: string) => string): string | undefined => {
  if (selection.state === 'invalid') {
    return t('shell.people.detail.invalidLink');
  }
  if (selection.state === 'foreign_company') {
    return t('shell.people.detail.foreignCompany');
  }
  if (selection.state === 'company_required') {
    return t('shell.people.detail.companyRequired');
  }
  return undefined;
};

export const PeopleView = ({ model }: { readonly model: PeoplePageModel }) => {
  const { t } = useModernI18n();
  const controls = useShellControls(model.shell.state === 'authenticated' ? model.shell : undefined);
  const selectedLegalEntityId = model.shell.state === 'authenticated' ? model.shell.selectedLegalEntityId : undefined;
  const search = useRouterState({
    select: (state) =>
      peopleDetailQuery(
        Option.getOrElse(Schema.decodeUnknownOption(DetailSearchSchema)(state.location.search), () => ({})),
        selectedLegalEntityId,
      ),
  });
  if (model.shell.state === 'anonymous') {
    return <SignInRedirect reason={model.shell.reason} />;
  }
  if (model.shell.state !== 'authenticated' || controls.reloadRequired) {
    return (
      <main className="p-300">
        <StatusText status="error">Správa lidí je nedostupná. Obnovte stránku a vyberte firmu.</StatusText>
      </main>
    );
  }
  return (
    <ShellContentLayout
      controls={controls}
      currentEntrypointKey="shell-super-app.page.people"
      shell={model.shell}
      title={t('shell.people.title')}
    >
      <PeopleWorkspace
        companyId={selectedLegalEntityId}
        key={`${model.shell.identity.tenantId}:${model.shell.identity.principalId}:${selectedLegalEntityId}:${search.agent}:${search.person.state}:${
          search.person.state === 'selected' ? search.person.principalId : ''
        }`}
        linkedAgent={search.agent}
        linkedPerson={search.person.state === 'selected' ? search.person.principalId : undefined}
        linkedPersonCompanyQualified={search.person.state === 'selected' && search.person.companyQualified}
        linkedPersonError={linkedPersonError(search.person, t)}
      />
    </ShellContentLayout>
  );
};
