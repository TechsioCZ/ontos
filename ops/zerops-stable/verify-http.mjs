// The HTTP, child process and redaction ports of the stable verification (verify.mjs). Only these touch the network
// or spawn processes; tests replace them with local fixtures.
import { spawn } from 'node:child_process';

const REQUEST_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

/** One browser-like session: cookies set by responses are sent back, cookies the server expires are dropped. */
export class CookieJar {
  #cookies = new Map();
  #onValue;

  /** @param {(value: string) => void} [onValue] Receives every cookie value, so the redactor can hide it. */
  constructor(onValue = () => {}) {
    this.#onValue = onValue;
  }

  absorb(headers) {
    for (const line of headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const expired = attributes.some((attribute) => {
        const [key = '', raw = ''] = attribute.split('=');
        if (key.toLowerCase() === 'max-age') return Number(raw) <= 0;
        if (key.toLowerCase() === 'expires') return Date.parse(raw) <= Date.now();
        return false;
      });
      if (expired || value === '') {
        this.#cookies.delete(name);
      } else {
        this.#cookies.set(name, value);
        this.#onValue(value);
      }
    }
  }

  get empty() {
    return this.#cookies.size === 0;
  }

  header() {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /** A curl (Netscape) cookie jar for one host, as stage-symmy-full-function-proof.mts reads it. */
  netscape(hostname) {
    return `${[...this.#cookies].map(([name, value]) => [hostname, 'FALSE', '/', 'TRUE', '0', name, value].join('\t')).join('\n')}\n`;
  }
}

/**
 * The request port: a manual-redirect fetch with a deadline whose body is read whole. A jar adds its cookies and
 * absorbs the answer's. Transport errors reject with the error name and message only.
 */
export const createHttp =
  (fetchImpl = fetch) =>
  async (url, { method = 'GET', headers = {}, json, jar, timeoutMs = REQUEST_TIMEOUT_MS } = {}) => {
    const sent = { accept: 'application/json, text/html;q=0.9', ...headers };
    if (jar !== undefined && !jar.empty && sent.cookie === undefined) sent.cookie = jar.header();
    if (json !== undefined) sent['content-type'] = 'application/json';
    const response = await fetchImpl(url, {
      body: json === undefined ? undefined : JSON.stringify(json),
      headers: sent,
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    jar?.absorb(response.headers);
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { body, contentType: response.headers.get('content-type') ?? '', status: response.status, text };
  };

/** Runs one command to its end or its deadline; output is kept in memory, capped, and never inherited. */
export const spawnProcess = ({ command, args, cwd, env, timeoutMs }) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stderr: '', stdout: '' };
    const collect = (name) => (chunk) => {
      if (output[name].length < OUTPUT_LIMIT_BYTES) output[name] += chunk.toString('utf8');
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stderr: `${error.name}: ${error.message}`, stdout: output.stdout, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr: output.stderr, stdout: output.stdout, timedOut });
    });
  });

/** Replaces every known secret in a text. Secrets are added as the run learns them (cookies, tokens). */
export const createRedactor = (initial = []) => {
  const secrets = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.length >= 4) secrets.add(value);
  };
  for (const value of initial) add(value);
  const redact = (text) => {
    let result = String(text);
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) result = result.replaceAll(secret, '[redacted]');
    return result;
  };
  return { add, redact };
};
