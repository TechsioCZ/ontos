// Kavárna Doma storefront: static SPA + storefront-local BFF on one port (default 3060).
// The BFF is the only holder of the storefront API key; the browser talks to /api/* only.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderArtwork } from '../src/shared/art.ts';
import { getConfig } from './config.ts';
import { homeOf, lastSnapshot, loadRecords, projectCatalog, queryCatalog, summaryOf, useFixture } from './catalog.ts';
import { OntosError } from './ontos.ts';
import { HttpProblem, SHIPPING_OPTIONS, lookupOrder, parseCartLines, parseOrderRequest, placeOrder, validateCart } from './orders.ts';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

const baseHeaders = {
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive',
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { ...baseHeaders, 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 256_000) throw new HttpProblem(413, { code: 'too_large', message: 'Požadavek je příliš velký.' });
    chunks.push(chunk as Buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    throw new HttpProblem(400, { code: 'invalid_json', message: 'Neplatný požadavek.' });
  }
};

/** Maps backend failures to customer-safe problems: never echo internal details, never pretend success. */
const failure = (response: ServerResponse, error: unknown): void => {
  if (error instanceof HttpProblem) {
    sendJson(response, error.status, error.problem);
    return;
  }
  if (error instanceof OntosError) {
    console.error(`[bff] ${error.message}${error.detail === undefined ? '' : ` – ${error.detail}`}`);
    if (error.code === 'storefront_not_configured') {
      sendJson(response, 503, { code: 'storefront_not_configured', message: 'E-shop zatím není napojený na OntOS (chybí serverový přístup).' });
      return;
    }
    if (error.status === 403) {
      sendJson(response, 403, { code: 'forbidden', message: 'Backend tento požadavek e-shopu odmítl (nepovoleno).' });
      return;
    }
    sendJson(response, 502, { code: 'backend_unavailable', message: 'Katalog OntOS je teď nedostupný. Zkuste to prosím znovu.' });
    return;
  }
  console.error('[bff] unexpected', error);
  sendJson(response, 500, { code: 'internal', message: 'Nastala neočekávaná chyba.' });
};

const numberParam = (value: string | null): number | undefined => {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const api = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
  const path = url.pathname;
  const method = request.method ?? 'GET';

  if (path === '/api/health' && method === 'GET') {
    const config = getConfig();
    sendJson(response, 200, { configured: config.apiKey !== undefined || useFixture(), fixture: useFixture(), ok: true });
    return;
  }
  if (path === '/api/home' && method === 'GET') {
    sendJson(response, 200, homeOf(projectCatalog(await loadRecords())));
    return;
  }
  if (path === '/api/categories' && method === 'GET') {
    sendJson(response, 200, { categories: projectCatalog(await loadRecords()).categories });
    return;
  }
  if (path === '/api/products' && method === 'GET') {
    const params = url.searchParams;
    const catalog = projectCatalog(await loadRecords());
    sendJson(
      response,
      200,
      queryCatalog(catalog, {
        availability: params.get('dostupnost') ?? undefined,
        category: params.get('kategorie') ?? undefined,
        maxPrice: numberParam(params.get('cena_do')),
        minPrice: numberParam(params.get('cena_od')),
        q: params.get('q') ?? undefined,
        sort: params.get('razeni') ?? undefined,
      }),
    );
    return;
  }
  const productMatch = /^\/api\/products\/([a-z0-9-]{1,120})$/u.exec(path);
  if (productMatch !== null && method === 'GET') {
    const catalog = projectCatalog(await loadRecords());
    const product = catalog.products.find((item) => item.slug === productMatch[1]);
    if (product === undefined) {
      sendJson(response, 404, { code: 'not_found', message: 'Produkt v nabídce e-shopu neexistuje nebo už není dostupný.' });
      return;
    }
    const related = catalog.products
      .filter((item) => item.category.slug === product.category.slug && item.id !== product.id)
      .slice(0, 4)
      .map(summaryOf);
    sendJson(response, 200, { fetchedAt: catalog.snapshot.fetchedAt, product, related });
    return;
  }
  if (path === '/api/cart/validate' && method === 'POST') {
    const body = await readBody(request);
    const lines = parseCartLines(body.lines);
    sendJson(response, 200, validateCart(projectCatalog(await loadRecords(true)), lines));
    return;
  }
  if (path === '/api/shipping' && method === 'GET') {
    sendJson(response, 200, { options: SHIPPING_OPTIONS });
    return;
  }
  if (path === '/api/orders' && method === 'POST') {
    const order = await placeOrder(parseOrderRequest(await readBody(request)));
    sendJson(response, order.replayed ? 200 : 201, order);
    return;
  }
  const orderMatch = /^\/api\/orders\/([A-Za-z0-9-]{8,120})$/u.exec(path);
  if (orderMatch !== null && method === 'GET') {
    const order = await lookupOrder(orderMatch[1]);
    if (order === undefined) sendJson(response, 404, { code: 'not_found', message: 'Objednávka s tímto odesláním nebyla nalezena.' });
    else sendJson(response, 200, order);
    return;
  }
  sendJson(response, 404, { code: 'not_found', message: 'Neznámá cesta.' });
};

const serveFile = (response: ServerResponse, file: string, immutable: boolean): void => {
  response.writeHead(200, {
    ...baseHeaders,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
  });
  createReadStream(file).pipe(response);
};

const serveStatic = (response: ServerResponse, url: URL): void => {
  if (url.pathname === '/robots.txt') {
    response.writeHead(200, { ...baseHeaders, 'content-type': 'text/plain; charset=utf-8' });
    response.end('User-agent: *\nDisallow: /\n');
    return;
  }
  const art = /^\/img\/([a-z0-9-]{1,140})\.svg$/u.exec(url.pathname);
  if (art !== null) {
    const shipped = join(DIST, 'img', `${art[1]}.svg`);
    if (existsSync(shipped)) {
      serveFile(response, shipped, false);
      return;
    }
    response.writeHead(200, { ...baseHeaders, 'cache-control': 'public, max-age=3600', 'content-type': 'image/svg+xml' });
    const base = art[1].split('--')[0];
    const snapshot = lastSnapshot();
    const product = snapshot === undefined ? undefined : projectCatalog(snapshot).products.find((item) => item.slug === base || item.images.some((image) => image.startsWith(`/img/${base}.svg`) || image.startsWith(`/img/${base}--`)));
    response.end(renderArtwork(art[1], product === undefined ? {} : { category: product.category.name, name: product.name }));
    return;
  }
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/u, '');
  const candidate = join(DIST, relative);
  if (candidate.startsWith(DIST) && relative !== '' && existsSync(candidate) && statSync(candidate).isFile()) {
    serveFile(response, candidate, relative.startsWith('static/'));
    return;
  }
  const index = join(DIST, 'index.html');
  if (!existsSync(index)) {
    response.writeHead(503, { ...baseHeaders, 'content-type': 'text/plain; charset=utf-8' });
    response.end('Storefront is not built yet: run `pnpm --dir apps/eshop-storefront build`.');
    return;
  }
  serveFile(response, index, false);
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    api(request, response, url).catch((error: unknown) => failure(response, error));
    return;
  }
  try {
    serveStatic(response, url);
  } catch (error) {
    failure(response, error);
  }
});

const { port } = getConfig();
server.listen(port, () => {
  console.log(`[eshop-storefront] http://localhost:${port}${useFixture() ? ' (DEV FIXTURE – not OntOS)' : ''}`);
});
