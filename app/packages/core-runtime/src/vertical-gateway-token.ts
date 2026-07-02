// @effect-diagnostics globalDate:off nodeBuiltinImport:off processEnv:off
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

interface ResolvedOperationIdentity {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface VerticalGatewayTokenMissing {
  readonly _tag: 'VerticalGatewayTokenMissing';
  readonly message: string;
}

export interface VerticalGatewayTokenInvalid {
  readonly _tag: 'VerticalGatewayTokenInvalid';
  readonly message: string;
}

export type ResolveVerticalGatewayTokenResult =
  | {
      readonly _tag: 'Success';
      readonly operationContext: ResolvedOperationIdentity;
    }
  | {
      readonly _tag: 'Failure';
      readonly error: VerticalGatewayTokenMissing | VerticalGatewayTokenInvalid;
    };

type VerticalGatewayTokenPayload = ResolvedOperationIdentity & {
  aud: string;
  exp: number;
  iat: number;
  jti: string;
};

const missingToken = (): VerticalGatewayTokenMissing => ({
  _tag: 'VerticalGatewayTokenMissing',
  message: 'Authentication is required to create an operation context.',
});

const invalidToken = (message: string): VerticalGatewayTokenInvalid => ({
  _tag: 'VerticalGatewayTokenInvalid',
  message,
});

const tokenSecret = () =>
  process.env['ONTOS_OPERATION_CONTEXT_TOKEN_SECRET'] ??
  'ontos-local-operation-context-token-secret';

const encodeJson = (value: unknown) =>
  Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url');

const decodeJson = <T>(value: string): T | undefined => {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf-8')) as T;
  } catch {
    return undefined;
  }
};

const sign = (value: string) =>
  createHmac('sha256', tokenSecret()).update(value).digest('base64url');

const signaturesMatch = (actual: string, expected: string) => {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return (
    actualBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
};

export const createVerticalGatewayToken = ({
  audience,
  operationContext,
  ttlSeconds = 60,
}: {
  audience: string;
  operationContext: ResolvedOperationIdentity;
  ttlSeconds?: number;
}) => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: 'HS256', typ: 'ontos-vertical-gateway' });
  const payload = encodeJson({
    aud: audience,
    exp: nowSeconds + ttlSeconds,
    iat: nowSeconds,
    jti: randomUUID(),
    legalEntityId: operationContext.legalEntityId,
    principalId: operationContext.principalId,
    tenantId: operationContext.tenantId,
  } satisfies VerticalGatewayTokenPayload);
  const unsignedToken = `${header}.${payload}`;

  return `${unsignedToken}.${sign(unsignedToken)}`;
};

export const resolveVerticalGatewayToken = ({
  audience,
  token,
}: {
  audience: string;
  token: string | null | undefined;
}): ResolveVerticalGatewayTokenResult => {
  if (token === null || token === undefined || token.trim().length === 0) {
    return {
      _tag: 'Failure',
      error: missingToken(),
    };
  }

  const [header, payload, signature, extra] = token.split('.');
  if (
    header === undefined ||
    payload === undefined ||
    signature === undefined ||
    extra !== undefined
  ) {
    return {
      _tag: 'Failure',
      error: invalidToken('Vertical gateway token is malformed.'),
    };
  }

  const unsignedToken = `${header}.${payload}`;
  if (!signaturesMatch(signature, sign(unsignedToken))) {
    return {
      _tag: 'Failure',
      error: invalidToken('Vertical gateway token signature is invalid.'),
    };
  }

  const decoded = decodeJson<VerticalGatewayTokenPayload>(payload);
  if (decoded === undefined) {
    return {
      _tag: 'Failure',
      error: invalidToken('Vertical gateway token payload is invalid.'),
    };
  }

  if (decoded.aud !== audience) {
    return {
      _tag: 'Failure',
      error: invalidToken('Vertical gateway token audience is invalid.'),
    };
  }

  if (decoded.exp <= Math.floor(Date.now() / 1000)) {
    return {
      _tag: 'Failure',
      error: invalidToken('Vertical gateway token is expired.'),
    };
  }

  return {
    _tag: 'Success',
    operationContext: {
      legalEntityId: decoded.legalEntityId,
      principalId: decoded.principalId,
      tenantId: decoded.tenantId,
    },
  };
};
