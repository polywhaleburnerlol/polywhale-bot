// ─────────────────────────────────────────────────────────────────────────────
// Polymarket API Key Generator
// Run once with: node --env-file=.env.env generate-api-key.js
//
// This derives a fresh API key tied to your EOA signer address (0x22e6...).
// The bot sends POLY_ADDRESS = EOA address in every request header, so the
// API key must be registered under that same address to avoid 401 errors.
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID  = 137;

async function main() {
  if (!process.env.PRIVATE_KEY) {
    console.error("❌ PRIVATE_KEY not set in .env");
    process.exit(1);
  }

  const signer  = new Wallet(process.env.PRIVATE_KEY);
  const address = await signer.getAddress();

  console.log(`\nSigner (EOA) address: ${address}`);
  console.log("Deriving API key under this address...\n");

  // signatureType 0 = standard EOA — registers the key under the EOA address,
  // which matches what the SDK sends as POLY_ADDRESS in every request header.
  const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer);

  try {
    const apiKey = await client.createOrDeriveApiKey();

    console.log("═══════════════════════════════════════════════════════════");
    console.log("✅  API key generated — copy these into your .env file:");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`POLY_API_KEY=${apiKey.key}`);
    console.log(`POLY_SECRET=${apiKey.secret}`);
    console.log(`POLY_PASSPHRASE=${apiKey.passphrase}`);
    console.log("═══════════════════════════════════════════════════════════\n");
  } catch (err) {
    console.error("❌ Failed to generate key:", err.message);
    console.error(err);
    process.exit(1);
  }
}

main();
