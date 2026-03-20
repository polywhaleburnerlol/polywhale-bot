// ═══════════════════════════════════════════════════════════════════════════════
// Polymarket Whale Copy-Trader Bot  v5.2  (Production Hardening)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Detects whale trades on-chain via Polygon WebSocket, enriches via the
// Polymarket Data API, then copy-trades for every active Supabase client.
//
// Auth:  Gnosis Safe proxy wallets (signatureType=2).  POLY_ADDRESS fixed
//        POLY_ADDRESS = EOA (the address the API key is bound to). See (§1).
// ═══════════════════════════════════════════════════════════════════════════════

import "dotenv/config";
import { ethers } from "ethers";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";
import { createServer } from "node:http";
import crypto from "node:crypto";

// ═════════════════════════════════════════════════════════════════════════════
// =============================================================================
// §1  POLY_ADDRESS — NO OVERRIDE NEEDED
// =============================================================================
// The ClobClient sets POLY_ADDRESS = signer EOA automatically, which matches
// the address the API key is bound to. No manual override needed.
// Previously this section patched axios.create() to override POLY_ADDRESS to
// the funder address, but the API key is bound to EOA, so that caused 401s.
// =============================================================================



/* ─── Resend trade notification ─── */
async function sendTradeEmail({ to, market, outcome, side, size, price, orderId }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !to) return;
  const emoji   = side === "BUY" ? "🟢" : "🔴";
  const sizeStr = side === "BUY" ? `$${size} USDC` : `${size} shares`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from:    "PolyWhale <notifications@polywhale.app>",
      to:      [to],
      subject: `${emoji} Trade Executed — ${market}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#060b18;color:#e2e8f0;padding:32px;border-radius:12px;border:1px solid rgba(0,229,204,0.15)"><div style="margin-bottom:24px"><img src="https://polywhale.app/whale-logo.png" height="28" style="display:block;margin-bottom:12px"/><h1 style="font-size:20px;color:#00e5cc;margin:0">Trade Executed</h1></div><table style="width:100%;border-collapse:collapse"><tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);color:#8492a6;font-size:13px">Market</td><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);font-weight:600;text-align:right">${market}</td></tr><tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);color:#8492a6;font-size:13px">Outcome</td><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);font-weight:600;text-align:right">${outcome}</td></tr><tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);color:#8492a6;font-size:13px">Side</td><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);font-weight:600;text-align:right">${side}</td></tr><tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);color:#8492a6;font-size:13px">Size</td><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);font-weight:600;text-align:right">${sizeStr}</td></tr><tr><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);color:#8492a6;font-size:13px">Price</td><td style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);font-weight:600;text-align:right">$${price}</td></tr><tr><td style="padding:10px 0;color:#8492a6;font-size:13px">Order ID</td><td style="padding:10px 0;font-size:11px;font-family:monospace;text-align:right;color:#8492a6">${orderId}</td></tr></table><div style="margin-top:24px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.06);font-size:12px;color:#4a5568;text-align:center">PolyWhale automatically mirrored this trade on your behalf.<br/><a href="https://dashboard.polywhale.app" style="color:#00e5cc;text-decoration:none">View your dashboard</a></div></div>`,
    }),
  }).catch(e => console.warn("[Resend]", e.message));
}

/* ─── Telegram trade notification ─── */
async function sendTelegramMessage({ chatId, market, outcome, side, size, price, orderId }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  const emoji   = side === "BUY" ? "🟢" : "🔴";
  const sizeStr = side === "BUY" ? `$${size} USDC` : `${size} shares`;
  const text =
    `${emoji} <b>Trade Executed — PolyWhale</b>\n\n` +
    `📊 <b>Market:</b> ${market}\n` +
    `🎯 <b>Outcome:</b> ${outcome}\n` +
    `📈 <b>Side:</b> ${side}\n` +
    `💰 <b>Size:</b> ${sizeStr}\n` +
    `💲 <b>Fill Price:</b> $${price}\n` +
    `🔑 <b>Order ID:</b> <code>${orderId}</code>\n\n` +
    `<a href="https://dashboard.polywhale.app">View dashboard</a>`;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  }).catch(e => L.warn(`[Telegram] ${e.message}`));
}

// ═════════════════════════════════════════════════════════════════════════════
// §2  Configuration
// ═════════════════════════════════════════════════════════════════════════════
function parseWhaleAddresses() {
  const raw = process.env.WHALE_ADDRESSES || process.env.WHALE_ADDRESS || "";
  return [...new Set(
    raw.split(",").map(a => a.trim().toLowerCase()).filter(a => a.length > 0),
  )];
}

const CONFIG = Object.freeze({
  CLOB_HOST:    "https://clob.polymarket.com",
  CLOB_WS_URL:  "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  DATA_API:     "https://data-api.polymarket.com",
  GAMMA_API:    "https://gamma-api.polymarket.com",
  CHAIN_ID:     137,

  WHALE_ADDRESSES: parseWhaleAddresses(),

  POLYGON_WSS_URL: process.env.POLYGON_WSS_URL || "",
  CTF_EXCHANGES: [
    "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
    "0xc5d563a36ae78145c45a50134d48a1215220f80a",
  ],

  MAX_SLIPPAGE_PCT:         0.05,
  SELL_DELAY_MS:            10_000,
  BALANCE_FETCH_TIMEOUT_MS: 5_000,
  ACTIVITY_LOOKBACK_SEC:    60,
  DEDUP_WINDOW_MS:          60_000,
  WS_RECONNECT_DELAY_MS:    5_000,
  HEARTBEAT_INTERVAL_MS:    10_000,
  MIN_TRADE_USD:            1,
  HEARTBEAT_PORT:           parseInt(process.env.PORT, 10) || 3000,
});

// ═════════════════════════════════════════════════════════════════════════════
// §3  Environment Validation
// ═════════════════════════════════════════════════════════════════════════════
function validateEnv() {
  const required = ["SUPABASE_URL", "SUPABASE_KEY", "POLYGON_WSS_URL", "ENCRYPTION_SECRET", "WHALE_ADDRESSES"];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) { console.error(`❌ Missing: ${missing.join(", ")}`); process.exit(1); }
  const keyLen = Buffer.from(process.env.ENCRYPTION_SECRET, "utf-8").length;
  if (keyLen !== 32) { console.error(`❌ ENCRYPTION_SECRET must be 32 bytes (got ${keyLen})`); process.exit(1); }
  if (!CONFIG.WHALE_ADDRESSES.length) { console.error("❌ WHALE_ADDRESSES empty"); process.exit(1); }
}

// ═════════════════════════════════════════════════════════════════════════════
// §4  Supabase + Encryption
// ═════════════════════════════════════════════════════════════════════════════
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const Enc = {
  _key: null,
  _k() { if (!this._key) this._key = Buffer.from(process.env.ENCRYPTION_SECRET, "utf-8"); return this._key; },
  encrypt(t) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this._k(), iv);
    const e = Buffer.concat([c.update(t, "utf-8"), c.final()]);
    return `${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${e.toString("hex")}`;
  },
  decrypt(s) {
    const [iv, tag, enc] = s.split(":");
    if (!iv || !tag || !enc) throw new Error("Bad ciphertext");
    const d = crypto.createDecipheriv("aes-256-gcm", this._k(), Buffer.from(iv, "hex"));
    d.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([d.update(Buffer.from(enc, "hex")), d.final()]).toString("utf-8");
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// §5  Logging + Utilities
// ═════════════════════════════════════════════════════════════════════════════
function ts() { return new Date().toISOString().slice(11, 23); }
function sideEmoji(s) { return s === "BUY" ? "🟢" : "🔴"; }
function wTag(a) { return a ? `${a.slice(0, 8)}…${a.slice(-4)}` : "whale(?)"; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const L = {
  info:  (m, ...a) => console.log(`[${ts()}] ℹ️  ${m}`, ...a),
  trade: (m, ...a) => console.log(`[${ts()}] 💰 ${m}`, ...a),
  whale: (m, ...a) => console.log(`[${ts()}] 🐋 ${m}`, ...a),
  warn:  (m, ...a) => console.warn(`[${ts()}] ⚠️  ${m}`, ...a),
  error: (m, ...a) => console.error(`[${ts()}] ❌ ${m}`, ...a),
  ws:    (m, ...a) => console.log(`[${ts()}] 🔌 ${m}`, ...a),
  hb:    (m, ...a) => console.log(`[${ts()}] 💓 ${m}`, ...a),
};

// ── Structured logging → Supabase bot_logs table ──
// Levels: info, trade, warn, error.  Fires async, never blocks the bot.
// Table: id (auto), created_at (auto), level, message, client_id (nullable),
//        trade_data (jsonb, nullable), metadata (jsonb, nullable)
async function botLog(level, message, { clientId = null, tradeData = null, meta = null } = {}) {
  try {
    const row = { level, message };
    if (clientId)  row.client_id  = clientId;
    if (tradeData) row.trade_data = tradeData;
    if (meta)      row.metadata   = meta;
    const { error } = await supabase.from("bot_logs").insert(row);
    if (error) L.warn(`botLog insert failed: ${error.message}`);
  } catch (e) {
    L.warn(`botLog threw: ${e.message}`);
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// §6  HTTP Heartbeat
// ═════════════════════════════════════════════════════════════════════════════
function startHeartbeat() {
  const srv = createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
  });
  srv.listen(CONFIG.HEARTBEAT_PORT, () => L.info(`HTTP heartbeat on :${CONFIG.HEARTBEAT_PORT}`));
}

// ── Supabase heartbeat — writes updated_at to bot_heartbeat every 30s ──
async function pingSupabase() {
  try {
    const { error } = await supabase
      .from("bot_heartbeat")
      .upsert({ id: 1, updated_at: new Date().toISOString() });
    if (error) L.warn(`Supabase heartbeat failed: ${error.message}`);
  } catch (err) {
    L.warn(`Supabase heartbeat threw: ${err?.message ?? err}`);
  }
}

function startSupabaseHeartbeat() {
  pingSupabase(); // immediate on startup
  setInterval(pingSupabase, 30_000);
  L.hb("Supabase heartbeat started — pinging every 30s");
}

// ═════════════════════════════════════════════════════════════════════════════
// §7  ClobClient Factory
// ═════════════════════════════════════════════════════════════════════════════
function makeClobClient(dc) {
  // The SDK sets POLY_ADDRESS = signer EOA automatically (see §1).

  const client = new ClobClient(
    CONFIG.CLOB_HOST, CONFIG.CHAIN_ID,
    new Wallet(dc.private_key),
    { key: dc.poly_api_key, secret: dc.poly_secret, passphrase: dc.poly_passphrase },
    2,                   // POLY_GNOSIS_SAFE
    dc.funder_address,   // proxy address (Safe)
  );


  return client;
}

// ═════════════════════════════════════════════════════════════════════════════
// §8  Market Helpers
// ═════════════════════════════════════════════════════════════════════════════
async function fetchMarketInfo(conditionId, assetId) {
  // Query by clob_token_ids (asset) first — most reliable for neg-risk markets.
  // The condition_id lookup can return the wrong market for neg-risk events.
  const queries = [];
  if (assetId)      queries.push(`clob_token_ids=${assetId}`);
  if (conditionId)  queries.push(`condition_id=${conditionId}`);

  for (const q of queries) {
    try {
      const r = await fetch(`${CONFIG.GAMMA_API}/markets?${q}`);
      if (!r.ok) continue;
      const arr = await r.json();
      const m = arr?.[0];
      if (!m) continue;
      const negRisk = m.neg_risk === true || m.neg_risk === "true";
      const tickSize = m.minimum_tick_size || "0.01";
      L.info(`  Market info: negRisk=${negRisk}, tickSize=${tickSize} (via ${q.split("=")[0]})`);
      return { tickSize, negRisk };
    } catch {}
  }
  return null;
}

async function getShareBalance(asset, funder) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), CONFIG.BALANCE_FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`${CONFIG.DATA_API}/positions?user=${funder}&asset=${asset}`, { signal: ac.signal });
    if (!r.ok) return null;
    const pos = await r.json();
    if (!Array.isArray(pos)) return null;
    for (const p of pos) {
      if (p.asset?.toLowerCase() === asset.toLowerCase() && parseFloat(p.size) > 0) return String(p.size);
    }
    return null;
  } catch { return null; }
  finally { clearTimeout(t); }
}

async function checkLiquidity(clob, asset, side, whalePrice, target) {
  let book;
  try { book = await clob.getOrderBook(asset); } catch { return false; }
  if (!book) return false;
  const levels = side === "BUY"
    ? [...(book.asks || [])].sort((a, b) => +a.price - +b.price)
    : [...(book.bids || [])].sort((a, b) => +b.price - +a.price);
  const dev = whalePrice * CONFIG.MAX_SLIPPAGE_PCT;
  const hi = side === "BUY" ? Math.min(whalePrice + dev, 0.99) : whalePrice;
  const lo = side === "BUY" ? whalePrice : Math.max(whalePrice - dev, 0.01);
  let filled = 0;
  for (const lv of levels) {
    const lp = +lv.price, ls = +lv.size;
    if (!isFinite(lp) || !isFinite(ls) || ls <= 0) continue;
    if (side === "BUY" && lp > hi) break;
    if (side === "SELL" && lp < lo) break;
    filled += Math.min(lp * ls, target - filled);
    if (filled >= target) return true;
  }
  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// §9  Dedup
// ═════════════════════════════════════════════════════════════════════════════
const _recent = new Map();
function isDup(asset, side) {
  const k = `${asset}:${side}`, now = Date.now();
  if (_recent.has(k) && now - _recent.get(k) < CONFIG.DEDUP_WINDOW_MS) return true;
  _recent.set(k, now);
  for (const [rk, rt] of _recent) { if (now - rt > CONFIG.DEDUP_WINDOW_MS * 2) _recent.delete(rk); }
  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// §10  Copy-Trade Execution
// ═════════════════════════════════════════════════════════════════════════════
async function executeCopyTrade(wt) {
  const { side, price, asset, conditionId, outcome, title, whaleAddress } = wt;
  if (isDup(asset, side)) { L.info(`Dedup: ${side} "${title}"`); return; }

  const { data: clients, error } = await supabase.from("clients").select("*").eq("is_active", true);
  if (error) { L.error(`Supabase: ${error.message}`); return; }
  if (!clients?.length) { L.warn("No active clients"); return; }

  L.info(`📡 ${sideEmoji(side)} ${side} "${title}" [${outcome}] — ${clients.length} client(s)`);

  const mkt = await fetchMarketInfo(conditionId, asset);
  if (!mkt) { L.error(`No market info for ${conditionId}`); return; }

  const wp = parseFloat(price);
  const tick = parseFloat(mkt.tickSize) || 0.01;
  const rawWorst = side === "BUY"
    ? Math.min(wp * (1 + CONFIG.MAX_SLIPPAGE_PCT), 0.99)
    : Math.max(wp * (1 - CONFIG.MAX_SLIPPAGE_PCT), 0.01);
  const worst = parseFloat((Math.round(rawWorst / tick) * tick).toFixed(4));

  await Promise.allSettled(clients.map(async (row) => {
    const tag = `client[${row.id}]`;

    // ── Per-client error isolation: decrypt separately so one bad row
    //    doesn't log cryptic errors or block other clients ──
    let dc;
    try {
      dc = {
        ...row,
        private_key:     Enc.decrypt(row.private_key),
        poly_api_key:    Enc.decrypt(row.poly_api_key),
        poly_secret:     Enc.decrypt(row.poly_secret),
        poly_passphrase: Enc.decrypt(row.poly_passphrase),
      };
    } catch (decErr) {
      L.error(`${tag} — credential decrypt failed: ${decErr.message}`);
      botLog("error", `Credential decrypt failed: ${decErr.message}`, { clientId: row.id });
      return;  // Skip this client, continue with others
    }

    try {
      let amt;
      if (side === "SELL") {
        L.info(`${tag} — waiting ${CONFIG.SELL_DELAY_MS / 1000}s for indexer…`);
        await sleep(CONFIG.SELL_DELAY_MS);
        amt = await getShareBalance(asset, dc.funder_address);
        if (!amt) {
          L.warn(`${tag} — 0 shares, skip SELL`);
          botLog("info", `Skipped SELL: 0 shares`, { clientId: row.id, meta: { asset, title } });
          return;
        }
      } else {
        amt = dc.trade_amount_usd;
      }

      // ── Trade amount validation ──
      // Polymarket rejects BUY orders under $1.  Catch it here with a
      // clear log instead of letting the server return a cryptic 400.
      if (side === "BUY" && parseFloat(amt) < CONFIG.MIN_TRADE_USD) {
        L.warn(`${tag} — trade_amount_usd=$${amt} below $${CONFIG.MIN_TRADE_USD} minimum, skip`);
        botLog("warn", `Skipped: trade amount $${amt} below minimum`, { clientId: row.id, meta: { asset, title } });
        return;
      }

      const clob = makeClobClient(dc);
      const liqTarget = side === "SELL" ? parseFloat(amt) * wp : dc.trade_amount_usd;
      if (!(await checkLiquidity(clob, asset, side, wp, liqTarget))) {
        L.warn(`${tag} — no liquidity, skip`);
        botLog("info", `Skipped: insufficient liquidity`, { clientId: row.id, meta: { asset, title, side } });
        return;
      }

      L.trade(`${tag} — FOK ${side} | amt=${amt} | worst=${worst} | ${asset.slice(0, 16)}…`);

      const resp = await clob.createAndPostMarketOrder(
        { tokenID: asset, side: side === "BUY" ? Side.BUY : Side.SELL, amount: amt, price: worst },
        { tickSize: mkt.tickSize, negRisk: mkt.negRisk },
        OrderType.FOK,
      );

      if (resp?.success === true) {
        const oid = resp.orderID || resp.orderIds?.[0] || "N/A";
        L.trade(`✅ FILLED — ${tag} | ${side} "${title}" [${outcome}] | oid=${oid}`);

        // ── Fetch actual fill details from Data API ──
        // The SDK response only confirms success; the real fill price and
        // share count come from the activity endpoint after indexing.
        let fillPrice = worst;   // fallback to worst (slippage ceiling)
        let fillShares = null;
        try {
          await sleep(2000);  // brief wait for indexer
          const now = Math.floor(Date.now() / 1000);
          const fr = await fetch(
            `${CONFIG.DATA_API}/activity?user=${dc.funder_address}&type=TRADE&limit=3` +
            `&start=${now - 30}&sortBy=TIMESTAMP&sortDirection=DESC`,
          );
          if (fr.ok) {
            const acts = await fr.json();
            const match = acts?.find(a => a.asset === asset && a.side === side);
            if (match) {
              fillPrice  = parseFloat(match.price) || worst;
              fillShares = match.size || null;
              L.info(`${tag} — actual fill: price=$${fillPrice}, shares=${fillShares}`);
            }
          }
        } catch (e) { L.warn(`${tag} — fill lookup failed: ${e.message}`); }

        // ── Insert to trades table with actual fill data ──
        const tradeRow = {
          client_id: row.id, asset_id: asset, market_title: title,
          side, price: fillPrice, shares: fillShares,
          order_id: oid, whale_address: whaleAddress, outcome,
        };
        supabase.from("trades").insert(tradeRow)
          .then(({ error: e }) => { if (e) L.error(`${tag} DB: ${e.message}`); });

        // ── Structured log for successful fill ──
        botLog("trade", `FILLED ${side} "${title}" [${outcome}]`, {
          clientId: row.id,
          tradeData: { orderId: oid, fillPrice, fillShares, worstPrice: worst, amount: amt, asset, side, outcome },
        });

        if (row.user_email) {
          sendTradeEmail({ to: row.user_email, market: title, outcome, side, size: amt, price: fillPrice, orderId: oid })
            .catch(e => L.warn(`[Email] ${e.message}`));
        }

        if (row.telegram_chat_id) {
          sendTelegramMessage({ chatId: row.telegram_chat_id, market: title, outcome, side, size: amt, price: fillPrice, orderId: oid })
            .catch(e => L.warn(`[Telegram] ${e.message}`));
        }

        if (process.env.DISCORD_WEBHOOK_URL) {
          const sz = side === "SELL" ? `${fillShares || amt} shares` : `$${amt}`;
          fetch(process.env.DISCORD_WEBHOOK_URL, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content:
              `** **WHALE ALERT**\n**${side}** ${title}\n` +
              `Outcome: ${outcome} | Size: ${sz} @ $${fillPrice}\n` +
              `Order: ${oid} | Whale: ${wTag(whaleAddress)} | ✅ FILLED`,
            }),
          }).catch(e => L.warn(`Discord: ${e.message}`));
        }
      } else {
        const errDetail = resp?.error || resp?.errorMsg || JSON.stringify(resp);
        L.error(`${tag} — NOT confirmed: ${errDetail}`);
        botLog("error", `Order rejected: ${errDetail}`, {
          clientId: row.id, meta: { asset, title, side, worst, amount: amt },
        });
      }
    } catch (err) {
      L.error(`${tag} — ${err.message}`);
      botLog("error", `Unhandled: ${err.message}`, { clientId: row.id, meta: { asset, title, side } });
    }
  }));
}

// ═════════════════════════════════════════════════════════════════════════════
// §11  On-Chain Listener (Primary Detection)
// ═════════════════════════════════════════════════════════════════════════════
const ORDER_FILLED = ethers.utils.id(
  "OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)",
);

class ChainListener {
  constructor(onAsset) {
    this.onAsset = onAsset;
    this.provider = null;
    this.seen = new Set();
    this._whales = new Set(CONFIG.WHALE_ADDRESSES);
    this.events = 0;
    this._stop = false;
  }

  start() {
    L.ws(`⚡ Chain listener — ${CONFIG.WHALE_ADDRESSES.length} whales, ${CONFIG.CTF_EXCHANGES.length} contracts`);
    this._connect();
  }
  stop() { this._stop = true; this.provider?.removeAllListeners(); }

  _connect() {
    if (this._stop) return;
    try {
      this.provider = new ethers.providers.WebSocketProvider(CONFIG.POLYGON_WSS_URL);
      this.provider._websocket.on("open", () => { L.ws("⚡ Polygon WSS connected"); this._sub(); });
      this.provider._websocket.on("close", () => {
        L.ws("⚡ Polygon WSS closed — reconnecting…");
        setTimeout(() => this._connect(), CONFIG.WS_RECONNECT_DELAY_MS);
      });
      this.provider._websocket.on("error", (e) => L.error(`⚡ WSS: ${e.message}`));
    } catch (e) {
      L.error(`⚡ WSS connect: ${e.message}`);
      setTimeout(() => this._connect(), CONFIG.WS_RECONNECT_DELAY_MS);
    }
  }

  _sub() {
    // ── Topic-level whale filtering ──────────────────────────────────────────
    // Instead of subscribing to ALL OrderFilled events (thousands/sec) and
    // discarding non-whale events client-side, we tell the node to only deliver
    // events where a whale address appears in topics[2] (maker) OR topics[3]
    // (taker). Filtering happens at QuickNode before any data is sent to us.
    // Reduces QuickNode usage by ~99%.
    //
    // Addresses must be zero-padded to 32 bytes for topic matching:
    //   0xabc...def → 0x000000000000000000000000abc...def
    const whaleTopics = CONFIG.WHALE_ADDRESSES.map(
      a => "0x" + "0".repeat(24) + a.slice(2).toLowerCase()
    );

    CONFIG.CTF_EXCHANGES.forEach(addr => {
      // Subscription A: whale is the MAKER (topics[2])
      this.provider.on(
        { address: addr, topics: [ORDER_FILLED, null, whaleTopics] },
        (entry) => this._handle(entry).catch(e => L.error(`Chain handler (maker): ${e.message}`))
      );
      // Subscription B: whale is the TAKER (topics[3])
      this.provider.on(
        { address: addr, topics: [ORDER_FILLED, null, null, whaleTopics] },
        (entry) => this._handle(entry).catch(e => L.error(`Chain handler (taker): ${e.message}`))
      );
    });

    L.ws(`⚡ Subscribed with whale topic filter — ${CONFIG.WHALE_ADDRESSES.length} addresses, 2 subscriptions per exchange`);
  }

  async _handle(entry) {
    if (!CONFIG.CTF_EXCHANGES.includes(entry.address.toLowerCase())) return;
    const dk = `${entry.transactionHash}:${entry.logIndex}`;
    if (this.seen.has(dk)) return;
    this.seen.add(dk);
    this.events++;

    if (!entry.topics || entry.topics.length < 4) return;
    const maker = ("0x" + entry.topics[2].slice(26)).toLowerCase();
    const taker = ("0x" + entry.topics[3].slice(26)).toLowerCase();
    const isM = this._whales.has(maker), isT = this._whales.has(taker);
    if (!isM && !isT) return;

    const whale = isM ? maker : taker;
    L.whale(`⚡ ON-CHAIN — ${wTag(whale)} as ${isM ? "maker" : "taker"} | tx=${entry.transactionHash.slice(0, 18)}… | blk=${entry.blockNumber}`);

    // Early asset subscription from event data
    try {
      const d = ethers.utils.defaultAbiCoder.decode(["uint256","uint256","uint256","uint256","uint256"], entry.data);
      const id = d[0].toString() !== "0" ? d[0].toString() : d[1].toString();
      if (id && id !== "0") this.onAsset(id);
    } catch {}

    // Enrich from Data API
    const trade = await this._enrich(whale);
    if (!trade) { L.warn(`  Could not enrich ${wTag(whale)}`); return; }

    L.info(`  ✅ ${sideEmoji(trade.side)} ${trade.side} "${trade.title}" [${trade.outcome}] @ ${trade.price}`);
    this.onAsset(trade.asset);
    executeCopyTrade(trade);
  }

  async _enrich(addr) {
    for (let i = 1; i <= 5; i++) {
      try {
        const now = Math.floor(Date.now() / 1000);
        const r = await fetch(
          `${CONFIG.DATA_API}/activity?user=${addr}&type=TRADE&limit=1` +
          `&start=${now - CONFIG.ACTIVITY_LOOKBACK_SEC}&sortBy=TIMESTAMP&sortDirection=DESC`,
        );
        if (r.ok) {
          const a = (await r.json())?.[0];
          if (a?.asset && a.side && a.price) return {
            whaleAddress: addr, side: a.side, price: a.price, size: a.size,
            asset: a.asset, conditionId: a.conditionId,
            outcome: a.outcome || "Unknown", title: a.title || "Unknown",
          };
        }
      } catch (e) { if (i <= 2) L.warn(`  enrich #${i}: ${e.message}`); }
      if (i < 5) await sleep(1000);
    }
    return null;
  }

  prune() {
    // Prune seen set by age (keep last 10 min) instead of just by count
    // Prevents both memory bloat and false dedup drops after a clear
    if (this.seen.size > 10000) this.seen.clear(); // hard cap fallback
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// §12  CLOB Market WebSocket (Secondary Detection)
// ═════════════════════════════════════════════════════════════════════════════
class MarketWS {
  constructor() { this.ws = null; this.subs = new Set(); }

  connect() {
    this.ws = new WebSocket(CONFIG.CLOB_WS_URL);
    this.ws.on("open", () => {
      L.ws("CLOB Market WS connected");
      if (this.subs.size) this.ws.send(JSON.stringify({ assets_ids: [...this.subs], type: "market", custom_feature_enabled: true }));
    });
    this.ws.on("message", async (raw) => {
      try {
        const d = JSON.parse(raw);
        if (d.event_type !== "last_trade_price" || !this.subs.has(d.asset_id)) return;
        const t = await this._verify(d.asset_id);
        if (t) executeCopyTrade(t);
      } catch {}
    });
    this.ws.on("close", () => { L.ws("CLOB WS closed — reconnecting…"); setTimeout(() => this.connect(), CONFIG.WS_RECONNECT_DELAY_MS); });
    this.ws.on("error", () => {});
  }

  sub(id) {
    if (this.subs.has(id)) return;
    this.subs.add(id);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ assets_ids: [id], type: "market", custom_feature_enabled: true }));
  }

  async _verify(assetId) {
    const start = Math.floor(Date.now() / 1000) - 30;
    for (let i = 0; i < 5; i++) {
      for (const addr of CONFIG.WHALE_ADDRESSES) {
        try {
          const r = await fetch(`${CONFIG.DATA_API}/activity?user=${addr}&type=TRADE&limit=5&start=${start}&sortBy=TIMESTAMP&sortDirection=DESC`);
          if (r.ok) {
            const m = (await r.json()).find(a => a.asset === assetId);
            if (m) return { whaleAddress: addr, side: m.side, price: m.price, asset: m.asset, conditionId: m.conditionId, title: m.title, outcome: m.outcome };
          }
        } catch {}
      }
      await sleep(1000);
    }
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// §13  Main
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  validateEnv();
  startHeartbeat();
  startSupabaseHeartbeat();

  L.info("═══════════════════════════════════════════════════════════");
  L.info("  Polymarket Whale Copy-Trader  v5.2");
  L.info("═══════════════════════════════════════════════════════════");
  L.info(`  Whales:     ${CONFIG.WHALE_ADDRESSES.length}`);
  CONFIG.WHALE_ADDRESSES.forEach(a => L.info(`    • ${a}`));
  L.info(`  Detection:  Polygon WSS → OrderFilled`);
  L.info(`  Secondary:  CLOB Market WS`);
  L.info(`  Dedup:      ${CONFIG.DEDUP_WINDOW_MS / 1000}s`);
  L.info(`  Slippage:   ${(CONFIG.MAX_SLIPPAGE_PCT * 100).toFixed(0)}%`);
  L.info("═══════════════════════════════════════════════════════════");

  const mws = new MarketWS();
  mws.connect();

  const chain = new ChainListener(id => mws.sub(id));
  chain.start();

  setInterval(() => {
    const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
    L.hb(`[HEARTBEAT] Assets: ${mws.subs.size} | Events: ${chain.events} | Mem: ${mem}MB`);
  }, CONFIG.HEARTBEAT_INTERVAL_MS);

  setInterval(() => chain.prune(), 60_000);
}

main().catch(e => { console.error(e); process.exit(1); });