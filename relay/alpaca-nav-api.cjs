const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9333', defaultViewport: null });
  const pages = await browser.pages();
  const page = pages[0];

  console.log('Current URL:', page.url());

  // Try navigating directly to the paper trading home
  console.log('Navigating to paper trading home...');
  await page.goto('https://app.alpaca.markets/paper/dashboard/overview', { waitUntil: 'networkidle2', timeout: 15000 });
  console.log('URL after navigation:', page.url());

  await page.screenshot({ path: 'relay/alpaca-dashboard.png' });
  console.log('Screenshot saved: alpaca-dashboard.png');

  await new Promise(r => setTimeout(r, 2000));

  // Now try to navigate to API Keys page
  console.log('\nNavigating to API keys...');
  await page.goto('https://app.alpaca.markets/paper/dashboard/api-keys', { waitUntil: 'networkidle2', timeout: 15000 });
  console.log('URL after API nav:', page.url());

  await page.screenshot({ path: 'relay/alpaca-apikeys.png' });
  console.log('Screenshot saved: alpaca-apikeys.png');

  // Get page text
  const bodyText = await page.evaluate(() => document.body.innerText);
  const lines = bodyText.split('\n').filter(l => l.trim().length > 0).slice(0, 60);
  console.log('\nPage text:');
  lines.forEach(l => console.log('  ', l.trim()));

  // Look for buttons
  const buttons = await page.$$eval('button', btns => btns.map(b => b.textContent.trim()).filter(t => t.length > 0 && t.length < 50));
  console.log('\nButtons:', buttons);

  browser.disconnect();
})().catch(e => console.error('Error:', e.message));
