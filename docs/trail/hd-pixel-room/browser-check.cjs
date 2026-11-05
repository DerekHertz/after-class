// Start the deterministic fixture with bun run scripts/preview-ui.ts.
// Run with PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_EXECUTABLE=/path/to/chrome node browser-check.cjs.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { writeFileSync } = require('node:fs');
const base = process.env.PREVIEW_URL || 'http://127.0.0.1:8770/?clean=1';
const results = [];
const scenes = [
  ['last-desk', 'The Last Desk'], ['study-bench', 'The Study Bench'], ['projection-booth', 'The Projection Booth'],
];
const companions = ['Pip', 'Mote', 'Lumi', 'Inkcloud Yun', 'Moonlit Library Mote', 'Pagewing Spirit Mote'];
(async () => {
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(base);
    await page.waitForLoadState('networkidle');
    async function picker(open) {
      if (await page.locator('.appearance-picker').evaluate(e => e.open) !== open) {
        await page.locator('.appearance-picker > summary').click();
      }
    }
    async function chooseScene(name) {
      await picker(true);
      await page.getByRole('button', { name: new RegExp('^' + name) }).click();
      await picker(false);
    }
    async function verifySourceToggle(mobile) {
      const control = mobile ? page.locator('.hd-mobile-tools button').first() : page.locator('.hd-card');
      if (await page.locator('#review-source').isVisible()) {
        await control.focus(); await page.keyboard.press('Enter');
        await page.locator('#review-source').waitFor({ state: 'hidden' });
      }
      await control.focus(); await page.keyboard.press('Enter');
      await page.locator('#review-source').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.hd-room-friend .study-companion').getAttribute('data-reaction'), 'draw');
      await page.waitForTimeout(1100);
      assert.equal(await page.locator('.hd-room-friend .study-companion').getAttribute('data-reaction'), null);
    }
    async function animationsPaused(hidden) {
      await page.evaluate(value => {
        Object.defineProperty(document, 'hidden', { configurable: true, value });
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden);
      await page.waitForTimeout(50);
      const states = await page.locator('.hd-room-art *').evaluateAll(elements => elements
        .filter(e => getComputedStyle(e).animationName !== 'none')
        .map(e => getComputedStyle(e).animationPlayState));
      assert(states.length > 0);
      assert(states.every(state => state === (hidden ? 'paused' : 'running')));
    }
    async function hasVisibleMotion() {
      return page.locator('.hd-room-art *').evaluateAll(elements => elements.some(element => {
        const style = getComputedStyle(element);
        if (style.animationName === 'none' || style.animationPlayState === 'paused') return false;
        for (let node = element; node; node = node.parentElement) {
          if (getComputedStyle(node).display === 'none') return false;
        }
        return true;
      }));
    }
    for (const [id, name] of scenes) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await chooseScene(name);
      assert.equal(await page.locator('.hd-room').getAttribute('data-scene'), id);
      await page.locator('textarea').fill('Draft survives ' + id);
      const stageBefore = await page.locator('.hd-room-stage').boundingBox();
      await page.mouse.move(1400, 950);
      assert.deepEqual(await page.locator('.hd-room-stage').boundingBox(), stageBefore);
      await picker(true);
      for (const detail of ['Painted', 'HD pixel art']) {
        await page.getByRole('button', { name: detail, exact: true }).click();
        assert.equal(await page.locator('textarea').inputValue(), 'Draft survives ' + id);
      }
      for (const companion of companions) {
        await page.getByRole('button', { name: new RegExp('^' + companion) }).click();
        assert(await page.locator('.hd-room-friend .hd-companion').evaluate(async element => {
          const style = getComputedStyle(element);
          const sizes = [];
          for (const variable of ['--companion-idle', '--companion-draw', '--companion-read']) {
            const image = new Image(); image.src = style.getPropertyValue(variable).trim().slice(5, -2);
            await image.decode(); sizes.push([image.naturalWidth, image.naturalHeight]);
          }
          return sizes.every(([width, height]) => width > 0 && height > 0 && width === sizes[0][0] && height === sizes[0][1]);
        }));
      }
      await page.getByRole('button', { name: /^Mote/ }).click();
      await picker(false);
      if (id === 'projection-booth') assert((await page.locator('.hd-room-friend .hd-companion-pose').evaluate(e => getComputedStyle(e).filter)).includes('brightness'));
      await verifySourceToggle(false);
      if (id === 'projection-booth') {
        const contrast = await page.locator('#source-heading').evaluate(element => {
          function luminance(color) {
            const channels = color.match(/[\d.]+/g).slice(0, 3).map(value => Number(value) / 255)
              .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
            return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
          }
          const foreground = luminance(getComputedStyle(element).color);
          const background = luminance(getComputedStyle(document.querySelector('#review-source')).backgroundColor);
          return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
        });
        assert(contrast >= 4.5, 'Booth source heading must contrast with the paper surface');
      }
      await page.mouse.move(1430, 10);
      await page.locator('textarea').focus();
      await page.screenshot({ path: join(__dirname, id === 'last-desk' ? 'desktop.png' : id + '.png'), fullPage: true });
      await page.locator('.hd-journal').focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('.hd-room-friend .study-companion').getAttribute('data-reaction'), 'read');
      await page.waitForURL('**/record'); assert(await page.locator('.record-page').isVisible());
      await page.goto(base); await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('.hd-room').getAttribute('data-scene'), id);
      await animationsPaused(true); await animationsPaused(false);
      await page.emulateMedia({ reducedMotion: 'reduce' }); assert.equal(await hasVisibleMotion(), false);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await picker(true); await page.getByLabel('Reduce motion').check(); assert.equal(await hasVisibleMotion(), false);
      await page.getByLabel('Show companion').uncheck(); assert.equal(await page.locator('.hd-room-friend').count(), 0);
      await page.getByLabel('Show companion').check(); await page.getByLabel('Reduce motion').uncheck(); await picker(false);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
      assert((await page.locator('.hd-mobile-tools button').first().boundingBox()).height >= 44);
      await verifySourceToggle(true);
      await page.locator('textarea').focus();
      await page.mouse.move(389, 1);
      await page.screenshot({ path: join(__dirname, id === 'last-desk' ? 'mobile.png' : id + '-mobile.png'), fullPage: true });
      await page.locator('.hd-mobile-tools').getByRole('button', { name: 'My notebook', exact: true }).click();
      await page.waitForURL('**/record');
      await page.goto(base); await page.waitForLoadState('networkidle');
      // CSS embeds images as data URLs. Exercise functional fallback by removing all HD artwork.
      await page.addStyleTag({ content: '.hd-room-art *, .hd-companion-pose { background-image:none !important; }' });
      await page.locator('textarea').fill('Works with artwork unavailable');
      await verifySourceToggle(true);
      assert.equal(await page.locator('textarea').inputValue(), 'Works with artwork unavailable');
      await page.locator('.hd-mobile-tools').getByRole('button', { name: 'My notebook', exact: true }).click();
      await page.waitForURL('**/record'); await page.goto(base); await page.waitForLoadState('networkidle');
      results.push({ scene: id, status: 'PASS', checks: ['Fixed camera', 'Detail change preserves draft', 'Six HD idle/draw/read frame sets decode at matching dimensions', 'Keyboard source reaction and settle', 'Desktop and mobile notebook navigation', 'System/app reduced motion including all visible animated descendants', 'Synthetic visibility pauses/resumes all animation', 'Hidden companion', '390px no horizontal overflow and 44px mobile controls', 'Source, draft and notebook usable with HD artwork removed'] });
    }
    await page.locator('textarea').fill('Cross-room draft');
    for (const [, name] of scenes) {
      await chooseScene(name); assert.equal(await page.locator('textarea').inputValue(), 'Cross-room draft');
    }
    assert.deepEqual(errors, []);
    writeFileSync(join(__dirname, 'browser-results.json'), JSON.stringify({ status: 'PASS', fixture: true, viewportWidths: [1440, 390], pairingsDecoded: 18, scenes: results, additional: ['Draft survives changes across all three rooms', 'Projection Booth source heading contrast meets 4.5:1'], limitations: ['Visibility tested with synthetic visibilitychange, OS tab suspension untested.', 'Artwork bundled inline, missing-image behavior simulated through CSS image removal.'], pageErrors: errors }, null, 2) + '\n');
    console.log(JSON.stringify({ status: 'PASS', scenes: results.map(result => result.scene), pairingsDecoded: 18 }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
