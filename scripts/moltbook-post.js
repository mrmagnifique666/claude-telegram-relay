/**
 * Moltbook auto-post + captcha solver
 * Usage: node scripts/moltbook-post.js
 */
require('dotenv').config();
const KEY = process.env.MOLTBOOK_API_KEY;
const BASE = 'https://www.moltbook.com/api/v1';
const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// Number word parser
const WORDS = {
  zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,
  ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,
  seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,
  sixty:60,seventy:70,eighty:80,ninety:90,hundred:100,thousand:1000,
};

function wordsToNumber(str) {
  // Clean up the mixed case challenge text
  const clean = str.toLowerCase().replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = clean.split(/[\s-]+/);
  let total = 0, current = 0;
  for (const t of tokens) {
    const val = WORDS[t];
    if (val === undefined) continue;
    if (val === 100) current *= 100;
    else if (val === 1000) { current *= 1000; total += current; current = 0; }
    else current += val;
  }
  return total + current;
}

function solveChallenge(challenge) {
  // Decode mixed case: strip non-alpha except spaces and basic punct
  const decoded = challenge.replace(/[\[\]^-]/g, '').replace(/([a-zA-Z])([A-Z])/g, '$1 $2')
    .toLowerCase().replace(/\s+/g, ' ').trim();
  console.log('Decoded:', decoded);

  // Try to find numbers and operation
  // Pattern: number OP number = ?
  // Look for keywords
  const addWords = ['total', 'sum', 'combined', 'plus', 'add', 'new velocity', 'accelerates by', 'and'];
  const subWords = ['difference', 'minus', 'subtract', 'less', 'slower'];
  const mulWords = ['times', 'multiply', 'product'];
  const divWords = ['divide', 'split', 'per'];

  // Extract all number phrases
  const numbers = [];
  // Try to find explicit digit numbers first
  const digitMatches = decoded.match(/\d+(\.\d+)?/g);
  if (digitMatches) digitMatches.forEach(m => numbers.push(parseFloat(m)));

  // Also look for word-numbers in segments
  // Split by common separators
  const segments = decoded.split(/,|;|and|but|then|plus/);
  for (const seg of segments) {
    const n = wordsToNumber(seg);
    if (n > 0 && !numbers.includes(n)) numbers.push(n);
  }

  // If we still don't have 2 numbers, try harder
  if (numbers.length < 2) {
    // Look for "twenty three" style
    const allWords = decoded.split(/\s+/);
    const found = [];
    let i = 0;
    while (i < allWords.length) {
      if (WORDS[allWords[i]] !== undefined) {
        let phrase = allWords[i];
        while (i + 1 < allWords.length && WORDS[allWords[i+1]] !== undefined) {
          i++;
          phrase += ' ' + allWords[i];
        }
        const n = wordsToNumber(phrase);
        if (n > 0) found.push(n);
      }
      i++;
    }
    for (const n of found) if (!numbers.includes(n)) numbers.push(n);
  }

  console.log('Found numbers:', numbers);

  if (numbers.length >= 2) {
    const a = numbers[0], b = numbers[1];
    // Determine operation from context
    if (/total|sum|combined|plus|add|accelerat|new velocity|force/.test(decoded)) {
      return (a + b).toFixed(2);
    }
    if (/differ|minus|subtract|less|slow|reduc/.test(decoded)) {
      return (a - b).toFixed(2);
    }
    if (/times|multiply|product/.test(decoded)) {
      return (a * b).toFixed(2);
    }
    if (/divid|split|ratio/.test(decoded)) {
      return (a / b).toFixed(2);
    }
    // Default to addition
    return (a + b).toFixed(2);
  }
  return null;
}

async function postAndVerify(submolt, title, content) {
  console.log(`Posting to s/${submolt}: "${title}"`);

  const resp = await fetch(`${BASE}/posts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ submolt, title, content }),
  });
  const json = await resp.json();

  if (!json.success && json.retry_after_minutes) {
    console.log(`Rate limited — wait ${json.retry_after_minutes} minutes`);
    return { ok: false, error: 'rate_limited', wait: json.retry_after_minutes };
  }

  if (!json.verification_required) {
    console.log('No verification needed:', JSON.stringify(json));
    return { ok: json.success, data: json };
  }

  const { code, challenge } = json.verification;
  console.log('Challenge:', challenge);

  const answer = solveChallenge(challenge);
  if (!answer) {
    console.log('Could not solve challenge!');
    return { ok: false, error: 'unsolvable', challenge };
  }

  console.log('Answer:', answer);

  // Verify immediately
  const vResp = await fetch(`${BASE}/verify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ verification_code: code, answer }),
  });
  const vJson = await vResp.json();
  console.log('Verification:', JSON.stringify(vJson));

  return { ok: vJson.success, postId: json.post?.id, data: vJson };
}

// If called directly, post from command line args or stdin
const args = process.argv.slice(2);
if (args[0] === '--submolt') {
  const submolt = args[1];
  const title = args[3] || args[2]; // --title "..."
  // Content from stdin or args
  let content = '';
  if (args.indexOf('--content') >= 0) {
    content = args[args.indexOf('--content') + 1];
  }
  postAndVerify(submolt, title, content).then(r => {
    process.exit(r.ok ? 0 : 1);
  });
}

module.exports = { postAndVerify, solveChallenge };
