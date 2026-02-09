const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9333', defaultViewport: null });
  const pages = await browser.pages();
  const page = pages[0];

  console.log('Current URL:', page.url());
  await page.screenshot({ path: 'relay/alpaca-dashboard.png' });
  console.log('Dashboard screenshot saved');

  // Click API in sidebar
  console.log('\nLooking for API link...');
  const buttons = await page.$$('button');
  for (const btn of buttons) {
    const text = await page.evaluate(el => el.textContent.trim(), btn);
    if (text === 'API') {
      console.log('Clicking API button...');
      await btn.click();
      await new Promise(r => setTimeout(r, 3000));
      break;
    }
  }

  console.log('URL after API click:', page.url());
  await page.screenshot({ path: 'relay/alpaca-apikeys.png', fullPage: true });
  console.log('API page screenshot saved');

  // Get page text
  const bodyText = await page.evaluate(() => document.body.innerText);
  const lines = bodyText.split('\n').filter(l => l.trim().length > 0);
  console.log('\nPage content:');
  lines.forEach(l => console.log('  ', l.trim()));

  // Look for API key patterns in HTML
  const html = await page.evaluate(() => document.body.innerHTML);

  // Check for "Generate" or "Regenerate" or "Create" buttons
  const allBtns = await page.$$eval('button', btns => btns.map(b => b.textContent.trim()).filter(t => t.length > 0 && t.length < 80));
  console.log('\nAll buttons:', allBtns);

  // Check for links
  const allLinks = await page.$$eval('a', links => links.map(l => ({ text: l.textContent.trim(), href: l.href })).filter(l => l.text.length > 0 && l.text.length < 80));
  console.log('\nAll links:', JSON.stringify(allLinks.slice(0, 20)));

  browser.disconnect();
})().catch(e => console.error('Error:', e.message));
