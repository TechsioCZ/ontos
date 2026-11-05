import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData, useRouter } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Match, Result, Schema } from 'effect';
import type { Cause } from 'effect';
import { useRef, useState } from 'react';

import { createAccessAdministrationIdempotencyKey } from '../../../../api/auth-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { submitPeopleCommand } from '../../../access-admin/people/people-commands.ts';
import { toPeopleViewModel } from '../../../access-admin/people/people-presentation.ts';
import { PeopleView } from '../../../access-admin/people/people-view.tsx';
import { PeopleCommandIdentitySchema } from '../../../access-admin/people/people-view-model.ts';
import type { PeopleCommand, PeopleFeedback } from '../../../access-admin/people/people-view-model.ts';
import { ShellContentLayout } from '../../../shell-content-layout.tsx';
import { UltramodernRouteHead } from '../../../ultramodern-route-head.tsx';
import { useShellControls } from '../../../use-shell-controls.ts';

const PeoplePage = () => {
  const { language, t } = useModernI18n();
  const model = useLoaderData({ from: '/$lang/access/people' });
  const router = useRouter();
  const controls = useShellControls(model.shell.state === 'authenticated' ? model.shell : undefined);
  const [feedback, setFeedback] = useState<PeopleFeedback>('idle');
  const inFlight = useRef(false);
  const retryIdentity = useRef<{ readonly command: string; readonly key: string } | null>(null);
  const handleRefreshFailure = (error: Cause.UnknownError | Cause.TimeoutError) => {
    const failed = Match.value(error).pipe(
      Match.tag('UnknownError', 'TimeoutError', () => 'unavailable' as const),
      Match.exhaustive,
    );
    setFeedback(failed);
  };
  const refresh = () => {
    if (inFlight.current) {
      return;
    }
    void browserRuntime.runPromise(
      Effect.tryPromise(() => router.invalidate({ sync: true })).pipe(
        Effect.timeout('30 seconds'),
        Effect.match({ onFailure: handleRefreshFailure, onSuccess: () => setFeedback('idle') }),
      ),
    );
  };
  const handleCommand = (command: PeopleCommand, expectedRevision: string) => {
    if (model.state !== 'ready' || inFlight.current) {
      return;
    }
    const encodedIdentity = Schema.encodeResult(PeopleCommandIdentitySchema)({ command, expectedRevision });
    if (Result.isFailure(encodedIdentity)) {
      setFeedback('invalid');
      return;
    }
    const commandIdentity = encodedIdentity.success;
    inFlight.current = true;
    setFeedback('saving');
    const key =
      retryIdentity.current?.command === commandIdentity
        ? Effect.succeed(retryIdentity.current.key)
        : createAccessAdministrationIdempotencyKey().pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                retryIdentity.current = { command: commandIdentity, key: value };
              }),
            ),
          );
    void browserRuntime.runPromise(
      key.pipe(
        Effect.flatMap((idempotencyKey) =>
          submitPeopleCommand({
            command,
            expectedRevision,
            options: { idempotencyKey, locale: language },
            reason: t(
              command.kind === 'remove-role'
                ? 'shell.accessAdmin.people.confirmRemove'
                : 'shell.accessAdmin.people.delegationRevoke',
            ),
            snapshot: model.snapshot,
          }),
        ),
        Effect.catchTag('PlatformError', () => Effect.succeed<PeopleFeedback>('unavailable')),
        Effect.flatMap((result) => {
          setFeedback(result);
          if (result !== 'saved') {
            return Effect.void;
          }
          return Effect.tryPromise(() => router.invalidate({ sync: true })).pipe(
            Effect.timeout('30 seconds'),
            Effect.match({
              onFailure: handleRefreshFailure,
              onSuccess: () => {
                retryIdentity.current = null;
                setFeedback('saved');
              },
            }),
          );
        }),
        Effect.ensuring(
          Effect.sync(() => {
            inFlight.current = false;
          }),
        ),
      ),
    );
  };
  const nextPage = () => {
    if (model.state === 'ready' && model.snapshot.people.nextCursor !== null) {
      const url = new URL(globalThis.location.href);
      url.searchParams.set('cursor', model.snapshot.people.nextCursor);
      globalThis.location.assign(url.href);
    }
  };
  const reloadRequired =
    model.state === 'reload_required' || model.shell.state === 'reload_required' || controls.reloadRequired;
  const closedMessage =
    model.state === 'unauthenticated'
      ? 'shell.accessAdmin.common.unauthenticated'
      : 'shell.accessAdmin.common.unavailable';
  if (reloadRequired || model.shell.state !== 'authenticated') {
    return (
      <>
        <UltramodernRouteHead />
        <main className="shell:mx-auto shell:grid shell:w-full shell:max-w-5xl shell:gap-6 shell:px-4 shell:py-8">
          <StatusText aria-live="polite" showIcon status="error">
            {t(reloadRequired ? 'shell.moduleTarget.reload_required' : closedMessage)}
          </StatusText>
        </main>
      </>
    );
  }
  return (
    <>
      <UltramodernRouteHead />
      <ShellContentLayout
        controls={controls}
        currentAccessPage="people"
        shell={model.shell}
        title={t('shell.accessAdmin.people.title')}
      >
        {model.state === 'ready' ? (
          <PeopleView
            feedback={feedback}
            model={toPeopleViewModel(model.snapshot, {
              locale: language,
              tenant: t('shell.accessAdmin.common.tenantContext'),
              unknown: t('shell.accessAdmin.common.unknown'),
            })}
            onCommand={handleCommand}
            onNextPage={nextPage}
            onRefresh={refresh}
          />
        ) : (
          <section className="shell:grid shell:gap-4">
            <StatusText aria-live="polite" showIcon status="error">
              {t(
                model.state === 'invalid'
                  ? 'shell.accessAdmin.people.invalid'
                  : `shell.accessAdmin.common.${model.state}`,
              )}
            </StatusText>
            {model.state === 'unavailable' || model.state === 'conflict' ? (
              <Button onClick={refresh} type="button">
                {t('shell.accessAdmin.common.retry')}
              </Button>
            ) : null}
          </section>
        )}
      </ShellContentLayout>
    </>
  );
};

export default PeoplePage;
