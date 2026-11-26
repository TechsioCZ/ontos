import { Context } from 'effect';
import type { ShellAuthenticationApiRuntimeArguments } from './index.ts';

export class ShellAuthenticationApiRuntimeConfiguration extends Context.Service<
  ShellAuthenticationApiRuntimeConfiguration,
  ShellAuthenticationApiRuntimeArguments
>()(
  '@app/shell-super-app/api/shell-authentication-api-runtime-configuration/ShellAuthenticationApiRuntimeConfiguration',
) {}
