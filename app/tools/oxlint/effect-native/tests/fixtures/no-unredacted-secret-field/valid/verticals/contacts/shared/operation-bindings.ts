import type { AnyActionRegistration as ActionBinding } from '@app/core-runtime';
import type { AnyReadRegistration as ReadBinding } from '@app/core-runtime';
import { HttpApi as H } from 'effect/http-api';

export interface OperationBinding {
  readonly apiKey: string;
  readonly operationKey: string;
  readonly registration: ActionBinding | ReadBinding;
}

export interface PublicSurface {
  readonly api: Readonly<Record<string, H.Constraint>>;
  readonly operationContracts?: readonly OperationBinding[];
}
