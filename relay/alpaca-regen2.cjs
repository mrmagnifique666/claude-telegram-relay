const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9333', defaultViewport: null });
  const pages = await browser.pages();
  const page = pages[0];

  // Make sure we're on dashboard
  if (!page.url().includes('dashboard/overview')) {
    await page.goto('https://app.alpaca.markets/dashboard/overview', { waitUntil: 'networkidle2', timeout: 15000 });
  }

  // Scroll to API Keys section
  await page.evaluate(() => {
    const allP = document.querySelectorAll('p');
    for (const p of allP) {
      if (p.textContent.trim() === 'API Keys') {
        p.scrollIntoView({ behavior: 'instant', block: 'center' });
        break;
      }
    }
  });
  await new Promise(r => setTimeout(r, 1000));

  // Click Regenerate button
  console.log('Looking for Regenerate button...');
  const buttons = await page.$$('button');
  for (const btn of buttons) {
    const text = await page.evaluate(el => el.textContent.trim(), btn);
    if (text === 'Regenerate') {
      console.log('Clicking Regenerate...');
      await btn.click();
      await new Promise(r => setTimeout(r, 3000));
      break;
    }
  }

  // Take screenshot - there might be a confirmation dialog
  await page.screenshot({ path: 'relay/alpaca-after-regen.png' });
  console.log('Post-regen screenshot saved');

  // Check for any dialog/modal
  const pageText = await page.evaluate(() => document.body.innerText);

  // Look for confirmation buttons like "Yes", "Confirm", "OK"
  const allBtns = await page.$$eval('button', btns => btns.map(b => b.textContent.trim()).filter(t => t.length > 0 && t.length < 50));
  console.log('Buttons after regen:', allBtns);

  // Check if there's a new secret key shown
  // After regenerating, Alpaca typically shows the secret key ONCE
  const keyPatterns = await page.evaluate(() => {
    const text = document.body.innerText;
    const results = [];
    // Look for anything that looks like a key
    const words = text.split(/[\s\n]+/);
    for (const word of words) {
      if (/^PK[A-Z0-9]{10,}/.test(word)) results.push('API_KEY: ' + word);
      if (/^[A-Za-z0-9\/\+]{20,50}$/.test(word) && !word.includes(' ')) results.push('POSSIBLE_SECRET: ' + word);
    }
    return results;
  });
  console.log('Key patterns found:', keyPatterns);

  // Get all text near "API Keys" section
  const apiSection = pageText.substring(pageText.indexOf('API Keys'));
  console.log('\nAPI Section text:', apiSection.substring(0, 500));

  browser.disconnect();
})().catch(e => console.error('Error:', e.message));
