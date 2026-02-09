const puppeteer = require('puppeteer');

(async () => {
  // Launch fresh Chrome with saved session
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--window-size=1280,900', '--no-sandbox', '--remote-debugging-port=9333'],
    userDataDir: 'C:/Users/Nicolas/Documents/Claude/chrome-kingston'
  });

  const pages = await browser.pages();
  let page = pages[0] || await browser.newPage();

  // Go to new account page
  await page.goto('https://app.alpaca.markets/brokerage/new-account', {
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  console.log('Page loaded:', page.url());
  await new Promise(r => setTimeout(r, 2000));

  // Click Individual Account
  let buttons = await page.$$('button');
  for (const btn of buttons) {
    const text = await btn.evaluate(el => el.textContent.trim());
    if (text.includes('Individual Account')) {
      console.log('Clicking Individual Account...');
      await btn.click();
      await new Promise(r => setTimeout(r, 1000));
      break;
    }
  }

  // Click Next
  buttons = await page.$$('button');
  for (const btn of buttons) {
    const text = await btn.evaluate(el => el.textContent.trim());
    if (text === 'Next') {
      console.log('Clicking Next...');
      await btn.click();
      await new Promise(r => setTimeout(r, 4000));
      console.log('After Next URL:', page.url());
      break;
    }
  }

  await page.screenshot({ path: 'relay/alpaca-after-individual.png' });

  // Check form fields
  const inputs = await page.$$eval('input, select, textarea', els => els.map(el => ({
    type: el.type || el.tagName.toLowerCase(),
    name: el.name || '',
    placeholder: el.placeholder || '',
    id: el.id || '',
    label: el.getAttribute('aria-label') || ''
  })));
  console.log('Form fields:', JSON.stringify(inputs, null, 2));

  // Check all visible text labels
  const labels = await page.$$eval('label', els => els.map(el => el.textContent.trim()));
  console.log('Labels:', labels);

  const allBtns = await page.$$eval('button', btns => btns.map(b => b.textContent.trim()).filter(t => t.length > 0));
  console.log('Buttons:', allBtns);

  // Keep alive
  console.log('Keeping browser alive for 600 seconds...');
  await new Promise(r => setTimeout(r, 600000));
  await browser.close();
})().catch(e => console.error('Error:', e.message));
