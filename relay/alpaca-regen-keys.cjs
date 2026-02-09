const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9333', defaultViewport: null });
  const pages = await browser.pages();
  const page = pages[0];

  console.log('URL:', page.url());

  // Scroll to the right sidebar API Keys section
  // First, find and scroll to the API Keys heading
  await page.evaluate(() => {
    const allElements = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, span, div');
    for (const el of allElements) {
      if (el.textContent.trim() === 'API Keys' && el.tagName === 'P') {
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        break;
      }
    }
  });
  await new Promise(r => setTimeout(r, 1000));

  // Take screenshot of the API Keys section area
  await page.screenshot({ path: 'relay/alpaca-apikeys.png' });
  console.log('API section screenshot saved');

  // Get the content of the API Keys container
  const apiContainer = await page.evaluate(() => {
    // Find the container that has "API Keys", "Endpoint", "Key", "Regenerate"
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      const text = el.innerText || '';
      if (text.includes('API Keys') && text.includes('Endpoint') && text.includes('Regenerate') && text.length < 500) {
        // Get all children info
        const children = [];
        const walk = (node, depth) => {
          if (depth > 6) return;
          for (const child of node.children) {
            children.push({
              tag: child.tagName,
              text: child.textContent.trim().substring(0, 100),
              class: child.className ? child.className.substring(0, 80) : '',
              value: child.value || '',
              href: child.href || '',
              childCount: child.children.length
            });
            walk(child, depth + 1);
          }
        };
        walk(el, 0);
        return { containerText: text, children };
      }
    }
    return null;
  });

  if (apiContainer) {
    console.log('\nAPI Container text:', apiContainer.containerText);
    console.log('\nChildren:');
    apiContainer.children.forEach((c, i) => {
      if (c.text.length > 0 || c.value.length > 0) {
        console.log(`  [${i}] <${c.tag}> class="${c.class}" text="${c.text}" value="${c.value}"`);
      }
    });
  }

  // Now click Regenerate
  console.log('\nClicking Regenerate...');
  const buttons = await page.$$('button');
  for (const btn of buttons) {
    const text = await page.evaluate(el => el.textContent.trim(), btn);
    if (text === 'Regenerate') {
      await btn.click();
      console.log('Clicked Regenerate!');
      await new Promise(r => setTimeout(r, 3000));
      break;
    }
  }

  // Take screenshot after regeneration
  await page.screenshot({ path: 'relay/alpaca-after-regen.png' });
  console.log('Post-regen screenshot saved');

  // Check for modal/dialog
  const dialogText = await page.evaluate(() => {
    const dialogs = document.querySelectorAll('[role="dialog"], .modal, [class*="modal"], [class*="dialog"]');
    for (const d of dialogs) {
      if (d.innerText.trim().length > 0) return d.innerText.trim().substring(0, 500);
    }
    return null;
  });
  if (dialogText) {
    console.log('\nDialog found:', dialogText);
  }

  // Check for new text on page
  const newBodyText = await page.evaluate(() => document.body.innerText);
  const apiIdx = newBodyText.indexOf('API Keys');
  if (apiIdx >= 0) {
    console.log('\nAPI section after regen:', newBodyText.substring(apiIdx, apiIdx + 500));
  }

  // Look for key-like values again
  const possibleKeys = await page.evaluate(() => {
    const allElements = document.querySelectorAll('span, div, p, code, pre, td, input, textarea');
    const results = [];
    for (const el of allElements) {
      const text = (el.value || el.textContent || '').trim();
      if (/^PK[A-Z0-9]{8,}/.test(text)) {
        results.push({ tag: el.tagName, text: text });
      }
      if (/^SK[A-Za-z0-9]{8,}/.test(text)) {
        results.push({ tag: el.tagName, text: text });
      }
      if (text.includes('paper-api.alpaca.markets')) {
        results.push({ tag: el.tagName, text: text });
      }
    }
    return results;
  });

  if (possibleKeys.length > 0) {
    console.log('\n=== FOUND KEYS ===');
    possibleKeys.forEach(k => console.log(`  <${k.tag}>: ${k.text}`));
  } else {
    console.log('\nNo keys found in DOM yet');
  }

  // Check all buttons
  const allBtns = await page.$$eval('button', btns => btns.map(b => b.textContent.trim()).filter(t => t.length > 0 && t.length < 80));
  console.log('\nCurrent buttons:', allBtns);

  browser.disconnect();
})().catch(e => console.error('Error:', e.message));
