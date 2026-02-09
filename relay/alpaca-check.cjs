const puppeteer = require('puppeteer');

(async () => {
  // Launch Chrome with saved session
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    userDataDir: 'C:/Users/Nicolas/Documents/Claude/chrome-kingston',
    args: [
      '--remote-debugging-port=9333',
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized'
    ]
  });

  const page = await browser.newPage();

  // Navigate to Alpaca dashboard
  await page.goto('https://app.alpaca.markets/dashboard/overview', {
    waitUntil: 'networkidle2',
    timeout: 20000
  });

  console.log('URL:', page.url());
  await page.screenshot({ path: 'relay/alpaca-current-state.png' });
  console.log('Screenshot saved');

  // Get page text
  const bodyText = await page.evaluate(() => document.body.innerText);
  const lines = bodyText.split('\n').filter(l => l.trim().length > 0);
  console.log('\nPage text (first 60 lines):');
  lines.slice(0, 60).forEach((l, i) => console.log(`  ${i}: ${l.trim()}`));

  // Find "Ask AI" or MCP-related elements
  const aiElements = await page.evaluate(() => {
    const results = [];
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      const ownText = Array.from(el.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent.trim())
        .join(' ');
      if (ownText.toLowerCase().includes('ask ai') ||
          ownText.toLowerCase().includes('mcp') ||
          ownText.toLowerCase().includes('trade using ai') ||
          ownText.toLowerCase().includes('natural language')) {
        results.push({
          text: ownText.substring(0, 120),
          tag: el.tagName,
          href: el.href || ''
        });
      }
    }
    return results;
  });
  console.log('\nAI/MCP elements:', JSON.stringify(aiElements, null, 2));

  // Get all buttons
  const buttons = await page.$$eval('button', btns => btns.map(b => b.textContent.trim()).filter(t => t.length > 0 && t.length < 60));
  console.log('\nButtons:', buttons);

  // Keep browser alive
  console.log('\nBrowser alive for 300s...');
  await new Promise(r => setTimeout(r, 300000));
  await browser.close();
})().catch(e => console.error('Error:', e.message));
