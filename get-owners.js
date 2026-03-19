// Reads the owner(s) stored inside the 0xF936... Safe contract
// Run with: node get-owners.js

const SAFE = "0xF936176A7F09097faD1824308DdF08A4CE708D0C";
const RPCS = [
  "https://polygon-rpc.com",
  "https://rpc.ankr.com/polygon",
  "https://rpc-mainnet.matic.quiknode.pro",
];
const DATA = "0xa0e67e2b"; // getOwners()

async function call(rpc, data) {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "eth_call",
      params: [{ to: SAFE, data }, "latest"],
    }),
  });
  const json = await r.json();
  if (!json.result || json.result === "0x") throw new Error("empty result");
  return json.result;
}

function decodeAddressArray(hex) {
  const raw    = hex.slice(2);
  const offset = parseInt(raw.slice(0, 64), 16) * 2;
  const count  = parseInt(raw.slice(offset, offset + 64), 16);
  const addrs  = [];
  for (let i = 0; i < count; i++) {
    const chunk = raw.slice(offset + 64 + i * 64, offset + 64 + (i + 1) * 64);
    addrs.push("0x" + chunk.slice(24));
  }
  return addrs;
}

let result;
for (const rpc of RPCS) {
  try {
    process.stdout.write(`Trying ${rpc} ... `);
    result = await call(rpc, DATA);
    console.log("✅");
    break;
  } catch (e) {
    console.log(`❌ ${e.message}`);
  }
}

if (!result) {
  // Fallback: try owner() — single-owner contracts
  console.log("\nTrying owner() fallback...");
  for (const rpc of RPCS) {
    try {
      const res = await call(rpc, "0x8da5cb5b");
      const owner = "0x" + res.slice(26);
      console.log(`\n✅ Owner: ${owner}`);
      console.log("\nPut this address's private key in your .env as PRIVATE_KEY.\n");
      process.exit(0);
    } catch {}
  }
  console.log("\n❌ All RPCs failed. Go here and click 'Read Contract' → getOwners:");
  console.log(`   https://polygonscan.com/address/${SAFE}#readContract\n`);
  process.exit(1);
}

console.log(`\nOwners of ${SAFE}:`);
console.log("─────────────────────────────────────────────");
for (const addr of decodeAddressArray(result)) {
  console.log(" ", addr);
}
console.log("\nPut this address's private key in your .env as PRIVATE_KEY.\n");
