// ─────────────────────────────────────────────────────────────────────────────
// Polymarket Proxy Diagnostic v2
// Run with: node --env-file=.env.env diagnose2.js
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { Wallet } from "@ethersproject/wallet";

const RPC = "https://polygon-rpc.com";

async function ethCall(to, data) {
  const resp = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });
  const json = await resp.json();
  return json.result;
}

async function main() {
  const signer = new Wallet(process.env.PRIVATE_KEY);
  const eoa    = (await signer.getAddress()).toLowerCase();
  const funder = process.env.FUNDER_ADDRESS?.toLowerCase();

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Polymarket Proxy Diagnostic v2");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  EOA:     ${eoa}`);
  console.log(`  FUNDER:  ${funder}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Polymarket uses several contract addresses — check all known ones
  const contracts = [
    { label: "Exchange (main)",        addr: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" },
    { label: "Exchange (neg risk)",    addr: "0xC5d563A36AE78145C45a50134d48A1215220f80a" },
    { label: "ProxyFactory",           addr: "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052" },
  ];

  // selector for proxyWallets(address) = keccak256 first 4 bytes
  const selector = "0xf6a3d24e";
  const paddedEoa = eoa.slice(2).padStart(64, "0");

  for (const { label, addr } of contracts) {
    try {
      const result = await ethCall(addr, selector + paddedEoa);
      if (result && result !== "0x" && result !== "0x" + "0".repeat(64)) {
        const proxy = "0x" + result.slice(26).toLowerCase();
        const match = proxy === funder;
        console.log(`${label}:`);
        console.log(`  proxyWallets(${eoa}) → ${proxy}`);
        console.log(`  Matches FUNDER_ADDRESS: ${match ? "✅ YES" : "❌ NO"}\n`);
      } else {
        console.log(`${label}: no proxy registered for this EOA\n`);
      }
    } catch (err) {
      console.log(`${label}: error — ${err.message}\n`);
    }
  }

  // Also check from the other direction — does funder recognise eoa as owner?
  // CTFExchange has isValidOperator(address operator, address account)
  const isOperatorSelector = "0x397bc45f"; // isValidOperator(address,address)
  const paddedFunder = funder?.slice(2).padStart(64, "0");

  console.log("───────────────────────────────────────────────────────────");
  console.log("Checking if EOA is a valid operator for the proxy...\n");

  for (const { label, addr } of contracts) {
    try {
      const data   = isOperatorSelector + paddedEoa + paddedFunder;
      const result = await ethCall(addr, data);
      const isValid = result && result !== "0x" && BigInt(result) === 1n;
      console.log(`${label}: EOA is operator of proxy → ${isValid ? "✅ YES" : "❌ NO"}`);
    } catch (err) {
      console.log(`${label}: error — ${err.message}`);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
