/**
 * SolePing API — Live Sneaker Resale Intelligence
 * Wraps the Sneaks-API library to pull real-time pricing from
 * StockX, GOAT, FlightClub, and Stadium Goods.
 * Endpoints:
 *   GET /api/search?q=jordan+1&limit=10  — Search sneakers
 *   GET /api/product/:styleID            — Get product detail + prices
 *   GET /api/trending?limit=10           — Most popular sneakers right now
 *   GET /api/health                      — Health check
 * Deploy: Render.com, Railway, or any Node.js host
 */

const express    = require("express");
const cors       = require("cors");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");
const NodeCache  = require("node-cache");
const SneaksAPI  = require("sneaks-api");

const app    = express();
const sneaks = new SneaksAPI();
const cache  = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5-min cache
const PORT   = process.env.PORT || 3001;

// Allowed origins (add your frontend domain here)
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "https://meethailo.com",
  "https://www.meethailo.com",
  process.env.FRONTEND_URL,
].filter(Boolean);

// ── Middleware ──────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ── Helper: promisify Sneaks callbacks ─────────────────────
const search = (query, limit) =>
  new Promise((resolve, reject) =>
    sneaks.getProducts(query, limit, (err, products) =>
      err ? reject(err) : resolve(products)
    )
  );

const getProduct = (styleID) =>
  new Promise((resolve, reject) =>
    sneaks.getProductPrices(styleID, (err, product) =>
      err ? reject(err) : resolve(product)
    )
  );

const trending = (limit) =>
  new Promise((resolve, reject) =>
    sneaks.getMostPopular(limit, (err, products) =>
      err ? reject(err) : resolve(products)
    )
  );

// ── Routes ─────────────────────────────────────────────────

// Search
app.get("/api/search", async (req, res) => {
  try {
    const q     = req.query.q || "";
 * SolePing API — Live Sneaker Resale Intelligence
 * Wraps the Sneaks-API library to pull real-time pricing from
 * StockX, GOAT, FlightClub, and Stadium Goods.
 * Endpoints:
 *   GET /api/search?q=jordan+1&limit=10  — Search sneakers
 *   GET /api/product/:styleID            — Get product detail + prices
 *   GET /api/trending?limit=10           — Most popular sneakers right now
 *   GET /api/health                      — Health check
 * Deploy: Render.com, Railway, or any Node.js host
 */

const express    = require("express");
const cors       = require("cors");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");
const NodeCache  = require("node-cache");
const SneaksAPI  = require("sneaks-api");

const app    = express();
const sneaks = new SneaksAPI();
const cache  = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5-min cache
const PORT   = process.env.PORT || 3001;

// Allowed origins (add your frontend domain here)
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "https://meethailo.com",
  "https://www.meethailo.com",
  process.env.FRONTEND_URL,
].filter(Boolean);

// Middleware
app.use(helmet());
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Helper: promisify Sneaks callbacks
const search = (query, limit) =>
  new Promise((resolve, reject) =>
    sneaks.getProducts(query, limit, (err, products) =>
      err ? reject(err) : resolve(products)
    )
  );

const getProduct = (styleID) =>
  new Promise((resolve, reject) =>
    sneaks.getProductPrices(styleID, (err, product) =>
      err ? reject(err) : resolve(product)
    )
  );

const trending = (limit) =>
  new Promise((resolve, reject) =>
    sneaks.getMostPopular(limit, (err, products) =>
      err ? reject(err) : resolve(products)
    )
  );
// Routes

// Search
app.get("/api/search", async (req, res) => {
  try {
    const q     = req.query.q || "";
    const limit = Math.min(parseInt(req.query.limit) || 10, 40);
    const key   = `search:${q}:${limit}`;
    const hit   = cache.get(key);
    if (hit) return res.json({ source: "cache", results: hit });
    const results = await search(q, limit);
    cache.set(key, results);
    res.json({ source: "live", results });
  } catch (e) {
    console.error("Search error:", e);
    res.status(500).json({ error: "Search failed" });
  }
});

// Product detail + prices
app.get("/api/product/:styleID", async (req, res) => {
  try {
    const { styleID } = req.params;
    const key = `product:${styleID}`;
    const hit = cache.get(key);
    if (hit) return res.json({ source: "cache", product: hit });
    const product = await getProduct(styleID);
    cache.set(key, product);
    res.json({ source: "live", product });
  } catch (e) {
    console.error("Product error:", e);
    res.status(500).json({ error: "Product lookup failed" });
  }
});

// Trending
app.get("/api/trending", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 40);
    const key   = `trending:${limit}`;
    const hit   = cache.get(key);
    if (hit) return res.json({ source: "cache", results: hit });
    const results = await trending(limit);
    cache.set(key, results);
    res.json({ source: "live", results });
  } catch (e) {
    console.error("Trending error:", e);
    res.status(500).json({ error: "Trending lookup failed" });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "SolePing API",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Start
app.listen(PORT, () => {
  console.log(`SolePing API running on port ${PORT}`);
});
