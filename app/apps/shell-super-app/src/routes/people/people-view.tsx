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
import { PeoplePanel } from './people-panel.tsx';

const DetailSearchSchema = Schema.Struct({
  agent: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  person: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
});
const PeopleWorkspace = ({
  companyId,
  linkedAgent,
  linkedPerson,
}: {
  readonly companyId: string | undefined;
  readonly linkedAgent?: string | undefined;
  readonly linkedPerson?: string | undefined;
}) => {
  const [tab, setTab] = useState(linkedAgent === undefined ? 'people' : 'agents');
  const [notification, setNotification] = useState('');
  return (
    <div className="grid gap-250">
      <fieldset aria-label="Lidé a agenti" className="flex gap-100">
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
      {tab === 'people' ? (
        <PeoplePanel companyId={companyId} linkedPerson={linkedPerson} />
      ) : companyId === undefined ? (
        <StatusText status="warning">Pro správu agentů vyberte firmu.</StatusText>
      ) : (
        <AgentEntitiesSection
          legalEntityId={companyId}
          onNotify={(title, description) => setNotification([title, description].filter(Boolean).join(' '))}
        />
      )}
    </div>
  );
};

export const PeopleView = ({ model }: { readonly model: PeoplePageModel }) => {
  const controls = useShellControls(model.shell.state === 'authenticated' ? model.shell : undefined);
  const search = useRouterState({
    select: (state) => Option.getOrUndefined(Schema.decodeOption(DetailSearchSchema)(state.location.search)),
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
      title="Lidé a role"
    >
      <PeopleWorkspace
        companyId={model.shell.selectedLegalEntityId}
        key={`${model.shell.identity.tenantId}:${model.shell.selectedLegalEntityId}:${search?.agent}:${search?.person}`}
        linkedAgent={search?.agent}
        linkedPerson={search?.person}
      />
    </ShellContentLayout>
  );
};
