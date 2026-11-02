import { Schema } from 'effect';
import { connect } from 'node:net';
import { Duplex } from 'node:stream';

const rollbackCutFault = 'audit-error-rollback-cut';
const auditFaults = new Set<string | undefined>(['audit-error', rollbackCutFault]);
const VerificationSettlementFaultSchema = Schema.Literals([
  'commit-cut',
  'commit-ack-lost',
  'audit-error',
  rollbackCutFault,
  'body-timeout',
]);
export type VerificationSettlementFault = typeof VerificationSettlementFaultSchema.Type;

/** Purpose-specific native-wire faults for the email-verification transaction; payloads never escape. */
const replaceQuery = (frame: Buffer, start: number, end: number, query: string): Buffer => {
  const result = Buffer.concat([frame.subarray(0, start), Buffer.from(query), frame.subarray(end)]);
  result.writeInt32BE(result.length - 1, 1);
  return result;
};

export const verificationSettlementTransport = (connectionURL: URL) => {
  const sslMode = connectionURL.searchParams.get('sslmode');
  if (sslMode !== null && sslMode !== 'disable') {
    throw new Error('Verification settlement wire fixture requires an already unencrypted test deployment');
  }
  let armed: VerificationSettlementFault | undefined;
  let selected = false;
  const observed = {
    auditError: false,
    bodyErrorResponse: false,
    commitCut: false,
    commitForwarded: false,
    idleCommitObserved: false,
    rollbackCut: false,
    timeoutInjected: false,
  };
  const sockets = new Set<Duplex>();
  const stream = (): Duplex => {
    const upstream = connect({
      host: connectionURL.hostname,
      noDelay: true,
      port: Number(connectionURL.port || '5432'),
    });
    let frontend = Buffer.alloc(0);
    let backend = Buffer.alloc(0);
    let startup = true;
    let ownsVerification = false;
    let awaitingCommit = false;
    let withholdingCommit = false;
    let cut = false;
    const frameLimit = 16 * 1024 * 1024;
    const faultFrame = (input: Buffer): Buffer | undefined => {
      let frame: Buffer = input;
      const [kind] = frame;
      if (kind === 81 || kind === 80) {
        const queryStart = kind === 81 ? 5 : frame.indexOf(0, 5) + 1;
        const queryEnd = frame.indexOf(0, queryStart);
        const query = frame.toString('utf-8', queryStart, queryEnd);
        const command = query.trim().toUpperCase();
        if (armed !== undefined && !selected && query.startsWith('update ') && query.includes('"email_verified"')) {
          selected = true;
          ownsVerification = true;
          if (armed === 'body-timeout') {
            const delayed = query.replace(
              /(?<assignment>"email_verified"\s*=\s*)(?<parameter>\$\d+)/u,
              '$<assignment>(select $<parameter>::boolean from pg_sleep(10))',
            );
            if (delayed === query) {
              throw new Error('Verification fixture could not select interruptible body write');
            }
            frame = replaceQuery(frame, queryStart, queryEnd, delayed);
            observed.timeoutInjected = true;
          }
        }
        if (
          ownsVerification &&
          query.startsWith('insert ') &&
          query.includes('"portal_auth_audit_event"') &&
          auditFaults.has(armed)
        ) {
          frame = replaceQuery(frame, queryStart, queryEnd, `!${query}`);
          observed.auditError = true;
        }
        if (ownsVerification && command === 'COMMIT') {
          if (armed === 'commit-cut') {
            observed.commitCut = true;
            cut = true;
            upstream.destroy();
            return undefined;
          }
          observed.commitForwarded = true;
          awaitingCommit = armed === 'commit-ack-lost';
        }
        if (ownsVerification && command === 'ROLLBACK' && armed === rollbackCutFault) {
          observed.rollbackCut = true;
          cut = true;
          upstream.destroy();
          return undefined;
        }
      }
      return frame;
    };
    const forward = new Duplex({
      destroy(error, completeWrite) {
        sockets.delete(forward);
        upstream.destroy();
        completeWrite(error);
      },
      final(completeWrite) {
        upstream.end(completeWrite);
      },
      read() {
        // Upstream data drives this readable side.
      },
      write(chunk: Buffer, _encoding, completeWrite) {
        frontend = Buffer.concat([frontend, chunk]);
        while (frontend.length >= (startup ? 4 : 5)) {
          const length = startup ? frontend.readInt32BE(0) : frontend.readInt32BE(1) + 1;
          if (length < (startup ? 8 : 5) || length > frameLimit) {
            completeWrite(new Error('Invalid verification fixture frontend frame'));
            return;
          }
          if (frontend.length < length) {
            break;
          }
          let frame: Buffer = frontend.subarray(0, length);
          frontend = frontend.subarray(length);
          if (startup) {
            const protocol = frame.readInt32BE(4);
            startup = protocol === 80_877_103;
          } else {
            const processed = faultFrame(frame);
            if (processed !== undefined) {
              frame = processed;
            }
          }
          if (cut) {
            frontend = Buffer.alloc(0);
          } else {
            upstream.write(frame);
          }
        }
        completeWrite();
      },
    });
    sockets.add(forward);
    upstream.on('data', (chunk: Buffer) => {
      backend = Buffer.concat([backend, chunk]);
      while (!cut && backend.length >= 5) {
        const length = backend.readInt32BE(1) + 1;
        if (length < 5 || length > frameLimit) {
          forward.destroy(new Error('Invalid verification fixture backend frame'));
          return;
        }
        if (backend.length < length) {
          break;
        }
        const frame = backend.subarray(0, length);
        backend = backend.subarray(length);
        if (ownsVerification && frame[0] === 69) {
          observed.bodyErrorResponse = true;
        }
        if (awaitingCommit && frame[0] === 67 && frame.toString('utf-8', 5, frame.length - 1) === 'COMMIT') {
          withholdingCommit = true;
        }
        if (withholdingCommit) {
          if (frame[0] === 90) {
            observed.idleCommitObserved = frame[5] === 73;
            cut = true;
            forward.destroy();
          }
        } else {
          forward.push(frame);
        }
      }
    });
    upstream.on('error', (error) => {
      forward.destroy(error);
    });
    upstream.on('close', () => {
      forward.destroy();
    });
    return forward;
  };
  return {
    arm(fault: VerificationSettlementFault) {
      if (armed !== undefined) {
        throw new Error('Verification settlement fault already armed');
      }
      armed = fault;
    },
    close() {
      for (const socket of sockets) {
        socket.destroy();
      }
    },
    observed,
    stream,
  };
};
