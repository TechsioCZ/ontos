import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Result, Schema } from 'effect';
import { startTransition, useActionState } from 'react';

import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { WhyView } from '../../../access-admin/why/why-view.tsx';
import { completeWhyCheck, hiddenWhySubjects } from '../../../access-admin/why/why-view-model.ts';
import type { WhyCheckState, WhySearchDraft, WhySubjectOptions } from '../../../access-admin/why/why-view-model.ts';
import { ShellContentLayout } from '../../../shell-content-layout.tsx';
import { useShellControls } from '../../../use-shell-controls.ts';
import { checkWhySearch, loadWhySubjects, mergeWhySubjects } from './why-page-model.ts';
import type { WhyPageModel } from './why-page-model.ts';

const encodePageKey = Schema.encodeResult(Schema.fromJsonString(Schema.Array(Schema.String)));

const WhyPageContent = ({ model }: { readonly model: WhyPageModel }) => {
  const { language, t } = useModernI18n();
  const controls = useShellControls(model.shell.state === 'authenticated' ? model.shell : undefined);
  const [subjects, morePeople, peoplePending] = useActionState((previous: WhySubjectOptions) => {
    if (previous.state === 'ready' && previous.nextCursor !== null) {
      return browserRuntime.runPromise(
        loadWhySubjects({ locale: language }, previous.nextCursor).pipe(
          Effect.map((next) => mergeWhySubjects(previous, next)),
        ),
      );
    }
    return browserRuntime.runPromise(loadWhySubjects({ locale: language }));
  }, model.subjects);
  const [check, submit, pending] = useActionState(
    (previous: WhyCheckState, draft: WhySearchDraft) =>
      browserRuntime.runPromise(
        checkWhySearch(draft, { locale: language }, previous.subjectsDenied ? hiddenWhySubjects : subjects).pipe(
          Effect.map((result) => completeWhyCheck(previous, draft, result)),
        ),
      ),

    {
      draft: model.draft,
      result: model.result,
      subjectsDenied: model.result.state === 'forbidden' && model.draft.subject.length > 0,
    },
  );
  const onCheck = (draft: WhySearchDraft) => startTransition(() => submit(draft));
  if (model.shell.state === 'reload_required' || controls.reloadRequired) {
    return (
      <main className="shell:p-6">
        <StatusText showIcon status="error">
          {t('shell.moduleTarget.reload_required')}
        </StatusText>
      </main>
    );
  }
  if (model.shell.state === 'authenticated') {
    return (
      <ShellContentLayout
        controls={controls}
        currentAccessPage="why"
        shell={model.shell}
        title={t('shell.accessAdmin.why.title')}
      >
        <WhyView
          draft={check.subjectsDenied ? { ...check.draft, subject: '' } : model.draft}
          key={check.subjectsDenied ? 'self-only' : 'with-subjects'}
          onCheck={onCheck}
          onMorePeople={() => startTransition(() => morePeople())}
          onRetry={() => onCheck(check.draft)}
          pending={pending || peoplePending}
          result={check.result}
          subjects={check.subjectsDenied ? hiddenWhySubjects : subjects}
        />
      </ShellContentLayout>
    );
  }
  return (
    <main className="shell:p-6">
      <StatusText showIcon status="error">
        {t(
          model.shell.state === 'anonymous'
            ? 'shell.accessAdmin.common.unauthenticated'
            : 'shell.dashboard.unavailable',
        )}
      </StatusText>
    </main>
  );
};

const WhyPage = () => {
  const model = useLoaderData({ from: '/$lang/access/why' });
  const identity =
    model.shell.state === 'authenticated'
      ? [model.shell.identity.tenantId, model.shell.identity.principalId]
      : [model.shell.state];
  const key = encodePageKey([...identity, ...Object.values(model.draft)]).pipe(Result.getOrElse(() => 'unavailable'));
  return <WhyPageContent key={key} model={model} />;
};

export default WhyPage;
