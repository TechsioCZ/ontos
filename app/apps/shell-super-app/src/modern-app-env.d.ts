import '@modern-js/app-tools/types';
import type React from 'react';

declare global {
  const ULTRAMODERN_SITE_URL: string;
}

declare module 'ticketing/Widget' {
  const Component: React.ComponentType<Record<string, never>>;
  export default Component;
}
