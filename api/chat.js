// api/chat.js
// Little Minors AI chatbot backend — "Mimi Bot"
//
// SECURITY: No keys in this file. All secrets come from Vercel env vars.
//
// Required Vercel Environment Variables:
//   GROQ_API_KEY        - your Groq API key
//   SHOPIFY_STORE       - e.g. 45e8a2-44.myshopify.com
//   SHOPIFY_ADMIN_TOKEN - Admin API token (needs read_products, read_inventory, read_orders)
//   WHATSAPP_NUMBER     - your WhatsApp number, international format, digits only
//                         e.g. 923001234567  (92 = Pakistan, no +, no spaces)
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
          const image =
            (p.image && p.image.src) ||
            (p.images && p.images[0] && p.images[0].src) ||
            "";
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
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
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

// ---- Order lookup: verified by order number + email ----
async function lookupOrder(orderId, email) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token || !orderId || !email) return { ok: false, reason: "missing" };

  const name = String(orderId).replace(/[^0-9]/g, "");
  const url = `https://${store}/admin/api/2024-10/orders.json?status=any&name=${encodeURIComponent(name)}`;

  try {
    const r = await fetch(url, {
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    });
    if (r.status === 403) return { ok: false, reason: "no_scope" };
    if (!r.ok) return { ok: false, reason: "error" };
    const data = await r.json();
    const order = (data.orders || []).find(
      (o) => (o.email || "").toLowerCase() === String(email).toLowerCase().trim()
    );
    if (!order) return { ok: false, reason: "not_found" };

    const fulfillment = order.fulfillment_status || "unfulfilled";
    const tracking =
      (order.fulfillments && order.fulfillments[0] && order.fulfillments[0].tracking_url) || "";
    return {
      ok: true,
      order: {
        name: order.name,
        financial_status: order.financial_status,
        fulfillment_status: fulfillment,
        tracking_url: tracking,
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
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: GROQ_MODEL, messages, temperature, max_tokens }),
  });
  if (!r.ok) throw new Error(await r.text());
  const data = await r.json();
  return data?.choices?.[0]?.message?.content || "";
}

// Step 1: understand intent (the "think first" step)
async function detectIntent(messages) {
  const convo = messages.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n");

  const prompt = `You are the intent classifier for Little Minors, a baby & kids store.
Read the conversation and classify the LAST customer message.

Return ONLY valid JSON, no markdown, no extra text, in this exact shape:
{"intent":"product|order_status|talk_to_agent|place_order|greeting|other","search_query":"","order_id":"","email":""}

Rules:
- "product": customer is looking for or asking about an item to buy. Put clean search words (e.g. "baby bottle", "girls trouser") in search_query. Ignore filler.
- "order_status": customer wants to track/check an existing order. Extract order_id and email if present.
- "talk_to_agent": customer wants a human/agent/support/complaint.
- "place_order": customer explicitly wants to order/buy now / place an order.
- "greeting": hi/hello/salaam/thanks with no request.
- "other": anything unclear, gibberish (like "ss"), or a general question with no product.
- If the message is not clearly about a product, DO NOT guess a product. Use "other".

Conversation:
${convo}`;

  try {
    const raw = await groqCall([{ role: "user", content: prompt }], { temperature: 0, max_tokens: 150 });
    const clean = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(clean);
    return {
      intent: parsed.intent || "other",
      search_query: parsed.search_query || "",
      order_id: parsed.order_id || "",
      email: parsed.email || "",
    };
  } catch (e) {
    return { intent: "other", search_query: "", order_id: "", email: "" };
  }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const waNumber = process.env.WHATSAPP_NUMBER || "";

  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array required" });
    }

    const intentData = await detectIntent(messages);

    let products = [];
    let orderResult = null;
    let action = "none";
    let contextForReply = "";

    if (intentData.intent === "product") {
      const catalog = await getCatalog();
      products = searchCatalog(catalog, intentData.search_query);
      contextForReply = products.length
        ? `Matching products (recommend ONLY these, mention discounts if any):\n${products
            .map(
              (p, i) =>
                `${i + 1}. ${p.title} - Rs ${p.price}${
                  p.discountPercent ? ` (was Rs ${p.compareAtPrice}, ${p.discountPercent}% off)` : ""
                } - ${p.available ? "In stock" : "Out of stock"}`
            )
            .join("\n")}`
        : `No matching products found. Politely say we don't have that item right now; invite them to ask about something else. Do NOT list unrelated products.`;
    } else if (intentData.intent === "order_status") {
      if (intentData.order_id && intentData.email) {
        const r = await lookupOrder(intentData.order_id, intentData.email);
        orderResult = r;
        if (r.ok) {
          contextForReply = `Order ${r.order.name}: payment ${r.order.financial_status}, delivery ${r.order.fulfillment_status}.${
            r.order.tracking_url ? " A tracking link is available." : ""
          } Share this status warmly in one or two lines.`;
        } else if (r.reason === "no_scope") {
          contextForReply = `Order tracking is not enabled yet. Ask the customer to contact support.`;
        } else if (r.reason === "not_found") {
          contextForReply = `No order matched that ID and email. Ask them to double-check the order number and the email used at checkout.`;
        } else {
          contextForReply = `Could not check the order right now. Ask them to try again shortly.`;
        }
      } else {
        contextForReply = `Customer wants order status but hasn't given both details. Ask for their order number AND the email used at checkout, in one short line.`;
      }
    } else if (intentData.intent === "talk_to_agent") {
      action = "agent";
      contextForReply = `Customer wants a human agent. Warmly tell them they can chat with our team on WhatsApp using the button below.`;
    } else if (intentData.intent === "place_order") {
      action = "order_form";
      contextForReply = `Customer wants to place an order. Warmly tell them to fill the quick form below and we'll take their order on WhatsApp.`;
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
      order: orderResult && orderResult.ok ? orderResult.order : null,
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
