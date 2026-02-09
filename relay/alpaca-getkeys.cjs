const puppeteer = require('puppeteer');

(async () => {
  // Connect to existing Chrome via debugging port
  const browser = await puppeteer.connect({
    browserURL: 'http://localhost:9333',
    defaultViewport: null
  });

  const pages = await browser.pages();
  const page = pages[pages.length - 1];

  console.log('Connected! Current URL:', page.url());

  // Click on API link in sidebar
  await page.goto('https://app.alpaca.markets/paper/dashboard/configuration/api-keys', {
    waitUntil: 'networkidle2',
    timeout: 15000
  }).catch(() => console.log('Direct API keys URL timeout'));

  await new Promise(r => setTimeout(r, 2000));
  let url = page.url();
  console.log('After API nav:', url);

  // If that didn't work, try clicking the API link
  if (!url.includes('api')) {
    try {
      const apiLink = await page.$('a[href*="api"]');
      if (apiLink) {
        await apiLink.click();
        await new Promise(r => setTimeout(r, 3000));
        console.log('Clicked API link, URL:', page.url());
      } else {
        // Try finding by text
        const links = await page.$$('a');
        for (const link of links) {
          const text = await link.evaluate(el => el.textContent.trim());
          if (text === 'API' || text.includes('API')) {
            await link.click();
            await new Promise(r => setTimeout(r, 3000));
            console.log('Clicked API text link, URL:', page.url());
            break;
          }
        }
      }
    } catch (e) {
      console.log('Error clicking API:', e.message);
    }
  }

  await page.screenshot({ path: 'relay/alpaca-apikeys.png' });

  // Get page text to find keys
  const bodyText = await page.evaluate(() => document.body.innerText);

  // Look for API key patterns
  const lines = bodyText.split('\n');
  for (const line of lines) {
    if (line.match(/[A-Z0-9]{16,}/) || line.toLowerCase().includes('key') || line.toLowerCase().includes('secret')) {
      console.log('KEY LINE:', line.trim());
    }
  }

  // Also look for "Generate" or "Regenerate" button if keys aren't shown
  const buttons = await page.$$eval('button', btns => btns.map(b => b.textContent.trim()));
  console.log('Buttons on page:', buttons);

  console.log('\nDone. Screenshot saved to relay/alpaca-apikeys.png');
  browser.disconnect();
})().catch(e => console.error('Error:', e.message));
