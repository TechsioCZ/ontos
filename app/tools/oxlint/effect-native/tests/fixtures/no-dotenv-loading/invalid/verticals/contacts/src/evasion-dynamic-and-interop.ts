// Dynamic + interop shapes.
import * as dotenvNamespace from 'dotenv';

export const viaDefaultInterop = (): void => {
  dotenvNamespace.default.config({ quiet: true });
};

export const viaDestructuredNamespace = (): void => {
  const { config } = dotenvNamespace;
  config({ quiet: true });
};

export const viaAwaitImport = async (): Promise<void> => {
  const { config } = await import('@dotenvx/dotenvx');
  config({ quiet: true });
};

export const viaTemplateSpecifier = async (): Promise<unknown> => await import(`dotenv/config`);
