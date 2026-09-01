/// <reference types="@modern-js/app-tools/types" />

declare const ULTRAMODERN_SITE_URL: string;

declare module 'contacts/PageContacts' {
  const PageContacts: React.FunctionComponent<{
    readonly target: unknown;
  }>;
  export default PageContacts;
}
