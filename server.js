// SolePing API - Live Sneaker Resale Intelligence
// Wraps Sneaks-API for real-time pricing from StockX, GOAT, FlightClub, Stadium Goods

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const NodeCache = require("node-cache");
const SneaksAPI = require("sneaks-api");
const path = require("path");

const app = express();
app.set("trust proxy", 1);
const sneaks = new SneaksAPI();
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const PORT = process.env.PORT || 3001;

app.use(helmet({ frameguard: false, contentSecurityPolicy: false }));
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }));

const doSearch = (q, n) =>
  new Promise((res, rej) => sneaks.getProducts(q, n, (e, p) => e ? rej(e) : res(p)));

const doProduct = (id) =>
  new Promise((res, rej) => sneaks.getProductPrices(id, (e, p) => e ? rej(e) : res(p)));

const doTrending = (n) =>
  new Promise((res, rej) => sneaks.getMostPopular(n, (e, p) => e ? rej(e) : res(p)));
app.get("/api/search", async (req, res) => {
  try {
    const q = req.query.q || "";
    const limit = Math.min(parseInt(req.query.limit) || 10, 40);
    const key = "search:" + q + ":" + limit;
    const hit = cache.get(key);
    if (hit) return res.json({ source: "cache", results: hit });
    const results = await doSearch(q, limit);
    cache.set(key, results);
    res.json({ source: "live", results });
  } catch (e) {
    console.error("Search error:", e);
    res.status(500).json({ error: "Search failed" });
  }
});

app.get("/api/product/:styleID", async (req, res) => {
  try {
    const id = req.params.styleID;
    const key = "product:" + id;
    const hit = cache.get(key);
    if (hit) return res.json({ source: "cache", product: hit });
    const product = await doProduct(id);
    cache.set(key, product);
    res.json({ source: "live", product });
  } catch (e) {
    console.error("Product error:", e);
    res.status(500).json({ error: "Product lookup failed" });
  }
});

app.get("/api/trending", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 40);
    const key = "trending:" + limit;
    const hit = cache.get(key);
    if (hit) return res.json({ source: "cache", results: hit });
    const results = await doTrending(limit);
    cache.set(key, results);
    res.json({ source: "live", results });
  } catch (e) {
    console.error("Trending error:", e);
    res.status(500).json({ error: "Trending lookup failed" });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "SolePing API",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log("SolePing API running on port " + PORT);
});
