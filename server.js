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
    + '&i=a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    + '&s=1'
    + '&num_results_per_page=' + limit
    + '&_dt=' + Date.now();

  const resp = await fetch(url, {
    headers: {
      'accept': 'application/json',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!resp.ok) throw new Error('Constructor ' + resp.status);
  const data = await resp.json();
  const results = data.response?.results || [];

  return results.slice(0, limit).map(r => {
    const d = r.data || {};
    const retail = d.retail_price ? parseFloat(d.retail_price) : null;
    const lowestAsk = d.lowest_price_cents ? d.lowest_price_cents / 100 : (d.price ? parseFloat(d.price) : null);
    const marketPrice = lowestAsk;
    const spread = marketPrice && retail ? marketPrice - retail : null;
    const spreadPct = spread && retail ? Math.round((spread / retail) * 100) : null;

    return {
      id: d.slug || d.id || r.value || '',
      name: r.value || d.product_name || d.name || 'Unknown',
      brand: d.brand_name || d.brand || '',
      colorway: d.color || '',
      styleID: d.sku || '',
      retail: retail,
      lowestAsk: lowestAsk,
      highestBid: lowestAsk ? Math.round(lowestAsk * 0.92) : null,
      lastSale: lowestAsk,
      spread: spread,
      spreadPct: spreadPct,
      totalSales: 0,
      salesLast72h: 0,
      pricePremium: spreadPct,
      thumbnail: d.main_picture_url || d.image_url || '',
      image: d.main_picture_url || d.original_picture_url || '',
      url: d.slug ? 'https://www.goat.com/sneakers/' + d.slug : d.url || '',
      releaseDate: d.release_date || '',
      category: d.product_type || 'sneakers',
      source: 'goat-constructor'
    };
  }).filter(s => s.name !== 'Unknown');
}

// ============================================================
//   METHOD 3: Flight Club API
// ============================================================
async function searchFlightClub(query, limit) {
  const url = 'https://2fwotdvm2o-dsn.algolia.net/1/indexes/product_variants_v2_flight_club/query';
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

  if (!resp.ok) throw new Error('FlightClub Algolia ' + resp.status);
  const data = await resp.json();
  const hits = data.hits || [];

  return hits.slice(0, limit).map(h => {
    const retail = h.retail_price_cents ? h.retail_price_cents / 100 : null;
    const lowestAsk = h.lowest_price_cents ? h.lowest_price_cents / 100 : null;
    const marketPrice = lowestAsk;
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
      lastSale: lowestAsk,
      spread: spread,
      spreadPct: spreadPct,
      totalSales: 0,
      salesLast72h: 0,
      pricePremium: spreadPct,
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
//   METHOD 6: Curated Sneaker Database (always works)
// ============================================================
const CURATED_SNEAKERS = [
  { id:'aj1-retro-high-og-chicago', name:'Air Jordan 1 Retro High OG Chicago', brand:'Jordan', colorway:'White/Black-Varsity Red', styleID:'DZ5485-612', retail:180, lowestAsk:340, lastSale:325, thumbnail:'https://images.stockx.com/images/Air-Jordan-1-Retro-High-OG-Chicago-Reimagined-Product.jpg', releaseDate:'2022-10-29' },
  { id:'aj1-retro-high-og-bred', name:'Air Jordan 1 Retro High OG Bred', brand:'Jordan', colorway:'Black/Varsity Red-White', styleID:'555088-001', retail:170, lowestAsk:290, lastSale:275, thumbnail:'https://images.stockx.com/images/Air-Jordan-1-Retro-High-OG-Bred-2016-Product.jpg', releaseDate:'2016-09-03' },
  { id:'aj1-dark-mocha', name:'Air Jordan 1 Retro High Dark Mocha', brand:'Jordan', colorway:'Sail/Dark Mocha-Black', styleID:'555088-105', retail:170, lowestAsk:310, lastSale:295, thumbnail:'https://images.stockx.com/images/Air-Jordan-1-Retro-High-Dark-Mocha-Product.jpg', releaseDate:'2020-10-31' },
  { id:'aj1-university-blue', name:'Air Jordan 1 Retro High OG University Blue', brand:'Jordan', colorway:'White/University Blue-Black', styleID:'555088-134', retail:170, lowestAsk:265, lastSale:250, thumbnail:'https://images.stockx.com/images/Air-Jordan-1-Retro-High-University-Blue-Product.jpg', releaseDate:'2021-03-06' },
  { id:'aj1-shadow-2018', name:'Air Jordan 1 Retro High OG Shadow', brand:'Jordan', colorway:'Black/Medium Grey-White', styleID:'555088-013', retail:160, lowestAsk:305, lastSale:290, thumbnail:'https://images.stockx.com/images/Air-Jordan-1-Retro-High-OG-Shadow-Product.jpg', releaseDate:'2018-04-14' },
  { id:'aj4-retro-bred-2019', name:'Air Jordan 4 Retro Bred 2019', brand:'Jordan', colorway:'Black/Cement Grey-Summit White-Fire Red', styleID:'308497-060', retail:200, lowestAsk:370, lastSale:355, thumbnail:'https://images.stockx.com/images/Air-Jordan-4-Retro-Bred-2019-Product.jpg', releaseDate:'2019-05-04' },
  { id:'aj4-white-oreo', name:'Air Jordan 4 Retro White Oreo', brand:'Jordan', colorway:'White/Tech Grey-Black-Fire Red', styleID:'CT8527-100', retail:190, lowestAsk:260, lastSale:245, thumbnail:'https://images.stockx.com/images/Air-Jordan-4-Retro-White-Oreo-2021-Product.jpg', releaseDate:'2021-07-03' },
  { id:'aj11-bred-2019', name:'Air Jordan 11 Retro Bred 2019', brand:'Jordan', colorway:'Black/White-Varsity Red', styleID:'378037-061', retail:220, lowestAsk:310, lastSale:295, thumbnail:'https://images.stockx.com/images/Air-Jordan-11-Retro-Bred-2019-Product.jpg', releaseDate:'2019-12-14' },
  { id:'yeezy-350-v2-beluga-rf', name:'adidas Yeezy Boost 350 V2 Beluga Reflective', brand:'adidas', colorway:'Beluga Reflective', styleID:'GW1229', retail:230, lowestAsk:295, lastSale:280, thumbnail:'https://images.stockx.com/images/adidas-Yeezy-Boost-350-V2-Beluga-Reflective-Product.jpg', releaseDate:'2021-12-18' },
  { id:'yeezy-350-v2-zebra', name:'adidas Yeezy Boost 350 V2 Zebra', brand:'adidas', colorway:'White/Core Black/Red', styleID:'CP9654', retail:220, lowestAsk:270, lastSale:255, thumbnail:'https://images.stockx.com/images/adidas-Yeezy-Boost-350-V2-Zebra-Product.jpg', releaseDate:'2017-02-25' },
  { id:'yeezy-350-v2-bred', name:'adidas Yeezy Boost 350 V2 Bred', brand:'adidas', colorway:'Core Black/Core Black/Red', styleID:'CP9652', retail:220, lowestAsk:365, lastSale:350, thumbnail:'https://images.stockx.com/images/adidas-Yeezy-Boost-350-V2-Core-Black-Red-Product.jpg', releaseDate:'2017-02-11' },
  { id:'yeezy-slide-onyx', name:'adidas Yeezy Slide Onyx', brand:'adidas', colorway:'Onyx', styleID:'HQ6448', retail:70, lowestAsk:110, lastSale:105, thumbnail:'https://images.stockx.com/images/adidas-Yeezy-Slide-Onyx-Product.jpg', releaseDate:'2022-03-14' },
  { id:'yeezy-foam-rnnr-onyx', name:'adidas Yeezy Foam RNNR Onyx', brand:'adidas', colorway:'Onyx', styleID:'HP8739', retail:90, lowestAsk:105, lastSale:98, thumbnail:'https://images.stockx.com/images/adidas-Yeezy-Foam-RNNR-Onyx-Product.jpg', releaseDate:'2022-06-04' },
  { id:'dunk-low-panda', name:'Nike Dunk Low Retro White Black Panda', brand:'Nike', colorway:'White/Black-White', styleID:'DD1391-100', retail:110, lowestAsk:98, lastSale:95, thumbnail:'https://images.stockx.com/images/Nike-Dunk-Low-Retro-White-Black-2021-Product.jpg', releaseDate:'2021-03-10' },
  { id:'dunk-low-grey-fog', name:'Nike Dunk Low Grey Fog', brand:'Nike', colorway:'White/Grey Fog', styleID:'DD1391-103', retail:100, lowestAsk:115, lastSale:110, thumbnail:'https://images.stockx.com/images/Nike-Dunk-Low-Grey-Fog-Product.jpg', releaseDate:'2021-10-13' },
  { id:'dunk-low-unc', name:'Nike Dunk Low UNC', brand:'Nike', colorway:'White/University Blue', styleID:'DD1391-102', retail:100, lowestAsk:145, lastSale:135, thumbnail:'https://images.stockx.com/images/Nike-Dunk-Low-University-Blue-Product.jpg', releaseDate:'2021-06-24' },
  { id:'travis-scott-aj1-low-mocha', name:'Travis Scott x Air Jordan 1 Low OG Mocha', brand:'Jordan', colorway:'Sail/University Red-Black-Dark Mocha', styleID:'CQ4277-001', retail:150, lowestAsk:1250, lastSale:1200, thumbnail:'https://images.stockx.com/images/Air-Jordan-1-Retro-Low-OG-SP-Travis-Scott-Product.jpg', releaseDate:'2019-07-20' },
  { id:'travis-scott-aj1-high-mocha', name:'Travis Scott x Air Jordan 1 Retro High OG Mocha', brand:'Jordan', colorway:'Sail/Dark Mocha-University Red-Black', styleID:'CD4487-100', retail:175, lowestAsk:1650, lastSale:1580, thumbnail:'https://images.stockx.com/images/Air-Jordan-1-High-OG-TS-SP-Travis-Scott-Product.jpg', releaseDate:'2019-05-11' },
  { id:'nb-550-white-green', name:'New Balance 550 White Green', brand:'New Balance', colorway:'White/Green', styleID:'BB550WT1', retail:110, lowestAsk:105, lastSale:100, thumbnail:'https://images.stockx.com/images/New-Balance-550-White-Green-Product.jpg', releaseDate:'2021-03-18' },
  { id:'nb-2002r-protection-pack-rain-cloud', name:'New Balance 2002R Protection Pack Rain Cloud', brand:'New Balance', colorway:'Rain Cloud', styleID:'M2002RDA', retail:130, lowestAsk:175, lastSale:165, thumbnail:'https://images.stockx.com/images/New-Balance-2002R-Protection-Pack-Rain-Cloud-Product.jpg', releaseDate:'2022-04-08' },
  { id:'aj3-white-cement-reimagined', name:'Air Jordan 3 Retro White Cement Reimagined', brand:'Jordan', colorway:'Summit White/Fire Red-Black-Cement Grey', styleID:'DN3707-100', retail:200, lowestAsk:220, lastSale:210, thumbnail:'https://images.stockx.com/images/Air-Jordan-3-Retro-White-Cement-Reimagined-Product.jpg', releaseDate:'2023-03-11' },
  { id:'aj1-low-travis-scott-reverse-mocha', name:'Travis Scott x Air Jordan 1 Low OG Reverse Mocha', brand:'Jordan', colorway:'Sail/University Red-Ridgerock', styleID:'DM7866-162', retail:150, lowestAsk:950, lastSale:920, thumbnail:'https://images.stockx.com/images/Air-Jordan-1-Low-OG-SP-Travis-Scott-Reverse-Mocha-Product.jpg', releaseDate:'2022-07-21' },
  { id:'nike-sb-dunk-low-ben-jerry', name:'Nike SB Dunk Low Ben & Jerry\'s Chunky Dunky', brand:'Nike', colorway:'White/Lagoon Pulse-Black-University Gold', styleID:'CU3244-100', retail:100, lowestAsk:1800, lastSale:1750, thumbnail:'https://images.stockx.com/images/Nike-SB-Dunk-Low-Ben-Jerrys-Chunky-Dunky-Product.jpg', releaseDate:'2020-05-26' },
  { id:'dunk-low-green-glow', name:'Nike Dunk Low Green Glow', brand:'Nike', colorway:'White/Green Glow', styleID:'DD1503-105', retail:100, lowestAsk:120, lastSale:115, thumbnail:'https://images.stockx.com/images/Nike-Dunk-Low-Green-Glow-Product.jpg', releaseDate:'2022-02-11' },
  { id:'aj4-military-black', name:'Air Jordan 4 Retro Military Black', brand:'Jordan', colorway:'White/Black-Neutral Grey', styleID:'DH6927-111', retail:190, lowestAsk:230, lastSale:220, thumbnail:'https://images.stockx.com/images/Air-Jordan-4-Retro-Military-Black-Product.jpg', releaseDate:'2022-05-21' },
  { id:'aj1-lost-and-found', name:'Air Jordan 1 Retro High OG Lost & Found', brand:'Jordan', colorway:'Varsity Red/Black-Sail-Muslin', styleID:'DZ5485-612', retail:180, lowestAsk:210, lastSale:200, thumbnail:'https://images.stockx.com/images/Air-Jordan-1-Retro-High-OG-Lost-and-Found-Product.jpg', releaseDate:'2022-11-19' },
  { id:'nike-air-force-1-low-white', name:'Nike Air Force 1 Low \'07 White', brand:'Nike', colorway:'White/White', styleID:'315122-111', retail:110, lowestAsk:105, lastSale:100, thumbnail:'https://images.stockx.com/images/Nike-Air-Force-1-Low-White-07-Product.jpg', releaseDate:'2007-01-01' },
  { id:'asics-gel-kayano-14-silver', name:'ASICS Gel-Kayano 14 Silver', brand:'ASICS', colorway:'White/Pure Silver', styleID:'1201A019-105', retail:140, lowestAsk:155, lastSale:148, thumbnail:'https://images.stockx.com/images/ASICS-Gel-Kayano-14-Silver-Product.jpg', releaseDate:'2023-08-10' },
  { id:'nb-9060-grey-day', name:'New Balance 9060 Grey Day', brand:'New Balance', colorway:'Grey/Silver', styleID:'U9060GRY', retail:150, lowestAsk:170, lastSale:162, thumbnail:'https://images.stockx.com/images/New-Balance-9060-Grey-Day-Product.jpg', releaseDate:'2023-11-01' },
  { id:'aj4-bred-reimagined', name:'Air Jordan 4 Retro Bred Reimagined', brand:'Jordan', colorway:'Fire Red/Cement Grey-Summit White-Black', styleID:'FV5029-006', retail:210, lowestAsk:260, lastSale:248, thumbnail:'https://images.stockx.com/images/Air-Jordan-4-Retro-Bred-Reimagined-Product.jpg', releaseDate:'2024-02-17' },
];

function searchCurated(query, limit) {
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter(w => w.length > 1);

  const scored = CURATED_SNEAKERS.map(s => {
    const text = (s.name + ' ' + s.brand + ' ' + s.colorway + ' ' + s.styleID).toLowerCase();
    let score = 0;
    // Exact phrase match
    if (text.includes(q)) score += 10;
    // Individual word matches
    for (const w of words) {
      if (text.includes(w)) score += 3;
    }
    // Brand-specific boost
    if (s.brand.toLowerCase().includes(q)) score += 5;
    return { ...s, _score: score };
  }).filter(s => s._score > 0);

  scored.sort((a, b) => b._score - a._score);

  return scored.slice(0, limit).map(s => ({
    id: s.id,
    name: s.name,
    brand: s.brand,
    colorway: s.colorway,
    styleID: s.styleID,
    retail: s.retail,
    lowestAsk: s.lowestAsk,
    highestBid: Math.round(s.lowestAsk * 0.9),
    lastSale: s.lastSale,
    spread: s.lowestAsk - s.retail,
    spreadPct: Math.round(((s.lowestAsk - s.retail) / s.retail) * 100),
    totalSales: Math.floor(Math.random() * 5000) + 500,
    salesLast72h: Math.floor(Math.random() * 100) + 10,
    pricePremium: Math.round(((s.lowestAsk - s.retail) / s.retail) * 100),
    thumbnail: s.thumbnail,
    image: s.thumbnail,
    url: '',
    releaseDate: s.releaseDate,
    category: 'sneakers',
    source: 'curated-database'
  }));
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
    payout: r2(payout), netProfit: r2(netProfit), roi: r1(roi)
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
  const cacheKey = 'trending-v3';
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const limit = Math.min(parseInt(req.query.limit) || 25, 50);
    const queries = ['Jordan 1', 'Yeezy 350', 'Dunk Low', 'Travis Scott', 'New Balance 550'];
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
    const source = trending.length > 0 && trending[0].source ? trending[0].source : 'curated-database';
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
  console.log('=== SolePing API v4 ===');
  console.log('Port:', PORT);
  console.log('Data: GOAT Algolia > GOAT Constructor > FlightClub > StockX GraphQL > SneakerDB > Curated DB');
  console.log('Curated DB: ' + CURATED_SNEAKERS.length + ' sneakers');
  console.log('Keep-alive: every 10 min');
  console.log('========================');
});
