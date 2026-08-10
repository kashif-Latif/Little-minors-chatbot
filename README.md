# 🐝 Bee Bot — Little Minors AI Chat Assistant

An AI-powered sales chatbot embedded on the **Little Minors** Shopify store (baby & kids).
It chats with customers, searches live products, handles order tracking, takes orders via
WhatsApp, and hands off to a human agent — all on free/low-cost API tiers.

---

## What it does

- **AI conversation** in the customer's own language (English / Urdu / Roman Urdu).
- **Live product search** — finds real products with current prices, stock, discounts, and images.
- **Order tracking** — by order number (#LM), tracking ID, phone, or email. Shows order name,
  total, payment status, fulfilment status, courier, and tracking number.
- **Place an order** — a form that sends the order to your WhatsApp.
- **Talk to an agent** — WhatsApp handoff (Mon–Sat, 10am–6pm, replies in 1–2 hours).
- **Store policy** — 7-day EXCHANGE only (no returns/refunds).

---

## Architecture (6 parts)

| # | Part | Where it lives | Holds keys? |
|---|------|----------------|-------------|
| 1 | **Widget** (`little-minors-chat-widget.liquid`) | Shopify theme snippet `chat-widget` | ❌ No |
| 2 | **Backend** (`api/chat.js`) | This repo → Vercel | ✅ Yes (env vars) |
| 3 | **AI providers** | Groq + Gemini (via backend) | — |
| 4 | **Shopify Admin API** | Live price/stock/orders | — |
| 5 | **Shopify `suggest.json`** | Storefront search engine (no key) | — |
| 6 | **WhatsApp** | Human handoff / order confirmation | — |

**Message flow:** customer types → widget → backend → AI understands intent →
`suggest.json` finds products → Admin API verifies live price/stock → AI writes one-line reply →
widget shows product cards + reply.

---

## AI fallback chain (self-healing)

Tried in order; drops to the next automatically on rate-limit (429) or error:

```
Groq llama-3.3-70b  →  Groq llama-3.1-8b-instant  →  Gemini 3.6 Flash  →  Gemini 3.5 Flash-Lite  →  keyword fallback
```

Re-evaluated fresh on every message, so it recovers the moment Groq's limit resets.
If all AIs are down, it still shows live products with a simple reply (never a hard error).

---

## Search strategy

1. **Pack shortcut** — "pack of 3 / 4 / 5", "all packs" → shows those packs (typed queries only).
2. **Discount** — "sale / discount / deal" → discounted items, highest % first.
3. **Product search** — Shopify `suggest.json` (the store's own search engine) ranks results;
   each is matched back to live Admin data for accurate price/stock/image.
   - Specific query (a product name) → the accurate product.
   - Broad query ("boys pants") → many, for browsing.
   - Typos are cleaned by the AI first ("trowser" → "trouser").

---

## Repository structure

```
.
├── api/
│   └── chat.js          ← backend (MUST be at api/chat.js)
├── package.json
├── .gitignore
└── .gitattributes
```

> The widget (`little-minors-chat-widget.liquid`) does **not** go in this repo —
> it is pasted into the Shopify theme.

---

## Environment variables (set in Vercel → Settings → Environment Variables)

| Variable | Value / Notes |
|----------|---------------|
| `GROQ_API_KEY` | Groq API key |
| `GEMINI_API_KEY` | Gemini API key (optional but recommended) |
| `SHOPIFY_STORE` | Little Minors `*.myshopify.com` domain |
| `SHOPIFY_ADMIN_TOKEN` | Shopify Admin API access token (`shpat_…`) |
| `WHATSAPP_NUMBER` | `923018481401` |
| `PUBLIC_DOMAIN` | `https://littleminors.com` |
| `ALLOWED_ORIGIN` | `https://littleminors.com` (use `*` while testing) |
| `GROQ_MODELS` | *(optional)* comma-separated model override |
| `GEMINI_MODELS` | *(optional)* comma-separated model override |

**Shopify Admin token scopes required:** `read_products`, `read_inventory`, `read_orders`, `read_customers`.

> 🔒 Keys live **only** in Vercel — never in the code or the widget.

---

## Deploy

1. **Backend:** push this repo to GitHub → import into Vercel → add env vars → Deploy.
   Vercel gives a URL like `https://<project>.vercel.app`. Endpoint: `/api/chat`.
2. **Widget:** in Shopify → Online Store → Themes → Edit code → Snippets → add
   `chat-widget` → paste `little-minors-chat-widget.liquid` (ensure `VERCEL_URL` points to
   your backend `/api/chat`). Then in `theme.liquid`, before `</body>`, add:
   ```liquid
   {% render 'chat-widget' %}
   ```
3. Hard-refresh the site (Ctrl+Shift+R).

**Health check:** open `https://<project>.vercel.app/api/chat` → "Method not allowed" = alive.

---

## Notes

- Product data is fetched **live** from Shopify every time — nothing is stored.
- Conversations persist only in the customer's browser (localStorage), cleared on "New chat".
- Order form collects **Size** (baby/kids clothing).
- Carriers: **PostEx** and **OwnExpress**.
- This bot is fully separate from **Trixi Bot** (Trenzee) — different Vercel project & store keys,
  so the two never share products.
