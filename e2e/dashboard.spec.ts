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
