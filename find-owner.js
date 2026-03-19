// ─────────────────────────────────────────────────────────────────────────────
// Find which EOA owns 0xF936...
// Run with: node --env-file=.env.env find-owner.js
//
// Polymarket deterministically derives a Safe address from each EOA using
// CREATE2. This script derives the expected Safe for every known address
// and finds which one matches 0xF936...
// ─────────────────────────────────────────────────────────────────────────────

import { getContractConfig } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { ethers } from "ethers";

// All your known EOA addresses — add any others you want to check
const KNOWN_EOAS = [
  "0x22e61361d964Bb8a068B3dD6A0385200E20B46f3",
  "0x8a7A1435014E0962E7C1ce1F28706B88d9a6793d",
  "0xd54E23499c614E24ef9116D0Ff548aeF3fD91b5F",
];

const TARGET_SAFE  = "0xF936176A7F09097faD1824308DdF08A4CE708D0C";
const CHAIN_ID     = 137;

// Polymarket Safe factory — from their open-source SDK
const SAFE_FACTORY       = "0xaacfeea03eb1561c4e67d661e40682bd20e3541b";
const SAFE_INIT_CODE_HASH = "0x5b4a9650f5b6d68e64fc4b90b3ea5c83c3b5ab1e7d46ab3c7c4b85e39c4bb3e5";

function deriveSafeAddress(eoaAddress) {
  const salt = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(["address"], [eoaAddress])
  );
  return ethers.utils.getCreate2Address(
    SAFE_FACTORY,
    salt,
    SAFE_INIT_CODE_HASH
  );
}

async function main() {
  // Also check the current PRIVATE_KEY from .env
  const envWallet = process.env.PRIVATE_KEY
    ? new Wallet(process.env.PRIVATE_KEY)
    : null;
  const envAddress = envWallet ? await envWallet.getAddress() : null;

  const allEoas = [...new Set([
    ...KNOWN_EOAS,
    ...(envAddress ? [envAddress] : []),
  ])];

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Safe Address Derivation");
  console.log(`  Looking for: ${TARGET_SAFE}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  let found = false;
  for (const eoa of allEoas) {
    try {
      const derived = deriveSafeAddress(eoa);
      const match   = derived.toLowerCase() === TARGET_SAFE.toLowerCase();
      console.log(`EOA:     ${eoa}`);
      console.log(`Safe:    ${derived}`);
      console.log(`Match:   ${match ? "✅ THIS IS THE OWNER" : "❌ no"}\n`);
      if (match) found = true;
    } catch (err) {
      console.log(`EOA:     ${eoa}`);
      console.log(`Error:   ${err.message}\n`);
    }
  }

  if (!found) {
    console.log("─────────────────────────────────────────────────────────");
    console.log("None of the known addresses derive to 0xF936...");
    console.log("The owner EOA is a MetaMask account not listed above.");
    console.log("\nTo find it: open MetaMask → click account icon → check");
    console.log("each account address listed there.");
    console.log("─────────────────────────────────────────────────────────\n");
  }
}

main().catch(console.error);
