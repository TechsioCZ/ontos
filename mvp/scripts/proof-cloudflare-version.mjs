#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(workspaceRoot, '.modernjs/ultramodern-generated-contract.json');
const defaultOut = path.join(
  workspaceRoot,
  '.codex/reports/cloudflare-version-proof/public-url-proof.json',
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseArgs(argv) {
  const parsed = {
    appId: undefined,
    out: defaultOut,
    requirePublicUrls: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--app') {
      parsed.appId = argv[index + 1];
      index += 1;
    } else if (arg === '--out') {
      parsed.out = argv[index + 1];
      index += 1;
    } else if (arg === '--require-public-urls') {
      parsed.requirePublicUrls = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/proof-cloudflare-version.mjs [--app workspace] [--out evidence.json] [--require-public-urls]

Set each app's public URL using the contract env key, for example:
  ULTRAMODERN_PUBLIC_URL_WORKSPACE=https://workspace.example.workers.dev
`);
}

function joinUrl(baseUrl, routePath) {
  return new URL(routePath, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
}

function normalizeUrlWithTrailingSlash(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

async function fetchText(url) {
  const response = await fetch(url);
  return {
    ok: response.ok,
    status: response.status,
    accessControlAllowOrigin: response.headers.get('access-control-allow-origin'),
    contentSecurityPolicy: response.headers.get('content-security-policy'),
    contentSecurityPolicyReportOnly: response.headers.get('content-security-policy-report-only'),
    contentType: response.headers.get('content-type'),
    link: response.headers.get('link'),
    permissionsPolicy: response.headers.get('permissions-policy'),
    referrerPolicy: response.headers.get('referrer-policy'),
    xContentTypeOptions: response.headers.get('x-content-type-options'),
    xRobotsTag: response.headers.get('x-robots-tag'),
    body: await response.text(),
  };
}

function parseMaybeJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function markerFromJson(value) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  if (value.marker && typeof value.marker.build === 'string') {
    return value.marker.build;
  }
  if (typeof value.build === 'string') {
    return value.build;
  }
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const marker = markerFromJson(item);
        if (marker) {
          return marker;
        }
      }
    } else {
      const marker = markerFromJson(nested);
      if (marker) {
        return marker;
      }
    }
  }
  return undefined;
}

function extractUiMarker(html) {
  return html.match(/data-build-marker=["']([^"']+)["']/u)?.[1];
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function matchesPreviewHostname(hostname, pattern) {
  const normalizedHostname = hostname.toLowerCase();
  const normalizedPattern = String(pattern || '').toLowerCase();

  if (!normalizedPattern) {
    return false;
  }

  if (normalizedPattern.startsWith('*.')) {
    return normalizedHostname.endsWith(normalizedPattern.slice(1));
  }

  return normalizedHostname === normalizedPattern;
}

function shouldNoindexUrl(publicUrl, noindex) {
  if (!noindex || noindex === false) {
    return false;
  }

  const { hostname } = new URL(publicUrl);
  const normalizedHostname = hostname.toLowerCase();

  if (
    noindex.localhost !== false &&
    (normalizedHostname === 'localhost' ||
      normalizedHostname === '127.0.0.1' ||
      normalizedHostname === '[::1]')
  ) {
    return true;
  }

  if (noindex.workersDev !== false && normalizedHostname.endsWith('.workers.dev')) {
    return true;
  }

  return (noindex.previewHostnames || []).some((pattern) =>
    matchesPreviewHostname(normalizedHostname, pattern),
  );
}

function assertHeader(evidence, response, expected, options) {
  if (expected === false || expected === undefined) {
    return;
  }

  const actual = response[options.field];
  evidence.assertions.push({
    type: 'security-header',
    header: options.header,
    route: options.route,
    expected,
    actual,
    status: actual === expected ? 'pass' : 'fail',
  });
  assert(actual === expected, `${options.appId} ${options.route} is missing ${options.header}`);
}

function assertCloudflareSecurity(evidence, app, response, route, publicUrl, options = {}) {
  const security = app.deploy?.cloudflare?.security;

  if (!security || security.enabled === false) {
    return;
  }

  const headers = security.headers || {};
  assertHeader(evidence, response, headers.referrerPolicy, {
    appId: app.id,
    field: 'referrerPolicy',
    header: 'referrer-policy',
    route,
  });
  assertHeader(evidence, response, headers.contentTypeOptions, {
    appId: app.id,
    field: 'xContentTypeOptions',
    header: 'x-content-type-options',
    route,
  });
  assertHeader(evidence, response, headers.permissionsPolicy, {
    appId: app.id,
    field: 'permissionsPolicy',
    header: 'permissions-policy',
    route,
  });

  const csp = security.contentSecurityPolicy;
  if (options.html && csp?.mode !== 'off') {
    const header =
      csp?.mode === 'enforce' ? 'content-security-policy' : 'content-security-policy-report-only';
    const actual =
      csp?.mode === 'enforce'
        ? response.contentSecurityPolicy
        : response.contentSecurityPolicyReportOnly;
    const expectedDirectives = ['script-src', 'style-src', 'connect-src'];
    const missingDirectives = expectedDirectives.filter(
      (directive) => !actual?.includes(directive),
    );

    evidence.assertions.push({
      type: 'security-csp',
      header,
      route,
      mode: csp?.mode ?? 'report-only',
      actual,
      missingDirectives,
      status: actual && missingDirectives.length === 0 ? 'pass' : 'fail',
    });
    assert(actual, `${app.id} ${route} is missing ${header}`);
    assert(
      missingDirectives.length === 0,
      `${app.id} ${route} CSP is missing ${missingDirectives.join(', ')}`,
    );
  }

  if (shouldNoindexUrl(publicUrl, security.noindex)) {
    evidence.assertions.push({
      type: 'security-noindex',
      route,
      actual: response.xRobotsTag,
      status: response.xRobotsTag === 'noindex, nofollow' ? 'pass' : 'fail',
    });
    assert(
      response.xRobotsTag === 'noindex, nofollow',
      `${app.id} ${route} is missing noindex X-Robots-Tag`,
    );
  }
}

async function validateApp(app, publicUrl) {
  const cloudflare = app.deploy?.cloudflare;
  const routes = cloudflare?.routes ?? {};
  const evidence = {
    appId: app.id,
    publicUrl,
    workerName: cloudflare?.workerName,
    publicUrlEnv: cloudflare?.publicUrlEnv,
    assertions: [],
  };

  const ssrRoute = routes.ssr ?? '/en';
  const ssr = await fetchText(joinUrl(publicUrl, ssrRoute));
  evidence.assertions.push({
    type: 'ssr',
    route: ssrRoute,
    status: ssr.ok ? 'pass' : 'fail',
    statusCode: ssr.status,
  });
  assert(ssr.ok, `${app.id} SSR route returned HTTP ${ssr.status}`);
  assertCloudflareSecurity(evidence, app, ssr, ssrRoute, publicUrl, {
    html: true,
  });

  const uiMarker = extractUiMarker(ssr.body);
  evidence.assertions.push({
    type: 'ui-marker',
    expected: app.marker?.build,
    actual: uiMarker,
    status: uiMarker === app.marker?.build ? 'pass' : 'fail',
  });
  assert(uiMarker === app.marker?.build, `${app.id} UI marker mismatch`);

  const cssRootSelector = app.styling?.federation?.rootSelector;
  const expectedAppId = cssRootSelector?.match(/data-app-id="([^"]+)"/u)?.[1];
  evidence.assertions.push({
    type: 'css-root-marker',
    expected: cssRootSelector,
    status: expectedAppId && ssr.body.includes(`data-app-id="${expectedAppId}"`) ? 'pass' : 'fail',
  });
  assert(
    expectedAppId && ssr.body.includes(`data-app-id="${expectedAppId}"`),
    `${app.id} SSR response is missing CSS root marker ${cssRootSelector}`,
  );
  const cssPreloadLinkHeader = ssr.link ?? '';
  evidence.assertions.push({
    type: 'css-preload-link-header',
    actual: cssPreloadLinkHeader,
    status:
      cssPreloadLinkHeader.includes('rel=preload') && cssPreloadLinkHeader.includes('as=style')
        ? 'pass'
        : 'fail',
  });
  assert(
    cssPreloadLinkHeader.includes('rel=preload') && cssPreloadLinkHeader.includes('as=style'),
    `${app.id} SSR response is missing CSS preload Link headers`,
  );

  const manifestRoute = routes.mfManifest ?? '/mf-manifest.json';
  const manifest = await fetchText(joinUrl(publicUrl, manifestRoute));
  const manifestJson = parseMaybeJson(manifest.body);
  evidence.assertions.push({
    type: 'mf-manifest',
    route: manifestRoute,
    status: manifest.ok ? 'pass' : 'fail',
    statusCode: manifest.status,
  });
  assert(manifest.ok, `${app.id} MF manifest returned HTTP ${manifest.status}`);
  assertCloudflareSecurity(evidence, app, manifest, manifestRoute, publicUrl);
  evidence.assertions.push({
    type: 'mf-manifest-cors',
    route: manifestRoute,
    actual: manifest.accessControlAllowOrigin,
    status: manifest.accessControlAllowOrigin === '*' ? 'pass' : 'fail',
  });
  assert(
    manifest.accessControlAllowOrigin === '*',
    `${app.id} MF manifest is missing Cloudflare CORS headers`,
  );
  const expectedPublicPath = normalizeUrlWithTrailingSlash(publicUrl);
  const manifestPublicPath = manifestJson?.metaData?.publicPath;
  evidence.assertions.push({
    type: 'mf-manifest-public-path',
    expected: expectedPublicPath,
    actual: manifestPublicPath,
    status: manifestPublicPath === expectedPublicPath ? 'pass' : 'fail',
  });
  assert(
    manifestPublicPath === expectedPublicPath,
    `${app.id} MF manifest publicPath must resolve remote assets from ${expectedPublicPath}`,
  );

  const localeRoute = routes.locale ?? `/locales/en/${app.i18n?.namespace}.json`;
  const locale = await fetchText(joinUrl(publicUrl, localeRoute));
  const localeJson = parseMaybeJson(locale.body);
  evidence.assertions.push({
    type: 'i18n-marker',
    namespace: app.i18n?.namespace,
    route: localeRoute,
    status:
      locale.ok && localeJson && Object.hasOwn(localeJson, app.i18n?.namespace) ? 'pass' : 'fail',
    statusCode: locale.status,
  });
  assert(locale.ok, `${app.id} locale JSON returned HTTP ${locale.status}`);
  assertCloudflareSecurity(evidence, app, locale, localeRoute, publicUrl);
  evidence.assertions.push({
    type: 'i18n-cors',
    route: localeRoute,
    actual: locale.accessControlAllowOrigin,
    status: locale.accessControlAllowOrigin === '*' ? 'pass' : 'fail',
  });
  assert(
    locale.accessControlAllowOrigin === '*',
    `${app.id} locale JSON is missing Cloudflare CORS headers`,
  );
  assert(
    localeJson && Object.hasOwn(localeJson, app.i18n?.namespace),
    `${app.id} locale JSON is missing namespace ${app.i18n?.namespace}`,
  );

  if (routes.effectReadiness) {
    const readiness = await fetchText(joinUrl(publicUrl, routes.effectReadiness));
    const readinessJson = parseMaybeJson(readiness.body);
    const apiMarker = markerFromJson(readinessJson);
    evidence.assertions.push({
      type: 'api-marker',
      route: routes.effectReadiness,
      expected: app.marker?.build,
      actual: apiMarker,
      status: readiness.ok && apiMarker === app.marker?.build ? 'pass' : 'fail',
      statusCode: readiness.status,
    });
    assert(readiness.ok, `${app.id} Effect readiness returned HTTP ${readiness.status}`);
    assert(apiMarker === app.marker?.build, `${app.id} API marker mismatch`);
  }

  return evidence;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const contract = readJson(contractPath);
  const apps = args.appId ? contract.apps.filter((app) => app.id === args.appId) : contract.apps;
  assert(apps.length > 0, `No generated app matched ${args.appId}`);

  const results = [];
  const skipped = [];
  for (const app of apps) {
    const publicUrlEnv = app.deploy?.cloudflare?.publicUrlEnv;
    const publicUrl = publicUrlEnv && process.env[publicUrlEnv];
    if (!publicUrl) {
      const skippedEntry = {
        appId: app.id,
        status: args.requirePublicUrls ? 'fail' : 'skipped',
        publicUrlEnv,
        reason: 'public URL environment variable is not set',
      };
      skipped.push(skippedEntry);
      if (args.requirePublicUrls) {
        throw new Error(`${app.id} requires ${publicUrlEnv}`);
      }
      continue;
    }
    results.push(await validateApp(app, publicUrl));
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: results.length > 0 ? 'pass' : 'skipped',
    contractPath,
    results,
    skipped,
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`[cloudflare-version-proof] ${report.status}: ${args.out}\n`);
  return 0;
}

main().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error) => {
    process.stderr.write(`[cloudflare-version-proof] ${error.message}\n`);
    process.exitCode = 1;
  },
);
