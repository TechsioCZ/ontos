import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import type { ModuleTargetPageModel } from '../modules/[moduleId]/page.data.ts';
import { ModuleTargetView } from '../modules/[moduleId]/page.tsx';

const ContactsPage = () => {
  const initialModel: ModuleTargetPageModel = useLoaderData({
    from: '/$lang/contacts',
    structuralSharing: false,
  });
  return <ModuleTargetView initialModel={initialModel} />;
};

export default ContactsPage;
