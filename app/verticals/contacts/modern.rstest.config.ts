import { appTools, defineConfig } from '@modern-js/app-tools';

export default defineConfig({
  plugins: [appTools()],
  source: {
    globalVars: {
      ULTRAMODERN_CONTACTS_API_BASE_URL: 'http://localhost:4101/contacts-api',
      ULTRAMODERN_SHELL_ORIGIN: 'http://localhost:3020',
      ULTRAMODERN_SITE_URL: 'http://localhost:4101',
    },
  },
});
