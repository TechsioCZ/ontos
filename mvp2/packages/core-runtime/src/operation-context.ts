// oxlint-disable-next-line typescript/consistent-type-definitions
export type OperationContext<TAction> = {
  action: TAction;
  legalEntityId: string;
  principalId: string;
  tenantId: string;
};
