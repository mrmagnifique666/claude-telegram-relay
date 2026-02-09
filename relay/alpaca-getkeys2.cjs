const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9333', defaultViewport: null });
  const pages = await browser.pages();
  const page = pages[0];

  // Click API in sidebar
  const links = await page.$$('a');
  for (const link of links) {
    const text = await page.evaluate(el => el.textContent.trim(), link);
    if (text === 'API') {
      console.log('Found API link, clicking...');
      await link.click();
      await new Promise(r => setTimeout(r, 3000));
      break;
    }
  }

  // Take screenshot
  await page.screenshot({ path: 'relay/alpaca-api-page.png', fullPage: true });
  console.log('Screenshot saved: alpaca-api-page.png');

  // Get current URL
  console.log('Current URL:', page.url());

  // Get page text
  const bodyText = await page.evaluate(() => document.body.innerText);
  const lines = bodyText.split('\n').filter(l => l.trim().length > 0).slice(0, 60);
  console.log('\nPage text:');
  lines.forEach(l => console.log('  ', l.trim()));

  // Look for any key-like patterns
  const pageContent = await page.evaluate(() => document.body.innerHTML);
  const keyPattern = /PK[A-Z0-9]{10,}/g;
  const secretPattern = /[a-zA-Z0-9]{20,40}/g;
  const keys = pageContent.match(keyPattern);
  if (keys) console.log('\nAPI Keys found:', keys);

  // Look for buttons
  const buttons = await page.$$eval('button', btns => btns.map(b => ({ text: b.textContent.trim(), disabled: b.disabled })).filter(b => b.text.length > 0 && b.text.length < 50));
  console.log('\nButtons:', JSON.stringify(buttons));

  browser.disconnect();
})().catch(e => console.error('Error:', e.message));
