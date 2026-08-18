// api/chat.js — Little Minors "Bee Bot" backend
//
// SECURITY: No keys here. All secrets come from Vercel env vars.
// Env vars: GROQ_API_KEY, GEMINI_API_KEY (optional), SHOPIFY_STORE, SHOPIFY_ADMIN_TOKEN,
//           WHATSAPP_NUMBER (e.g. 923018481401), PUBLIC_DOMAIN, ALLOWED_ORIGIN

// AI providers, tried in order (best first; fall to next on rate-limit/error):
//   Groq 70b (smart) -> Groq 8b-instant (fast, higher limit) -> Gemini (separate quota) -> keyword fallback
// Gemini is OPTIONAL: only used if GEMINI_API_KEY is set. Both use the OpenAI-compatible format.
// Override model lists via GROQ_MODELS / GEMINI_MODELS env vars (comma-separated).
function providerChain() {
  const chain = [];
  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (groqKey) {
    for (const m of (process.env.GROQ_MODELS || "openai/gpt-oss-120b,llama-3.1-8b-instant")
      .split(",").map((s) => s.trim()).filter(Boolean)) {
      chain.push({ url: "https://api.groq.com/openai/v1/chat/completions", key: groqKey, model: m });
    }
  }
  if (geminiKey) {
    for (const m of (process.env.GEMINI_MODELS || "gemini-3.6-flash,gemini-3.5-flash-lite")
      .split(",").map((s) => s.trim()).filter(Boolean)) {
      chain.push({ url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key: geminiKey, model: m });
    }
  }
  return chain;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function shopHeaders() {
  return { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN, "Content-Type": "application/json" };
}
function storeBase() { return `https://${process.env.SHOPIFY_STORE}`; }

function mapProduct(p) {
  const variants = p.variants || [];
  const variant = variants[0] || {};
  const image = (p.image && p.image.src) || (p.images && p.images[0] && p.images[0].src) || "";
  const price = parseFloat(variant.price || "0");
  const compareAt = parseFloat(variant.compare_at_price || "0");
  const hasDiscount = compareAt > price && price > 0;
  // Available if ANY variant is in stock, or inventory isn't tracked, or oversell allowed
  const available = variants.some((v) => {
    if (v.inventory_management == null) return true;          // Shopify not tracking -> treat as available
    if (v.inventory_policy === "continue") return true;       // allowed to oversell
    return (v.inventory_quantity || 0) > 0;
  });
  return {
    title: p.title || "",
    handle: p.handle || "",
    price: variant.price || "",
    compareAtPrice: hasDiscount ? variant.compare_at_price : "",
    discountPercent: hasDiscount ? Math.round((1 - price / compareAt) * 100) : 0,
    available,
    image,
    url: `${storeBase()}/products/${p.handle}`,
    _text: `${p.title || ""} ${p.product_type || ""} ${p.tags || ""} ${p.vendor || ""}`.toLowerCase(),
  };
}

// ---- Full catalog cache (active + published) ----
let CATALOG = null, CATALOG_TIME = 0;
const TTL = 5 * 60 * 1000;

async function getCatalog() {
  const now = Date.now();
  if (CATALOG && now - CATALOG_TIME < TTL) return CATALOG;
  if (!process.env.SHOPIFY_STORE || !process.env.SHOPIFY_ADMIN_TOKEN) return [];
  let all = [];
  let url = `${storeBase()}/admin/api/2024-10/products.json?limit=250&status=active&published_status=published`;
  try {
    for (let i = 0; i < 6 && url; i++) {
      const r = await fetch(url, { headers: shopHeaders() });
      if (!r.ok) break;
      const data = await r.json();
      all = all.concat((data.products || [])
        .filter((p) => (p.status ? p.status === "active" : true) && p.published_at)
        .map(mapProduct));
      const link = r.headers.get("link") || r.headers.get("Link");
      const next = link && link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
  } catch (e) { return CATALOG || []; }
  CATALOG = all; CATALOG_TIME = now; return all;
}

// ---- Collections cache (for category requests like "Azadi Sale") ----
let COLLECTIONS = null, COLL_TIME = 0;
async function getCollections() {
  const now = Date.now();
  if (COLLECTIONS && now - COLL_TIME < TTL) return COLLECTIONS;
  if (!process.env.SHOPIFY_STORE || !process.env.SHOPIFY_ADMIN_TOKEN) return [];
  const out = [];
  for (const type of ["custom_collections", "smart_collections"]) {
    try {
      const r = await fetch(`${storeBase()}/admin/api/2024-10/${type}.json?limit=250`, { headers: shopHeaders() });
      if (!r.ok) continue;
      const data = await r.json();
      (data[type] || []).forEach((c) => out.push({ id: c.id, title: (c.title || "").toLowerCase() }));
    } catch (e) {}
  }
  COLLECTIONS = out; COLL_TIME = now; return out;
}

async function productsInCollection(collectionId) {
  let all = [];
  let url = `${storeBase()}/admin/api/2024-10/products.json?collection_id=${collectionId}&limit=250&status=active&published_status=published`;
  try {
    for (let i = 0; i < 4 && url; i++) {
      const r = await fetch(url, { headers: shopHeaders() });
      if (!r.ok) break;
      const data = await r.json();
      all = all.concat((data.products || [])
        .filter((p) => (p.status ? p.status === "active" : true) && p.published_at)
        .map(mapProduct));
      const link = r.headers.get("link") || r.headers.get("Link");
      const next = link && link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
  } catch (e) {}
  return all;
}

const STOP = new Set(["the","a","an","do","you","have","any","i","want","need","looking","for","me",
  "show","some","is","are","there","can","get","buy","please","of","to","in","on","and","with","my",
  "your","it","this","that","would","like","give","tell","about","product","products","item","items",
  "sale","kids","kid"]);

function tokens(text) {
  return (text || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 || /^\d+$/.test(w));
}
function keywords(text) { return tokens(text).filter((w) => !STOP.has(w)); }

// Synonyms: customer word -> words that actually appear in the Little Minors catalog
const SYNONYMS = {
  romper: ["romper", "bodysuit", "onesie"],
  jumpsuit: ["romper", "bodysuit", "onesie"],
  onesie: ["onesie", "bodysuit", "romper"],
  bodysuit: ["bodysuit", "romper", "onesie"],
  frock: ["dress"],
  jeans: ["trouser", "pant"],
  jean: ["trouser", "pant"],
  pant: ["trouser", "pant"],
  pants: ["trouser", "pant"],
  trousers: ["trouser"],
  joggers: ["trouser", "tracksuit"],
  jogger: ["trouser", "tracksuit"],
  trackpant: ["tracksuit", "trouser"],
  trackpants: ["tracksuit", "trouser"],
  hoodie: ["tracksuit", "suit"],
  nappy: ["diaper"],
  nappies: ["diaper"],
  tee: ["shirt", "tee"],
  tshirt: ["shirt", "tee"],
  tshirts: ["shirt", "tee"],
  pyjama: ["pajama", "sleepwear"],
  pyjamas: ["pajama", "sleepwear"],
  pajamas: ["pajama", "sleepwear"],
  nightwear: ["sleepwear", "pajama"],
  nightsuit: ["sleepwear", "pajama", "suit"],
  soother: ["pacifier", "soother"],
  dummy: ["pacifier", "soother"],
  sipper: ["feeder", "bottle"],
  feeder: ["feeder", "feeding", "bottle"],
  drone: ["drone", "aircraft", "plane"],
  fan: ["fan"],
  jersey: ["jersy", "jersey", "tracksuit"],
  jerseys: ["jersy", "jersey", "tracksuit"],
  knickers: ["nicker", "shorts"],
  knicker: ["nicker", "shorts"],
  nicker: ["nicker", "shorts"],
  kurti: ["kurta"],
  socks: ["socks", "sock"],
};

// The core "product type" words in the catalog. If a query names one of these,
// results are filtered to that type (so "boys pants" won't show shirts).
const PRODUCT_NOUNS = new Set([
  "romper", "bodysuit", "onesie", "trouser", "trousers", "pant", "pants", "shorts", "short",
  "shirt", "shirts", "tee", "tshirt", "tracksuit", "suit", "outfit", "dress", "kurta", "kurti",
  "jersy", "jersey", "nicker", "pacifier", "soother", "teether", "feeder", "bottle", "feeding",
  "brush", "bib", "fan", "fans", "drone", "aircraft", "car", "kit", "grooming", "blanket",
  "mittens", "cap", "pajama", "sleepwear", "toy", "sipper", "diaper",
]);

function expandSynonyms(kws) {
  const out = new Set(kws);
  for (const k of kws) if (SYNONYMS[k]) SYNONYMS[k].forEach((s) => out.add(s));
  return [...out];
}

// Damerau-OSA distance: single edits AND adjacent letter swaps count as 1
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

// Live vocabulary built from the fetched catalog (self-updating)
let VOCAB = null, VOCAB_TIME = 0;
function getVocab(catalog) {
  if (VOCAB && Date.now() - VOCAB_TIME < TTL) return VOCAB;
  const set = new Set();
  for (const p of catalog) for (const w of p._text.split(/\s+/)) if (w.length > 2) set.add(w);
  VOCAB = [...set]; VOCAB_TIME = Date.now(); return VOCAB;
}

// Add close-spelling matches for typos (e.g. "rompar" -> "romper")
function fuzzyExpand(kws, vocab) {
  const out = new Set(kws);
  for (const kw of kws) {
    if (kw.length < 4) continue;
    // "direct" only if a catalog word actually contains this keyword (not the reverse)
    let direct = false;
    for (const v of vocab) { if (v.includes(kw)) { direct = true; break; } }
    if (direct) continue;
    const th = kw.length <= 5 ? 1 : 2;
    for (const v of vocab) {
      if (v.length < 4) continue;
      if (Math.abs(v.length - kw.length) > 2) continue;
      if (editDistance(kw, v) <= th) out.add(v);
    }
  }
  return [...out];
}

// Try to match the query to a collection; return its products if found
async function categorySearch(query) {
  const IGNORE = new Set(["product", "products", "show", "want", "give", "please", "new", "all", "featured", "pack", "packs"]);
  const qToks = tokens(query).filter((t) => !IGNORE.has(t));
  if (!qToks.length) return null;
  const cols = await getCollections();
  let best = null, bestScore = 0;
  for (const c of cols) {
    const cToks = tokens(c.title);
    let score = 0;
    for (const t of qToks) if (cToks.includes(t)) score += 2;
    for (const t of qToks) if (c.title.includes(t) && !cToks.includes(t)) score += 1;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (best && bestScore >= 2) {
    const prods = await productsInCollection(best.id);
    if (prods.length) return prods.slice(0, 30);
  }
  return null;
}

// Decide how many results to show based on how SPECIFIC the query is.
// Specific (a product name / long query / near-exact top match) -> few accurate.
// Broad (e.g. "lipstick", "boys pants") -> more, for browsing.
function trimBySpecificity(query, results) {
  if (!results || !results.length) return results || [];
  const n = keywords(query).length;   // number of meaningful words the customer typed
  if (n >= 6) return results.slice(0, 1);    // full product-name paste -> the one accurate product
  if (n === 5) return results.slice(0, 4);   // fairly specific -> a few
  return results.slice(0, 10);               // short/browse query ("lipstick", "boys pants") -> more
}

// Shopify storefront search (suggest.json) — the store's own search engine, no key needed.
// Send a CLEAN query (Shopify ranks relevance itself). Match results back to live Admin data.
const SUGGEST_CACHE = new Map();   // query -> {t, results}
async function shopifySuggest(query, catalog) {
  const domain = (process.env.PUBLIC_DOMAIN || "https://littleminors.com").replace(/\/+$/, "");
  const q = (query || "").trim();
  if (!q) return null;

  const cached = SUGGEST_CACHE.get(q.toLowerCase());
  if (cached && Date.now() - cached.t < 60000) return cached.results;   // 60s cache

  const url = `${domain}/search/suggest.json?q=${encodeURIComponent(q)}&resources[type]=product&resources[limit]=10`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);   // don't let a slow call hang the reply
    const r = await fetch(url, { headers: { "Accept": "application/json" }, signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const data = await r.json();
    const items = data?.resources?.results?.products || [];
    if (!items.length) { SUGGEST_CACHE.set(q.toLowerCase(), { t: Date.now(), results: null }); return null; }
    const byHandle = new Map(catalog.map((p) => [p.handle, p]));
    const results = [];
    for (const it of items) {                       // keep Shopify's relevance order (best match first)
      const handle = (it.handle || (it.url || "").split("/products/")[1] || "").split("?")[0];
      const live = byHandle.get(handle);
      if (live) {
        results.push(live);                         // prefer our live Admin data (accurate stock/discount/image)
      } else if (it.title) {
        results.push({
          title: it.title,
          handle,
          price: (it.price != null ? String(it.price).replace(/[^0-9.]/g, "") : ""),
          compareAtPrice: "",
          discountPercent: 0,
          available: it.available !== false,
          image: it.image || it.featured_image || "",
          url: `${domain}/products/${handle}`,
        });
      }
    }
    const out = results.length ? results : null;
    SUGGEST_CACHE.set(q.toLowerCase(), { t: Date.now(), results: out });
    return out;
  } catch (e) {
    return null;   // timeout or network error -> fall back to our own search
  }
}

function keywordSearch(catalog, query) {
  const q = (query || "").toLowerCase().trim();
  const packPhrase = (q.match(/pack of\s*\d+/) || [])[0];
  let kws = keywords(query);
  kws = expandSynonyms(kws);
  kws = fuzzyExpand(kws, getVocab(catalog));   // typo tolerance + synonyms
  if (!kws.length && !packPhrase) return [];

  // If the customer named product type(s), we'll require results to match one of them
  const nounKws = kws.filter((k) => PRODUCT_NOUNS.has(k));

  let scored = catalog.map((p) => {
    const title = p.title.toLowerCase().replace(/\s+/g, " ");
    let score = 0;
    if (packPhrase && title.includes(packPhrase)) score += 6;
    if (q && title.includes(q)) score += 4;
    for (const kw of kws) {
      if (title.includes(kw)) score += 3;
      else if (p._text.includes(kw)) score += 1;
    }
    return { p, score };
  }).filter((x) => x.score > 0);

  // Keep only the requested product type (so "boys pants" doesn't show shirts)
  if (nounKws.length) {
    scored = scored.filter((x) =>
      nounKws.some((n) => x.p.title.toLowerCase().includes(n) || x.p._text.includes(n))
    );
  }

  scored.sort((a, b) => (b.score - a.score) || ((b.p.available === true) - (a.p.available === true)));
  return scored.slice(0, 20).map((x) => x.p);
}

// Returns the pack phrase (e.g. "pack of 3") ONLY if the message is a generic pack browse
// ("pack of 3", "show me pack of 5", "all packs"). Returns null if a specific product is named
// (e.g. "Pack of 3 Mini USB Fans ..."), so that goes to normal product search instead.
function packOnly(msg) {
  const text = (msg || "").toLowerCase();
  const m = text.match(/pack of\s*(\d+)/);
  const plain = /^\s*(all\s+)?packs?\s*$/.test(text);
  if (!m && !plain) return null;
  const FILLER = new Set([
    "pack", "packs", "all", "show", "want", "dikhao", "dikhaen", "please", "the", "for", "me", "mujhy",
    "ye", "yeh", "wala", "wali", "chahie", "chahiye", "chaiye", "chaheye", "mujhe", "iski", "iska",
    "price", "qeemat", "keemat", "hai", "kia", "kya", "kaun", "konsa", "konsi", "ka", "ke",
    "apke", "apkay", "pass", "paas", "hain", "any", "some", "and",
  ]);
  const rest = text
    .replace(/pack of\s*\d+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !FILLER.has(w) && !/^\d+$/.test(w));
  if (rest.length === 0) return m ? `pack of ${m[1]}` : "pack";  // generic pack query
  return null;                                                    // specific product -> not a pack browse
}

// Strict: only products whose TITLE contains the exact pack size (e.g. "pack of 5")
function packSearch(catalog, phrase) {
  const norm = phrase.toLowerCase().replace(/\s+/g, " ");
  return catalog.filter((p) => p.title.toLowerCase().replace(/\s+/g, " ").includes(norm)).slice(0, 20);
}

// AI refine: model picks/ranks from a SMALL shortlist (token-light).
// candidates is already a narrowed list from keyword search.
const AIPICK_CACHE = new Map(); // query -> {t, titles:Set}
async function aiPickProducts(candidates, query) {
  if (!query || !candidates.length) return null;
  const list = candidates.slice(0, 25).map((p, i) => `${i}: ${p.title}`).join("\n");
  const prompt = `A customer of a baby & kids store said: "${query}"

From this short product list, return ONLY a JSON array of the index numbers that genuinely match what the customer wants (understand synonyms, misspellings, phonetics, product type, age, colour, pack size). If they named a product type, include ONLY that type. Best match first, max 12. If none match, return [].
Products:
${list}`;
  try {
    const raw = await groqCall([{ role: "user", content: prompt }], { temperature: 0, max_tokens: 300 });
    const m = raw.replace(/```json/gi, "").replace(/```/g, "").trim().match(/\[[\s\S]*\]/);
    const arr = JSON.parse(m ? m[0] : "[]");
    if (!Array.isArray(arr)) return null;
    const picked = arr.map((i) => candidates[Number(i)]).filter(Boolean);
    return picked.length ? picked : null;
  } catch (e) { return null; }
}

// ---- Order lookup (order number w/ #LM prefix + identity verification) ----
function normPhone(v) { const d = String(v || "").replace(/\D/g, ""); return d.length > 10 ? d.slice(-10) : d; }

async function findOrderByNumber(orderId) {
  const digits = String(orderId).replace(/[^0-9]/g, "");
  const candidates = [digits, `LM${digits}`, `#LM${digits}`, `#${digits}`, String(orderId)];
  for (const name of candidates) {
    if (!name) continue;
    try {
      const url = `${storeBase()}/admin/api/2024-10/orders.json?status=any&name=${encodeURIComponent(name)}`;
      const r = await fetch(url, { headers: shopHeaders() });
      if (r.status === 401 || r.status === 403) return { error: "auth" };
      if (!r.ok) continue;
      const data = await r.json();
      if (data.orders && data.orders.length) return { order: data.orders[0] };
    } catch (e) {}
  }
  return { order: null };
}

async function findOrderByTracking(trackingNumber) {
  const t = String(trackingNumber || "").replace(/\s/g, "").toLowerCase();
  if (!t) return { order: null };
  try {
    const url = `${storeBase()}/admin/api/2024-10/orders.json?status=any&limit=250&fields=id,name,financial_status,fulfillment_status,total_price,currency,line_items,fulfillments`;
    const r = await fetch(url, { headers: shopHeaders() });
    if (r.status === 401 || r.status === 403) return { error: "auth" };
    if (!r.ok) return { order: null };
    const data = await r.json();
    for (const order of (data.orders || [])) {
      for (const f of (order.fulfillments || [])) {
        const nums = [f.tracking_number, ...(f.tracking_numbers || [])].filter(Boolean).map((x) => String(x).toLowerCase());
        if (nums.includes(t)) return { order };
      }
    }
  } catch (e) {}
  return { order: null };
}

async function findOrderByContact(email, phone) {
  // Needs read_customers scope. Searches customer by email/phone, returns latest order.
  const parts = [];
  if (email) parts.push(`email:${email}`);
  if (phone) parts.push(`phone:${String(phone).replace(/\s/g, "")}`);
  if (!parts.length) return { order: null };
  try {
    const url = `${storeBase()}/admin/api/2024-10/customers/search.json?query=${encodeURIComponent(parts.join(" OR "))}`;
    const r = await fetch(url, { headers: shopHeaders() });
    if (r.status === 403) return { error: "no_customer_scope" };
    if (!r.ok) return { order: null };
    const data = await r.json();
    const customer = (data.customers || [])[0];
    if (!customer) return { order: null };
    const or = await fetch(`${storeBase()}/admin/api/2024-10/customers/${customer.id}/orders.json?status=any&limit=5`, { headers: shopHeaders() });
    if (!or.ok) return { order: null };
    const od = await or.json();
    const order = (od.orders || [])[0];
    return { order: order || null };
  } catch (e) { return { order: null }; }
}

async function lookupOrder({ orderId, phone, email, tracking }) {
  if (!process.env.SHOPIFY_STORE || !process.env.SHOPIFY_ADMIN_TOKEN) return { ok: false, reason: "error" };
  if (!orderId && !phone && !email && !tracking) return { ok: false, reason: "need_any" };

  let order = null;
  if (orderId) {
    const found = await findOrderByNumber(orderId);
    if (found.error === "auth") return { ok: false, reason: "auth" };
    order = found.order;
  }
  if (!order && tracking) {
    const found = await findOrderByTracking(tracking);
    if (found.error === "auth") return { ok: false, reason: "auth" };
    order = found.order;
    if (!order) return { ok: false, reason: "tracking_not_found" };
  }
  if (!order && (email || phone)) {
    const r = await findOrderByContact(email, phone);
    if (r.error === "no_customer_scope") return { ok: false, reason: "no_customer_scope" };
    order = r.order;
  }
  if (!order) return { ok: false, reason: "not_found" };

  const fulfilled = order.fulfillment_status === "fulfilled" || (order.fulfillments && order.fulfillments.length > 0);
  const items = (order.line_items || []).map((li) => li.title).slice(0, 5);

  // Pull carrier + tracking info from the latest fulfillment that has it
  let carrier = "", trackingNumber = "", trackingUrl = "";
  const fs = order.fulfillments || [];
  for (let i = fs.length - 1; i >= 0; i--) {
    const f = fs[i];
    const num = (f.tracking_numbers && f.tracking_numbers[0]) || f.tracking_number;
    if (num) {
      trackingNumber = String(num);
      carrier = f.tracking_company || (f.tracking_companies && f.tracking_companies[0]) || "";
      trackingUrl = (f.tracking_urls && f.tracking_urls[0]) || f.tracking_url || "";
      break;
    }
  }

  return {
    ok: true,
    order: {
      name: order.name,
      financial_status: order.financial_status,
      fulfillment_status: order.fulfillment_status || "unfulfilled",
      shipped: !!fulfilled,
      total: order.total_price || "",
      currency: order.currency || "PKR",
      items,
      carrier,
      trackingNumber,
      trackingUrl,
    },
  };
}

async function groqCall(messages, opts) {
  const { temperature = 0.5, max_tokens = 512 } = opts || {};
  const chain = providerChain();
  let lastErr = "";
  for (const p of chain) {
    try {
      const payload = { model: p.model, messages, temperature, max_tokens };
      // gpt-oss models are reasoning models; keep reasoning minimal so short replies
      // aren't truncated and stay fast.
      if (/gpt-oss/i.test(p.model)) payload.reasoning_effort = "low";
      const r = await fetch(p.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (r.status === 429) { lastErr = "429 rate limit"; continue; }   // busy -> next provider/model
      if (r.status === 401 || r.status === 403) { lastErr = "auth"; continue; } // bad key -> next provider
      if (!r.ok) { lastErr = await r.text(); continue; }
      const data = await r.json();
      const txt = data?.choices?.[0]?.message?.content;
      if (txt) return txt;
      lastErr = "empty response";
    } catch (e) {
      lastErr = String(e);
    }
  }
  throw new Error(lastErr || "all providers failed");
}

async function detectIntent(messages) {
  const lastUser = ([...messages].reverse().find((m) => m.role === "user") || {}).content || "";
  // Use only a little recent context (last 2 turns) so old products/topics don't pollute
  // the search query later in a long conversation. The CURRENT message is what matters.
  const convo = messages.slice(-2).map((m) => `${m.role}: ${m.content}`).join("\n");
  const NOUNS = "romper, bodysuit, onesie, trouser, pant, shorts, shirt, tee, tracksuit, jersy (jersey), suit, outfit, dress, kurta, nicker, pacifier, soother, teether, feeder, feeding bottle, bottle, brush, bib, fan, drone, aircraft, rc car, car, grooming kit, kit, blanket, mittens, cap, pajama, sleepwear, toy, romper, independence day, 14 august";
  const prompt = `You are the intent classifier + search normalizer for Little Minors, a baby & kids store in Pakistan.
Classify the LAST customer message (shown as CURRENT below). Build search_query ONLY from the CURRENT message — ignore products or topics from earlier turns. Return ONLY JSON, no markdown:
{"intent":"product|order_status|talk_to_agent|place_order|greeting|other","search_query":""}

For "product" intent, build search_query using the store's product words below. IMPORTANT:
- Fix spelling and phonetic errors and map to the closest store word. Examples: "rumor"->"romper", "tracsuit"->"tracksuit", "jersey"->"jersy", "trowser"->"trouser", "pacifer"->"pacifier".
- Map synonyms to store words: "jeans"->"trouser", "frock"->"dress", "onesie/jumpsuit"->"romper bodysuit", "dummy/soother"->"pacifier".
- Keep useful attributes (boys, girls, baby, colors, "14 august", "pack of 5") but drop filler words.
- Only output words that describe the product they want.

Store product words: ${NOUNS}

Intents:
- "product": looking for/asking about an item to buy.
- "order_status": wants to track/check an order.
- "talk_to_agent": wants a human/agent/support, or asks for our number.
- "place_order": explicitly wants to order/buy now.
- "greeting": hi/hello/salaam/thanks only.
- "other": unclear/gibberish (e.g. "ss") or general question with no product. Never guess a product here.

Recent context:
${convo}

CURRENT message (classify + build search_query from THIS only): "${lastUser}"`;
  try {
    const raw = await groqCall([{ role: "user", content: prompt }], { temperature: 0, max_tokens: 400 });
    const clean = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const p = JSON.parse(clean);
    return { intent: p.intent || "other", search_query: p.search_query || "" };
  } catch (e) { return { intent: "other", search_query: "" }; }
}


// ---- Chat logging via SheetDB (fire-and-forget; never blocks or breaks the chat) ----
// Works with a SheetDB API URL (https://sheetdb.io/api/v1/XXXX) in LOG_WEBHOOK_URL.
// SheetDB expects { data: { <ColumnName>: value, ... } } with columns matching row 1 of the sheet.
async function logChat(fields) {
  const url = process.env.LOG_WEBHOOK_URL;
  if (!url) return;
  try {
    const row = {
      "Timestamp": new Date().toISOString(),
      "Store": fields.store || "",
      "Session": fields.session || "",
      "Customer Message": fields.message || "",
      "Bot Reply": fields.reply || "",
      "Intent": fields.intent || "",
      "Products Shown": fields.products || "",
      "Action": fields.action || "",
      "User Agent": fields.ua || "",
    };
    // Await the log write so the serverless function doesn't get frozen before it finishes.
    // SheetDB is fast; this adds well under a second and guarantees the row is written.
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ data: row }),
    }).catch(() => {});   // ignore logging errors
  } catch (e) {}
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, bot: "Bee Bot", version: "v6-sheetdb-await", model: (process.env.GROQ_MODELS || "openai/gpt-oss-120b,llama-3.1-8b-instant"), logging: !!process.env.LOG_WEBHOOK_URL });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const waNumber = process.env.WHATSAPP_NUMBER || "";
  const callNumber = waNumber ? `+${waNumber}` : "";

  try {
    const body = req.body || {};

    // ---- Verified order tracking from the tracking form ----
    if (body.track) {
      const r = await lookupOrder(body.track);
      if (r.ok) {
        const o = r.order;
        const itemsLine = o.items.length ? ` (${o.items.join(", ")})` : "";
        const status = o.shipped ? "shipped" : (o.fulfillment_status || "processing");
        const totalLine = o.total ? ` Total: Rs ${o.total}.` : "";
        const carrierLine = o.trackingNumber
          ? ` Courier: ${o.carrier || "our courier"}, tracking #${o.trackingNumber}. Tap the button below to track.`
          : (o.shipped ? " Tracking details will appear here once the courier scans it." : "");
        return res.status(200).json({
          reply: `Order ${o.name}${itemsLine} — payment: ${o.financial_status}, status: ${status}.${totalLine}${carrierLine}`,
          order: o,
          whatsappNumber: waNumber,
        });
      }
      const msg = {
        auth: "Order tracking isn't authorized yet. Please message us on WhatsApp and we'll check for you.",
        no_scope: "Order tracking isn't switched on yet. Please message us on WhatsApp and we'll check for you.",
        no_customer_scope: "Searching by phone/email isn't enabled. Please enter your order number instead.",
        tracking_not_found: "I couldn't match that tracking number to an order. Please enter your Order number (e.g. #LM1234) instead, or message us on WhatsApp.",
        need_any: "Please enter your order number, phone, or email.",
        not_found: "I couldn't find an order with those details. Please double-check and try again.",
        error: "I couldn't check the order right now. Please try again shortly.",
      }[r.reason] || "I couldn't check the order right now.";
      return res.status(200).json({ reply: msg, order: null, reason: r.reason, whatsappNumber: waNumber, callNumber });
    }

    const { messages } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array required" });
    }

    const lastMsg = ([...messages].reverse().find((m) => m.role === "user") || {}).content || "";

    // Deterministic PACK shortcut: only for GENERIC pack browse ("pack of 3", "all packs").
    // If a specific product is named ("Pack of 3 Mini USB Fans..."), skip this and search normally.
    const genericPack = packOnly(lastMsg);
    if (genericPack) {
      const catalog = await getCatalog();
      let products;
      if (genericPack.startsWith("pack of")) products = packSearch(catalog, genericPack);
      else products = catalog.filter((p) => p.title.toLowerCase().includes("pack")).slice(0, 20);
      products = products.filter((p) => p.available);
      const reply = products.length
        ? (genericPack.startsWith("pack of") ? `Here are our ${genericPack} options 👇` : "Here are our packs 👇")
        : "We don't have that pack in stock right now. Would you like to see something else?";
      return res.status(200).json({ reply, products, whatsappNumber: waNumber });
    }

    // Open/check + exchange policy shortcut
    if (/\b(open|khol|kholna|khool|check the product|exchange|return|returns|refund|replace|replacement|policy|7 ?days?|wapas|badal)\b/i.test(lastMsg)) {
      const reply = await shortReply(messages, "Customer asks about opening/checking the product, returns, refunds, or exchange. State clearly and warmly in one or two lines: they can open and check the product on delivery, and we offer a 7-day EXCHANGE only. We do NOT offer returns or refunds — exchange within 7 days only if there's an issue. Do not say we have a return policy.");
      return res.status(200).json({ reply: reply || "You can open & check the product on delivery. We offer 7-day exchange only — no returns or refunds.", products: [], action: "none", whatsappNumber: waNumber });
    }

    // Quick carrier shortcut
    if (/\b(postex|ownexpress|own express|courier|carrier)\b/i.test(lastMsg)) {
      const reply = await shortReply(messages, "Customer asks about the courier/carrier. Tell them we ship via PostEx and OwnExpress, and they can track using the buttons below.");
      return res.status(200).json({ reply: reply || "We ship via PostEx and OwnExpress — track using the buttons below.", products: [], action: "none", showCarriers: true, whatsappNumber: waNumber });
    }

    // Quick order-tracking shortcut (typed phrases like "where is my order")
    if (/\b(track|tracking|my order|where.*order|order status|parcel|shipment|kahan|kahaan)\b/i.test(lastMsg)) {
      const reply = await shortReply(messages, "Customer wants to track an order. In one short line, ask them to fill the tracking form below.");
      return res.status(200).json({ reply: reply || "Please share your order number or tracking ID below.", products: [], action: "track_form", whatsappNumber: waNumber });
    }

    const intentData = await detectIntent(messages);
    // Safety net: clear browse/product phrases should always search products
    if (intentData.intent === "other" &&
        /\b(product|products|kids?|baby|clothes|romper|shirt|trouser|pant|fan|show|dikhao|chahiye|chahie|all products|everything)\b/i.test(lastMsg)) {
      intentData.intent = "product";
    }
    let products = [];
    let action = "none";
    let showCall = false;
    let context = "";

    if (intentData.intent === "product") {
      const q = ((intentData.search_query || "") + " " + lastMsg).toLowerCase();
      const packPhrase = packOnly(lastMsg);   // only for generic pack browse; null if specific product
      let results;
      if (packPhrase && packPhrase.startsWith("pack of")) {
        const catalog = await getCatalog();
        results = packSearch(catalog, packPhrase);              // ONLY real packs of that size
      } else if (/\b(discount|discounted|sale|deal|deals|offer|offers|cheap|off)\b/.test(q)) {
        const catalog = await getCatalog();
        results = catalog.filter((p) => p.discountPercent > 0)
          .sort((a, b) => b.discountPercent - a.discountPercent).slice(0, 20);
      } else {
        const catalog = await getCatalog();
        const rawQ = lastMsg;                                 // exactly what the customer typed
        const normQ = intentData.search_query || lastMsg;     // light typo help
        // Shopify's own search engine (suggest.json) — finds the exact product the customer named
        results = await shopifySuggest(rawQ, catalog);
        if (!results || !results.length) results = await shopifySuggest(normQ, catalog);
        // specific product query -> narrow to the accurate one; broad query -> keep many
        if (results && results.length) results = trimBySpecificity(rawQ, results);
        // Broad browse ("all products", "everything", "kids clothes") -> sample of the catalog
        if ((!results || !results.length) && /\b(all|every|everything|sab|saray|sary|kids?|baby|clothes|products?|items?)\b/.test(q)) {
          results = catalog.filter((p) => p.available).slice(0, 12);
        }
      }
      products = results || [];
      // Only show IN-STOCK products
      products = products.filter((p) => p.available);
      if (products.length) {
        const list = products.slice(0, 6).map((p) => `${p.title}${p.price ? " — Rs " + p.price : ""}`).join("; ");
        context = `Products found (name — price): ${list}. Reply in ONE short line in the customer's language. If they asked about a specific product's price, state that product's price from this list. Otherwise just say something like "Here are some options for you 👇". NEVER ask which type or what kind. NEVER say a price is unavailable — the prices are shown on the cards.`;
      } else {
        action = "agent";
        context = `No matching products. In one short line say we don't have that right now, and they can chat with our team on WhatsApp (button below) or ask for something else. Do NOT invent products.`;
      }
    } else if (intentData.intent === "order_status") {
      action = "track_form";
      context = `Customer wants to track an order. In one short line, ask them to fill the tracking form below.`;
    } else if (intentData.intent === "talk_to_agent") {
      action = "agent";
      context = `Customer wants a human agent. In one or two short lines, warmly tell them they can chat with our team on WhatsApp using the button below. Mention our hours are Monday to Saturday, 10am to 6pm, and we usually reply within 1 to 2 hours. Reply in the customer's language.`;
    } else if (intentData.intent === "place_order") {
      action = "order_form";
      context = `Customer wants to place an order. In one short line, ask them to fill the quick form below.`;
    } else if (intentData.intent === "greeting") {
      context = `Greet warmly in ONE short line and ask how you can help.`;
    } else {
      context = `Unclear or not a product. Do NOT show products. In one short line, gently ask what they're looking for.`;
    }

    const reply = await shortReply(messages, context);
    const fallback = products.length
      ? "Here are some options for you 👇"
      : (action === "agent" ? "You can chat with our team on WhatsApp using the button below." : "How can I help you find something for your little one?");

    await logChat({
      store: "Bee Bot", session: body.session || "",
      message: lastMsg, reply: reply || fallback,
      intent: intentData.intent,
      products: products.slice(0, 5).map((p) => p.title).join(" | "),
      action, ua: (req.headers && req.headers["user-agent"]) || "",
    });

    return res.status(200).json({
      reply: reply || fallback,
      intent: intentData.intent,
      products,
      action,
      showCall,
      callNumber: showCall ? callNumber : "",
      whatsappNumber: waNumber,
    });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("401") || msg.toLowerCase().includes("invalid api key")) {
      return res.status(502).json({ error: "AI service error", detail: "Groq key issue" });
    }
    return res.status(500).json({ error: "Server error", detail: msg });
  }
}

async function shortReply(messages, context) {
  const SYSTEM = `You are Bee Bot, a warm assistant for Little Minors, a baby & kids store in Pakistan.
- Reply in the SAME language the customer used (English/Urdu/Roman Urdu).
- ALWAYS answer in ONE short line. Never write long paragraphs or lists.
- Never invent products, prices, or order info.`;
  try {
    return await groqCall(
      [
        { role: "system", content: SYSTEM },
        { role: "system", content: `Context: ${context}` },
        ...messages.slice(-6).map((m) => ({ role: m.role, content: m.content })),
      ],
      { temperature: 0.5, max_tokens: 400 }
    );
  } catch (e) { return ""; }
}
