import { Schema } from 'effect';

const TenantIdSchema = Schema.String.pipe(Schema.brand('TenantId'));

type Props = { readonly tenantId: string };

const Row = ({ tenantId }: Props): unknown => <span data-key={tenantId}>{tenantId}</span>;

// JSX attributes and plain option objects are not Schema field bags.
export const View = (): unknown => (
  <Row tenantId="t-1" {...{ principalId: 'p-1' }} />
);

export const Contract = Schema.Struct({ tenantId: TenantIdSchema });
