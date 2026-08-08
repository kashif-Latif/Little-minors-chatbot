// api/chat.js
// Vercel serverless function for the Trenzee AI sales chatbot.
//
// SECURITY: This file contains NO keys. All secrets are read from
// Vercel Environment Variables (process.env). Never type a key into
// this file or commit a key to GitHub.
//
// Required Environment Variables (set these in Vercel dashboard):
//   GROQ_API_KEY      - your Groq API key
//   SHOPIFY_STORE     - your store domain, e.g. f9ikjt-d0.myshopify.com
//   SHOPIFY_ADMIN_TOKEN - your Shopify Admin API access token
//   ALLOWED_ORIGIN    - your storefront URL, e.g. https://trenzee.com
//                       (use * while testing, then lock it down)

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

// ---- System prompt: controls the bot's behaviour ----
const SYSTEM_PROMPT = `You are Aisha, a friendly sales assistant for Trenzee Cosmetics, a beauty store.

Rules:
- Reply in the SAME language the customer wrote in. English in, English out. Urdu in, Urdu out. Match their language every time.
- Keep answers to one or two short lines. Be direct and warm. No long paragraphs unless the customer explicitly asks for detail.
- You help customers find products, answer questions about them, and guide them to buy.
- When products are provided to you in the context, recommend from those. Never invent products or prices.
- If you don't have a matching product, say so politely and suggest they browse the store.`;

// ---- CORS helper ----
function setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ---- Fetch products from Shopify Admin API ----
async function searchProducts(query) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) return [];

  // Shopify Admin product search. We pull a handful of products and
  // let the model pick the best matches. `title` search keeps it simple.
  const url = `https://${store}/admin/api/2024-10/products.json?limit=10&title=${encodeURIComponent(query)}`;

  try {
    const r = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
    });
    if (!r.ok) return [];
    const data = await r.json();
    const storeBase = `https://${store}`;
    return (data.products || []).map((p) => {
      const variant = (p.variants && p.variants[0]) || {};
      const image = (p.image && p.image.src) || (p.images && p.images[0] && p.images[0].src) || "";
      return {
        title: p.title,
        price: variant.price || "",
        available: variant.inventory_quantity > 0,
        image,
        url: `${storeBase}/products/${p.handle}`,
      };
    });
  } catch (e) {
    return [];
  }
}

// If the title search returns nothing, fall back to a broad recent list
async function fallbackProducts() {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) return [];
  const url = `https://${store}/admin/api/2024-10/products.json?limit=6`;
  try {
    const r = await fetch(url, {
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    });
    if (!r.ok) return [];
    const data = await r.json();
    const storeBase = `https://${store}`;
    return (data.products || []).map((p) => {
      const variant = (p.variants && p.variants[0]) || {};
      const image = (p.image && p.image.src) || "";
      return {
        title: p.title,
        price: variant.price || "",
        available: variant.inventory_quantity > 0,
        image,
        url: `${storeBase}/products/${p.handle}`,
      };
    });
  } catch (e) {
    return [];
  }
}

// ---- Main handler ----
export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array required" });
    }

    // The latest user message drives product search
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    let products = [];
    if (lastUser && lastUser.content) {
      products = await searchProducts(lastUser.content);
      if (products.length === 0) products = await fallbackProducts();
    }

    // Give the model the product context so it recommends real items
    const productContext =
      products.length > 0
        ? `Available products (recommend from these only):\n${products
            .map(
              (p, i) =>
                `${i + 1}. ${p.title} - Rs ${p.price} - ${p.available ? "In stock" : "Out of stock"}`
            )
            .join("\n")}`
        : "No matching products found in the store right now.";

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
        temperature: 0.6,
        max_tokens: 300,
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      return res.status(502).json({ error: "AI service error", detail: errText });
    }

    const groqData = await groqRes.json();
    const reply =
      (groqData.choices &&
        groqData.choices[0] &&
        groqData.choices[0].message &&
        groqData.choices[0].message.content) ||
      "Sorry, I couldn't respond just now.";

    // Send back the reply plus the products so the widget can show image cards
    return res.status(200).json({ reply, products });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e) });
  }
}
