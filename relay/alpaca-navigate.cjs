const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--window-size=1280,900', '--no-sandbox', '--remote-debugging-port=9333'],
    userDataDir: 'C:/Users/Nicolas/Documents/Claude/chrome-kingston'
  });

  const pages = await browser.pages();
  let page = pages[0];
  if (!page) page = await browser.newPage();

  // Check current URL
  const currentUrl = page.url();
  console.log('Current URL:', currentUrl);

  // If we're still on login/MFA, the session cookies should carry over
  // Navigate to paper trading dashboard
  await page.goto('https://app.alpaca.markets/paper/dashboard/overview', {
    waitUntil: 'networkidle2',
    timeout: 20000
  }).catch(() => console.log('Navigation timeout'));

  await new Promise(r => setTimeout(r, 3000));

  let url = page.url();
  let title = await page.title();
  console.log('After navigation - URL:', url);
  console.log('After navigation - Title:', title);

  await page.screenshot({ path: 'relay/alpaca-dashboard.png' });
  console.log('Dashboard screenshot saved');

  // If we're on the dashboard, look for API Keys link
  if (url.includes('dashboard') || url.includes('paper')) {
    // Try to find and click API Keys
    try {
      // Look for API keys in the sidebar
      const links = await page.$$eval('a', els => els.map(a => ({
        href: a.href,
        text: a.textContent.trim()
      })));
      console.log('Links found:', JSON.stringify(links.filter(l =>
        l.text.toLowerCase().includes('api') ||
        l.text.toLowerCase().includes('key') ||
        l.href.includes('api')
      )));

      // Navigate directly to API keys page
      await page.goto('https://app.alpaca.markets/paper/dashboard/configuration/api-keys', {
        waitUntil: 'networkidle2',
        timeout: 15000
      }).catch(() => console.log('API keys page timeout'));

      await new Promise(r => setTimeout(r, 2000));
      await page.screenshot({ path: 'relay/alpaca-apikeys.png' });
      console.log('API Keys page URL:', page.url());

      // Try to find the API key text on the page
      const pageText = await page.evaluate(() => document.body.innerText);
      // Look for key patterns
      const keyMatch = pageText.match(/[A-Z0-9]{20,}/g);
      if (keyMatch) {
        console.log('Potential keys found:', keyMatch);
      }
    } catch (e) {
      console.log('Error navigating to API keys:', e.message);
    }
  } else if (url.includes('login')) {
    console.log('Still on login page - session may not have persisted');
    await page.screenshot({ path: 'relay/alpaca-still-login.png' });
  }

  // Keep alive
  console.log('Keeping browser open for 300 seconds...');
  await new Promise(r => setTimeout(r, 300000));
  await browser.close();
})().catch(e => console.error('Fatal Error:', e.message));
