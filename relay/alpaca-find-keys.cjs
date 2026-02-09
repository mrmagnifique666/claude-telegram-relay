const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9333', defaultViewport: null });
  const pages = await browser.pages();
  const page = pages[0];

  // First go back to dashboard overview
  await page.goto('https://app.alpaca.markets/dashboard/overview', { waitUntil: 'networkidle2', timeout: 15000 });
  console.log('URL:', page.url());

  // Scroll to top first
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise(r => setTimeout(r, 1000));

  // Take a full page screenshot without clipping
  await page.screenshot({ path: 'relay/alpaca-dashboard.png', fullPage: false });
  console.log('Dashboard screenshot saved');

  // Get ALL text content from the page, find API Keys section
  const allText = await page.evaluate(() => document.body.innerText);

  // Find API Keys related content
  const lines = allText.split('\n');
  let apiStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('API Keys') || lines[i].includes('Endpoint') || lines[i].includes('Regenerate')) {
      if (apiStart === -1) apiStart = Math.max(0, i - 2);
    }
  }

  if (apiStart >= 0) {
    console.log('\n--- API Keys Section ---');
    for (let i = apiStart; i < Math.min(apiStart + 15, lines.length); i++) {
      console.log(`  Line ${i}: "${lines[i].trim()}"`);
    }
  }

  // Now let's look specifically for the right sidebar content
  // The API Keys widget is in the right column of the dashboard
  // Let's find elements that contain "API Keys" text
  const apiKeyElements = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const results = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.textContent.includes('API Keys') ||
          node.textContent.includes('Endpoint') ||
          node.textContent.includes('paper-api') ||
          node.textContent.match(/^PK[A-Z0-9]+/) ||
          node.textContent.includes('Regenerate')) {
        // Get parent element info
        const parent = node.parentElement;
        const grandparent = parent ? parent.parentElement : null;
        results.push({
          text: node.textContent.trim(),
          parentTag: parent ? parent.tagName : '',
          parentClass: parent ? parent.className.substring(0, 100) : '',
          gpTag: grandparent ? grandparent.tagName : '',
          gpText: grandparent ? grandparent.innerText.substring(0, 300) : ''
        });
      }
    }
    return results;
  });

  console.log('\n--- API Key Related Text Nodes ---');
  apiKeyElements.forEach((el, i) => {
    console.log(`\n[${i}] Text: "${el.text}"`);
    console.log(`    Parent: <${el.parentTag}> class="${el.parentClass}"`);
    console.log(`    Grandparent text: "${el.gpText}"`);
  });

  // Also try to find the key value by looking at all short text elements that look like API keys
  const possibleKeys = await page.evaluate(() => {
    const allElements = document.querySelectorAll('span, div, p, code, pre, td, input');
    const results = [];
    for (const el of allElements) {
      const text = el.textContent.trim();
      // API key pattern: starts with PK, 20+ chars
      if (/^PK[A-Z0-9]{8,}/.test(text)) {
        results.push({ tag: el.tagName, text: text });
      }
      // Secret key pattern: long alphanumeric
      if (/^[a-zA-Z0-9]{20,50}$/.test(text) && !text.includes(' ')) {
        results.push({ tag: el.tagName, text: text });
      }
      // Endpoint URL
      if (text.includes('paper-api.alpaca.markets')) {
        results.push({ tag: el.tagName, text: text });
      }
    }
    return results;
  });

  console.log('\n--- Possible Keys/Endpoints ---');
  possibleKeys.forEach(k => console.log(`  <${k.tag}>: ${k.text}`));

  browser.disconnect();
})().catch(e => console.error('Error:', e.message));
