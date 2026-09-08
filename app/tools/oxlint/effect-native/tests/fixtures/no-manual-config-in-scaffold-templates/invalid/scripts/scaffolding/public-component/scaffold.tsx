// expect-count: 4
import type { ReactElement } from 'react';

/** A .tsx generator: the emitted component still reads ambient configuration. */
export const renderPublicComponent = (name: string): string => `
export const ${name} = (): ReactElement => {
  const flags = JSON.parse(process.env.ONTOS_PUBLIC_FLAGS ?? '{}');
  if (Array.isArray(flags)) {
    throw new PublicComponentConfigurationError('flags must be an object');
  }
  return <section data-flags={flags} />;
};
`;

export const banner = (): ReactElement => <span>ontos</span>;
