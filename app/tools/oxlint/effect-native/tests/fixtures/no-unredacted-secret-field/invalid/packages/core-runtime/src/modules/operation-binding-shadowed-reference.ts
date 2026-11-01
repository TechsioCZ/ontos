// expect-count: 1
import type { AnyActionRegistration as ActionBinding } from '../actions/definition.ts';
import type { AnyReadRegistration as ReadBinding } from '../reads/definition.ts';
import { HttpApi as H } from 'effect/http-api';

export interface OperationBinding {
  readonly apiKey: string;
  readonly operationKey: string;
  readonly registration: ActionBinding | ReadBinding;
}

export interface PublicSurface<OperationBinding> {
  readonly api: Readonly<Record<string, H.Constraint>>;
  readonly operationContracts?: readonly OperationBinding[];
}
