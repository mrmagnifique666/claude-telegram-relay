const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9333', defaultViewport: null });
  const pages = await browser.pages();
  const page = pages[0];

  // Click "Generate New Keys" button
  console.log('Looking for "Generate New Keys" button...');
  const buttons = await page.$$('button');
  for (const btn of buttons) {
    const text = await page.evaluate(el => el.textContent.trim(), btn);
    if (text === 'Generate New Keys') {
      console.log('Clicking "Generate New Keys"...');
      await btn.click();
      await new Promise(r => setTimeout(r, 5000));
      break;
    }
  }

  // Take screenshot immediately
  await page.screenshot({ path: 'relay/alpaca-new-keys.png' });
  console.log('New keys screenshot saved');

  // Get the page text - the secret key is shown only ONCE after regeneration
  const pageText = await page.evaluate(() => document.body.innerText);

  // Extract API Keys section
  const apiIdx = pageText.indexOf('API Keys');
  if (apiIdx >= 0) {
    const apiSection = pageText.substring(apiIdx, apiIdx + 800);
    console.log('\n=== API KEYS SECTION ===');
    console.log(apiSection);
  }

  // Also scan for key-like strings in the DOM
  const keyData = await page.evaluate(() => {
    const results = [];
    // Get all text nodes
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent.trim();
      // API Key pattern (PK...)
      if (/^PK[A-Z0-9]{10,}$/.test(text)) {
        results.push({ type: 'API_KEY', value: text });
      }
      // Secret Key pattern (long alphanumeric, may include special chars)
      if (/^[A-Za-z0-9\/\+\=]{20,}$/.test(text) && !text.startsWith('PK') && text.length < 80) {
        results.push({ type: 'POSSIBLE_SECRET', value: text });
      }
      // Endpoint URL
      if (text.includes('paper-api.alpaca.markets')) {
        results.push({ type: 'ENDPOINT', value: text });
      }
    }

    // Also check input values
    const inputs = document.querySelectorAll('input');
    for (const inp of inputs) {
      if (inp.value && inp.value.length > 10) {
        results.push({ type: 'INPUT_VALUE', value: inp.value });
      }
    }

    return results;
  });

  console.log('\n=== KEY DATA FOUND ===');
  keyData.forEach(k => console.log(`  ${k.type}: ${k.value}`));

  // Check for any copy buttons or secret display
  const allBtns = await page.$$eval('button', btns => btns.map(b => ({
    text: b.textContent.trim(),
    ariaLabel: b.getAttribute('aria-label') || ''
  })).filter(b => b.text.length > 0 && b.text.length < 50));
  console.log('\nButtons:', JSON.stringify(allBtns));

  // Keep connection for 120 seconds so we can take more screenshots if needed
  console.log('\nKeeping browser alive for 120s...');
  await new Promise(r => setTimeout(r, 120000));
  browser.disconnect();
})().catch(e => console.error('Error:', e.message));
