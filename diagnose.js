// ─────────────────────────────────────────────────────────────────────────────
// Polymarket Proxy Diagnostic
// Run with: node --env-file=.env.env diagnose.js
//
// Checks the on-chain relationship between your EOA and proxy wallet,
// and verifies which API key / signatureType combination will work.
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID  = 137;

// Polymarket Exchange contract on Polygon — holds proxy registrations
const EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

// proxyWallets(address owner) → address proxy
const PROXY_WALLET_ABI = [
  "function proxyWallets(address) view returns (address)"
];

async function main() {
  const signer  = new Wallet(process.env.PRIVATE_KEY);
  const eoa     = await signer.getAddress();
  const funder  = process.env.FUNDER_ADDRESS;

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Polymarket Proxy Diagnostic");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  EOA (PRIVATE_KEY):    ${eoa}`);
  console.log(`  FUNDER_ADDRESS:       ${funder}`);
  console.log("───────────────────────────────────────────────────────────\n");

  // ── Test 1: Check what proxy the exchange contract has registered for this EOA ──
  try {
    const rpcUrl = "https://polygon-rpc.com";
    const payload = {
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{
        to: EXCHANGE_ADDRESS,
        // proxyWallets(address) selector = 0xf6a3d24e, padded EOA address
        data: "0xf6a3d24e000000000000000000000000" + eoa.slice(2).toLowerCase(),
      }, "latest"],
    };

    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await resp.json();
    const raw  = json.result;

    if (raw && raw !== "0x" && raw !== "0x" + "0".repeat(64)) {
      const registeredProxy = "0x" + raw.slice(26); // last 20 bytes
      console.log(`✅ On-chain proxy registered for ${eoa}:`);
      console.log(`   → ${registeredProxy}`);

      if (registeredProxy.toLowerCase() === funder?.toLowerCase()) {
        console.log(`\n✅ MATCH — FUNDER_ADDRESS matches on-chain proxy.`);
        console.log("   signatureType 1 (POLY_PROXY) should work.");
        console.log("   Use API keys from Builder Settings (tied to the proxy address).\n");
      } else {
        console.log(`\n⚠️  MISMATCH — on-chain proxy is ${registeredProxy}`);
        console.log(`   but FUNDER_ADDRESS is set to    ${funder}`);
        console.log("   Update FUNDER_ADDRESS in your .env to match the on-chain value.\n");
      }
    } else {
      console.log(`❌ No proxy registered on-chain for EOA ${eoa}.`);
      console.log("   This means signatureType 1 will NEVER work with this EOA.");
      console.log("   The PRIVATE_KEY in your .env may not be the owner of this proxy.\n");
    }
  } catch (err) {
    console.log(`⚠️  Could not read on-chain proxy (RPC error): ${err.message}\n`);
  }

  // ── Test 2: Try authenticated call with CURRENT .env credentials ──
  console.log("───────────────────────────────────────────────────────────");
  console.log(`Testing API key: ${process.env.POLY_API_KEY}`);

  const creds = {
    key:        process.env.POLY_API_KEY,
    secret:     process.env.POLY_SECRET,
    passphrase: process.env.POLY_PASSPHRASE,
  };

  // Try signatureType 0 first (EOA — simplest)
  for (const [sigType, label] of [[0, "EOA"], [1, "POLY_PROXY"]]) {
    try {
      const args = sigType === 0
        ? [CLOB_HOST, CHAIN_ID, signer, creds, 0]
        : [CLOB_HOST, CHAIN_ID, signer, creds, 1, funder];

      const client = new ClobClient(...args);
      const keys   = await client.getApiKeys();
      console.log(`\n✅ signatureType ${sigType} (${label}) — API key ACCEPTED`);
      console.log(`   Use signatureType: ${sigType} in bot.js`);
      console.log(`   Active keys: ${JSON.stringify(keys)}`);
      break;
    } catch (err) {
      console.log(`❌ signatureType ${sigType} (${label}) — ${err.message?.slice(0, 80)}`);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
