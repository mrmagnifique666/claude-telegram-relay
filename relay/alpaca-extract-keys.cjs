const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9333', defaultViewport: null });
  const pages = await browser.pages();
  const page = pages[0];

  // Scroll down to find API Keys section
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(r => setTimeout(r, 1500));

  // Take screenshot of bottom of page where API Keys section is
  await page.screenshot({ path: 'relay/alpaca-apikeys.png' });
  console.log('Screenshot saved');

  // Find all text near "API Keys", "Endpoint", "Key"
  const apiSection = await page.evaluate(() => {
    const body = document.body.innerText;
    const idx = body.indexOf('API Keys');
    if (idx >= 0) {
      return body.substring(idx, idx + 500);
    }
    return 'API Keys section not found';
  });
  console.log('\nAPI Section text:');
  console.log(apiSection);

  // Try to find the actual key value - look for elements near "Key" label
  const keyInfo = await page.evaluate(() => {
    const allElements = document.querySelectorAll('*');
    const results = [];
    for (const el of allElements) {
      const text = el.textContent.trim();
      if (text === 'Key' || text === 'Endpoint' || text.startsWith('PK') || text.includes('paper-api')) {
        results.push({
          tag: el.tagName,
          text: text.substring(0, 200),
          className: el.className ? el.className.substring(0, 100) : ''
        });
      }
    }
    return results;
  });
  console.log('\nKey-related elements:');
  keyInfo.forEach(k => console.log(`  <${k.tag}> class="${k.className}" text="${k.text}"`));

  // Look for hidden inputs or data attributes
  const hiddenValues = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input[type="hidden"], input[type="password"]');
    return Array.from(inputs).map(i => ({ name: i.name, value: i.value.substring(0, 50) }));
  });
  console.log('\nHidden inputs:', hiddenValues);

  // Try clicking "Regenerate" to get new keys
  console.log('\nLooking for Regenerate button...');
  const btns = await page.$$('button');
  for (const btn of btns) {
    const text = await page.evaluate(el => el.textContent.trim(), btn);
    if (text === 'Regenerate') {
      console.log('Found Regenerate button!');
      // Get the parent container's text for context
      const parentText = await page.evaluate(el => {
        let parent = el.parentElement;
        for (let i = 0; i < 5 && parent; i++) {
          parent = parent.parentElement;
        }
        return parent ? parent.innerText.substring(0, 500) : 'no parent';
      }, btn);
      console.log('Parent context:', parentText);
      break;
    }
  }

  browser.disconnect();
})().catch(e => console.error('Error:', e.message));
