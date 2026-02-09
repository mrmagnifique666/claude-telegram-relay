const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9333', defaultViewport: null });
  const pages = await browser.pages();
  const page = pages[0];

  console.log('Current URL:', page.url());

  // Try clicking Home button in sidebar
  const buttons = await page.$$('button');
  for (const btn of buttons) {
    const text = await page.evaluate(el => el.textContent.trim(), btn);
    if (text === 'Home') {
      console.log('Clicking Home button...');
      await btn.click();
      await new Promise(r => setTimeout(r, 3000));
      console.log('URL after Home click:', page.url());
      await page.screenshot({ path: 'relay/alpaca-after-home.png' });
      break;
    }
  }

  // If still stuck, try clicking the Kingston dropdown at top left
  if (page.url().includes('new-account')) {
    console.log('Still on setup page. Trying Kingston dropdown...');
    const dropdowns = await page.$$('button');
    for (const btn of dropdowns) {
      const text = await page.evaluate(el => el.textContent.trim(), btn);
      if (text.includes('Kingston') && text.includes('Paper')) {
        console.log('Clicking account selector:', text);
        await btn.click();
        await new Promise(r => setTimeout(r, 2000));
        await page.screenshot({ path: 'relay/alpaca-dropdown.png' });
        break;
      }
    }
  }

  // If still stuck, try using browser Back
  if (page.url().includes('new-account')) {
    console.log('Trying browser back button...');
    await page.goBack();
    await new Promise(r => setTimeout(r, 3000));
    console.log('URL after back:', page.url());
    await page.screenshot({ path: 'relay/alpaca-after-back.png' });
  }

  // Try the "Back" button on the form
  if (page.url().includes('new-account')) {
    console.log('Trying form Back button...');
    const allBtns = await page.$$('button');
    for (const btn of allBtns) {
      const text = await page.evaluate(el => el.textContent.trim(), btn);
      if (text === 'Back') {
        await btn.click();
        await new Promise(r => setTimeout(r, 2000));
        console.log('URL after form Back:', page.url());
        await page.screenshot({ path: 'relay/alpaca-form-back.png' });
        break;
      }
    }
  }

  // Last resort: try direct URL patterns
  if (page.url().includes('new-account')) {
    const urls = [
      'https://app.alpaca.markets/paper/dashboard',
      'https://app.alpaca.markets/paper',
      'https://app.alpaca.markets/account/api-keys',
    ];
    for (const url of urls) {
      console.log('Trying direct URL:', url);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
      console.log('  Result:', page.url());
      if (!page.url().includes('new-account')) {
        await page.screenshot({ path: 'relay/alpaca-found.png' });
        break;
      }
    }
  }

  console.log('\nFinal URL:', page.url());
  browser.disconnect();
})().catch(e => console.error('Error:', e.message));
