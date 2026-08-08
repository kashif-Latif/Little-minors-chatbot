// api/chat.js
// Little Minors AI chatbot backend — "Mimi Bot"
//
// SECURITY: No keys in this file. All secrets come from Vercel env vars.
//
// Required Vercel Environment Variables:
//   GROQ_API_KEY        - your Groq API key
//   SHOPIFY_STORE       - e.g. 45e8a2-44.myshopify.com
//   SHOPIFY_ADMIN_TOKEN - Admin API token (needs read_products, read_inventory, read_orders)
//   WHATSAPP_NUMBER     - digits only, international, e.g. 923018481401
//   PUBLIC_DOMAIN       - e.g. https://littleminors.com
//   ALLOWED_ORIGIN      - e.g. https://littleminors.com  (use * while testing)

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ---- Catalog: ACTIVE + PUBLISHED only (removes draft/old products) ----
let CATALOG = null;
let CATALOG_TIME = 0;
const CATALOG_TTL = 5 * 60 * 1000;

async function getCatalog() {
  const now = Date.now();
  if (CATALOG && now - CATALOG_TIME < CATALOG_TTL) return CATALOG;
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) return [];

  const storeBase = `https://${store}`;
  let all = [];
  let url = `https://${store}/admin/api/2024-10/products.json?limit=250&status=active&published_status=published`;

  try {
    for (let page = 0; page < 4 && url; page++) {
      const r = await fetch(url, {
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      });
      if (!r.ok) break;
      const data = await r.json();
      const products = (data.products || [])
        .filter((p) => (p.status ? p.status === "active" : true) && p.published_at)
        .map((p) => {
          const variant = (p.variants && p.variants[0]) || {};
          const image = (p.image && p.image.src) || (p.images && p.images[0] && p.images[0].src) || "";
          const price = parseFloat(variant.price || "0");
          const compareAt = parseFloat(variant.compare_at_price || "0");
          const hasDiscount = compareAt > price && price > 0;
          const discountPercent = hasDiscount ? Math.round((1 - price / compareAt) * 100) : 0;
          return {
            title: p.title || "",
            handle: p.handle || "",
            price: variant.price || "",
            compareAtPrice: hasDiscount ? variant.compare_at_price : "",
            discountPercent,
            available: (variant.inventory_quantity || 0) > 0,
            image,
            url: `${storeBase}/products/${p.handle}`,
            _text: `${p.title || ""} ${p.product_type || ""} ${p.tags || ""} ${p.vendor || ""}`.toLowerCase(),
          };
        });
      all = all.concat(products);
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

function keywords(text) {
  const STOP = new Set([
    "the","a","an","do","you","have","any","i","want","need","looking","for","me","show","some",
    "is","are","there","can","get","buy","please","of","to","in","on","and","with","my","your",
    "it","this","that","would","like","give","tell","about","product","products","item","items",
  ]);
  return (text || "")
    .toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function searchCatalog(catalog, query) {
  const kws = keywords(query);
  if (kws.length === 0) return [];
  const scored = catalog
    .map((p) => {
      let score = 0;
      for (const kw of kws) {
        if (p.title.toLowerCase().includes(kw)) score += 3;
        else if (p._text.includes(kw)) score += 1;
      }
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => (b.score - a.score) || ((b.p.available === true) - (a.p.available === true)));
  return scored.slice(0, 6).map((x) => x.p);
}

// ---- Phone normalize: compare last 10 digits ----
function normPhone(v) {
  const d = String(v || "").replace(/\D/g, "");
  return d.length > 10 ? d.slice(-10) : d;
}

// ---- Order lookup: locate by order number, verify with name/phone/email ----
// Requires order number PLUS at least one matching identity field.
async function lookupOrder({ orderId, name, phone, email }) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) return { ok: false, reason: "error" };
  if (!orderId) return { ok: false, reason: "need_order_id" };
  if (!name && !phone && !email) return { ok: false, reason: "need_identity" };

  const num = String(orderId).replace(/[^0-9]/g, "");
  const url = `https://${store}/admin/api/2024-10/orders.json?status=any&name=${encodeURIComponent(num)}`;

  try {
    const r = await fetch(url, {
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    });
    if (r.status === 403) return { ok: false, reason: "no_scope" };
    if (!r.ok) return { ok: false, reason: "error" };
    const data = await r.json();
    const order = (data.orders || [])[0];
    if (!order) return { ok: false, reason: "not_found" };

    // Gather identity fields from the order
    const oEmail = (order.email || "").toLowerCase().trim();
    const cust = order.customer || {};
    const ship = order.shipping_address || {};
    const oName = `${cust.first_name || ""} ${cust.last_name || ""} ${ship.name || ""}`.toLowerCase();
    const oPhones = [order.phone, ship.phone, cust.phone].map(normPhone).filter(Boolean);

    // Verify: at least one provided identity field matches
    let matched = false;
    if (email && oEmail && email.toLowerCase().trim() === oEmail) matched = true;
    if (phone && oPhones.includes(normPhone(phone))) matched = true;
    if (name && oName && oName.includes(name.toLowerCase().trim())) matched = true;

    if (!matched) return { ok: false, reason: "verify_failed" };

    const items = (order.line_items || []).map((li) => li.title).slice(0, 5);
    const tracking =
      (order.fulfillments && order.fulfillments[0] && order.fulfillments[0].tracking_url) || "";
    return {
      ok: true,
      order: {
        name: order.name,
        financial_status: order.financial_status,          // paid / pending
        fulfillment_status: order.fulfillment_status || "unfulfilled", // fulfilled / null
        tracking_url: tracking,
        items,
        created_at: order.created_at,
      },
    };
  } catch (e) {
    return { ok: false, reason: "error" };
  }
}

async function groqCall(messages, opts) {
  const { temperature = 0.5, max_tokens = 300 } = opts || {};
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
Classify the LAST customer message. Return ONLY valid JSON, no markdown:
{"intent":"product|order_status|talk_to_agent|place_order|greeting|other","search_query":""}

Rules:
- "product": looking for/asking about an item. Put clean search words in search_query. Ignore filler.
- "order_status": wants to track/check an existing order.
- "talk_to_agent": wants a human/agent/support/complaint.
- "place_order": explicitly wants to order/buy now.
- "greeting": hi/hello/salaam/thanks, no request.
- "other": unclear, gibberish (like "ss"), or general question with no product. Never guess a product here.

Conversation:
${convo}`;
  try {
    const raw = await groqCall([{ role: "user", content: prompt }], { temperature: 0, max_tokens: 120 });
    const clean = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean);
    return { intent: parsed.intent || "other", search_query: parsed.search_query || "" };
  } catch (e) {
    return { intent: "other", search_query: "" };
  }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const waNumber = process.env.WHATSAPP_NUMBER || "";

  try {
    const body = req.body || {};

    // ---- Direct order-tracking submission from the tracking form ----
    if (body.track) {
      const r = await lookupOrder(body.track);
      if (r.ok) {
        const itemsLine = r.order.items.length ? ` (${r.order.items.join(", ")})` : "";
        return res.status(200).json({
          reply: `Order ${r.order.name}${itemsLine} — payment: ${r.order.financial_status}, delivery: ${r.order.fulfillment_status}.`,
          order: r.order,
          whatsappNumber: waNumber,
        });
      }
      const msg = {
        no_scope: "Order tracking isn't enabled yet. Please contact us on WhatsApp and we'll check for you.",
        need_order_id: "Please enter your order number.",
        need_identity: "Please add your name, phone, or email so I can verify it's your order.",
        not_found: "I couldn't find an order with that number. Please double-check it.",
        verify_failed: "Those details don't match this order. Please check the name, phone, or email used at checkout.",
        error: "I couldn't check the order right now. Please try again shortly.",
      }[r.reason] || "I couldn't check the order right now.";
      return res.status(200).json({ reply: msg, order: null, whatsappNumber: waNumber });
    }

    const { messages } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array required" });
    }

    const intentData = await detectIntent(messages);
    let products = [];
    let action = "none";
    let contextForReply = "";

    if (intentData.intent === "product") {
      const catalog = await getCatalog();
      products = searchCatalog(catalog, intentData.search_query);
      contextForReply = products.length
        ? `Matching products (recommend ONLY these, mention discounts if any):\n${products
            .map((p, i) => `${i + 1}. ${p.title} - Rs ${p.price}${p.discountPercent ? ` (was Rs ${p.compareAtPrice}, ${p.discountPercent}% off)` : ""} - ${p.available ? "In stock" : "Out of stock"}`)
            .join("\n")}`
        : `No matching products found. Politely say we don't have that item right now; invite them to ask about something else. Do NOT list unrelated products.`;
    } else if (intentData.intent === "order_status") {
      action = "track_form";
      contextForReply = `Customer wants to track an order. Warmly ask them to fill the short tracking form below (order number + name/phone/email).`;
    } else if (intentData.intent === "talk_to_agent") {
      action = "agent";
      contextForReply = `Customer wants a human agent. Warmly tell them to use the WhatsApp button below to reach our team.`;
    } else if (intentData.intent === "place_order") {
      action = "order_form";
      contextForReply = `Customer wants to place an order. Warmly tell them to fill the quick form below and we'll confirm on WhatsApp.`;
    } else if (intentData.intent === "greeting") {
      contextForReply = `Greet warmly in one line and ask how you can help find something for their little one.`;
    } else {
      contextForReply = `The message is unclear or not about a specific product. Do NOT show products. Gently ask a clarifying question about what they're looking for.`;
    }

    const SYSTEM = `You are Mimi Bot, a warm, friendly assistant for Little Minors, a baby & kids store in Pakistan.
- Reply in the SAME language the customer used (English->English, Urdu->Urdu, Roman Urdu->Roman Urdu).
- Keep it to one or two short lines. Warm and helpful. No long paragraphs.
- Only mention products given in the context. Never invent products, prices, or order info.`;

    const reply = await groqCall(
      [
        { role: "system", content: SYSTEM },
        { role: "system", content: `Context for your reply:\n${contextForReply}` },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      { temperature: 0.5, max_tokens: 250 }
    );

    return res.status(200).json({
      reply: reply || "Sorry, I couldn't respond just now.",
      intent: intentData.intent,
      products,
      action,
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
