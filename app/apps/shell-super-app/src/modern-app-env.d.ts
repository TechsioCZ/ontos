/// <reference types="@modern-js/app-tools/types" />

declare const ULTRAMODERN_SITE_URL: string;

declare module 'partyRegistry/Page*' {
  const VerticalPage: React.FunctionComponent<{
    readonly routeParams: Readonly<Record<string, string>>;
    readonly target: import('../shared/api.ts').ResolvedModuleTarget;
  }>;
  export default VerticalPage;
}
