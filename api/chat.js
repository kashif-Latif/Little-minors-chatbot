// api/chat.js — Little Minors "Bee Bot" backend
//
// SECURITY: No keys here. All secrets come from Vercel env vars.
// Env vars: GROQ_API_KEY, SHOPIFY_STORE, SHOPIFY_ADMIN_TOKEN,
//           WHATSAPP_NUMBER (e.g. 923018481401), PUBLIC_DOMAIN, ALLOWED_ORIGIN

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

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
  const variant = (p.variants && p.variants[0]) || {};
  const image = (p.image && p.image.src) || (p.images && p.images[0] && p.images[0].src) || "";
  const price = parseFloat(variant.price || "0");
  const compareAt = parseFloat(variant.compare_at_price || "0");
  const hasDiscount = compareAt > price && price > 0;
  return {
    title: p.title || "",
    handle: p.handle || "",
    price: variant.price || "",
    compareAtPrice: hasDiscount ? variant.compare_at_price : "",
    discountPercent: hasDiscount ? Math.round((1 - price / compareAt) * 100) : 0,
    available: (variant.inventory_quantity || 0) > 0,
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

// Try to match the query to a collection; return its products if found
async function categorySearch(query) {
  const qToks = tokens(query);
  if (!qToks.length) return null;
  const cols = await getCollections();
  let best = null, bestScore = 0;
  for (const c of cols) {
    const cToks = tokens(c.title);
    let score = 0;
    for (const t of qToks) if (cToks.includes(t)) score += 2;
    // also substring (e.g. "azadi" in "azadi sale")
    for (const t of qToks) if (c.title.includes(t) && !cToks.includes(t)) score += 1;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (best && bestScore >= 2) {
    const prods = await productsInCollection(best.id);
    if (prods.length) return prods.slice(0, 30);
  }
  return null;
}

function keywordSearch(catalog, query) {
  const q = (query || "").toLowerCase().trim();
  const packPhrase = (q.match(/pack of\s*\d+/) || [])[0];        // e.g. "pack of 3"
  const kws = keywords(query);
  if (!kws.length && !packPhrase) return [];
  const scored = catalog.map((p) => {
    const title = p.title.toLowerCase().replace(/\s+/g, " ");
    let score = 0;
    if (packPhrase && title.includes(packPhrase)) score += 6;   // strongest: exact pack size
    if (q && title.includes(q)) score += 4;                      // full phrase match
    for (const kw of kws) {
      if (title.includes(kw)) score += 3;
      else if (p._text.includes(kw)) score += 1;
    }
    return { p, score };
  }).filter((x) => x.score > 0)
    .sort((a, b) => (b.score - a.score) || ((b.p.available === true) - (a.p.available === true)));
  return scored.slice(0, 20).map((x) => x.p);
}

// ---- Order lookup (order number w/ #LM prefix + identity verification) ----
function normPhone(v) { const d = String(v || "").replace(/\D/g, ""); return d.length > 10 ? d.slice(-10) : d; }

async function findOrderByNumber(orderId) {
  const digits = String(orderId).replace(/[^0-9]/g, "");
  const candidates = [`LM${digits}`, `#LM${digits}`, digits, String(orderId)];
  for (const name of candidates) {
    try {
      const url = `${storeBase()}/admin/api/2024-10/orders.json?status=any&name=${encodeURIComponent(name)}`;
      const r = await fetch(url, { headers: shopHeaders() });
      if (r.status === 403) return { error: "no_scope" };
      if (!r.ok) continue;
      const data = await r.json();
      if (data.orders && data.orders.length) return { order: data.orders[0] };
    } catch (e) {}
  }
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

async function lookupOrder({ orderId, phone, email }) {
  if (!process.env.SHOPIFY_STORE || !process.env.SHOPIFY_ADMIN_TOKEN) return { ok: false, reason: "error" };
  if (!orderId && !phone && !email) return { ok: false, reason: "need_any" };

  let order = null;
  if (orderId) {
    const found = await findOrderByNumber(orderId);
    if (found.error === "no_scope") return { ok: false, reason: "no_scope" };
    order = found.order;
  }
  if (!order && (email || phone)) {
    const r = await findOrderByContact(email, phone);
    if (r.error === "no_customer_scope") return { ok: false, reason: "no_customer_scope" };
    order = r.order;
  }
  if (!order) return { ok: false, reason: "not_found" };

  const fulfilled = order.fulfillment_status === "fulfilled" || (order.fulfillments && order.fulfillments.length > 0);
  const items = (order.line_items || []).map((li) => li.title).slice(0, 5);
  return {
    ok: true,
    order: {
      name: order.name,
      financial_status: order.financial_status,
      fulfillment_status: order.fulfillment_status || "unfulfilled",
      shipped: !!fulfilled,
      items,
    },
  };
}

async function groqCall(messages, opts) {
  const { temperature = 0.5, max_tokens = 200 } = opts || {};
  const r = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: GROQ_MODEL, messages, temperature, max_tokens }),
  });
  if (!r.ok) throw new Error(await r.text());
  const data = await r.json();
  return data?.choices?.[0]?.message?.content || "";
}

async function detectIntent(messages) {
  const convo = messages.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n");
  const prompt = `You are the intent classifier for Little Minors, a baby & kids store.
Classify the LAST customer message. Return ONLY JSON, no markdown:
{"intent":"product|order_status|talk_to_agent|place_order|greeting|other","search_query":""}
- "product": looking for/asking about items. Put clean search/category words (e.g. "azadi sale","boys jeans","baby bottle") in search_query.
- "order_status": wants to track/check an order.
- "talk_to_agent": wants a human/agent/support/complaint, or asks for phone number.
- "place_order": explicitly wants to order/buy now.
- "greeting": hi/hello/salaam/thanks only.
- "other": unclear/gibberish (e.g. "ss") or general question with no product. Never guess a product here.
Conversation:
${convo}`;
  try {
    const raw = await groqCall([{ role: "user", content: prompt }], { temperature: 0, max_tokens: 100 });
    const clean = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const p = JSON.parse(clean);
    return { intent: p.intent || "other", search_query: p.search_query || "" };
  } catch (e) { return { intent: "other", search_query: "" }; }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const waNumber = process.env.WHATSAPP_NUMBER || "";
  const callNumber = waNumber ? `+${waNumber}` : "";

  try {
    const body = req.body || {};

    // ---- Verified order tracking from the tracking form ----
    if (body.track) {
      const r = await lookupOrder(body.track);
      if (r.ok) {
        const itemsLine = r.order.items.length ? ` (${r.order.items.join(", ")})` : "";
        const status = r.order.shipped ? "shipped" : (r.order.fulfillment_status || "processing");
        return res.status(200).json({
          reply: `Order ${r.order.name}${itemsLine} — payment: ${r.order.financial_status}, status: ${status}.`,
          order: r.order,
          whatsappNumber: waNumber,
        });
      }
      const msg = {
        no_scope: "Order tracking isn't switched on yet. Please message us on WhatsApp and we'll check for you.",
        no_customer_scope: "Searching by phone/email isn't enabled. Please enter your order number instead.",
        need_any: "Please enter your order number, phone, or email.",
        not_found: "I couldn't find an order with those details. Please double-check and try again.",
        error: "I couldn't check the order right now. Please try again shortly.",
      }[r.reason] || "I couldn't check the order right now.";
      return res.status(200).json({ reply: msg, order: null, showCarriers: true, whatsappNumber: waNumber, callNumber });
    }

    const { messages } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array required" });
    }

    const lastMsg = ([...messages].reverse().find((m) => m.role === "user") || {}).content || "";

    // Quick carrier shortcut
    if (/\b(postex|ownexpress|own express|courier|carrier)\b/i.test(lastMsg)) {
      const reply = await shortReply(messages, "Customer asks about the courier/carrier. Tell them we ship via PostEx and OwnExpress, and they can track using the buttons below.");
      return res.status(200).json({ reply, products: [], action: "none", showCarriers: true, whatsappNumber: waNumber });
    }

    const intentData = await detectIntent(messages);
    let products = [];
    let action = "none";
    let showCall = false;
    let context = "";

    if (intentData.intent === "product") {
      const q = (intentData.search_query || lastMsg || "").toLowerCase();
      let results;
      if (/\b(discount|discounted|sale|deal|deals|offer|offers|cheap|off)\b/.test(q)) {
        // Customer wants discounted items — return products that actually have a discount
        const catalog = await getCatalog();
        results = catalog.filter((p) => p.discountPercent > 0)
          .sort((a, b) => b.discountPercent - a.discountPercent).slice(0, 20);
      } else {
        results = await categorySearch(intentData.search_query);
        if (!results) { const catalog = await getCatalog(); results = keywordSearch(catalog, intentData.search_query); }
      }
      products = results || [];
      if (products.length) {
        context = `Found ${products.length} matching products. In ONE short line, say you found some options and ask which they'd like. Do NOT list them (the cards show below).`;
      } else {
        showCall = true;
        context = `No matching products. In one short line say we don't have that right now and they can call us or ask for something else. Do NOT invent products.`;
      }
    } else if (intentData.intent === "order_status") {
      action = "track_form";
      context = `Customer wants to track an order. In one short line, ask them to fill the tracking form below.`;
    } else if (intentData.intent === "talk_to_agent") {
      action = "agent"; showCall = true;
      context = `Customer wants a human agent or our number. In one short line, tell them they can call or WhatsApp us using the buttons below.`;
    } else if (intentData.intent === "place_order") {
      action = "order_form";
      context = `Customer wants to place an order. In one short line, ask them to fill the quick form below.`;
    } else if (intentData.intent === "greeting") {
      context = `Greet warmly in ONE short line and ask how you can help.`;
    } else {
      context = `Unclear or not a product. Do NOT show products. In one short line, gently ask what they're looking for.`;
    }

    const reply = await shortReply(messages, context);

    return res.status(200).json({
      reply: reply || "How can I help?",
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
  return groqCall(
    [
      { role: "system", content: SYSTEM },
      { role: "system", content: `Context: ${context}` },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    { temperature: 0.5, max_tokens: 90 }
  );
}
