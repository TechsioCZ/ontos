import { appTools, defineConfig } from '@modern-js/app-tools';

export default defineConfig({
  plugins: [appTools()],
  source: {
    globalVars: {
      ULTRAMODERN_SHELL_ORIGIN: 'http://localhost:3020',
      ULTRAMODERN_SITE_URL: 'http://localhost:4102',
    },
  },
});
