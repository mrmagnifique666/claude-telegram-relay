const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--window-size=1280,900', '--no-sandbox'],
    userDataDir: 'C:/Users/Nicolas/Documents/Claude/chrome-kingston'
  });

  const pages = await browser.pages();
  let page = pages[0];
  if (!page) page = await browser.newPage();

  // Go to login page
  await page.goto('https://app.alpaca.markets/account/login', { waitUntil: 'networkidle2', timeout: 30000 });

  // Clear and fill email
  const emailField = await page.waitForSelector('input[name="email"], input[type="email"]', { timeout: 10000 });
  await emailField.click({ clickCount: 3 });
  await emailField.type('Kingston.orchestrator@gmail.com', { delay: 50 });

  // Clear and fill password
  const pwField = await page.waitForSelector('input[name="password"], input[type="password"]', { timeout: 5000 });
  await pwField.click({ clickCount: 3 });
  await pwField.type('Gatineau!969', { delay: 50 });

  // Click Continue button
  await new Promise(r => setTimeout(r, 500));
  const buttons = await page.$$eval('button', btns => btns.map(b => b.textContent));
  console.log('Buttons found:', buttons);

  // Click the submit/continue button
  const submitBtn = await page.$('button[type="submit"]');
  if (submitBtn) {
    await submitBtn.click();
    console.log('Clicked submit button');
  } else {
    // Try all buttons
    const allBtns = await page.$$('button');
    for (const b of allBtns) {
      const text = await b.evaluate(el => el.textContent.trim());
      if (text.includes('Continue') || text.includes('Log') || text.includes('Sign')) {
        await b.click();
        console.log('Clicked button:', text);
        break;
      }
    }
  }

  // Wait for navigation
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {
    console.log('Navigation timeout - may have loaded already');
  });

  // Wait extra
  await new Promise(r => setTimeout(r, 3000));

  // Screenshot
  await page.screenshot({ path: 'relay/alpaca-after-login.png', fullPage: false });

  const title = await page.title();
  const url = page.url();
  console.log('Title:', title);
  console.log('URL:', url);

  // Now try to navigate to Paper Trading API keys
  if (url.includes('dashboard') || url.includes('overview')) {
    // Look for Paper Trading toggle or API Keys link
    console.log('Logged in! Navigating to API keys...');

    // Try paper trading
    await page.goto('https://app.alpaca.markets/paper/dashboard/overview', { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
    await page.screenshot({ path: 'relay/alpaca-paper-dashboard.png' });
    console.log('Paper dashboard URL:', page.url());
  }

  // Keep alive
  console.log('Browser open. Keeping alive for 300 seconds...');
  await new Promise(r => setTimeout(r, 300000));
  await browser.close();
})().catch(e => console.error('Error:', e.message));
