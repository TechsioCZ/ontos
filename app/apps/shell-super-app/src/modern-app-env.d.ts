/// <reference types="@modern-js/app-tools/types" />

declare const ULTRAMODERN_SITE_URL: string;

declare module 'crm/PageCrm' {
  const PageCrm: React.FunctionComponent<{
    readonly target: unknown;
  }>;
  export default PageCrm;
}
