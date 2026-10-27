import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';

import { SignInRedirect } from '../../sign-in-redirect.tsx';
import { ConnectedAppsSection } from './connected-apps-section.tsx';
import { ShellContentLayout } from '../../shell-content-layout.tsx';
import { useShellControls } from '../../use-shell-controls.ts';

const ProfilePage = () => {
  const { t } = useModernI18n();
  const model = useLoaderData({ from: '/$lang/profile' });
  const controls = useShellControls(model.shell.state === 'authenticated' ? model.shell : undefined);
  if (model.shell.state === 'reload_required' || controls.reloadRequired) {
    return (
      <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-8">
        <StatusText aria-live="polite" showIcon status="error">
          {t('shell.moduleTarget.reload_required')}
        </StatusText>
      </main>
    );
  }
  if (model.shell.state === 'anonymous') {
    return <SignInRedirect reason={model.shell.reason} />;
  }
  if (model.shell.state !== 'authenticated') {
    return (
      <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-8">
        <StatusText aria-live="polite" showIcon status="error">
          {t(model.shell.state === 'unavailable' ? 'shell.dashboard.unavailable' : 'shell.profile.loading')}
        </StatusText>
      </main>
    );
  }
  return (
    <ShellContentLayout controls={controls} shell={model.shell} title={t('shell.profile.title')}>
      <div className="grid w-full min-w-0 gap-300">
        <section className="ontos-card rounded-lg border border-border-primary/60 bg-base [&_.ontos-card]:border-0 [&_.ontos-card]:bg-transparent [&_.ontos-card]:p-0 grid max-w-6xl gap-100 p-300">
          <h2 className="font-semibold text-lg">{t('shell.profile.identity')}</h2>
          <p className="text-sm">{model.shell.identity.displayName}</p>
        </section>
        <ConnectedAppsSection />
      </div>
    </ShellContentLayout>
  );
};

export default ProfilePage;
