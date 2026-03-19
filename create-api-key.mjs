// ─────────────────────────────────────────────────────────────────────────────
// create-api-key.mjs  v4
//
// The existing API key is bound to EOA (not the funder/Safe). The server
// returns 400 "Could not create" because a key already exists, then derive
// returns the same stale EOA-bound key. FIX:
//
//   1. Derive the existing key (EOA-bound — works with POLY_ADDRESS = EOA)
//   2. Delete it using raw L2 auth with POLY_ADDRESS = EOA
//   3. Create a FRESH key (now succeeds, binds to funder via signatureType=2)
//   4. Verify via raw fetch (not SDK — the SDK swallows 401s)
//   5. Encrypt and print
//
// Run:  node create-api-key.mjs
// ─────────────────────────────────────────────────────────────────────────────
import "dotenv/config";
import { ethers }    from "ethers";
import { Wallet }    from "@ethersproject/wallet";
import axios from "axios";
import crypto        from "node:crypto";

// ── Controllable POLY_ADDRESS interceptor ───────────────────────────────────
let _polyAddressOverride = null;

function interceptor(config) {
  if (config.headers && _polyAddressOverride) {
    const hasApiKey = config.headers["POLY_API_KEY"] || config.headers["poly_api_key"];
    if (hasApiKey) {
      config.headers["POLY_ADDRESS"] = _polyAddressOverride;
    }
  }
  return config;
}

const _origAxiosCreate = axios.create;
axios.create = function patchedCreate(...args) {
  const instance = _origAxiosCreate.apply(this, args);
  instance.interceptors.request.use(interceptor);
  return instance;
};
axios.interceptors.request.use(interceptor);

const { ClobClient } = await import("@polymarket/clob-client");

// ── Config ─────────────────────────────────────────────────────────────────
const PRIVATE_KEY       = process.env.PRIVATE_KEY;
const FUNDER_ADDRESS    = process.env.FUNDER_ADDRESS;
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET;
const CLOB_HOST         = "https://clob.polymarket.com";
const CHAIN_ID          = 137;

if (!PRIVATE_KEY || !FUNDER_ADDRESS || !ENCRYPTION_SECRET) {
  console.error("❌ Missing PRIVATE_KEY, FUNDER_ADDRESS, or ENCRYPTION_SECRET in .env");
  process.exit(1);
}
if (Buffer.from(ENCRYPTION_SECRET, "utf-8").length !== 32) {
  console.error("❌ ENCRYPTION_SECRET must be exactly 32 UTF-8 bytes");
  process.exit(1);
}

const ENC_KEY = Buffer.from(ENCRYPTION_SECRET, "utf-8");
function encrypt(text) {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const enc    = Buffer.concat([cipher.update(text, "utf-8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
}

// ── Build L2 auth headers manually (bypasses SDK error swallowing) ──────────
function buildL2Headers(apiKey, secret, passphrase, polyAddress) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac("sha256", Buffer.from(secret, "base64"))
    .update(timestamp + "GET" + "/auth/api-keys")
    .digest("base64");
  return {
    "POLY_API_KEY":    apiKey,
    "POLY_SIGNATURE":  sig,
    "POLY_TIMESTAMP":  timestamp,
    "POLY_PASSPHRASE": passphrase,
    "POLY_ADDRESS":    polyAddress,
  };
}

function buildL2DeleteHeaders(apiKey, secret, passphrase, polyAddress) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac("sha256", Buffer.from(secret, "base64"))
    .update(timestamp + "DELETE" + "/auth/api-key")
    .digest("base64");
  return {
    "POLY_API_KEY":    apiKey,
    "POLY_SIGNATURE":  sig,
    "POLY_TIMESTAMP":  timestamp,
    "POLY_PASSPHRASE": passphrase,
    "POLY_ADDRESS":    polyAddress,
  };
}

// ── Reliable L2 auth test via raw fetch (no SDK) ────────────────────────────
async function rawTestL2(apiKey, secret, passphrase, polyAddress, label) {
  try {
    const headers = buildL2Headers(apiKey, secret, passphrase, polyAddress);
    const r = await fetch(`${CLOB_HOST}/auth/api-keys`, { headers });
    const body = await r.text();
    const ok = r.status === 200;
    console.log(`   ${label}: ${r.status} ${r.statusText} ${ok ? "✅" : "❌"}`);
    if (ok) {
      try { const j = JSON.parse(body); console.log(`   Response: ${JSON.stringify(j).slice(0, 200)}`); } catch {}
    }
    return ok;
  } catch (e) {
    console.log(`   ${label}: fetch error — ${e.message} ❌`);
    return false;
  }
}

// ── Raw L2 delete via fetch ─────────────────────────────────────────────────
async function rawDeleteKey(apiKey, secret, passphrase, polyAddress) {
  const headers = buildL2DeleteHeaders(apiKey, secret, passphrase, polyAddress);
  const r = await fetch(`${CLOB_HOST}/auth/api-key`, { method: "DELETE", headers });
  const body = await r.text();
  return { status: r.status, body };
}

async function main() {
  const pk     = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : "0x" + PRIVATE_KEY;
  const signer = new Wallet(pk);
  const eoaAddr = signer.address;

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PolyWhale API Key Setup  v4");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  EOA signer:  ${eoaAddr}`);
  console.log(`  Funder/Safe: ${FUNDER_ADDRESS}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: Get the existing key (derive, not create)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("📋 Phase 1: Deriving existing API key...\n");
  _polyAddressOverride = null;  // L1 auth — leave POLY_ADDRESS alone
  const bareClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer, undefined, 2, FUNDER_ADDRESS);

  let oldCreds;
  try {
    oldCreds = await bareClient.deriveApiKey();
  } catch {
    try { oldCreds = await bareClient.createOrDeriveApiKey(); } catch {}
  }

  const oldKey        = oldCreds?.key || oldCreds?.apiKey || oldCreds?.api_key;
  const oldSecret     = oldCreds?.secret;
  const oldPassphrase = oldCreds?.passphrase;

  if (!oldKey || !oldSecret || !oldPassphrase) {
    console.log("   No existing key found — skipping deletion, going straight to create.\n");
  } else {
    console.log(`   Found existing key: ${oldKey}`);

    // Test which address it's bound to (using raw fetch, not SDK)
    console.log("\n   Testing existing key binding...");
    const funderOk = await rawTestL2(oldKey, oldSecret, oldPassphrase, FUNDER_ADDRESS, "Funder");
    const eoaOk    = await rawTestL2(oldKey, oldSecret, oldPassphrase, eoaAddr, "EOA");

    const deleteAddr = funderOk ? FUNDER_ADDRESS : eoaOk ? eoaAddr : null;

    if (!deleteAddr) {
      console.log("\n   ⚠️  Existing key doesn't work with either address.");
      console.log("   It may be expired. Proceeding to create anyway...\n");
    } else {
      // ═════════════════════════════════════════════════════════════════════
      // PHASE 2: Delete the old key
      // ═════════════════════════════════════════════════════════════════════
      console.log(`\n🗑️  Phase 2: Deleting old key (bound to ${deleteAddr === eoaAddr ? "EOA" : "funder"})...\n`);

      const del = await rawDeleteKey(oldKey, oldSecret, oldPassphrase, deleteAddr);
      console.log(`   DELETE /auth/api-key → ${del.status}`);
      console.log(`   Response: ${del.body.slice(0, 200)}`);

      if (del.status === 200) {
        console.log("   ✅ Old key deleted!\n");
      } else {
        console.log("   ⚠️  Delete returned non-200 — trying SDK fallback...");
        // Try SDK delete methods with override set to the working address
        _polyAddressOverride = deleteAddr;
        const authedClient = new ClobClient(
          CLOB_HOST, CHAIN_ID, signer,
          { key: oldKey, secret: oldSecret, passphrase: oldPassphrase },
          2, FUNDER_ADDRESS,
        );
        for (const m of ["deleteApiKey", "deleteApiKeys"]) {
          if (typeof authedClient[m] === "function") {
            try {
              await authedClient[m]();
              console.log(`   ✅ ${m}() succeeded`);
              break;
            } catch (e) {
              console.log(`   ${m}(): ${e.message}`);
            }
          }
        }
        _polyAddressOverride = null;
        console.log("");
      }

      // Brief pause to let the server process the deletion
      console.log("   Waiting 2s for server to process deletion...");
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 3: Create a fresh key
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n⏳ Phase 3: Creating FRESH API key...\n");
  _polyAddressOverride = null;  // L1 auth — no override

  // Need a fresh client (previous one may have cached state)
  const freshClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer, undefined, 2, FUNDER_ADDRESS);

  let newCreds;
  for (const method of ["createApiKey", "createOrDeriveApiKey"]) {
    if (typeof freshClient[method] !== "function") continue;
    try {
      console.log(`   Trying ${method}()...`);
      newCreds = await freshClient[method]();
      const k = newCreds?.key || newCreds?.apiKey || newCreds?.api_key;
      if (k) {
        console.log(`   ✅ ${method}() returned a key: ${k}\n`);
        break;
      } else {
        console.log(`   ⚠️  ${method}() returned empty: ${JSON.stringify(newCreds)}`);
        newCreds = null;
      }
    } catch (e) {
      console.log(`   ❌ ${method}() threw: ${e.message}`);
      newCreds = null;
    }
  }

  if (!newCreds) {
    console.error("\n❌ Could not create a new API key.");
    console.error("   If the old key wasn't deleted, try deleting it manually:");
    console.error("   1. Go to https://polymarket.com → Settings → API Keys → Delete All");
    console.error("   2. Re-run this script");
    process.exit(1);
  }

  const key        = newCreds.key || newCreds.apiKey || newCreds.api_key;
  const secret     = newCreds.secret;
  const passphrase = newCreds.passphrase;

  if (!key || !secret || !passphrase) {
    console.error("❌ Incomplete credentials:", JSON.stringify(newCreds, null, 2));
    process.exit(1);
  }

  console.log("──────────────────────────────────────────────────────");
  console.log("New plaintext credentials:");
  console.log(`  key:        ${key}`);
  console.log(`  secret:     ${secret}`);
  console.log(`  passphrase: ${passphrase}`);
  console.log("──────────────────────────────────────────────────────\n");

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 4: Verify the new key (raw fetch — no SDK error swallowing)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("🔍 Phase 4: Verifying new key binding (raw HTTP, no SDK)...\n");

  const funderWorks = await rawTestL2(key, secret, passphrase, FUNDER_ADDRESS, "POLY_ADDRESS = funder");
  const eoaWorks    = await rawTestL2(key, secret, passphrase, eoaAddr, "POLY_ADDRESS = EOA");

  console.log("");
  if (funderWorks) {
    console.log("✅ New key works with FUNDER — bot.js interceptor is correct!\n");
  } else if (eoaWorks) {
    console.log("⚠️  New key works with EOA only — NOT funder.");
    console.log("   This means the SDK still created the key bound to EOA.");
    console.log("   bot.js needs to NOT override POLY_ADDRESS (or set it to EOA).");
    console.log(`   EOA address: ${eoaAddr}\n`);
  } else {
    console.log("❌ New key doesn't work with either address!");
    console.log("   Something is fundamentally wrong. Try:");
    console.log("   1. Delete all keys via Polymarket UI → Settings → API Keys");
    console.log("   2. Re-run this script\n");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 5: Encrypt and print
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("══════════════════════════════════════════════════════════");
  console.log("🔒 COPY THESE INTO YOUR SUPABASE 'clients' ROW:");
  console.log("══════════════════════════════════════════════════════════\n");
  console.log("poly_api_key:\n" + encrypt(key) + "\n");
  console.log("poly_secret:\n" + encrypt(secret) + "\n");
  console.log("poly_passphrase:\n" + encrypt(passphrase) + "\n");

  const rawPk = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY.slice(2) : PRIVATE_KEY;
  console.log("private_key:\n" + encrypt(rawPk) + "\n");

  if (eoaWorks && !funderWorks) {
    console.log("══════════════════════════════════════════════════════════");
    console.log("⚠️  CRITICAL: Key is bound to EOA. You MUST also update");
    console.log("   bot.js to DISABLE the POLY_ADDRESS override.");
    console.log("   See instructions above.");
    console.log("══════════════════════════════════════════════════════════");
  }

  console.log("\n✅ DONE — Update Supabase, then restart bot.js");
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
