import { test, expect, type Page } from '@playwright/test';

// Every test here is a regression check for something that actually shipped
// broken in 1.5.3 or was caught during the 1.5.4 review. Comments say which.

const CHECKOUT = 'creem.io';
const PRICING  = 'trimwares.com/trace';

async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.locator('main').waitFor();
  // The app polls /api/data every 2.5s, so 'networkidle' never settles —
  // wait for hydration by waiting for real content instead.
  await expect(page.locator('main')).not.toHaveText(/^\s*$/);
}

test.describe('free dashboard', () => {
  test('overview renders data and the Developer card, with zero console errors or failed requests', async ({ page }) => {
    const errors: string[] = [];
    const failed: string[] = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });

    await open(page, '/');
    await expect(page.getByText('Unlock Developer')).toBeVisible();
    await expect(page.getByText(/No session data/i)).toHaveCount(0);

    // 1.5.3: Next 16 segment-prefetch requests 404'd 20× per page.
    expect(failed, 'no 4xx/5xx responses').toEqual([]);
    expect(errors, 'no console errors').toEqual([]);
  });

  test('Developer CTA is actually visible — real computed colors, not just present in the DOM', async ({ page }) => {
    // 1.5.4 first cut: text-black on a bg-green-400 that generated no CSS
    // (Tailwind palette collision) → black-on-black. Present in DOM, invisible.
    await open(page, '/');
    await page.locator('main').evaluate(el => { el.scrollTop = el.scrollHeight; });
    const cta = page.locator(`main a[href*="${CHECKOUT}"]`).first();
    await expect(cta).toBeVisible();
    await expect(cta).toHaveText(/Get Developer — \$79 once/);
    const { color, bg } = await cta.evaluate(el => {
      const s = getComputedStyle(el); return { color: s.color, bg: s.backgroundColor };
    });
    expect(bg, 'button has a real background').not.toBe('rgba(0, 0, 0, 0)');
    expect(color).not.toBe(bg);
  });

  test('"Get Developer" goes to checkout; "View Developer pricing" goes to the pricing page', async ({ page, context }) => {
    await open(page, '/');
    // Label rule: only links that actually charge a card say "Get Developer".
    for (const a of await page.locator('a', { hasText: /^Get Developer/ }).all()) {
      expect(await a.getAttribute('href')).toContain(CHECKOUT);
    }
    for (const a of await page.locator('a', { hasText: /View Developer pricing/ }).all()) {
      expect(await a.getAttribute('href')).toContain(PRICING);
    }
    // And the checkout link opens in a new tab, not over the dashboard.
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.locator(`main a[href*="${CHECKOUT}"]`).first().click(),
    ]);
    expect(popup.url()).toContain(CHECKOUT);
    await popup.close();
  });

  test('locked sidebar items open the pricing page instead of 404ing', async ({ page }) => {
    // 1.5.3: these were <Link href="/alerts"> etc. — routes that don't exist
    // in the free build. Clicking "Spend Alerts" landed on a 404.
    await open(page, '/');
    for (const label of ['30-day Analytics', 'Spend Alerts', 'Multi-project dashboard']) {
      const href = await page.locator('a', { hasText: label }).first().getAttribute('href');
      expect(href, label).toContain(PRICING);
    }
  });

  test('sidebar navigation is a soft navigation — no full page reloads', async ({ page }) => {
    // 1.5.3: .txt RSC payloads were served as application/octet-stream, so
    // Next rejected them and every sidebar click was a hard reload.
    await open(page, '/');
    let loads = 0;
    page.on('load', () => loads++);
    for (const label of ['Recommendations', 'Attribution', 'Models', 'Settings', 'Overview']) {
      await page.locator('a', { hasText: label }).first().click();
      await expect(page).toHaveURL(new RegExp(label === 'Overview' ? '/$' : `/${label.toLowerCase()}`));
    }
    expect(loads, 'full page loads during navigation').toBe(0);
  });

  test('provider names are brand-cased and money formatting is uniform', async ({ page }) => {
    await open(page, '/models');
    await expect(page.getByText('OpenAI').first()).toBeVisible();
    await expect(page.getByText(/\bOpenai\b/)).toHaveCount(0);
    // Whole-dollar amounts render with exactly two decimals everywhere.
    const text = await page.locator('main').innerText();
    const dollarsOverOne = text.match(/\$[1-9]\d*\.\d+/g) ?? [];
    for (const m of dollarsOverOne) expect(m, 'two decimals for amounts ≥ $1').toMatch(/^\$\d+\.\d{2}$/);
  });

  test('every request across every page goes to the local server only — nothing leaves the machine', async ({ page, baseURL }) => {
    // The product promise. Until 1.5.4 the dashboard @imported Inter and
    // JetBrains Mono from fonts.googleapis.com on every load — a third-party
    // request from a "nothing leaves your machine" tool, and a broken layout
    // offline. Fonts are now bundled at build time; this asserts no request
    // of any kind — script, style, font, image, XHR, prefetch — goes anywhere
    // but the dashboard server itself.
    const localHost = new URL(baseURL!).host;
    const external: string[] = [];
    page.on('request', r => { const h = new URL(r.url()).host; if (h !== localHost) external.push(r.url()); });
    for (const path of ['/', '/recommendations', '/attribution', '/models', '/settings']) {
      await open(page, path);
    }
    // Let any late-loading assets (fonts, prefetches) fire before judging.
    await page.waitForTimeout(1500);
    expect(external, 'requests to hosts other than the dashboard server').toEqual([]);
    const fonts = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family); });
    expect(fonts, 'self-hosted fonts actually loaded').toEqual(expect.arrayContaining(['Inter', 'JetBrains Mono']));
  });

  test('shows an error state — not a blank page — when the API is down', async ({ page }) => {
    await page.route('**/api/data*', r => r.fulfill({ status: 500, body: 'boom' }));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('main')).toContainText(/error|unavailable|couldn.t|failed|not running/i);
  });

  test('Clear session actually clears, reports honestly, and archives the log', async ({ page }) => {
    // 1.5.3: POST /api/clear didn't exist. The request fell through to
    // index.html with a 200 and the button said "Cleared" anyway.
    // Runs last: it empties the shared seeded session.
    await open(page, '/settings');
    // Locate by a stable filter, not by accessible name — the name changes to
    // "Cleared" on success, and a name-based locator would stop matching at
    // exactly the moment we want to observe it.
    const btn = page.locator('main button').filter({ hasText: /Clear session|Cleared/ });
    await btn.click();
    await expect(btn).toHaveText(/Cleared/);
    // Not '[role=alert]' — Next's own hidden <next-route-announcer> carries
    // that role on every page. Assert on our error text specifically.
    await expect(page.getByText(/Couldn.t clear/)).toHaveCount(0);

    const after = await page.evaluate(() => fetch('/api/data').then(r => r.json()));
    expect(after.hasData).toBe(false);

    await open(page, '/');
    await expect(page.getByText(/No session data|Run your app/i).first()).toBeVisible();
  });

  test('unknown /api/* routes return JSON 404, never the dashboard HTML', async ({ page }) => {
    // 1.5.3: any unknown path — API routes included — returned index.html
    // with a 200, so a fetch() checking only response.ok saw "success".
    const r = await page.request.get('/api/does-not-exist');
    expect(r.status()).toBe(404);
    expect(r.headers()['content-type']).toContain('application/json');
    const stale = await page.request.get('/_next/static/chunks/nope-0000000000000000.js');
    expect(stale.status()).toBe(404);
    expect(stale.headers()['content-type']).not.toContain('text/html');
  });
});

// ─── Request boundary hardening ──────────────────────────────────────────────
// Each was a confirmed, reproducible defect found in review and probed with a
// sentinel file before being fixed. Free lacked the origin and project-path
// guards the Developer build already had.


test('a cross-origin clear is rejected and leaves the session intact', async ({ request }) => {
  // Confirmed: an "https://evil.example" Origin returned 200 and archived a
  // fixture's session. Any page the user had open could have done this.
  const before = await (await request.get('/api/data')).json();
  const r = await request.post('/api/clear', { headers: { Origin: 'https://evil.example' } });
  expect(r.status()).toBe(403);
  const after = await (await request.get('/api/data')).json();
  expect(after.entryCount, 'session must survive the rejected request').toBe(before.entryCount);
});

test('an unrecognized Host header is rejected', async ({ request }) => {
  const r = await request.get('/api/data', { headers: { Host: 'evil.example' } });
  expect(r.status()).toBe(403);
});

test('an unregistered projectPath is rejected', async ({ request }) => {
  const r = await request.get('/api/data?projectPath=C:/Windows');
  expect(r.status()).toBe(403);
});


// ─── Path containment, probed over raw HTTP ──────────────────────────────────
// Playwright's request client NORMALIZES the URL before it hits the wire:
// supplying "/../package.json" sends "/package.json". Verified with an echo
// server. So an assertion written through Playwright can pass without ever
// testing containment. These use node:http with an explicit raw `path`, and a
// sentinel file placed outside the UI directory, so a regression is caught by
// the file's contents coming back rather than by a status code alone.
import http from 'node:http';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SENTINEL_BODY = 'TRAVERSAL-SENTINEL-MUST-NOT-BE-SERVED';
// bin/trimwares.js serves from <pkg>/ui, so <pkg>/ is one level outside it.
const SENTINEL_FILE = join(process.cwd(), '.traversal-sentinel.txt');

function rawGet(baseURL: string, rawPath: string): Promise<{ status: number; body: string }> {
  const u = new URL(baseURL);
  return new Promise(resolve => {
    const req = http.request(
      { host: u.hostname, port: u.port, method: 'GET', path: rawPath },
      res => {
        let b = '';
        res.on('data', c => { b += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      },
    );
    req.on('error', e => resolve({ status: -1, body: String(e) }));
    req.end();
  });
}

test('a raw traversal path cannot read a file outside the UI directory', async ({ baseURL }) => {
  writeFileSync(SENTINEL_FILE, SENTINEL_BODY);
  try {
    for (const rawPath of [
      '/../.traversal-sentinel.txt',
      '/..%2f.traversal-sentinel.txt',
      '/..\.traversal-sentinel.txt',
      '/ui/../../.traversal-sentinel.txt',
      '/subdir/../../.traversal-sentinel.txt',
    ]) {
      const r = await rawGet(baseURL!, rawPath);
      expect(r.body, `sentinel leaked via ${rawPath}`).not.toContain(SENTINEL_BODY);
      expect(r.status, `traversal must 404: ${rawPath}`).toBe(404);
    }
  } finally {
    if (existsSync(SENTINEL_FILE)) unlinkSync(SENTINEL_FILE);
  }
});

test('an oversized body is refused with 413, repeatably and when chunked', async ({ baseURL }) => {
  // The first implementation called req.destroy() the moment the cap was hit,
  // which could close the socket before the 413 reached the client — observed
  // as an even mix of 413s and ECONNRESETs across repeated attempts.
  const u = new URL(baseURL!);
  const post = (chunked: boolean) => new Promise<number | string>(resolve => {
    const req = http.request(
      { host: u.hostname, port: u.port, method: 'POST', path: '/api/projects/add',
        headers: { 'Content-Type': 'application/json' } },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); },
    );
    req.on('error', e => resolve('ERR:' + (e as NodeJS.ErrnoException).code));
    if (chunked) {
      let sent = 0;
      const tick = () => {
        if (sent >= 160 * 1024) { req.end(); return; }
        sent += 16 * 1024;
        if (req.write('x'.repeat(16 * 1024))) setTimeout(tick, 5); else req.once('drain', tick);
      };
      tick();
    } else {
      req.end('x'.repeat(160 * 1024));
    }
  });

  for (let i = 0; i < 4; i++) {
    expect(await post(false), `single-shot attempt ${i + 1}`).toBe(413);
  }
  expect(await post(true), 'chunked upload').toBe(413);
});

// ─── Canonical page URLs (trailingSlash: true) ───────────────────────────────
// Same next.config as the Developer build, where serving the slash-less form
// directly caused React #418 on every direct page load — reproduced 11 of 11
// there, and fixed by redirecting to the canonical URL.
const EXPORTED_PAGES = ['/attribution', '/models', '/recommendations', '/settings'];

test('page URLs without a trailing slash redirect to the canonical form', async ({ request }) => {
  for (const p of EXPORTED_PAGES) {
    const r = await request.get(p, { maxRedirects: 0 });
    expect(r.status(), `${p} should redirect`).toBe(308);
    expect(r.headers()['location'], `${p} location`).toBe(p + '/');
  }
});

test('the redirect preserves the query string and leaves API, assets and traversal alone', async ({ request }) => {
  expect((await request.get('/attribution?project=x', { maxRedirects: 0 })).headers()['location'])
    .toBe('/attribution/?project=x');
  expect((await request.get('/', { maxRedirects: 0 })).status()).toBe(200);
  expect((await request.get('/attribution/', { maxRedirects: 0 })).status()).toBe(200);
  expect((await request.get('/api/data', { maxRedirects: 0 })).status()).toBe(200);
  expect((await request.get('/_next/static/chunks/nope-0000.js', { maxRedirects: 0 })).status()).toBe(404);
});

test('loading a page directly produces no hydration error', async ({ page }) => {
  for (const p of ['/', ...EXPORTED_PAGES]) {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e.message ?? e)));
    await page.goto(p, { waitUntil: 'domcontentloaded' });
    await page.locator('main').waitFor();
    await page.waitForTimeout(2000);
    expect(errors.filter(e => /errors\/4\d\d/.test(e)), `hydration error on ${p}`).toEqual([]);
    page.removeAllListeners('pageerror');
  }
});
