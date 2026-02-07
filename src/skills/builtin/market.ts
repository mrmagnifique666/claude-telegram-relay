/**
 * Built-in skills: market.overview, market.movers, market.earnings, market.report
 * Daily Alpha Report pipeline — free Yahoo Finance data + Claude analysis.
 */
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

const YF = "https://query1.finance.yahoo.com/v8/finance/chart";
const UA = { "User-Agent": "Mozilla/5.0" };

// ── Helpers ──

interface QuoteData {
  symbol: string;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  high: number;
  low: number;
  volume: number;
  avgVolume?: number;
  ma20?: number;
  ma50?: number;
  ma200?: number;
  rsi14?: number;
}

async function getQuote(symbol: string, range = "1d"): Promise<QuoteData | null> {
  try {
    const resp = await fetch(`${YF}/${symbol}?interval=1d&range=${range}`, { headers: UA });
    if (!resp.ok) return null;
    const data = await resp.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;

    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose || price;
    return {
      symbol: symbol.toUpperCase(),
      price,
      prevClose,
      change: price - prevClose,
      changePct: ((price - prevClose) / prevClose) * 100,
      high: meta.regularMarketDayHigh || price,
      low: meta.regularMarketDayLow || price,
      volume: meta.regularMarketVolume || 0,
    };
  } catch {
    return null;
  }
}

async function getHistorical(symbol: string, days: number): Promise<number[]> {
  try {
    const resp = await fetch(`${YF}/${symbol}?interval=1d&range=${days > 100 ? "1y" : "6mo"}`, { headers: UA });
    if (!resp.ok) return [];
    const data = await resp.json();
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    return (closes || []).filter((c: any) => c != null);
  } catch {
    return [];
  }
}

function calcMA(prices: number[], period: number): number | undefined {
  if (prices.length < period) return undefined;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcRSI(prices: number[], period = 14): number | undefined {
  if (prices.length < period + 1) return undefined;
  const changes = [];
  for (let i = prices.length - period - 1; i < prices.length - 1; i++) {
    changes.push(prices[i + 1] - prices[i]);
  }
  let gains = 0, losses = 0;
  for (const c of changes) {
    if (c > 0) gains += c;
    else losses -= c;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

async function getEnrichedQuote(symbol: string): Promise<QuoteData | null> {
  const quote = await getQuote(symbol);
  if (!quote) return null;

  const prices = await getHistorical(symbol, 220);
  if (prices.length > 0) {
    quote.ma20 = calcMA(prices, 20);
    quote.ma50 = calcMA(prices, 50);
    quote.ma200 = calcMA(prices, 200);
    quote.rsi14 = calcRSI(prices);
  }

  // Get average volume
  try {
    const resp = await fetch(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=summaryDetail`,
      { headers: UA }
    );
    if (resp.ok) {
      const data = await resp.json();
      const detail = data?.quoteSummary?.result?.[0]?.summaryDetail;
      quote.avgVolume = detail?.averageVolume?.raw || detail?.averageDailyVolume10Day?.raw;
    }
  } catch { /* */ }

  return quote;
}

function fmt(n: number | undefined, dec = 2): string {
  if (n === undefined || n === null) return "N/A";
  return n.toFixed(dec);
}

function arrow(n: number): string {
  return n >= 0 ? "+" : "";
}

function rvol(vol: number, avg: number | undefined): string {
  if (!avg || avg === 0) return "N/A";
  return `${((vol / avg) * 100).toFixed(0)}%`;
}

// ── market.overview ──

registerSkill({
  name: "market.overview",
  description:
    "Market overview: SPY, QQQ, DIA, VIX, sector ETFs with price, change, MAs, RSI. Full macro snapshot.",
  argsSchema: { type: "object", properties: {} },
  async execute(): Promise<string> {
    const indices = ["SPY", "QQQ", "DIA", "IWM"];
    const sectors = ["XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLRE", "XLC", "XLB"];
    const volatility = ["^VIX"];

    const sections: string[] = [];

    // Indices
    const indexResults = await Promise.all(indices.map(getEnrichedQuote));
    sections.push("**INDICES**");
    for (const q of indexResults) {
      if (!q) continue;
      const maInfo = [
        q.ma20 ? `MA20:${fmt(q.ma20)}` : null,
        q.ma50 ? `MA50:${fmt(q.ma50)}` : null,
        q.ma200 ? `MA200:${fmt(q.ma200)}` : null,
      ].filter(Boolean).join(" | ");
      const rsiStr = q.rsi14 ? `RSI:${fmt(q.rsi14, 0)}` : "";
      sections.push(
        `${q.symbol}: $${fmt(q.price)} (${arrow(q.changePct)}${fmt(q.changePct)}%) ${rsiStr}\n  ${maInfo}`
      );
    }

    // VIX
    const vix = await getQuote("^VIX");
    if (vix) {
      const level =
        vix.price < 15 ? "COMPLAISANCE" :
        vix.price < 20 ? "NORMAL" :
        vix.price < 25 ? "ÉLEVÉ" :
        vix.price < 30 ? "PEUR" : "PANIQUE";
      sections.push(`\n**VIX:** ${fmt(vix.price)} (${arrow(vix.changePct)}${fmt(vix.changePct)}%) — ${level}`);
    }

    // Sectors
    const sectorResults = await Promise.all(sectors.map(getQuote));
    const sortedSectors = sectorResults
      .filter((s): s is QuoteData => s !== null)
      .sort((a, b) => b.changePct - a.changePct);

    sections.push("\n**SECTEURS** (leaders → laggards)");
    for (const s of sortedSectors) {
      const bar = s.changePct > 0 ? "🟢" : s.changePct < -0.5 ? "🔴" : "⚪";
      sections.push(`${bar} ${s.symbol}: ${arrow(s.changePct)}${fmt(s.changePct)}%`);
    }

    // Market regime
    const spy = indexResults.find((q) => q?.symbol === "SPY");
    if (spy && vix) {
      const aboveMA50 = spy.ma50 ? spy.price > spy.ma50 : null;
      const regime =
        aboveMA50 && vix.price < 20 ? "🟢 BULL" :
        !aboveMA50 && vix.price > 25 ? "🔴 BEAR" : "⚪ NEUTRE";
      sections.push(`\n**RÉGIME:** ${regime}`);
    }

    return sections.join("\n");
  },
});

// ── market.movers ──

registerSkill({
  name: "market.movers",
  description:
    "Top market movers: biggest gainers and losers by % change. Scans common active tickers.",
  argsSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Number of movers per direction (default 10)" },
    },
  },
  async execute(args): Promise<string> {
    const limit = Math.min(Number(args.limit) || 10, 20);

    // Scan a universe of popular active stocks
    const universe = [
      "NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "GOOG", "META", "AMD", "PLTR", "SOFI",
      "NIO", "RIVN", "LCID", "MARA", "RIOT", "COIN", "HOOD", "AFRM", "UPST", "RBLX",
      "SNAP", "PINS", "ROKU", "SQ", "PYPL", "SHOP", "DKNG", "PENN", "CRWD", "NET",
      "SNOW", "DDOG", "ZS", "PANW", "SMCI", "ARM", "AVGO", "MU", "INTC", "QCOM",
      "BA", "F", "GM", "XOM", "CVX", "JPM", "GS", "BAC", "WFC", "C",
      "PFE", "MRNA", "JNJ", "UNH", "LLY", "NVO", "ABBV", "BMY", "GILD", "AMGN",
      "DIS", "NFLX", "WBD", "PARA", "T", "VZ", "TMUS", "CRM", "ORCL", "NOW",
      "TER", "IONQ", "RGTI", "QUBT", "SOUN", "BBAI", "JOBY", "LUNR", "RKLB", "ACHR",
    ];

    const quotes = await Promise.all(universe.map(getQuote));
    const valid = quotes.filter((q): q is QuoteData => q !== null && q.changePct !== 0);
    valid.sort((a, b) => b.changePct - a.changePct);

    const gainers = valid.slice(0, limit);
    const losers = valid.slice(-limit).reverse();

    const lines: string[] = ["**TOP GAINERS**"];
    for (const q of gainers) {
      const vol = q.volume > 1e6 ? `${(q.volume / 1e6).toFixed(1)}M` : `${(q.volume / 1e3).toFixed(0)}K`;
      lines.push(`🟢 ${q.symbol}: $${fmt(q.price)} (+${fmt(q.changePct)}%) Vol:${vol}`);
    }

    lines.push("\n**TOP LOSERS**");
    for (const q of losers) {
      const vol = q.volume > 1e6 ? `${(q.volume / 1e6).toFixed(1)}M` : `${(q.volume / 1e3).toFixed(0)}K`;
      lines.push(`🔴 ${q.symbol}: $${fmt(q.price)} (${fmt(q.changePct)}%) Vol:${vol}`);
    }

    return lines.join("\n");
  },
});

// ── market.earnings ──

registerSkill({
  name: "market.earnings",
  description: "Get upcoming earnings calendar for today/this week.",
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    // Use Yahoo Finance earnings calendar
    try {
      const now = new Date();
      const dateStr = now.toISOString().split("T")[0];
      const resp = await fetch(
        `https://finance.yahoo.com/calendar/earnings?day=${dateStr}`,
        { headers: { ...UA, Accept: "text/html" } }
      );
      if (!resp.ok) return `Error fetching earnings calendar: HTTP ${resp.status}`;

      const html = await resp.text();
      // Extract earnings from the HTML (simple pattern matching)
      const rows: string[] = [];
      const matches = html.matchAll(/data-symbol="([A-Z]+)"[^>]*>/g);
      const symbols = new Set<string>();
      for (const m of matches) {
        symbols.add(m[1]);
      }

      if (symbols.size === 0) {
        return `No earnings data found for ${dateStr}. Earnings calendar may require market hours.`;
      }

      // Get prices for earnings tickers
      const tickers = Array.from(symbols).slice(0, 20);
      const quotes = await Promise.all(tickers.map(getQuote));

      const lines = [`**Earnings Today (${dateStr}):**`];
      for (let i = 0; i < tickers.length; i++) {
        const q = quotes[i];
        if (q) {
          lines.push(`${tickers[i]}: $${fmt(q.price)} (${arrow(q.changePct)}${fmt(q.changePct)}%)`);
        } else {
          lines.push(`${tickers[i]}: price unavailable`);
        }
      }
      return lines.join("\n");
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ── market.report ── The main Daily Alpha Report generator

const ANALYST_PROMPT = `Tu es un analyste quantitatif elite spécialisé dans le day trading et le swing trading à haute conviction. Génère un Daily Alpha Report basé sur les données marché ci-dessous.

## STRUCTURE DU RAPPORT

**SUJET:** 🎯 Daily Alpha Report - [DATE] | SPY [PRIX] | Régime: [BULL/BEAR/NEUTRE]

### SECTION 1: ANALYSE MACRO & RÉGIME MARCHÉ (300 mots max)
- Analyse les prix, MAs, VIX, secteurs leaders/laggards
- CONCLUSION: BULL (SPY > MA50 + VIX < 20) | BEAR (SPY < MA50 + VIX > 25) | NEUTRE

### SECTION 2: TOP 5 OPPORTUNITÉS LONG
| Ticker | Prix | Gap % | RVOL | Catalyseur | Conv. | Entry | Stop | TP1 | TP2 |
Pour chaque: catalyseur précis, analyse technique (RSI, MAs), plan d'entrée/sortie.
Conviction: 5/5 (30%), 4/5 (20%), 3/5 (10%)

### SECTION 3: TOP 3 OPPORTUNITÉS SHORT / PUTS
Signaux de retournement, catalyseurs négatifs.

### SECTION 4: WATCH LIST EVENTS
Earnings du jour, événements macro.

### SECTION 5: STRATÉGIE INTRADAY
Horaires critiques (9:30-10:00, 10:00-11:30, lunch, afternoon, power hour).
Règles: max 3-5 positions, stop-loss obligatoire, take profit partiel à +12-15%.

### SECTION 6: RED FLAGS
Tickers à éviter, bull traps, pump & dump.

### SECTION 7: RÉSUMÉ EXÉCUTIF (100 mots)
Biais, top 3 convictions, niveau cash recommandé.

## RÈGLES:
- JAMAIS de prix inventés — si données manquantes, marque "À vérifier pré-market"
- Prioriser qualité sur quantité
- Adapter tone au régime: Bullish = agressif, Bearish = prudent
- 1500-2000 mots MAX
- Opinion éducative, pas conseil financier

Voici les données marché du jour:`;

registerSkill({
  name: "market.report",
  description:
    "Generate the full Daily Alpha Report: collects market data, analyzes with Claude, sends via Telegram. The main morning briefing.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      sendToTelegram: {
        type: "string",
        description: "Send report via telegram.send? 'yes' or 'no' (default: yes)",
      },
    },
  },
  async execute(args): Promise<string> {
    const sendTg = (args.sendToTelegram as string) !== "no";

    log.info("[market.report] Collecting market data...");

    // 1. Collect all data in parallel
    const [
      spyQ, qqqQ, diaQ, iwmQ, vixQ,
      xlkQ, xlfQ, xleQ, xlvQ, xliQ, xlyQ, xlpQ, xluQ,
    ] = await Promise.all([
      getEnrichedQuote("SPY"),
      getEnrichedQuote("QQQ"),
      getEnrichedQuote("DIA"),
      getEnrichedQuote("IWM"),
      getQuote("^VIX"),
      getQuote("XLK"), getQuote("XLF"), getQuote("XLE"), getQuote("XLV"),
      getQuote("XLI"), getQuote("XLY"), getQuote("XLP"), getQuote("XLU"),
    ]);

    // 2. Scan movers
    const moverUniverse = [
      "NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "GOOG", "META", "AMD", "PLTR", "SOFI",
      "NIO", "RIVN", "MARA", "RIOT", "COIN", "HOOD", "AFRM", "UPST", "RBLX",
      "SNAP", "SQ", "PYPL", "SHOP", "DKNG", "CRWD", "NET", "SMCI", "ARM", "AVGO",
      "MU", "INTC", "QCOM", "BA", "XOM", "JPM", "GS", "LLY", "NVO", "NFLX",
      "CRM", "ORCL", "NOW", "TER", "IONQ", "RGTI", "SOUN", "BBAI", "RKLB",
    ];
    const moverQuotes = await Promise.all(moverUniverse.map(getQuote));
    const movers = moverQuotes
      .filter((q): q is QuoteData => q !== null)
      .sort((a, b) => b.changePct - a.changePct);

    // 3. Build data block for Claude
    const now = new Date();
    const dateStr = now.toLocaleDateString("fr-CA", { timeZone: "America/Toronto" });
    const timeStr = now.toLocaleTimeString("fr-CA", { timeZone: "America/Toronto", timeStyle: "short" });

    const dataBlock: string[] = [`Date: ${dateStr} ${timeStr} ET\n`];

    // Indices
    dataBlock.push("=== INDICES ===");
    for (const q of [spyQ, qqqQ, diaQ, iwmQ]) {
      if (!q) continue;
      dataBlock.push(
        `${q.symbol}: $${fmt(q.price)} (${arrow(q.changePct)}${fmt(q.changePct)}%) ` +
        `H:${fmt(q.high)} L:${fmt(q.low)} Vol:${q.volume} ` +
        `MA20:${fmt(q.ma20)} MA50:${fmt(q.ma50)} MA200:${fmt(q.ma200)} RSI14:${fmt(q.rsi14, 0)}`
      );
    }

    // VIX
    if (vixQ) {
      const level = vixQ.price < 15 ? "COMPLAISANCE" : vixQ.price < 20 ? "NORMAL" :
        vixQ.price < 25 ? "ÉLEVÉ" : vixQ.price < 30 ? "PEUR" : "PANIQUE";
      dataBlock.push(`\nVIX: ${fmt(vixQ.price)} (${arrow(vixQ.changePct)}${fmt(vixQ.changePct)}%) — ${level}`);
    }

    // Sectors
    dataBlock.push("\n=== SECTEURS ===");
    const sectors = [xlkQ, xlfQ, xleQ, xlvQ, xliQ, xlyQ, xlpQ, xluQ]
      .filter((s): s is QuoteData => s !== null)
      .sort((a, b) => b.changePct - a.changePct);
    for (const s of sectors) {
      dataBlock.push(`${s.symbol}: ${arrow(s.changePct)}${fmt(s.changePct)}%`);
    }

    // Regime
    const regime =
      spyQ && vixQ && spyQ.ma50 && spyQ.price > spyQ.ma50 && vixQ.price < 20 ? "BULL" :
      spyQ && vixQ && spyQ.ma50 && spyQ.price < spyQ.ma50 && vixQ.price > 25 ? "BEAR" : "NEUTRE";
    dataBlock.push(`\nRÉGIME MARCHÉ: ${regime}`);

    // Top movers
    dataBlock.push("\n=== TOP GAINERS ===");
    for (const q of movers.slice(0, 10)) {
      const vol = q.volume > 1e6 ? `${(q.volume / 1e6).toFixed(1)}M` : `${(q.volume / 1e3).toFixed(0)}K`;
      dataBlock.push(`${q.symbol}: $${fmt(q.price)} (+${fmt(q.changePct)}%) Vol:${vol}`);
    }
    dataBlock.push("\n=== TOP LOSERS ===");
    for (const q of movers.slice(-10).reverse()) {
      const vol = q.volume > 1e6 ? `${(q.volume / 1e6).toFixed(1)}M` : `${(q.volume / 1e3).toFixed(0)}K`;
      dataBlock.push(`${q.symbol}: $${fmt(q.price)} (${fmt(q.changePct)}%) Vol:${vol}`);
    }

    const fullData = dataBlock.join("\n");
    log.info(`[market.report] Data collected (${fullData.length} chars). Regime: ${regime}`);

    // The report will be generated by Claude when this data is returned
    // The orchestrator will feed this + the prompt to Claude, which generates the analysis
    const report =
      `[MARKET_REPORT] Données marché collectées. Génère le Daily Alpha Report complet.\n\n` +
      `${ANALYST_PROMPT}\n\n${fullData}\n\n` +
      `Génère le rapport maintenant et envoie-le à Nicolas via telegram.send. ` +
      `Format le rapport en texte Telegram (pas de tableaux markdown complexes, utilise des listes). ` +
      `Sépare en plusieurs messages si nécessaire (max 4000 chars par message).`;

    return report;
  },
});
