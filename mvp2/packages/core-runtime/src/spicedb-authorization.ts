// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off processEnv:off strictBooleanExpressions:off

export type SpiceDbAuthorizationDecision =
  | {
      readonly _tag: 'Allowed';
    }
  | {
      readonly _tag: 'Denied';
      readonly message: string;
    }
  | {
      readonly _tag: 'Unavailable';
      readonly message: string;
    };

export type SpiceDbPermissionCheckInput = {
  readonly permission: string;
  readonly resourceObjectId: string;
  readonly resourceObjectType: string;
  readonly subjectObjectId: string;
  readonly subjectObjectType: 'principal';
};

export type SpiceDbAuthorizationChecker = (
  input: SpiceDbPermissionCheckInput,
) => Promise<SpiceDbAuthorizationDecision>;

export const createTenantScopedSpiceDbPermissionCheck = ({
  permission,
  principalId,
  resourceObjectId,
  resourceObjectType,
  tenantId,
}: {
  readonly permission: string;
  readonly principalId: string;
  readonly resourceObjectId: string;
  readonly resourceObjectType: string;
  readonly tenantId: string;
}): SpiceDbPermissionCheckInput => ({
  permission,
  resourceObjectId: `${tenantId}_${resourceObjectId.replaceAll('.', '-')}`,
  resourceObjectType,
  subjectObjectId: principalId,
  subjectObjectType: 'principal',
});

type CoreSpiceDbConfig = {
  readonly endpoint: string;
  readonly insecure: boolean;
  readonly presharedKey: string;
};

const readSpiceDbConfig = (): CoreSpiceDbConfig => ({
  endpoint: process.env['SPICEDB_ENDPOINT'] ?? 'localhost:50051',
  insecure: (process.env['SPICEDB_INSECURE'] ?? 'true') !== 'false',
  presharedKey: process.env['SPICEDB_PRESHARED_KEY'] ?? 'local-spicedb-key',
});

const isCallable = (value: unknown): value is (...args: unknown[]) => unknown =>
  typeof value === 'function';

const stringRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const permissionshipAllows = (value: unknown): boolean => {
  const text = String(value).toLowerCase();

  return text.includes('has_permission') || text === '2' || text === 'true';
};

export const createSpiceDbAuthorizationChecker =
  (config: CoreSpiceDbConfig = readSpiceDbConfig()): SpiceDbAuthorizationChecker =>
  async (input) => {
    try {
      const authzed = stringRecord(await import('@authzed/authzed-node'));
      const v1 = stringRecord(authzed['v1']);
      const newClient = v1['NewClient'];

      if (!isCallable(newClient)) {
        throw new Error('@authzed/authzed-node did not expose v1.NewClient.');
      }

      const security = stringRecord(v1['ClientSecurity']);
      const transportSecurity = config.insecure
        ? security['INSECURE_LOCALHOST_ALLOWED']
        : security['SECURE'];
      const client = stringRecord(
        newClient(config.presharedKey, config.endpoint, transportSecurity),
      );
      const promises = stringRecord(client['promises']);
      const checkPermission = promises['checkPermission'] ?? client['checkPermission'];

      if (!isCallable(checkPermission)) {
        throw new Error('@authzed/authzed-node client did not expose checkPermission.');
      }

      const response = stringRecord(
        await checkPermission.call(client, {
          permission: input.permission,
          resource: {
            objectId: input.resourceObjectId,
            objectType: input.resourceObjectType,
          },
          subject: {
            object: {
              objectId: input.subjectObjectId,
              objectType: input.subjectObjectType,
            },
          },
        }),
      );

      return permissionshipAllows(response['permissionship'])
        ? { _tag: 'Allowed' }
        : {
            _tag: 'Denied',
            message: `SpiceDB denied ${input.permission} on ${input.resourceObjectType}:${input.resourceObjectId}.`,
          };
    } catch (error) {
      return {
        _tag: 'Unavailable',
        message: error instanceof Error ? error.message : 'SpiceDB permission check failed closed.',
      };
    }
  };

export const spiceDbAuthorizationChecker = createSpiceDbAuthorizationChecker();
