/// <reference types="@modern-js/app-tools/types" />

declare const ULTRAMODERN_SITE_URL: string;

declare module 'projects/PageProjects' {
  const PageProjects: React.FunctionComponent<{
    readonly target: unknown;
  }>;
  export default PageProjects;
}
