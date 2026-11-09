import type { HttpApi } from '@modern-js/bff-effect/effect-client';

import { ShellAuthenticationApi } from '../../shared/api.ts';
import { SymmyIngressGroup } from './contract.ts';

type ShellAuthenticationGroups = (typeof ShellAuthenticationApi.groups)[keyof typeof ShellAuthenticationApi.groups];

/** The server mounts the machine API alongside the Shell groups used by browser clients. */
export const ShellServerApi: HttpApi.HttpApi<
  typeof ShellAuthenticationApi.identifier,
  ShellAuthenticationGroups | typeof SymmyIngressGroup
> = ShellAuthenticationApi.add(SymmyIngressGroup);
