// ─────────────────────────────────────────────────────────────────────────────
// test-trade.mjs
// Diagnoses "invalid signature" errors by checking:
//   1. API key auth (L2)
//   2. Market info + negRisk value from Gamma API
//   3. Order signing with both negRisk=true and negRisk=false
//   4. Attempts a tiny $0.01 FOK order (will likely fail on liquidity, not sig)
//
// Run:  node test-trade.mjs
// ─────────────────────────────────────────────────────────────────────────────
import "dotenv/config";
import { Wallet }    from "@ethersproject/wallet";
import { createClient } from "@supabase/supabase-js";
import crypto        from "node:crypto";

// Import ClobClient normally — no axios patching needed
const { ClobClient, Side, OrderType } = await import("@polymarket/clob-client");

const CLOB_HOST = "https://clob.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";
const DATA_API  = "https://data-api.polymarket.com";
const CHAIN_ID  = 137;

// ── Decryption ───────────────────────────────────────────────────────────────
const encKey = Buffer.from(process.env.ENCRYPTION_SECRET, "utf-8");
function decrypt(s) {
  const [iv, tag, enc] = s.split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", encKey, Buffer.from(iv, "hex"));
  d.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(enc, "hex")), d.final()]).toString("utf-8");
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PolyWhale Trade Diagnostic");
  console.log("═══════════════════════════════════════════════════════════\n");

  // ── 1. Get client from Supabase ────────────────────────────────────────
  console.log("1️⃣  Fetching client from Supabase...");
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { data: clients, error } = await supabase.from("clients").select("*").eq("is_active", true);
  if (error || !clients?.length) { console.error("   ❌", error?.message || "No clients"); process.exit(1); }

  const row = clients[0];
  console.log(`   ✅ Client: ${row.label || row.id}`);
  console.log(`   Funder:   ${row.funder_address}\n`);

  // ── 2. Decrypt ─────────────────────────────────────────────────────────
  console.log("2️⃣  Decrypting credentials...");
  const dc = {
    private_key:     decrypt(row.private_key),
    poly_api_key:    decrypt(row.poly_api_key),
    poly_secret:     decrypt(row.poly_secret),
    poly_passphrase: decrypt(row.poly_passphrase),
    funder_address:  row.funder_address,
    trade_amount_usd: row.trade_amount_usd,
  };

  const pk = dc.private_key.startsWith("0x") ? dc.private_key : "0x" + dc.private_key;
  const signer = new Wallet(pk);
  console.log(`   ✅ EOA signer: ${signer.address}`);
  console.log(`   API key:      ${dc.poly_api_key}\n`);

  // ── 3. Test API auth ───────────────────────────────────────────────────
  console.log("3️⃣  Testing API key auth...");
  const clob = new ClobClient(
    CLOB_HOST, CHAIN_ID, signer,
    { key: dc.poly_api_key, secret: dc.poly_secret, passphrase: dc.poly_passphrase },
    2, dc.funder_address,
  );

  try {
    const keys = await clob.getApiKeys();
    console.log(`   ✅ Auth works — ${Array.isArray(keys) ? keys.length : "?"} key(s)\n`);
  } catch (e) {
    console.error(`   ❌ Auth failed: ${e.message}`);
    console.error("   Fix auth first before debugging signatures.\n");
    process.exit(1);
  }

  // ── 4. Find a recent active market to test against ─────────────────────
  console.log("4️⃣  Finding a test market...\n");

  // Try to get the same market the bot failed on, or any active market
  let testAsset, testConditionId, testTitle;

  // First, try getting the whale's recent trade for the exact market
  const whaleAddrs = (process.env.WHALE_ADDRESSES || "").split(",").map(a => a.trim().toLowerCase()).filter(Boolean);
  for (const addr of whaleAddrs.slice(0, 2)) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const r = await fetch(`${DATA_API}/activity?user=${addr}&type=TRADE&limit=1&start=${now - 300}&sortBy=TIMESTAMP&sortDirection=DESC`);
      if (r.ok) {
        const a = (await r.json())?.[0];
        if (a?.asset && a.conditionId) {
          testAsset = a.asset;
          testConditionId = a.conditionId;
          testTitle = a.title || "Unknown";
          console.log(`   Found recent whale trade: "${testTitle}"`);
          console.log(`   Asset: ${testAsset.slice(0, 20)}…`);
          console.log(`   ConditionId: ${testConditionId}\n`);
          break;
        }
      }
    } catch {}
  }

  if (!testConditionId) {
    console.log("   No recent whale trade found. Using a known active market...\n");
    // Fallback: fetch any active market from gamma API
    try {
      const r = await fetch(`${GAMMA_API}/markets?closed=false&limit=1`);
      if (r.ok) {
        const m = (await r.json())?.[0];
        if (m) {
          testConditionId = m.condition_id;
          testTitle = m.question || "Test market";
          // Need to get a token ID
          const tokens = m.tokens || [];
          if (tokens.length > 0) testAsset = tokens[0].token_id;
          console.log(`   Using market: "${testTitle}"`);
          console.log(`   ConditionId: ${testConditionId}\n`);
        }
      }
    } catch {}
  }

  if (!testConditionId) {
    console.error("   ❌ Could not find any market to test against.");
    process.exit(1);
  }

  // ── 5. Check market info and negRisk ───────────────────────────────────
  console.log("5️⃣  Fetching market info from Gamma API...\n");

  let marketData = null;
  try {
    const r = await fetch(`${GAMMA_API}/markets?condition_id=${testConditionId}`);
    if (r.ok) {
      const arr = await r.json();
      marketData = arr?.[0];
    }
  } catch {}

  if (!marketData) {
    // Try alternative endpoint
    try {
      const r = await fetch(`${GAMMA_API}/markets/${testConditionId}`);
      if (r.ok) marketData = await r.json();
    } catch {}
  }

  if (marketData) {
    console.log("   Raw market fields related to neg_risk:");
    console.log(`   neg_risk:             ${JSON.stringify(marketData.neg_risk)} (type: ${typeof marketData.neg_risk})`);
    console.log(`   negRisk:              ${JSON.stringify(marketData.negRisk)} (type: ${typeof marketData.negRisk})`);
    console.log(`   minimum_tick_size:    ${JSON.stringify(marketData.minimum_tick_size)}`);
    console.log(`   condition_id:         ${JSON.stringify(marketData.condition_id)}`);
    console.log(`   question:             ${JSON.stringify(marketData.question)?.slice(0, 80)}`);

    // Check what the bot's logic would produce
    const botNegRisk = marketData.neg_risk || false;
    const botTickSize = marketData.minimum_tick_size || "0.01";
    console.log(`\n   Bot would use:`);
    console.log(`   negRisk = ${JSON.stringify(botNegRisk)} (from: neg_risk || false)`);
    console.log(`   tickSize = ${JSON.stringify(botTickSize)}`);

    // Also check the enable_order_book field
    console.log(`\n   enable_order_book:     ${JSON.stringify(marketData.enable_order_book)}`);
    console.log(`   active:               ${JSON.stringify(marketData.active)}`);
    console.log(`   closed:               ${JSON.stringify(marketData.closed)}`);

    // Get token IDs
    if (marketData.tokens) {
      console.log(`\n   Tokens:`);
      for (const t of marketData.tokens) {
        console.log(`   - ${t.outcome}: ${t.token_id?.slice(0, 30)}…`);
        if (!testAsset) testAsset = t.token_id;
      }
    } else if (marketData.clobTokenIds) {
      console.log(`\n   clobTokenIds: ${JSON.stringify(marketData.clobTokenIds)}`);
      if (!testAsset && marketData.clobTokenIds?.length > 0) testAsset = marketData.clobTokenIds[0];
    }
  } else {
    console.log("   ⚠️  Could not fetch market data from Gamma API");
    console.log("   Trying with conditionId as-is...\n");
  }

  if (!testAsset) {
    console.error("   ❌ Could not determine token/asset ID for this market.");
    process.exit(1);
  }

  // ── 6. Try signing an order with BOTH negRisk values ───────────────────
  console.log("\n6️⃣  Testing order submission with both negRisk values...\n");

  const negRiskFromApi = marketData?.neg_risk;
  const tickSize = marketData?.minimum_tick_size || "0.01";

  for (const negRisk of [false, true]) {
    const label = `negRisk=${negRisk}`;
    console.log(`   ── Test: ${label} ──`);

    try {
      // Tiny FOK order — $0.50 at worst price, will likely fail on liquidity not sig
      const resp = await clob.createAndPostMarketOrder(
        {
          tokenID: testAsset,
          side: Side.BUY,
          amount: 0.50,   // $0.50 — minimal test amount
          price: 0.99,     // worst acceptable price
        },
        { tickSize, negRisk },
        OrderType.FOK,
      );

      if (resp?.success === true) {
        console.log(`   ✅ ${label}: ORDER ACCEPTED! oid=${resp.orderID || resp.orderIds?.[0]}`);
        console.log(`   This is the correct negRisk value!\n`);
      } else {
        const errMsg = resp?.error || resp?.errorMsg || JSON.stringify(resp);
        console.log(`   ${label}: ${errMsg}`);

        // Check if it's "invalid signature" or something else
        if (typeof errMsg === "string" && errMsg.includes("invalid signature")) {
          console.log(`   → Wrong negRisk value (signature uses wrong exchange contract)\n`);
        } else if (typeof errMsg === "string" && errMsg.includes("not enough liquidity")) {
          console.log(`   ✅ ${label}: Signature is VALID! (rejected for liquidity, not sig)\n`);
        } else {
          console.log(`   → Error: ${errMsg}\n`);
        }
      }
    } catch (e) {
      const msg = e.message || "";
      console.log(`   ${label}: threw — ${msg}`);
      if (msg.includes("invalid signature")) {
        console.log(`   → Wrong negRisk value\n`);
      } else if (msg.includes("not enough liquidity")) {
        console.log(`   ✅ ${label}: Signature VALID (liquidity issue only)\n`);
      } else {
        console.log(`   → ${msg}\n`);
      }
    }
  }

  // ── 7. Summary ─────────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  DIAGNOSIS SUMMARY");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  API auth:      ✅ Working`);
  console.log(`  Market:        ${testTitle}`);
  console.log(`  neg_risk (API): ${JSON.stringify(negRiskFromApi)} (type: ${typeof negRiskFromApi})`);
  console.log(`  Bot defaults to: negRisk = ${JSON.stringify(negRiskFromApi || false)}`);
  console.log("");
  console.log("  If BOTH negRisk values show 'invalid signature',");
  console.log("  the issue is NOT negRisk — it's likely that the EOA");
  console.log(`  (${signer.address})`);
  console.log(`  is not registered as a signer for the Safe`);
  console.log(`  (${dc.funder_address})`);
  console.log("  on the Polymarket exchange contracts.");
  console.log("");
  console.log("  To fix: open https://polymarket.com, connect with");
  console.log("  your wallet, and ensure your proxy/Safe is properly");
  console.log("  provisioned with the correct signer.");
  console.log("═══════════════════════════════════════════════════════════");
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
