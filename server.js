const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');

const app = express();
const PORT = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 300 });

// --- Middleware ---
app.use(cors());
app.use(helmet({ frameguard: false, contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.static('public'));
app.set('trust proxy', 1);

const limiter = rateLimit({ windowMs: 60000, max: 100, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);

// --- StockX Algolia Config ---
const ALGOLIA_URL = 'https://xw7sbct9v6-dsn.algolia.net/1/indexes/products/query';
const ALGOLIA_APP_ID = 'XW7SBCT9V6';
const ALGOLIA_API_KEY = '6b5e76b49705eb9f51a06571571c4a94';

// --- Marketplace Fee Structures (real 2024-2025 rates) ---
const MARKETPLACE_FEES = {
  stockx: {
    name: 'StockX',
    sellerFee: 0.095,
    paymentProc: 0.03,
    shipping: 13.95
  },
  goat: {
    name: 'GOAT',
    commission: 0.095,
    cashoutFee: 0.029,
    shipping: 9.95
  },
  ebay: {
    name: 'eBay',
    finalValueFee: 0.129,
    perOrderFee: 0.30,
    shipping: 14.00
  }
};

// --- Search StockX via Algolia ---
async function searchStockX(query, limit = 20) {
  const cacheKey = `sx:${query}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const response = await fetch(ALGOLIA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Algolia-Application-Id': ALGOLIA_APP_ID,
      'X-Algolia-API-Key': ALGOLIA_API_KEY
    },
    body: JSON.stringify({
      params: `query=${encodeURIComponent(query)}&hitsPerPage=${limit}&facets=*`
    })
  });

  if (!response.ok) throw new Error(`Algolia ${response.status}`);
  const data = await response.json();
  const results = (data.hits || []).map(transformHit).filter(s => s.name !== 'Unknown');
  cache.set(cacheKey, results);
  return results;
}

// --- Transform Algolia Hit to Clean Object ---
function transformHit(hit) {
  // Retail price - try multiple fields
  let retail = null;
  if (hit.searchable_traits && hit.searchable_traits['Retail Price']) {
    retail = parseFloat(hit.searchable_traits['Retail Price']);
  } else if (hit.retail_price_cents) {
    retail = hit.retail_price_cents / 100;
  }

  // Market prices
  const lowestAsk = hit.lowest_price_cents ? hit.lowest_price_cents / 100 : null;
  const highestBid = hit.highest_bid_cents ? hit.highest_bid_cents / 100 : null;

  // Last sale - handle both cents and dollars
  let lastSale = null;
  if (typeof hit.last_sale === 'number') {
    lastSale = hit.last_sale > 500 ? hit.last_sale / 100 : hit.last_sale;
  }

  // Spread
  let spread = null;
  let spreadPct = null;
  const marketPrice = lowestAsk || lastSale;
  if (marketPrice && retail && retail > 0) {
    spread = marketPrice - retail;
    spreadPct = Math.round((spread / retail) * 100);
  }

  return {
    id: hit.objectID || '',
    name: hit.name || 'Unknown',
    brand: hit.brand || '',
    colorway: hit.colorway || '',
    styleID: hit.style_id || hit.sku || '',
    retail: retail,
    lowestAsk: lowestAsk,
    highestBid: highestBid,
    lastSale: lastSale,
    spread: spread,
    spreadPct: spreadPct,
    totalSales: hit.deadstock_sold || 0,
    salesLast72h: hit.sales_last_72 || 0,
    pricePremium: hit.price_premium || null,
    thumbnail: hit.thumbnail_url || (hit.media ? hit.media.thumbUrl : '') || '',
    image: hit.image_url || (hit.media ? hit.media.imageUrl : '') || '',
    url: hit.url ? 'https://stockx.com/' + hit.url : '',
    releaseDate: hit.release_date || '',
    category: hit.product_category || 'sneakers',
    source: 'stockx-live'
  };
}

// --- Calculate Profit for a Marketplace ---
function calculateProfit(sellPrice, buyPrice, marketplace) {
  const fees = MARKETPLACE_FEES[marketplace];
  if (!fees) return null;

  let totalFees = 0;
  let feeBreakdown = {};

  if (marketplace === 'stockx') {
    const sf = sellPrice * fees.sellerFee;
    const pp = sellPrice * fees.paymentProc;
    totalFees = sf + pp + fees.shipping;
    feeBreakdown = { sellerFee: r2(sf), paymentProcessing: r2(pp), shipping: fees.shipping };
  } else if (marketplace === 'goat') {
    const cm = sellPrice * fees.commission;
    const co = sellPrice * fees.cashoutFee;
    totalFees = cm + co + fees.shipping;
    feeBreakdown = { commission: r2(cm), cashoutFee: r2(co), shipping: fees.shipping };
  } else if (marketplace === 'ebay') {
    const fvf = sellPrice * fees.finalValueFee + fees.perOrderFee;
    totalFees = fvf + fees.shipping;
    feeBreakdown = { finalValueFee: r2(fvf), shipping: fees.shipping };
  }

  const payout = sellPrice - totalFees;
  const netProfit = payout - buyPrice;
  const roi = buyPrice > 0 ? (netProfit / buyPrice) * 100 : 0;

  return {
    marketplace: fees.name,
    sellPrice, buyPrice,
    totalFees: r2(totalFees),
    feeBreakdown,
    payout: r2(payout),
    netProfit: r2(netProfit),
    roi: r1(roi)
  };
}

function r2(n) { return Math.round(n * 100) / 100; }
function r1(n) { return Math.round(n * 10) / 10; }

// =====================
//     API ROUTES
// =====================

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime(), cacheStats: cache.getStats() });
});

// Search
app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.json({ source: 'stockx-live', results: [], query: '' });
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 40);
    const results = await searchStockX(query, limit);
    res.json({ source: 'stockx-live', results, query });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed', message: err.message });
  }
});

// Trending
app.get('/api/trending', async (req, res) => {
  const cacheKey = 'trending-v2';
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const limit = Math.min(parseInt(req.query.limit) || 25, 50);
    const queries = ['Jordan 1', 'Yeezy', 'Dunk Low', 'Travis Scott', 'New Balance'];
    const allResults = [];
    const seen = new Set();

    for (const q of queries) {
      try {
        const hits = await searchStockX(q, 12);
        for (const hit of hits) {
          if (!seen.has(hit.id) && hit.lowestAsk) {
            seen.add(hit.id);
            allResults.push(hit);
          }
        }
      } catch (e) {
        console.error(`Trending query "${q}" failed:`, e.message);
      }
    }

    // Sort by spread (highest profit potential first)
    allResults.sort((a, b) => {
      const spreadA = a.spread || 0;
      const spreadB = b.spread || 0;
      return spreadB - spreadA;
    });

    const trending = allResults.slice(0, limit);
    const result = { source: 'stockx-live', results: trending, count: trending.length, updatedAt: new Date().toISOString() };
    cache.set(cacheKey, result, 600);
    res.json(result);
  } catch (err) {
    console.error('Trending error:', err.message);
    res.status(500).json({ error: 'Failed to load trending' });
  }
});

// Profit Calculator
app.get('/api/profit', (req, res) => {
  const sell = parseFloat(req.query.sell);
  const buy = parseFloat(req.query.buy);
  if (isNaN(sell) || isNaN(buy)) return res.status(400).json({ error: 'sell and buy params required (numbers)' });

  const all = {};
  for (const mp of Object.keys(MARKETPLACE_FEES)) {
    all[mp] = calculateProfit(sell, buy, mp);
  }
  res.json({ allMarketplaces: all });
});

// Fee structures (for frontend display)
app.get('/api/fees', (req, res) => {
  res.json(MARKETPLACE_FEES);
});

// --- Keep-Alive Self-Ping (prevents Render free tier sleep) ---
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://soleping-api.onrender.com';
setInterval(() => {
  fetch(SELF_URL + '/api/health').catch(() => {});
}, 10 * 60 * 1000);

// --- Start ---
app.listen(PORT, () => {
  console.log('=== SolePing API ===');
  console.log('Port:', PORT);
  console.log('Data: StockX Algolia (LIVE pricing)');
  console.log('Keep-alive: every 10 min');
  console.log('====================');
});
