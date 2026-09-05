// A parameter shadowing an imported dotenv-like name is not the dotenv binding.
import { loadWorkspaceConfiguration } from './workspace.ts';

export const run = (loadDotenv: (input: { readonly path: string }) => void): void => {
  loadDotenv({ path: '.env' });
  loadWorkspaceConfiguration();
};
