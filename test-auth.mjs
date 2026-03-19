// ─────────────────────────────────────────────────────────────────────────────
// test-auth.mjs
// Tests whether the API credentials stored in Supabase actually work.
// Does NOT place any trades — only calls read-only authenticated endpoints.
//
// Run:  node test-auth.mjs
// ─────────────────────────────────────────────────────────────────────────────
import "dotenv/config";
import { Wallet }    from "@ethersproject/wallet";
import axios from "axios";
import crypto        from "node:crypto";
import { createClient } from "@supabase/supabase-js";

// ── Same POLY_ADDRESS fix as bot.js ──────────────────────────────────────────
const _apiKeyToFunder = new Map();
function _fixPolyAddress(config) {
  if (config.headers) {
    const apiKey = config.headers["POLY_API_KEY"] || config.headers["poly_api_key"];
    if (apiKey) {
      const funder = _apiKeyToFunder.get(String(apiKey));
      if (funder) config.headers["POLY_ADDRESS"] = funder;
    }
  }
  return config;
}
const _origAxiosCreate = axios.create;
axios.create = function patchedCreate(...args) {
  const instance = _origAxiosCreate.apply(this, args);
  instance.interceptors.request.use(_fixPolyAddress);
  return instance;
};
axios.interceptors.request.use(_fixPolyAddress);

const { ClobClient } = await import("@polymarket/clob-client");

// ── Decryption ───────────────────────────────────────────────────────────────
const encKey = Buffer.from(process.env.ENCRYPTION_SECRET, "utf-8");
function decrypt(s) {
  const [iv, tag, enc] = s.split(":");
  if (!iv || !tag || !enc) throw new Error("Bad ciphertext format");
  const d = crypto.createDecipheriv("aes-256-gcm", encKey, Buffer.from(iv, "hex"));
  d.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(enc, "hex")), d.final()]).toString("utf-8");
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PolyWhale Auth Diagnostic");
  console.log("═══════════════════════════════════════════════════════════\n");

  // ── 1. Fetch client row from Supabase ──────────────────────────────────
  console.log("1️⃣  Fetching active client from Supabase...");
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { data: clients, error } = await supabase.from("clients").select("*").eq("is_active", true);

  if (error) { console.error("   ❌ Supabase error:", error.message); process.exit(1); }
  if (!clients?.length) { console.error("   ❌ No active clients found"); process.exit(1); }

  const row = clients[0];
  console.log(`   ✅ Found client: ${row.label || row.id}`);
  console.log(`   Funder address:  ${row.funder_address}\n`);

  // ── 2. Decrypt credentials ─────────────────────────────────────────────
  console.log("2️⃣  Decrypting stored credentials...");
  let dc;
  try {
    dc = {
      private_key:     decrypt(row.private_key),
      poly_api_key:    decrypt(row.poly_api_key),
      poly_secret:     decrypt(row.poly_secret),
      poly_passphrase: decrypt(row.poly_passphrase),
      funder_address:  row.funder_address,
    };
    console.log("   ✅ All 4 fields decrypted successfully");
    console.log(`   API key:    ${dc.poly_api_key}`);
    console.log(`   Secret:     ${dc.poly_secret.slice(0, 8)}...`);
    console.log(`   Passphrase: ${dc.poly_passphrase.slice(0, 8)}...`);
  } catch (e) {
    console.error("   ❌ Decryption failed:", e.message);
    console.error("   Your ENCRYPTION_SECRET may not match what was used to encrypt.");
    process.exit(1);
  }

  // ── 3. Derive EOA address from private key ─────────────────────────────
  console.log("\n3️⃣  Checking wallet...");
  const pk = dc.private_key.startsWith("0x") ? dc.private_key : "0x" + dc.private_key;
  const signer = new Wallet(pk);
  console.log(`   EOA signer:  ${signer.address}`);
  console.log(`   Funder/Safe: ${dc.funder_address}`);

  // ── 4. Build ClobClient and test authenticated call ────────────────────
  console.log("\n4️⃣  Testing authenticated API call (getApiKeys)...");
  _apiKeyToFunder.set(dc.poly_api_key, dc.funder_address);

  const clob = new ClobClient(
    "https://clob.polymarket.com", 137, signer,
    { key: dc.poly_api_key, secret: dc.poly_secret, passphrase: dc.poly_passphrase },
    2, dc.funder_address,
  );

  try {
    const keys = await clob.getApiKeys();
    console.log("   ✅ AUTH WORKS! Server returned", Array.isArray(keys) ? keys.length : "?", "key(s)");
    if (Array.isArray(keys)) {
      keys.forEach((k, i) => console.log(`   Key ${i}:`, JSON.stringify(k)));
    }
  } catch (e) {
    console.error("   ❌ AUTH FAILED:", e.message);
    if (e.response?.data) console.error("   Server:", JSON.stringify(e.response.data));
    console.error("\n   ➡️  FIX: Run 'node create-api-key.mjs' to generate fresh credentials,");
    console.error("       then update the encrypted values in your Supabase 'clients' row.");
    process.exit(1);
  }

  // ── 5. Test order book fetch (unauthenticated, but proves connectivity) ─
  console.log("\n5️⃣  Testing order book fetch (unauthenticated)...");
  try {
    // Use a known high-volume asset for the test
    const r = await fetch("https://clob.polymarket.com/markets");
    if (r.ok) console.log("   ✅ CLOB API reachable");
    else console.log("   ⚠️  CLOB API returned", r.status);
  } catch (e) {
    console.log("   ⚠️  CLOB connectivity issue:", e.message);
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  ✅ ALL CHECKS PASSED — credentials are valid");
  console.log("═══════════════════════════════════════════════════════════");
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
