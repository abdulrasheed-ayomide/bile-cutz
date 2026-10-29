/**
 * Browser smoke test (Playwright). Prerequisites: backend on :4000 and frontend dev server on :5173 against a
 * migrated + demo-seeded database, with an admin created via `npm run admin:create`
 * (email owner@example.com, password from ADMIN_PASSWORD below), and a fresh set of customers.
 *   cd e2e && npm i playwright && ADMIN_PASSWORD='...' node smoke.cjs
 * Screenshots are written to ./screenshots.
 */
const OUT = require('path').join(__dirname, 'screenshots');
require('fs').mkdirSync(OUT, { recursive: true });
const { chromium } = require('playwright');
const BASE = 'http://localhost:5173';
(async () => {
  const b = await chromium.launch();
  const errors = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource.*(4\d\d)/.test(m.text())) errors.push('console: ' + m.text()); });
  process.on('exit', () => {});
  const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });

  await page.goto(BASE); await page.waitForSelector('h1'); await shot('home');
  console.log('home h1:', await page.textContent('h1'));
  console.log('admin link on public nav:', await page.locator('a[href^="/admin"]').count());

  // guest booking
  await page.click('text=Book an appointment >> nth=0');
  await page.click('.choice >> nth=0');
  await page.waitForSelector('.cal-day:not([disabled])', { timeout: 8000 }).catch(async (e) => { await page.screenshot({ path: `${OUT}/fail.png`, fullPage: true }); throw e; });
  await page.locator('.cal-day:not([disabled])').nth(1).click();
  await page.waitForSelector('.slot:not([disabled])');
  await page.locator('.slot:not([disabled])').nth(2).click();
  await shot('booking-slots');
  await page.click('text=Continue');
  await page.fill('#name', 'Guest Tester'); await page.fill('#email', 'guest.tester@example.com'); await page.fill('#phone', '08011112222');
  await page.click('text=Review booking');
  await shot('booking-review');
  await page.click('text=Submit booking request');
  await page.waitForSelector('.ref'); console.log('guest ref:', await page.textContent('.ref'));
  await shot('booking-done');
  const link = await page.locator('a:has-text("Open my booking")').getAttribute('href');
  await page.goto(BASE + link); await page.waitForSelector('text=Your private booking'); console.log('guest manage ok');

  // customer register
  await page.goto(BASE + '/register');
  await page.fill('#fullName', 'Ade Bello'); await page.fill('#email', 'ade@example.com'); await page.fill('#password', 'Sup3rSecret!'); await page.fill('#confirmPassword', 'Sup3rSecret!');
  await page.click('button:has-text("Create account")');
  await page.waitForURL('**/account'); await page.waitForSelector('text=Hello, Ade');
  console.log('customer greeting:', await page.locator('.topbar').innerText());
  await shot('account');

  // admin
  const actx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const ap = await actx.newPage();
  ap.on('pageerror', (e) => errors.push('admin pageerror: ' + e.message));
  await ap.goto(BASE + '/admin'); await ap.waitForURL('**/admin/login');
  await ap.fill('#email', 'owner@example.com'); await ap.fill('#password', process.env.ADMIN_PASSWORD); await ap.click('button:has-text("Sign in")');
  await ap.waitForSelector('.stats'); await ap.screenshot({ path: `${OUT}/admin.png` });
  console.log('admin stats:', (await ap.locator('.stat').allInnerTexts()).map((t) => t.replace(/\n/g, ' ')).join(' | '));
  await ap.click('.stat:has-text("Pending approvals")'); await ap.waitForSelector('tbody tr');
  await ap.click('tbody tr >> nth=0'); await ap.click('button:has-text("Approve")'); await ap.click('.modal button:has-text("Approve")');
  await ap.waitForSelector('.badge-approved'); console.log('approved ok');
  await ap.goto(BASE + '/admin/calendar'); await ap.waitForSelector('.month-grid'); await ap.screenshot({ path: `${OUT}/calendar.png` });

  // chat round-trip customer -> admin
  await page.goto(BASE + '/account/messages'); await page.waitForSelector('#chat-input');
  await page.fill('#chat-input', 'Hello shop, running 5 mins late'); await page.keyboard.press('Enter');
  await page.waitForSelector('.bubble.mine:has-text("running 5")');
  await ap.goto(BASE + '/admin/messages'); await ap.waitForSelector('.conv'); await ap.click('.conv >> nth=0');
  await ap.waitForSelector('.bubble:has-text("running 5")');
  await ap.fill('#chat-input', 'No problem, see you soon'); await ap.keyboard.press('Enter');
  await page.waitForSelector('.bubble:has-text("see you soon")', { timeout: 8000 });
  console.log('live chat reply reached customer');
  await ap.screenshot({ path: `${OUT}/admin-chat.png` });

  // mobile
  const m = await b.newContext({ viewport: { width: 375, height: 800 } }); const mp = await m.newPage();
  await mp.goto(BASE); await mp.waitForSelector('h1'); await mp.screenshot({ path: `${OUT}/mobile-home.png` });
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log('mobile horizontal overflow:', overflow);
  await mp.goto(BASE + '/services'); await mp.waitForSelector('.service-card'); await mp.screenshot({ path: `${OUT}/mobile-services.png` });
  console.log('errors:', errors);
  await b.close();
})().catch(async (e) => { console.error('FAIL', e.message.split('\n').slice(0,3).join(' | ')); process.exit(1); });
