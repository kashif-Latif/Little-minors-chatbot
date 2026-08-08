// api/chat.js
// Vercel serverless function for the Little Minors AI sales chatbot.
//
// SECURITY: This file contains NO keys. All secrets are read from
// Vercel Environment Variables (process.env). Never type a key into
// this file or commit a key to GitHub.
//
// Required Environment Variables (set these in Vercel dashboard):
//   GROQ_API_KEY        - your Groq API key
//   SHOPIFY_STORE       - your store domain, e.g. 45e8a2-44.myshopify.com
//   SHOPIFY_ADMIN_TOKEN - your Shopify Admin API access token
//   ALLOWED_ORIGIN      - your storefront URL, e.g. https://littleminors.com
//                         (use * while testing, then lock it down)

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = `You are Laila, a friendly sales assistant for Little Minors, a baby and kids store in Pakistan.

Rules:
- Reply in the SAME language the customer wrote in. English in, English out. Urdu in, Urdu out. Match their language every time.
- Keep answers to one or two short lines. Be direct and warm. No long paragraphs unless the customer explicitly asks for detail.
- You help customers find products, answer questions, and guide them to buy.
- Recommend ONLY from the products listed in the context below. Never invent products or prices.
- If the context says no matching products were found, tell the customer politely that you don't have that item right now, and invite them to ask about something else. Do NOT recommend unrelated products in that case.`;

// ---- CORS ----
function setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ---- Simple in-memory cache so we don't refetch the whole catalog every message ----
let CATALOG = null;
let CATALOG_TIME = 0;
const CATALOG_TTL = 5 * 60 * 1000; // 5 minutes

async function getCatalog() {
  const now = Date.now();
  if (CATALOG && now - CATALOG_TIME < CATALOG_TTL) return CATALOG;

  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) return [];

  const storeBase = `https://${store}`;
  let all = [];
  let url = `https://${store}/admin/api/2024-10/products.json?limit=250`;

  try {
    // Pull up to a few pages so bigger catalogs are fully searchable
    for (let page = 0; page < 4 && url; page++) {
      const r = await fetch(url, {
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      });
      if (!r.ok) break;
      const data = await r.json();
      const products = (data.products || []).map((p) => {
        const variant = (p.variants && p.variants[0]) || {};
        const image = (p.image && p.image.src) || (p.images && p.images[0] && p.images[0].src) || "";
        return {
          title: p.title || "",
          handle: p.handle || "",
          type: p.product_type || "",
          tags: p.tags || "",
          vendor: p.vendor || "",
          price: variant.price || "",
          available: (variant.inventory_quantity || 0) > 0,
          image,
          url: `${storeBase}/products/${p.handle}`,
          // searchable blob
          _text: `${p.title || ""} ${p.product_type || ""} ${p.tags || ""} ${p.vendor || ""}`.toLowerCase(),
        };
      });
      all = all.concat(products);

      // pagination via Link header
      const link = r.headers.get("link") || r.headers.get("Link");
      const next = link && link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
  } catch (e) {
    return CATALOG || [];
  }

  CATALOG = all;
  CATALOG_TIME = now;
  return all;
}

// ---- Keyword search over the catalog ----
const STOPWORDS = new Set([
  "the","a","an","do","you","have","any","i","want","need","looking","for","me","show","some",
  "is","are","there","can","get","buy","please","hi","hello","hey","of","to","in","on","and",
  "with","my","your","it","this","that","would","like","give","tell","about","kya","hai","ap",
  "aap","mujhe","chahiye","koi","he","ka","ki","ke","product","products","item","items"
]);

function keywords(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function searchCatalog(catalog, query) {
  const kws = keywords(query);
  if (kws.length === 0) return { matched: false, products: [] };

  const scored = catalog
    .map((p) => {
      let score = 0;
      for (const kw of kws) {
        if (p.title.toLowerCase().includes(kw)) score += 3; // title match weighs most
        else if (p._text.includes(kw)) score += 1;          // tag/type/vendor match
      }
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      // prefer higher score, then in-stock items
      if (b.score !== a.score) return b.score - a.score;
      return (b.p.available === true) - (a.p.available === true);
    });

  if (scored.length === 0) return { matched: false, products: [] };
  return { matched: true, products: scored.slice(0, 6).map((x) => x.p) };
}

// ---- Main handler ----
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array required" });
    }

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const catalog = await getCatalog();

    let matched = false;
    let products = [];
    if (lastUser && lastUser.content) {
      const result = searchCatalog(catalog, lastUser.content);
      matched = result.matched;
      products = result.products;
    }

    // Build product context honestly: only show products if we actually matched.
    const productContext = matched
      ? `Matching products (recommend ONLY from these):\n${products
          .map(
            (p, i) =>
              `${i + 1}. ${p.title} - Rs ${p.price} - ${p.available ? "In stock" : "Out of stock"}`
          )
          .join("\n")}`
      : `No matching products were found for what the customer asked. Tell them politely you don't have that item right now. Do NOT list unrelated products.`;

    const groqMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: productContext },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const groqRes = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: groqMessages,
        temperature: 0.5,
        max_tokens: 300,
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      return res.status(502).json({ error: "AI service error", detail: errText });
    }

    const groqData = await groqRes.json();
    const reply =
      groqData?.choices?.[0]?.message?.content || "Sorry, I couldn't respond just now.";

    // Only send product cards when we actually matched something.
    return res.status(200).json({ reply, products: matched ? products : [] });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e) });
  }
}
