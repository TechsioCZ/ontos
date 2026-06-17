// @effect-diagnostics asyncFunction:off
import { getCurrentAuthContext } from './auth/demo-auth.ts';

type ResolvedOperationIdentity = {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
};

// oxlint-disable-next-line typescript/consistent-type-definitions
export type OperationContextAuthRequired = {
  readonly _tag: 'OperationContextAuthRequired';
  readonly message: string;
};

export type ResolveOperationContextFromSessionResult =
  | {
      readonly _tag: 'Success';
      readonly operationContext: ResolvedOperationIdentity;
    }
  | {
      readonly _tag: 'Failure';
      readonly error: OperationContextAuthRequired;
    };

const authRequired = (): OperationContextAuthRequired => ({
  _tag: 'OperationContextAuthRequired',
  message: 'Authentication is required to create an operation context.',
});

export const resolveOperationContextFromSession = async ({
  headers,
}: {
  headers: Headers;
}): Promise<ResolveOperationContextFromSessionResult> => {
  const { context } = await getCurrentAuthContext({ headers }).catch(() => ({ context: null }));

  if (context === null) {
    return {
      _tag: 'Failure',
      error: authRequired(),
    };
  }

  return {
    _tag: 'Success',
    operationContext: {
      legalEntityId: context.legalEntity.id,
      principalId: context.principal.id,
      tenantId: context.tenant.id,
    },
  };
};
