// ─────────────────────────────────────────────────────────────────────────────
// Polymarket API Key Verifier
// Run with: node --env-file=.env.env verify-api-key.js
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID  = 137;

async function main() {
  const signer  = new Wallet(process.env.PRIVATE_KEY);
  const address = await signer.getAddress();

  const creds = {
    key:        process.env.POLY_API_KEY,
    secret:     process.env.POLY_SECRET,
    passphrase: process.env.POLY_PASSPHRASE,
  };

  console.log(`\nTesting API key: ${creds.key}`);
  console.log(`Against address: ${address}\n`);

  const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, 0);

  try {
    // getApiKeys() is an authenticated call — it only succeeds if the key,
    // secret, passphrase, and POLY_ADDRESS all match on Polymarket's server.
    const keys = await client.getApiKeys();
    console.log("═══════════════════════════════════════════════════════════");
    console.log("✅  API key is VALID — Polymarket accepted the credentials.");
    console.log(`    Active keys on this account: ${JSON.stringify(keys)}`);
    console.log("═══════════════════════════════════════════════════════════\n");
    console.log("You can now update your .env and run bot.js.\n");
  } catch (err) {
    console.error("═══════════════════════════════════════════════════════════");
    console.error("❌  API key REJECTED — credentials did not authenticate.");
    console.error(`    Error: ${err.message}`);
    console.error("═══════════════════════════════════════════════════════════\n");
  }
}

main();
