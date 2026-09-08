// expect-count: 2
// default and namespace imports of node:crypto / crypto.
import crypto from 'node:crypto';
import * as nodeCrypto from 'crypto';

export const a = (pem: string) => crypto.createPrivateKey(pem);
export const b = (pem: string) => nodeCrypto.createPublicKey(pem);
