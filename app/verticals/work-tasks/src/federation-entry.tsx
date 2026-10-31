import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import type { JSX } from 'react';

import csResource from '../locales/cs/work-tasks.json';
import enResource from '../locales/en/work-tasks.json';

const federatedI18nLanguages = ['en', 'cs'];
const federatedI18nResources = {
  cs: { 'work-tasks': csResource },
  en: { 'work-tasks': enResource },
};

const WorkTasksRouteContent = () => {
  const { t } = useModernI18n();

  return (
    <section
      className="worktasks:rounded-2xl worktasks:bg-white/90 worktasks:p-5 worktasks:shadow-xl worktasks:shadow-stone-900/10"
      data-modern-boundary-id="verticalWorkTasks"
      data-modern-mf-expose="./Route"
    >
      <h2 className="worktasks:text-2xl worktasks:font-black">{t('work-tasks.title')}</h2>
      <p className="worktasks:mt-2 worktasks:text-stone-600">{t('work-tasks.routeSurface')}</p>
    </section>
  );
};

const WorkTasksRoute = (props: Record<string, never>): JSX.Element => {
  void props;

  return (
    <FederatedI18nBoundary
      defaultNamespace="work-tasks"
      fallbackLanguage="en"
      resources={federatedI18nResources}
      supportedLanguages={federatedI18nLanguages}
    >
      <WorkTasksRouteContent />
    </FederatedI18nBoundary>
  );
};

export default WorkTasksRoute;
