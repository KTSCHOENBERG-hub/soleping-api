const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');

const app = express();
const PORT = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 300 });

// --- Load got-scraping (ESM) dynamically ---
let gotScraping = null;
async function getGot() {
  if (!gotScraping) {
    const mod = await import('got-scraping');
    gotScraping = mod.gotScraping;
  }
  return gotScraping;
}

// --- Middleware ---
app.use(cors());
app.use(helmet({ frameguard: false, contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.static('public'));
app.set('trust proxy', 1);

const limiter = rateLimit({ windowMs: 60000, max: 100, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);

// --- Marketplace Fee Structures (real 2024-2025 rates) ---
const MARKETPLACE_FEES = {
  stockx: { name: 'StockX', sellerFee: 0.095, paymentProc: 0.03, shipping: 13.95 },
  goat: { name: 'GOAT', commission: 0.095, cashoutFee: 0.029, shipping: 9.95 },
  ebay: { name: 'eBay', finalValueFee: 0.129, perOrderFee: 0.30, shipping: 14.00 }
};

const r2 = n => Math.round(n * 100) / 100;

// ============================================================
//   Deterministic Price Fluctuation Engine
//   Prices change daily based on date hash, not randomly per request
// ============================================================
function priceFluctuate(basePrice, sneakerId) {
  if (!basePrice || basePrice <= 0) return basePrice;
  const today = new Date();
  const dayNum = Math.floor(today.getTime() / 86400000);
  // Simple hash from sneaker ID + day
  let hash = 0;
  const seed = sneakerId + ':' + dayNum;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  // Fluctuation: -5% to +5% of base price
  const pct = ((Math.abs(hash) % 1000) / 1000) * 0.10 - 0.05;
  return Math.round(basePrice * (1 + pct));
}

function getSalesCount(sneakerId) {
  const dayNum = Math.floor(Date.now() / 86400000);
  let hash = 0;
  const seed = 'sales:' + sneakerId + ':' + dayNum;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash % 150) + 10;
}

// ============================================================
//   METHOD 1: GOAT via Algolia (SaaS â works from any IP)
// ============================================================
async function searchGoatAlgolia(query, limit) {
  const url = 'https://2fwotdvm2o-dsn.algolia.net/1/indexes/product_variants_v2/query';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-algolia-agent': 'Algolia for vanilla JavaScript 3.25.1',
      'x-algolia-application-id': '2FWOTDVM2O',
      'x-algolia-api-key': 'ac96c6db12b2f0c748f2e5b0f1cad2e0',
      'content-type': 'application/json',
      'accept': 'application/json'
    },
    body: JSON.stringify({
      params: 'query=' + encodeURIComponent(query) + '&hitsPerPage=' + limit + '&facets=*&filters='
    }),
    signal: AbortSignal.timeout(12000)
  });

  if (!resp.ok) throw new Error('Algolia ' + resp.status);
  const data = await resp.json();
  const hits = data.hits || [];

  return hits.slice(0, limit).map(h => {
    const retail = h.retail_price_cents ? h.retail_price_cents / 100 : null;
    const lowestAsk = h.lowest_price_cents ? h.lowest_price_cents / 100 : null;
    const lastSale = h.instant_ship_lowest_price_cents ? h.instant_ship_lowest_price_cents / 100 : lowestAsk;
    const marketPrice = lowestAsk || lastSale;
    const spread = marketPrice && retail ? marketPrice - retail : null;
    const spreadPct = spread && retail ? Math.round((spread / retail) * 100) : null;

    return {
      id: h.slug || h.objectID || '',
      name: h.name || 'Unknown',
      brand: h.brand_name || '',
      colorway: h.color || '',
      styleID: h.sku || '',
      retail: retail,
      lowestAsk: lowestAsk,
      highestBid: lowestAsk ? Math.round(lowestAsk * 0.92) : null,
      lastSale: lastSale,
      spread: spread,
      spreadPct: spreadPct,
      totalSales: 0,
      salesLast72h: 0,
      pricePremium: spreadPct,
      thumbnail: h.main_picture_url || h.picture_url || h.image_url || '',
      image: h.main_picture_url || h.original_picture_url || h.picture_url || '',
      url: h.slug ? 'https://www.goat.com/sneakers/' + h.slug : '',
      releaseDate: h.release_date_name || h.release_date || '',
      category: h.product_type || 'sneakers',
      source: 'goat-live'
    };
  }).filter(s => s.name !== 'Unknown');
}

// ============================================================
//   METHOD 2: GOAT via Constructor.io (backup search)
// ============================================================
async function searchGoatConstructor(query, limit) {
  const url = 'https://ac.cnstrc.com/search/' + encodeURIComponent(query)
    + '?c=ciojs-client-2.35.2'
    + '&key=key_XT7bjdbvjgECO5d8'
    + '&i=goat-web'
    + '&s=0'
    + '&num_results_per_page=' + limit
    + '&_dt=' + Date.now();

  const resp = await fetch(url, {
    headers: { 'accept': 'application/json' },
    signal: AbortSignal.timeout(10000)
  });

  if (!resp.ok) throw new Error('Constructor ' + resp.status);
  const data = await resp.json();
  const results = data.response?.results || [];

  return results.slice(0, limit).map(r => {
    const d = r.data || {};
    const retail = d.retail_price_cents ? d.retail_price_cents / 100 : null;
    const lowestAsk = d.lowest_price_cents ? d.lowest_price_cents / 100 : null;
    const marketPrice = lowestAsk || retail;
    const spread = marketPrice && retail ? marketPrice - retail : null;
    const spreadPct = spread && retail ? Math.round((spread / retail) * 100) : null;

    return {
      id: d.slug || r.value || '',
      name: d.name || r.value || 'Unknown',
      brand: d.brand_name || '',
      colorway: d.color || '',
      styleID: d.sku || '',
      retail, lowestAsk,
      highestBid: lowestAsk ? Math.round(lowestAsk * 0.92) : null,
      lastSale: lowestAsk,
      spread, spreadPct,
      totalSales: 0, salesLast72h: 0, pricePremium: spreadPct,
      thumbnail: d.main_picture_url || d.picture_url || '',
      image: d.main_picture_url || d.original_picture_url || '',
      url: d.slug ? 'https://www.goat.com/sneakers/' + d.slug : '',
      releaseDate: d.release_date_name || '',
      category: d.product_type || 'sneakers',
      source: 'constructor-live'
    };
  }).filter(s => s.name !== 'Unknown');
}

// ============================================================
//   METHOD 3: FlightClub via Algolia
// ============================================================
async function searchFlightClub(query, limit) {
  const url = 'https://2fwotdvm2o-dsn.algolia.net/1/indexes/product_variants_v2_flight_club/query';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-algolia-agent': 'Algolia for vanilla JavaScript 3.25.1',
      'x-algolia-application-id': '2FWOTDVM2O',
      'x-algolia-api-key': 'ac96c6db12b2f0c748f2e5b0f1cad2e0',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      params: 'query=' + encodeURIComponent(query) + '&hitsPerPage=' + limit
    }),
    signal: AbortSignal.timeout(10000)
  });

  if (!resp.ok) throw new Error('FlightClub Algolia ' + resp.status);
  const data = await resp.json();
  const hits = data.hits || [];

  return hits.slice(0, limit).map(h => {
    const retail = h.retail_price_cents ? h.retail_price_cents / 100 : null;
    const lowestAsk = h.lowest_price_cents ? h.lowest_price_cents / 100 : null;
    const marketPrice = lowestAsk || retail;
    const spread = marketPrice && retail ? marketPrice - retail : null;
    const spreadPct = spread && retail ? Math.round((spread / retail) * 100) : null;

    return {
      id: h.slug || h.objectID || '',
      name: h.name || 'Unknown',
      brand: h.brand_name || '',
      colorway: h.color || '',
      styleID: h.sku || '',
      retail, lowestAsk,
      highestBid: lowestAsk ? Math.round(lowestAsk * 0.9) : null,
      lastSale: lowestAsk,
      spread, spreadPct,
      totalSales: 0, salesLast72h: 0, pricePremium: spreadPct,
      thumbnail: h.main_picture_url || h.picture_url || '',
      image: h.main_picture_url || h.original_picture_url || '',
      url: h.slug ? 'https://www.flightclub.com/' + h.slug : '',
      releaseDate: h.release_date_name || h.release_date || '',
      category: h.product_type || 'sneakers',
      source: 'flightclub-live'
    };
  }).filter(s => s.name !== 'Unknown');
}

// ============================================================
//   METHOD 4: StockX GraphQL (may be Cloudflare-blocked)
// ============================================================
async function searchStockXGraphQL(query, limit) {
  const got = await getGot();

  const graphqlBody = JSON.stringify({
    query: `query Browse($query: String!, $first: Int) {
      browse(query: $query, first: $first) {
        results { edges { node {
          id urlKey name brand colorway styleId
          market { state { lowestAsk { amount } highestBid { amount } }
                   statistics { lastSale { amount } totalSales last72Hours { salesCount } } }
          media { thumbUrl smallImageUrl imageUrl }
          traits { name value }
          productCategory
        } } }
      }
    }`,
    variables: { query, first: limit }
  });

  const resp = await got({
    url: 'https://stockx.com/api/p/e',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json',
      'apollographql-client-name': 'Iron',
      'apollographql-client-version': '2024.07.08.00',
      'x-stockx-device-id': Math.random().toString(36).substring(2),
      'origin': 'https://stockx.com',
      'referer': 'https://stockx.com/search?s=' + encodeURIComponent(query),
    },
    headerGeneratorOptions: {
      browsers: [{ name: 'chrome', minVersion: 120, maxVersion: 126 }],
      devices: ['desktop'],
      operatingSystems: ['windows'],
    },
    body: graphqlBody,
    responseType: 'text',
    followRedirect: true,
    timeout: { request: 12000 },
    retry: { limit: 0 },
  });

  if (resp.statusCode >= 400) throw new Error('StockX GraphQL ' + resp.statusCode);
  const data = JSON.parse(resp.body);
  if (!data.data || !data.data.browse) throw new Error('No browse data');

  const edges = data.data.browse.results.edges || [];
  return edges.slice(0, limit).map(e => transformStockXNode(e.node)).filter(s => s.name !== 'Unknown');
}

// ============================================================
//   METHOD 5: TheSneakerDatabase API (may be down)
// ============================================================
async function searchSneakerDB(query, limit) {
  const url = 'https://api.thesneakerdatabase.com/v2/sneakers?limit=' + limit + '&name=' + encodeURIComponent(query);
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error('SneakerDB ' + resp.status);

  const data = await resp.json();
  return (data.results || []).map(s => {
    const retail = s.retailPrice || null;
    const estimated = retail ? Math.round(retail * 1.15) : null;
    return {
      id: s.id || '',
      name: s.name || s.title || 'Unknown',
      brand: s.brand || '',
      colorway: s.colorway || '',
      styleID: s.styleId || s.sku || '',
      retail: retail,
      lowestAsk: estimated,
      highestBid: estimated ? Math.round(estimated * 0.9) : null,
      lastSale: estimated,
      spread: estimated && retail ? estimated - retail : null,
      spreadPct: estimated && retail ? Math.round(((estimated - retail) / retail) * 100) : null,
      totalSales: 0, salesLast72h: 0, pricePremium: null,
      thumbnail: (s.media && (s.media.smallImageUrl || s.media.thumbUrl)) || s.thumbnail || '',
      image: (s.media && (s.media.imageUrl || s.media.smallImageUrl)) || s.thumbnail || '',
      url: s.links && s.links.stockX ? s.links.stockX : '',
      releaseDate: s.releaseDate || '',
      category: 'sneakers',
      source: 'sneakerdb-estimated'
    };
  }).filter(s => s.name !== 'Unknown');
}

// ============================================================
//   METHOD 6: Curated Sneaker Database (100+ sneakers, always works)
//   Prices fluctuate daily via deterministic hash
// ============================================================
const CURATED_SNEAKERS = [
  // --- Jordan 1s ---
  { id:'aj1-retro-high-og-chicago', name:'Air Jordan 1 Retro High OG Chicago', brand:'Jordan', colorway:'White/Black-Varsity Red', styleID:'DZ5485-612', retail:180, baseAsk:340, baseSale:325, img:'Air-Jordan-1-Retro-High-OG-Chicago-Reimagined-Product.jpg', date:'2022-10-29', tags:'jordan 1 chicago retro high og red white' },
  { id:'aj1-retro-high-og-bred', name:'Air Jordan 1 Retro High OG Bred', brand:'Jordan', colorway:'Black/Varsity Red-White', styleID:'555088-001', retail:170, baseAsk:290, baseSale:275, img:'Air-Jordan-1-Retro-High-OG-Bred-2016-Product.jpg', date:'2016-09-03', tags:'jordan 1 bred banned red black retro high' },
  { id:'aj1-dark-mocha', name:'Air Jordan 1 Retro High Dark Mocha', brand:'Jordan', colorway:'Sail/Dark Mocha-Black', styleID:'555088-105', retail:170, baseAsk:310, baseSale:295, img:'Air-Jordan-1-Retro-High-Dark-Mocha-Product.jpg', date:'2020-10-31', tags:'jordan 1 dark mocha brown sail' },
  { id:'aj1-university-blue', name:'Air Jordan 1 Retro High OG University Blue', brand:'Jordan', colorway:'White/University Blue-Black', styleID:'555088-134', retail:170, baseAsk:265, baseSale:250, img:'Air-Jordan-1-Retro-High-University-Blue-Product.jpg', date:'2021-03-06', tags:'jordan 1 university blue unc' },
  { id:'aj1-shadow-2018', name:'Air Jordan 1 Retro High OG Shadow', brand:'Jordan', colorway:'Black/Medium Grey-White', styleID:'555088-013', retail:160, baseAsk:305, baseSale:290, img:'Air-Jordan-1-Retro-High-OG-Shadow-Product.jpg', date:'2018-04-14', tags:'jordan 1 shadow grey black' },
  { id:'aj1-lost-and-found', name:'Air Jordan 1 Retro High OG Lost & Found', brand:'Jordan', colorway:'Varsity Red/Black-Sail-Muslin', styleID:'DZ5485-612', retail:180, baseAsk:210, baseSale:200, img:'Air-Jordan-1-Retro-High-OG-Lost-and-Found-Product.jpg', date:'2022-11-19', tags:'jordan 1 lost found chicago red vintage' },
  { id:'aj1-royal-toe', name:'Air Jordan 1 Retro High OG Royal Toe', brand:'Jordan', colorway:'Black/White-Game Royal-Black', styleID:'555088-041', retail:170, baseAsk:230, baseSale:215, img:'Air-Jordan-1-Retro-High-Royal-Toe-Product.jpg', date:'2020-05-09', tags:'jordan 1 royal toe blue black' },
  { id:'aj1-pine-green', name:'Air Jordan 1 Retro High OG Pine Green', brand:'Jordan', colorway:'Pine Green/Black-Sail-White', styleID:'555088-302', retail:160, baseAsk:270, baseSale:255, img:'Air-Jordan-1-Retro-High-Pine-Green-Product.jpg', date:'2018-09-22', tags:'jordan 1 pine green' },
  { id:'aj1-obsidian', name:'Air Jordan 1 Retro High OG Obsidian', brand:'Jordan', colorway:'Sail/Obsidian-University Blue', styleID:'555088-140', retail:160, baseAsk:260, baseSale:245, img:'Air-Jordan-1-Retro-High-OG-Obsidian-University-Blue-Product.jpg', date:'2019-08-31', tags:'jordan 1 obsidian blue sail' },
  { id:'aj1-low-bleached-coral', name:'Air Jordan 1 Low Bleached Coral', brand:'Jordan', colorway:'White/Bleached Coral', styleID:'DC0774-161', retail:100, baseAsk:115, baseSale:108, img:'Air-Jordan-1-Low-Bleached-Coral-Product.jpg', date:'2023-07-20', tags:'jordan 1 low bleached coral pink' },
  { id:'aj1-mid-chicago-toe', name:'Air Jordan 1 Mid Chicago Black Toe', brand:'Jordan', colorway:'Black/Gym Red-White', styleID:'554724-069', retail:125, baseAsk:130, baseSale:122, img:'Air-Jordan-1-Mid-Chicago-Black-Toe-Product.jpg', date:'2020-07-15', tags:'jordan 1 mid chicago black toe' },
  // --- Jordan 3s ---
  { id:'aj3-white-cement-reimagined', name:'Air Jordan 3 Retro White Cement Reimagined', brand:'Jordan', colorway:'Summit White/Fire Red-Black-Cement Grey', styleID:'DN3707-100', retail:200, baseAsk:220, baseSale:210, img:'Air-Jordan-3-Retro-White-Cement-Reimagined-Product.jpg', date:'2023-03-11', tags:'jordan 3 white cement reimagined' },
  { id:'aj3-lucky-green', name:'Air Jordan 3 Retro Lucky Green', brand:'Jordan', colorway:'Lucky Green/White-Cement Grey', styleID:'CK9246-136', retail:200, baseAsk:195, baseSale:185, img:'Air-Jordan-3-Lucky-Green-Product.jpg', date:'2023-05-01', tags:'jordan 3 lucky green pine oregon' },
  { id:'aj3-fear', name:'Air Jordan 3 Retro Fear Pack', brand:'Jordan', colorway:'Night Stadium/Total Orange-Black', styleID:'626967-040', retail:175, baseAsk:310, baseSale:295, img:'Air-Jordan-3-Fear-Pack-Product.jpg', date:'2013-08-17', tags:'jordan 3 fear pack grey orange' },
  // --- Jordan 4s ---
  { id:'aj4-retro-bred-2019', name:'Air Jordan 4 Retro Bred 2019', brand:'Jordan', colorway:'Black/Cement Grey-Summit White-Fire Red', styleID:'308497-060', retail:200, baseAsk:370, baseSale:355, img:'Air-Jordan-4-Retro-Bred-2019-Product.jpg', date:'2019-05-04', tags:'jordan 4 bred cement fire red black' },
  { id:'aj4-white-oreo', name:'Air Jordan 4 Retro White Oreo', brand:'Jordan', colorway:'White/Tech Grey-Black-Fire Red', styleID:'CT8527-100', retail:190, baseAsk:260, baseSale:245, img:'Air-Jordan-4-Retro-White-Oreo-2021-Product.jpg', date:'2021-07-03', tags:'jordan 4 white oreo grey tech' },
  { id:'aj4-military-black', name:'Air Jordan 4 Retro Military Black', brand:'Jordan', colorway:'White/Black-Neutral Grey', styleID:'DH6927-111', retail:190, baseAsk:230, baseSale:220, img:'Air-Jordan-4-Retro-Military-Black-Product.jpg', date:'2022-05-21', tags:'jordan 4 military black grey white' },
  { id:'aj4-bred-reimagined', name:'Air Jordan 4 Retro Bred Reimagined', brand:'Jordan', colorway:'Fire Red/Cement Grey-Summit White-Black', styleID:'FV5029-006', retail:210, baseAsk:260, baseSale:248, img:'Air-Jordan-4-Retro-Bred-Reimagined-Product.jpg', date:'2024-02-17', tags:'jordan 4 bred reimagined red cement' },
  { id:'aj4-thunder', name:'Air Jordan 4 Retro Thunder 2023', brand:'Jordan', colorway:'Black/Tour Yellow', styleID:'DH6927-017', retail:210, baseAsk:235, baseSale:225, img:'Air-Jordan-4-Retro-Thunder-Product.jpg', date:'2023-05-13', tags:'jordan 4 thunder black yellow' },
  { id:'aj4-canyon-purple', name:'Air Jordan 4 Retro Canyon Purple', brand:'Jordan', colorway:'Canyon Purple/Anthracite-Alligator-Safety Orange', styleID:'AQ9129-500', retail:190, baseAsk:200, baseSale:188, img:'Air-Jordan-4-Retro-Canyon-Purple-Product.jpg', date:'2022-10-15', tags:'jordan 4 canyon purple' },
  { id:'aj4-sb-pine-green', name:'Nike SB x Air Jordan 4 Pine Green', brand:'Jordan', colorway:'Pine Green/Neutral Grey-White', styleID:'DR5415-103', retail:225, baseAsk:380, baseSale:360, img:'Air-Jordan-4-SB-Pine-Green-Product.jpg', date:'2023-03-20', tags:'jordan 4 sb pine green dunk nike' },
  // --- Jordan 5s ---
  { id:'aj5-fire-red-2020', name:'Air Jordan 5 Retro Fire Red 2020', brand:'Jordan', colorway:'True White/Fire Red-Black', styleID:'DA1911-102', retail:200, baseAsk:215, baseSale:205, img:'Air-Jordan-5-Retro-Fire-Red-Silver-Tongue-Product.jpg', date:'2020-04-25', tags:'jordan 5 fire red silver tongue white' },
  { id:'aj5-burgundy', name:'Air Jordan 5 Retro Burgundy', brand:'Jordan', colorway:'Sail/Burgundy Crush-Light Graphite', styleID:'DZ4131-106', retail:200, baseAsk:185, baseSale:175, img:'Air-Jordan-5-Retro-Burgundy-Product.jpg', date:'2023-09-09', tags:'jordan 5 burgundy sail' },
  // --- Jordan 6s ---
  { id:'aj6-unc', name:'Air Jordan 6 Retro UNC', brand:'Jordan', colorway:'White/University Blue-White', styleID:'384664-006', retail:200, baseAsk:225, baseSale:212, img:'Air-Jordan-6-Retro-UNC-Product.jpg', date:'2022-03-05', tags:'jordan 6 unc university blue white' },
  // --- Jordan 11s ---
  { id:'aj11-bred-2019', name:'Air Jordan 11 Retro Bred 2019', brand:'Jordan', colorway:'Black/White-Varsity Red', styleID:'378037-061', retail:220, baseAsk:310, baseSale:295, img:'Air-Jordan-11-Retro-Bred-2019-Product.jpg', date:'2019-12-14', tags:'jordan 11 bred playoff black red' },
  { id:'aj11-cool-grey-2021', name:'Air Jordan 11 Retro Cool Grey 2021', brand:'Jordan', colorway:'Medium Grey/White-Cool Grey', styleID:'CT8012-005', retail:225, baseAsk:260, baseSale:248, img:'Air-Jordan-11-Retro-Cool-Grey-2021-Product.jpg', date:'2021-12-11', tags:'jordan 11 cool grey' },
  { id:'aj11-cherry', name:'Air Jordan 11 Retro Cherry', brand:'Jordan', colorway:'White/Varsity Red-Black', styleID:'CT8012-116', retail:225, baseAsk:230, baseSale:218, img:'Air-Jordan-11-Retro-Cherry-Product.jpg', date:'2022-12-10', tags:'jordan 11 cherry varsity red white' },
  { id:'aj11-gratitude', name:'Air Jordan 11 Retro Gratitude', brand:'Jordan', colorway:'White/Black-Metallic Gold', styleID:'CT8012-170', retail:225, baseAsk:250, baseSale:238, img:'Air-Jordan-11-Retro-Gratitude-Product.jpg', date:'2023-12-09', tags:'jordan 11 gratitude dmp gold white black' },
  // --- Jordan 12s/13s ---
  { id:'aj12-playoffs-2022', name:'Air Jordan 12 Retro Playoffs 2022', brand:'Jordan', colorway:'Black/Varsity Red-White', styleID:'CT8013-006', retail:200, baseAsk:215, baseSale:205, img:'Air-Jordan-12-Retro-Playoffs-Product.jpg', date:'2022-03-12', tags:'jordan 12 playoffs black red' },
  { id:'aj13-bred-2017', name:'Air Jordan 13 Retro Bred', brand:'Jordan', colorway:'Black/True Red-White', styleID:'414571-004', retail:190, baseAsk:265, baseSale:250, img:'Air-Jordan-13-Retro-Bred-Product.jpg', date:'2017-02-18', tags:'jordan 13 bred black red white' },
  // --- Yeezy 350s ---
  { id:'yeezy-350-v2-beluga-rf', name:'adidas Yeezy Boost 350 V2 Beluga Reflective', brand:'adidas', colorway:'Beluga Reflective', styleID:'GW1229', retail:230, baseAsk:295, baseSale:280, img:'adidas-Yeezy-Boost-350-V2-Beluga-Reflective-Product.jpg', date:'2021-12-18', tags:'yeezy 350 v2 beluga reflective adidas' },
  { id:'yeezy-350-v2-zebra', name:'adidas Yeezy Boost 350 V2 Zebra', brand:'adidas', colorway:'White/Core Black/Red', styleID:'CP9654', retail:220, baseAsk:270, baseSale:255, img:'adidas-Yeezy-Boost-350-V2-Zebra-Product.jpg', date:'2017-02-25', tags:'yeezy 350 v2 zebra black white red adidas' },
  { id:'yeezy-350-v2-bred', name:'adidas Yeezy Boost 350 V2 Bred', brand:'adidas', colorway:'Core Black/Core Black/Red', styleID:'CP9652', retail:220, baseAsk:365, baseSale:350, img:'adidas-Yeezy-Boost-350-V2-Core-Black-Red-Product.jpg', date:'2017-02-11', tags:'yeezy 350 v2 bred pirate black red adidas' },
  { id:'yeezy-350-v2-cream', name:'adidas Yeezy Boost 350 V2 Cream', brand:'adidas', colorway:'Cream White/Cream White', styleID:'CP9366', retail:220, baseAsk:240, baseSale:228, img:'adidas-Yeezy-Boost-350-V2-Cream-Product.jpg', date:'2017-04-29', tags:'yeezy 350 v2 cream triple white adidas' },
  { id:'yeezy-350-v2-static-rf', name:'adidas Yeezy Boost 350 V2 Static Reflective', brand:'adidas', colorway:'Static/Static/Static', styleID:'EF2367', retail:220, baseAsk:390, baseSale:375, img:'adidas-Yeezy-Boost-350-V2-Static-Reflective-Product.jpg', date:'2018-12-26', tags:'yeezy 350 v2 static reflective silver adidas' },
  { id:'yeezy-350-v2-black-rf', name:'adidas Yeezy Boost 350 V2 Black Reflective', brand:'adidas', colorway:'Black Reflective', styleID:'FU9007', retail:220, baseAsk:420, baseSale:400, img:'adidas-Yeezy-Boost-350-V2-Black-Reflective-Product.jpg', date:'2019-06-07', tags:'yeezy 350 v2 black reflective adidas' },
  { id:'yeezy-350-v2-onyx', name:'adidas Yeezy Boost 350 V2 Onyx', brand:'adidas', colorway:'Onyx/Onyx/Onyx', styleID:'HQ4540', retail:230, baseAsk:235, baseSale:225, img:'adidas-Yeezy-Boost-350-V2-Onyx-Product.jpg', date:'2022-04-09', tags:'yeezy 350 v2 onyx black triple adidas' },
  { id:'yeezy-350-v2-bone', name:'adidas Yeezy Boost 350 V2 Bone', brand:'adidas', colorway:'Bone/Bone/Bone', styleID:'HQ6316', retail:230, baseAsk:220, baseSale:210, img:'adidas-Yeezy-Boost-350-V2-Bone-Product.jpg', date:'2022-03-21', tags:'yeezy 350 v2 bone off white adidas' },
  // --- Yeezy Slides & Foams ---
  { id:'yeezy-slide-onyx', name:'adidas Yeezy Slide Onyx', brand:'adidas', colorway:'Onyx', styleID:'HQ6448', retail:70, baseAsk:110, baseSale:105, img:'adidas-Yeezy-Slide-Onyx-Product.jpg', date:'2022-03-14', tags:'yeezy slide onyx black adidas' },
  { id:'yeezy-slide-bone', name:'adidas Yeezy Slide Bone', brand:'adidas', colorway:'Bone', styleID:'FW6345', retail:70, baseAsk:120, baseSale:112, img:'adidas-Yeezy-Slide-Bone-Product.jpg', date:'2021-09-06', tags:'yeezy slide bone white adidas' },
  { id:'yeezy-slide-granite', name:'adidas Yeezy Slide Granite', brand:'adidas', colorway:'Granite/Granite/Granite', styleID:'ID4132', retail:70, baseAsk:90, baseSale:85, img:'adidas-Yeezy-Slide-Granite-Product.jpg', date:'2023-07-03', tags:'yeezy slide granite grey adidas' },
  { id:'yeezy-foam-rnnr-onyx', name:'adidas Yeezy Foam RNNR Onyx', brand:'adidas', colorway:'Onyx', styleID:'HP4739', retail:90, baseAsk:105, baseSale:98, img:'adidas-Yeezy-Foam-RNNR-Onyx-Product.jpg', date:'2022-06-04', tags:'yeezy foam runner rnnr onyx black adidas' },
  { id:'yeezy-foam-rnnr-sand', name:'adidas Yeezy Foam RNNR Sand', brand:'adidas', colorway:'Sand', styleID:'FY4567', retail:80, baseAsk:130, baseSale:120, img:'adidas-Yeezy-Foam-RNNR-Sand-Product.jpg', date:'2021-03-26', tags:'yeezy foam runner rnnr sand tan beige adidas' },
  // --- Yeezy 500/700 ---
  { id:'yeezy-700-wave-runner', name:'adidas Yeezy Boost 700 Wave Runner', brand:'adidas', colorway:'Solid Grey/Chalk White/Core Black', styleID:'B75571', retail:300, baseAsk:340, baseSale:325, img:'adidas-Yeezy-Boost-700-Wave-Runner-Product.jpg', date:'2017-11-01', tags:'yeezy 700 wave runner grey orange teal adidas' },
  { id:'yeezy-500-utility-black', name:'adidas Yeezy 500 Utility Black', brand:'adidas', colorway:'Utility Black', styleID:'F36640', retail:200, baseAsk:250, baseSale:238, img:'adidas-Yeezy-500-Utility-Black-Product.jpg', date:'2018-07-07', tags:'yeezy 500 utility black adidas' },
  // --- Nike Dunks ---
  { id:'dunk-low-panda', name:'Nike Dunk Low Retro White Black Panda', brand:'Nike', colorway:'White/Black-White', styleID:'DD1391-100', retail:110, baseAsk:98, baseSale:95, img:'Nike-Dunk-Low-Retro-White-Black-2021-Product.jpg', date:'2021-03-10', tags:'nike dunk low panda black white retro' },
  { id:'dunk-low-grey-fog', name:'Nike Dunk Low Grey Fog', brand:'Nike', colorway:'White/Grey Fog', styleID:'DD1391-103', retail:100, baseAsk:115, baseSale:110, img:'Nike-Dunk-Low-Grey-Fog-Product.jpg', date:'2021-10-13', tags:'nike dunk low grey fog' },
  { id:'dunk-low-unc', name:'Nike Dunk Low UNC', brand:'Nike', colorway:'White/University Blue', styleID:'DD1391-102', retail:100, baseAsk:145, baseSale:135, img:'Nike-Dunk-Low-University-Blue-Product.jpg', date:'2021-06-24', tags:'nike dunk low unc university blue' },
  { id:'dunk-low-green-glow', name:'Nike Dunk Low Green Glow', brand:'Nike', colorway:'White/Green Glow', styleID:'DD1503-105', retail:100, baseAsk:120, baseSale:115, img:'Nike-Dunk-Low-Green-Glow-Product.jpg', date:'2022-02-11', tags:'nike dunk low green glow' },
  { id:'dunk-low-vintage-green', name:'Nike Dunk Low Vintage Green', brand:'Nike', colorway:'Sail/Vintage Green-Coconut Milk', styleID:'DQ8580-100', retail:110, baseAsk:130, baseSale:122, img:'Nike-Dunk-Low-Vintage-Green-Product.jpg', date:'2022-06-01', tags:'nike dunk low vintage green sail' },
  { id:'dunk-low-rose-whisper', name:'Nike Dunk Low Rose Whisper', brand:'Nike', colorway:'White/Rose Whisper', styleID:'DD1503-118', retail:100, baseAsk:108, baseSale:102, img:'Nike-Dunk-Low-Rose-Whisper-Product.jpg', date:'2022-04-07', tags:'nike dunk low rose whisper pink' },
  { id:'dunk-low-argon', name:'Nike Dunk Low Argon', brand:'Nike', colorway:'White/Argon Blue', styleID:'DM0121-400', retail:110, baseAsk:115, baseSale:108, img:'Nike-Dunk-Low-Argon-Product.jpg', date:'2022-09-01', tags:'nike dunk low argon blue' },
  { id:'dunk-low-coconut-milk', name:'Nike Dunk Low Coconut Milk', brand:'Nike', colorway:'Sail/Coconut Milk', styleID:'DD1503-121', retail:110, baseAsk:120, baseSale:115, img:'Nike-Dunk-Low-Coconut-Milk-Product.jpg', date:'2022-10-01', tags:'nike dunk low coconut milk sail cream' },
  { id:'dunk-low-court-purple', name:'Nike Dunk Low Court Purple', brand:'Nike', colorway:'White/Court Purple', styleID:'DD1391-104', retail:100, baseAsk:135, baseSale:128, img:'Nike-Dunk-Low-Court-Purple-Product.jpg', date:'2021-01-07', tags:'nike dunk low court purple' },
  { id:'dunk-low-medium-curry', name:'Nike Dunk Low Medium Curry', brand:'Nike', colorway:'Sail/Medium Curry-Fossil', styleID:'DD1390-100', retail:100, baseAsk:155, baseSale:145, img:'Nike-Dunk-Low-Medium-Curry-Product.jpg', date:'2021-02-11', tags:'nike dunk low medium curry sail brown' },
  // --- Nike SB Dunks ---
  { id:'nike-sb-dunk-low-ben-jerry', name:"Nike SB Dunk Low Ben & Jerry's Chunky Dunky", brand:'Nike', colorway:'White/Lagoon Pulse-Black-University Gold', styleID:'CU3244-100', retail:100, baseAsk:1800, baseSale:1750, img:'Nike-SB-Dunk-Low-Ben-Jerrys-Chunky-Dunky-Product.jpg', date:'2020-05-26', tags:'nike sb dunk low ben jerry chunky dunky cow' },
  { id:'nike-sb-dunk-low-strangelove', name:'Nike SB Dunk Low StrangeLove Skateboards', brand:'Nike', colorway:'Bright Melon/Gym Red-Med Soft Pink', styleID:'CT2552-800', retail:100, baseAsk:2200, baseSale:2100, img:'Nike-SB-Dunk-Low-StrangeLove-Skateboards-Product.jpg', date:'2020-02-08', tags:'nike sb dunk low strangelove pink heart valentine' },
  { id:'nike-sb-dunk-low-paris', name:'Nike SB Dunk Low Pro Paris', brand:'Nike', colorway:'Mushroom/Baroque Brown/Medium Olive', styleID:'BQ6817-200', retail:100, baseAsk:3500, baseSale:3300, img:'Nike-SB-Dunk-Low-Pro-Paris-Product.jpg', date:'2020-02-22', tags:'nike sb dunk low paris brown olive' },
  // --- Travis Scott ---
  { id:'travis-scott-aj1-low-mocha', name:'Travis Scott x Air Jordan 1 Low OG Mocha', brand:'Jordan', colorway:'Sail/University Red-Black-Dark Mocha', styleID:'CQ4277-001', retail:150, baseAsk:1250, baseSale:1200, img:'Air-Jordan-1-Retro-Low-OG-SP-Travis-Scott-Product.jpg', date:'2019-07-20', tags:'travis scott jordan 1 low mocha reverse sail cactus jack' },
  { id:'travis-scott-aj1-high-mocha', name:'Travis Scott x Air Jordan 1 Retro High OG Mocha', brand:'Jordan', colorway:'Sail/Dark Mocha-University Red-Black', styleID:'CD4487-100', retail:175, baseAsk:1650, baseSale:1580, img:'Air-Jordan-1-High-OG-TS-SP-Travis-Scott-Product.jpg', date:'2019-05-11', tags:'travis scott jordan 1 high mocha sail cactus jack' },
  { id:'aj1-low-travis-scott-reverse-mocha', name:'Travis Scott x Air Jordan 1 Low OG Reverse Mocha', brand:'Jordan', colorway:'Sail/University Red-Ridgerock', styleID:'DM7866-162', retail:150, baseAsk:950, baseSale:920, img:'Air-Jordan-1-Low-OG-SP-Travis-Scott-Reverse-Mocha-Product.jpg', date:'2022-07-21', tags:'travis scott jordan 1 low reverse mocha ridgerock' },
  { id:'travis-scott-aj4-cactus', name:'Travis Scott x Air Jordan 4 Retro Cactus Jack', brand:'Jordan', colorway:'University Blue/Varsity Red-Black', styleID:'308497-406', retail:225, baseAsk:1100, baseSale:1050, img:'Air-Jordan-4-Retro-Travis-Scott-Cactus-Jack-Product.jpg', date:'2019-06-15', tags:'travis scott jordan 4 cactus jack blue oilers houston' },
  { id:'travis-scott-af1-sail', name:'Travis Scott x Nike Air Force 1 Low Sail', brand:'Nike', colorway:'Sail/Sail-Gum Light Brown', styleID:'AQ4211-101', retail:150, baseAsk:650, baseSale:620, img:'Travis-Scott-x-Nike-Air-Force-1-Low-Sail-Product.jpg', date:'2018-08-10', tags:'travis scott nike air force 1 low sail cactus jack' },
  { id:'travis-scott-fragment-aj1', name:'Travis Scott x Fragment x Air Jordan 1 High', brand:'Jordan', colorway:'Sail/Black-Military Blue', styleID:'DH3227-105', retail:200, baseAsk:1700, baseSale:1620, img:'fragment-design-x-Travis-Scott-x-Air-Jordan-1-Retro-High-Product.jpg', date:'2021-07-29', tags:'travis scott fragment jordan 1 high blue sail military' },
  // --- Nike Air Force 1 ---
  { id:'nike-air-force-1-low-white', name:"Nike Air Force 1 Low '07 White", brand:'Nike', colorway:'White/White', styleID:'315122-111', retail:110, baseAsk:105, baseSale:100, img:'Nike-Air-Force-1-Low-White-07-Product.jpg', date:'2007-01-01', tags:'nike air force 1 low white triple af1' },
  { id:'nike-af1-stussy-fossil', name:'Nike Air Force 1 Low Stussy Fossil', brand:'Nike', colorway:'Fossil Stone/Sail', styleID:'CZ9084-200', retail:130, baseAsk:250, baseSale:235, img:'Nike-Air-Force-1-Low-Stussy-Fossil-Product.jpg', date:'2020-12-12', tags:'nike air force 1 stussy fossil stone sail' },
  // --- Nike Air Max ---
  { id:'nike-am1-patta-monarch', name:'Nike Air Max 1 Patta Monarch', brand:'Nike', colorway:'Monarch/Noise Aqua-Metallic Silver', styleID:'DH1348-001', retail:160, baseAsk:280, baseSale:265, img:'Nike-Air-Max-1-Patta-Monarch-Product.jpg', date:'2021-10-15', tags:'nike air max 1 patta monarch orange aqua' },
  { id:'nike-am90-off-white-desert', name:'Nike Air Max 90 Off-White Desert Ore', brand:'Nike', colorway:'Desert Ore/Hyper Jade-Bright Mango', styleID:'AA7293-200', retail:160, baseAsk:485, baseSale:465, img:'Nike-Air-Max-90-Off-White-Desert-Ore-Product.jpg', date:'2019-01-17', tags:'nike air max 90 off white desert ore virgil' },
  { id:'nike-am97-silver-bullet', name:'Nike Air Max 97 Silver Bullet 2022', brand:'Nike', colorway:'Metallic Silver/Varsity Red', styleID:'DM0028-002', retail:175, baseAsk:185, baseSale:178, img:'Nike-Air-Max-97-Silver-Bullet-2022-Product.jpg', date:'2022-04-15', tags:'nike air max 97 silver bullet metallic' },
  // --- New Balance ---
  { id:'nb-550-white-green', name:'New Balance 550 White Green', brand:'New Balance', colorway:'White/Green', styleID:'BB550WT1', retail:110, baseAsk:105, baseSale:100, img:'New-Balance-550-White-Green-Product.jpg', date:'2021-03-18', tags:'new balance 550 white green' },
  { id:'nb-2002r-protection-pack-rain-cloud', name:'New Balance 2002R Protection Pack Rain Cloud', brand:'New Balance', colorway:'Rain Cloud', styleID:'M2002RDA', retail:130, baseAsk:175, baseSale:165, img:'New-Balance-2002R-Protection-Pack-Rain-Cloud-Product.jpg', date:'2022-04-08', tags:'new balance 2002r protection pack rain cloud grey' },
  { id:'nb-9060-grey-day', name:'New Balance 9060 Grey Day', brand:'New Balance', colorway:'Grey/Silver', styleID:'U9060GRY', retail:150, baseAsk:170, baseSale:162, img:'New-Balance-9060-Grey-Day-Product.jpg', date:'2023-11-01', tags:'new balance 9060 grey day silver' },
  { id:'nb-550-white-burgundy', name:'New Balance 550 White Burgundy', brand:'New Balance', colorway:'White/Burgundy', styleID:'BB550LI1', retail:110, baseAsk:112, baseSale:105, img:'New-Balance-550-White-Burgundy-Product.jpg', date:'2022-07-01', tags:'new balance 550 white burgundy red' },
  { id:'nb-550-aime-leon-dore-green', name:'New Balance 550 Aime Leon Dore Green', brand:'New Balance', colorway:'White/Green', styleID:'BB550ALD', retail:130, baseAsk:350, baseSale:330, img:'New-Balance-550-Aime-Leon-Dore-Green-Product.jpg', date:'2020-10-02', tags:'new balance 550 aime leon dore ald green' },
  { id:'nb-2002r-jfg-peace-be-journey', name:'New Balance 2002R Joe Freshgoods', brand:'New Balance', colorway:'Pink/Purple', styleID:'M2002RJA', retail:150, baseAsk:420, baseSale:400, img:'New-Balance-2002R-Joe-Freshgoods-Product.jpg', date:'2022-09-23', tags:'new balance 2002r joe freshgoods peace be journey pink purple' },
  { id:'nb-990v3-grey', name:'New Balance 990v3 Grey', brand:'New Balance', colorway:'Grey/White', styleID:'M990GY3', retail:185, baseAsk:195, baseSale:188, img:'New-Balance-990v3-Grey-Product.jpg', date:'2012-01-01', tags:'new balance 990 v3 grey classic' },
  { id:'nb-1906r-protection-pack-silver', name:'New Balance 1906R Protection Pack Silver Metallic', brand:'New Balance', colorway:'Silver Metallic/Blue Haze', styleID:'M1906REG', retail:150, baseAsk:165, baseSale:155, img:'New-Balance-1906R-Protection-Pack-Silver-Product.jpg', date:'2023-05-01', tags:'new balance 1906r protection pack silver metallic' },
  // --- ASICS ---
  { id:'asics-gel-kayano-14-silver', name:'ASICS Gel-Kayano 14 Silver', brand:'ASICS', colorway:'White/Pure Silver', styleID:'1201A019-105', retail:140, baseAsk:155, baseSale:148, img:'ASICS-Gel-Kayano-14-Silver-Product.jpg', date:'2023-08-10', tags:'asics gel kayano 14 silver white' },
  { id:'asics-gel-1130-cream', name:'ASICS Gel-1130 Cream', brand:'ASICS', colorway:'Cream/Cream', styleID:'1201A844-100', retail:110, baseAsk:125, baseSale:118, img:'ASICS-Gel-1130-Cream-Product.jpg', date:'2023-06-01', tags:'asics gel 1130 cream off white' },
  { id:'asics-gt-2160-oyster-grey', name:'ASICS GT-2160 Oyster Grey', brand:'ASICS', colorway:'Oyster Grey/Carbon', styleID:'1203A320-020', retail:120, baseAsk:135, baseSale:128, img:'ASICS-GT-2160-Oyster-Grey-Product.jpg', date:'2024-01-15', tags:'asics gt 2160 oyster grey silver' },
  // --- Off-White ---
  { id:'off-white-aj1-chicago', name:'Off-White x Air Jordan 1 Retro High OG Chicago', brand:'Jordan', colorway:'White/Black-Varsity Red', styleID:'AA3834-101', retail:190, baseAsk:5500, baseSale:5200, img:'Off-White-x-Air-Jordan-1-Chicago-Product.jpg', date:'2017-09-01', tags:'off white jordan 1 chicago red virgil abloh the ten' },
  { id:'off-white-aj1-unc', name:'Off-White x Air Jordan 1 Retro High OG UNC', brand:'Jordan', colorway:'White/Dark Powder Blue-Cone', styleID:'AQ0818-148', retail:190, baseAsk:3800, baseSale:3600, img:'Off-White-x-Air-Jordan-1-UNC-Product.jpg', date:'2018-06-23', tags:'off white jordan 1 unc blue virgil abloh' },
  { id:'off-white-presto-white', name:'Off-White x Nike Air Presto White', brand:'Nike', colorway:'White/Black', styleID:'AA3830-100', retail:160, baseAsk:950, baseSale:900, img:'Off-White-x-Nike-Air-Presto-White-Product.jpg', date:'2018-07-20', tags:'off white nike air presto white virgil abloh the ten' },
  { id:'off-white-dunk-low-lot-1', name:'Off-White x Nike Dunk Low Lot 1', brand:'Nike', colorway:'White/Metallic Silver', styleID:'DM1602-127', retail:180, baseAsk:680, baseSale:650, img:'Off-White-x-Nike-Dunk-Low-Lot-1-Product.jpg', date:'2021-08-09', tags:'off white nike dunk low lot 1 dear summer virgil' },
  // --- adidas (non-Yeezy) ---
  { id:'adidas-samba-og-white', name:'adidas Samba OG Cloud White', brand:'adidas', colorway:'Cloud White/Core Black/Gum', styleID:'B75806', retail:100, baseAsk:108, baseSale:102, img:'adidas-Samba-OG-White-Product.jpg', date:'2018-01-01', tags:'adidas samba og white gum classic' },
  { id:'adidas-samba-og-black', name:'adidas Samba OG Core Black', brand:'adidas', colorway:'Core Black/Cloud White/Gum', styleID:'B75807', retail:100, baseAsk:115, baseSale:108, img:'adidas-Samba-OG-Black-Product.jpg', date:'2018-01-01', tags:'adidas samba og black gum classic' },
  { id:'adidas-gazelle-indoor-blue', name:'adidas Gazelle Indoor Blue Fusion Gum', brand:'adidas', colorway:'Blue Fusion/Ftwr White/Gum', styleID:'IF1808', retail:110, baseAsk:125, baseSale:118, img:'adidas-Gazelle-Indoor-Blue-Fusion-Product.jpg', date:'2023-09-01', tags:'adidas gazelle indoor blue fusion gum terrace' },
  { id:'adidas-campus-00s-black', name:'adidas Campus 00s Core Black', brand:'adidas', colorway:'Core Black/Ftwr White', styleID:'HQ8708', retail:100, baseAsk:95, baseSale:90, img:'adidas-Campus-00s-Black-Product.jpg', date:'2022-10-01', tags:'adidas campus 00s black white classic' },
  // --- Salomon / Outdoor Runners ---
  { id:'salomon-xt-6-black', name:'Salomon XT-6 Advanced Black', brand:'Salomon', colorway:'Black/Black/Phantom', styleID:'L41086600', retail:180, baseAsk:195, baseSale:185, img:'Salomon-XT-6-Advanced-Black-Product.jpg', date:'2022-01-01', tags:'salomon xt-6 xt6 advanced black trail gorpcore' },
  { id:'salomon-xt-6-vanilla-ice', name:'Salomon XT-6 Vanilla Ice', brand:'Salomon', colorway:'Vanilla Ice/Almond Milk/Green Ash', styleID:'L41740700', retail:180, baseAsk:210, baseSale:200, img:'Salomon-XT-6-Vanilla-Ice-Product.jpg', date:'2023-03-01', tags:'salomon xt-6 xt6 vanilla ice cream gorpcore' },
  // --- On Running ---
  { id:'on-cloud-5-all-white', name:'On Cloud 5 All White', brand:'On', colorway:'All White', styleID:'59.98374', retail:140, baseAsk:130, baseSale:125, img:'On-Cloud-5-All-White-Product.jpg', date:'2023-01-01', tags:'on running cloud 5 white roger federer swiss' },
  // --- Converse ---
  { id:'converse-cdg-high-black', name:'Converse Chuck Taylor All Star 70 Hi CDG PLAY Black', brand:'Converse', colorway:'Black/White', styleID:'150204C', retail:150, baseAsk:170, baseSale:160, img:'Converse-Chuck-Taylor-All-Star-70s-Hi-Comme-des-Garcons-PLAY-Black-Product.jpg', date:'2015-07-01', tags:'converse cdg comme des garcons play chuck taylor high black heart' },
  { id:'converse-fear-of-god-black', name:'Converse Chuck 70 Fear of God Essentials Black', brand:'Converse', colorway:'Black/Egret/Black', styleID:'167954C', retail:110, baseAsk:245, baseSale:230, img:'Converse-Chuck-70-Fear-of-God-Essentials-Black-Product.jpg', date:'2020-10-16', tags:'converse fear of god essentials fog chuck 70 black jerry lorenzo' },
  // --- Nike Blazer / Others ---
  { id:'nike-blazer-mid-77-white-black', name:'Nike Blazer Mid 77 Vintage White Black', brand:'Nike', colorway:'White/Black', styleID:'BQ6806-100', retail:100, baseAsk:85, baseSale:80, img:'Nike-Blazer-Mid-77-Vintage-White-Black-Product.jpg', date:'2019-01-01', tags:'nike blazer mid 77 vintage white black' },
  { id:'nike-vapormax-plus-black', name:'Nike Air VaporMax Plus Triple Black', brand:'Nike', colorway:'Black/Dark Grey', styleID:'924453-004', retail:200, baseAsk:195, baseSale:188, img:'Nike-Air-VaporMax-Plus-Triple-Black-Product.jpg', date:'2018-01-25', tags:'nike vapormax plus triple black dark grey' },
  { id:'nike-sacai-ldwaffle-pine-green', name:'Nike LD Waffle sacai Pine Green', brand:'Nike', colorway:'Pine Green/Clay Orange-Del Sol-Sail', styleID:'BV0073-300', retail:160, baseAsk:450, baseSale:430, img:'Nike-LD-Waffle-sacai-Pine-Green-Product.jpg', date:'2019-09-12', tags:'nike sacai ld waffle pine green orange collab' },
  // --- Nike Vomero 5 ---
  { id:'nike-vomero-5-oatmeal', name:'Nike Zoom Vomero 5 Oatmeal', brand:'Nike', colorway:'Oatmeal/Pale Ivory-Sail-Light Chocolate', styleID:'HF1553-200', retail:160, baseAsk:175, baseSale:168, img:'Nike-Vomero-5-Oatmeal-Product.jpg', date:'2024-03-01', tags:'nike zoom vomero 5 oatmeal pale ivory sail' },
  { id:'nike-vomero-5-photon-dust', name:'Nike Zoom Vomero 5 Photon Dust', brand:'Nike', colorway:'Photon Dust/Metallic Silver-Light Bone', styleID:'FD0791-001', retail:160, baseAsk:148, baseSale:140, img:'Nike-Vomero-5-Photon-Dust-Product.jpg', date:'2024-01-15', tags:'nike zoom vomero 5 photon dust silver grey' },
  // --- Fear of God ---
  { id:'fear-of-god-athletics-1-carbon', name:'Fear of God Athletics 1 Carbon', brand:'adidas', colorway:'Carbon/Carbon/Carbon', styleID:'IG8650', retail:250, baseAsk:185, baseSale:175, img:'Fear-of-God-Athletics-1-Carbon-Product.jpg', date:'2023-12-01', tags:'fear of god fog athletics 1 adidas carbon jerry lorenzo' },
  // --- Puma ---
  { id:'puma-lamelo-ball-mb01-queen-city', name:'Puma LaMelo Ball MB.01 Queen City', brand:'Puma', colorway:'Purple/Blue Atoll', styleID:'377237-06', retail:125, baseAsk:165, baseSale:155, img:'Puma-Lamelo-Ball-MB01-Queen-City-Product.jpg', date:'2022-02-18', tags:'puma lamelo ball mb01 queen city purple blue charlotte' },
  // --- Crocs ---
  { id:'crocs-classic-clog-lightning-mcqueen', name:'Crocs Classic Clog Lightning McQueen', brand:'Crocs', colorway:'Red/Black', styleID:'209747-90H', retail:60, baseAsk:110, baseSale:100, img:'Crocs-Classic-Clog-Lightning-McQueen-Product.jpg', date:'2023-06-15', tags:'crocs classic clog lightning mcqueen cars disney red' },
  // --- Birkenstock ---
  { id:'birkenstock-boston-taupe-suede', name:'Birkenstock Boston Soft Footbed Taupe Suede', brand:'Birkenstock', colorway:'Taupe', styleID:'560771', retail:160, baseAsk:200, baseSale:190, img:'Birkenstock-Boston-Taupe-Suede-Product.jpg', date:'2019-01-01', tags:'birkenstock boston taupe suede clog soft footbed' },
  // --- UGG ---
  { id:'ugg-tasman-chestnut', name:'UGG Tasman Slipper Chestnut', brand:'UGG', colorway:'Chestnut', styleID:'5950', retail:120, baseAsk:150, baseSale:140, img:'UGG-Tasman-Chestnut-Product.jpg', date:'2020-01-01', tags:'ugg tasman slipper chestnut brown' },
  // --- Nike Kobe ---
  { id:'nike-kobe-6-grinch', name:'Nike Kobe 6 Protro Grinch', brand:'Nike', colorway:'Green Apple/Volt-Crimson-Black', styleID:'CW2190-300', retail:180, baseAsk:430, baseSale:410, img:'Nike-Kobe-6-Protro-Grinch-Product.jpg', date:'2020-12-24', tags:'nike kobe 6 protro grinch green mamba christmas' },
  { id:'nike-kobe-4-draft-day', name:'Nike Kobe 4 Protro Draft Day', brand:'Nike', colorway:'Varsity Purple/White-Varsity Maize', styleID:'AV6339-500', retail:175, baseAsk:360, baseSale:340, img:'Nike-Kobe-4-Protro-Draft-Day-Product.jpg', date:'2019-08-23', tags:'nike kobe 4 protro draft day purple lakers' },
  // --- Nike LeBron ---
  { id:'nike-lebron-20-violet-frost', name:'Nike LeBron 20 Violet Frost', brand:'Nike', colorway:'Violet Frost/White', styleID:'DJ5423-500', retail:200, baseAsk:145, baseSale:138, img:'Nike-LeBron-20-Violet-Frost-Product.jpg', date:'2022-10-21', tags:'nike lebron 20 violet frost purple' },
];

function searchCurated(query, limit) {
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter(w => w.length > 1);

  const scored = CURATED_SNEAKERS.map(s => {
    const text = (s.name + ' ' + s.brand + ' ' + s.colorway + ' ' + s.styleID + ' ' + (s.tags || '')).toLowerCase();
    let score = 0;
    if (text.includes(q)) score += 10;
    for (const w of words) {
      if (text.includes(w)) score += 3;
    }
    if (s.brand.toLowerCase().includes(q)) score += 5;
    if (s.tags && s.tags.includes(q)) score += 5;
    return { ...s, _score: score };
  }).filter(s => s._score > 0);

  scored.sort((a, b) => b._score - a._score);

  return scored.slice(0, limit).map(s => {
    const ask = priceFluctuate(s.baseAsk, s.id);
    const sale = priceFluctuate(s.baseSale, s.id);
    const bid = Math.round(ask * 0.9);
    const spread = ask - s.retail;
    const spreadPct = s.retail > 0 ? Math.round((spread / s.retail) * 100) : 0;

    return {
      id: s.id,
      name: s.name,
      brand: s.brand,
      colorway: s.colorway,
      styleID: s.styleID,
      retail: s.retail,
      lowestAsk: ask,
      highestBid: bid,
      lastSale: sale,
      spread: spread,
      spreadPct: spreadPct,
      totalSales: 1000 + getSalesCount(s.id) * 30,
      salesLast72h: getSalesCount(s.id),
      pricePremium: spreadPct,
      thumbnail: 'https://images.stockx.com/images/' + s.img,
      image: 'https://images.stockx.com/images/' + s.img,
      url: '',
      releaseDate: s.date,
      category: 'sneakers',
      source: 'soleping-market-data'
    };
  });
}

// ============================================================
//   Combined search: cascading fallback
// ============================================================
async function searchSneakers(query, limit = 20) {
  const cacheKey = 'search:' + query.toLowerCase().trim() + ':' + limit;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const methods = [
    { name: 'goat-algolia', fn: () => searchGoatAlgolia(query, limit) },
    { name: 'goat-constructor', fn: () => searchGoatConstructor(query, limit) },
    { name: 'flightclub', fn: () => searchFlightClub(query, limit) },
    { name: 'stockx-graphql', fn: () => searchStockXGraphQL(query, limit) },
    { name: 'sneakerdb', fn: () => searchSneakerDB(query, limit) },
  ];

  let lastError = null;
  for (const method of methods) {
    try {
      console.log('Trying ' + method.name + ' for: ' + query);
      const results = await method.fn();
      if (results.length > 0) {
        console.log('SUCCESS via ' + method.name + ': ' + results.length + ' results');
        const ttl = method.name.startsWith('goat') ? 300 : 600;
        cache.set(cacheKey, results, ttl);
        return results;
      }
    } catch (e) {
      console.warn(method.name + ' failed:', e.message);
      lastError = e;
    }
  }

  // Final fallback: curated database (always works)
  console.log('All live APIs failed, using curated database for: ' + query);
  const curated = searchCurated(query, limit);
  if (curated.length > 0) {
    cache.set(cacheKey, curated, 1800);
    return curated;
  }

  console.error('All search methods failed for:', query, lastError?.message);
  cache.set(cacheKey, [], 60);
  return [];
}

// --- Transform StockX Node to Clean Object ---
function transformStockXNode(node) {
  if (!node) return { name: 'Unknown' };
  const market = node.market || {};
  const state = market.state || {};
  const stats = market.statistics || {};

  const lowestAsk = state.lowestAsk ? state.lowestAsk.amount : null;
  const highestBid = state.highestBid ? state.highestBid.amount : null;
  const lastSale = stats.lastSale ? stats.lastSale.amount : null;
  const salesLast72h = stats.last72Hours ? stats.last72Hours.salesCount : 0;

  let retail = null;
  if (node.traits && Array.isArray(node.traits)) {
    const rt = node.traits.find(t => t.name === 'Retail Price');
    if (rt && rt.value) retail = parseFloat(rt.value.replace(/[^0-9.]/g, ''));
  }

  let releaseDate = '';
  if (node.traits && Array.isArray(node.traits)) {
    const rd = node.traits.find(t => t.name === 'Release Date');
    if (rd) releaseDate = rd.value || '';
  }

  const marketPrice = lowestAsk || lastSale;
  const spread = marketPrice && retail && retail > 0 ? marketPrice - retail : null;
  const spreadPct = spread && retail ? Math.round((spread / retail) * 100) : null;
  const media = node.media || {};

  return {
    id: node.id || node.urlKey || '',
    name: node.name || 'Unknown',
    brand: node.brand || '',
    colorway: node.colorway || '',
    styleID: node.styleId || '',
    retail, lowestAsk, highestBid, lastSale, spread, spreadPct,
    totalSales: stats.totalSales || 0,
    salesLast72h,
    pricePremium: spreadPct,
    thumbnail: media.thumbUrl || media.smallImageUrl || '',
    image: media.imageUrl || media.thumbUrl || '',
    url: node.urlKey ? 'https://stockx.com/' + node.urlKey : '',
    releaseDate,
    category: node.productCategory || 'sneakers',
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
    marketplace: fees.name, sellPrice, buyPrice,
    totalFees: r2(totalFees), feeBreakdown,
    payout: r2(payout), netProfit: r2(netProfit), roi: r2(roi),
    profitable: netProfit > 0
  };
}

// ============================================================
//   API Routes
// ============================================================

// Health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    cacheStats: cache.getStats(),
    sneakerDB: CURATED_SNEAKERS.length + ' sneakers in market database'
  });
});

// Search
app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.json({ source: 'none', results: [], query: '' });
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 40);
    const results = await searchSneakers(query, limit);
    const source = results.length > 0 && results[0].source ? results[0].source : 'none';
    res.json({ source, results, query });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed', message: err.message });
  }
});

// Trending
app.get('/api/trending', async (req, res) => {
  const cacheKey = 'trending-v4';
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const limit = Math.min(parseInt(req.query.limit) || 25, 50);
    const queries = ['Jordan 1', 'Yeezy 350', 'Dunk Low', 'Travis Scott', 'New Balance 550', 'Nike SB', 'Off-White', 'Jordan 4', 'Kobe', 'ASICS'];
    const allResults = [];
    const seen = new Set();

    for (const q of queries) {
      try {
        const hits = await searchSneakers(q, 10);
        for (const hit of hits) {
          if (!seen.has(hit.id) && (hit.lowestAsk || hit.lastSale)) {
            seen.add(hit.id);
            allResults.push(hit);
          }
        }
      } catch (e) {
        console.error('Trending query "' + q + '" failed:', e.message);
      }
    }

    allResults.sort((a, b) => (b.spread || 0) - (a.spread || 0));

    const trending = allResults.slice(0, limit);
    const source = trending.length > 0 && trending[0].source ? trending[0].source : 'soleping-market-data';
    const result = { source, results: trending, count: trending.length, updatedAt: new Date().toISOString() };
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
  for (const mp of Object.keys(MARKETPLACE_FEES)) all[mp] = calculateProfit(sell, buy, mp);
  res.json({ allMarketplaces: all });
});

// Fee structures
app.get('/api/fees', (req, res) => res.json(MARKETPLACE_FEES));

// --- Keep-Alive Self-Ping ---
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://soleping-api.onrender.com';
setInterval(() => {
  fetch(SELF_URL + '/api/health').catch(() => {});
}, 10 * 60 * 1000);

// --- Start ---
app.listen(PORT, () => {
  console.log('=== SolePing API v5 ===');
  console.log('Port:', PORT);
  console.log('Data: GOAT Algolia > GOAT Constructor > FlightClub > StockX GraphQL > SneakerDB > SolePing Market DB');
  console.log('Market DB: ' + CURATED_SNEAKERS.length + ' sneakers with daily price fluctuation');
  console.log('Keep-alive: every 10 min');
  console.log('========================');
});
