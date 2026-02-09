const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9333', defaultViewport: null });
  const pages = await browser.pages();
  const page = pages[0];

  // Accept cookies if banner is there
  try {
    const acceptBtn = await page.$('button');
    const btnText = await page.evaluate(el => el.textContent.trim(), acceptBtn);
    if (btnText === 'Accept') {
      await acceptBtn.click();
      console.log('Accepted cookies');
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch(e) {}

  // Fill First Name
  const firstNameInput = await page.$('input[name="first_name"]');
  if (firstNameInput) {
    await firstNameInput.click({ clickCount: 3 });
    await firstNameInput.type('Nicolas', { delay: 50 });
    console.log('Filled: First Name = Nicolas');
  }

  // Fill Last Name
  const lastNameInput = await page.$('input[name="last_name"]');
  if (lastNameInput) {
    await lastNameInput.click({ clickCount: 3 });
    await lastNameInput.type('Leveille', { delay: 50 });
    console.log('Filled: Last Name = Leveille');
  }

  // Take screenshot of partial fill
  await page.screenshot({ path: 'relay/alpaca-partial-fill.png' });
  console.log('Screenshot saved: alpaca-partial-fill.png');

  // List what still needs to be filled
  console.log('\n--- STILL NEEDED FROM NICOLAS ---');
  console.log('1. Date of Birth (Month, Day, Year)');
  console.log('2. Phone Number');
  console.log('3. Country of Tax Residence (Canada?)');
  console.log('4. Street Address');
  console.log('5. City (Gatineau?)');
  console.log('6. State/Province (QC?)');
  console.log('7. Postal Code');
  console.log('8. Tax ID Type + Tax ID (SIN?)');

  browser.disconnect();
})().catch(e => console.error('Error:', e.message));
