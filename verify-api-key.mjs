import { createHmac } from "node:crypto";
import { ethers } from "ethers";

// ── Your credentials ──────────────────────────────────────────────────────
const PRIVATE_KEY = "db06dc24342f16fea0a0037a6003b30b8cb0be2a0cdc248987d7d992f60eb254";
const API_KEY     = "93c8642a-a04c-b22a-c33e-1d3eec74bc4f";
const SECRET      = "T4QobVjzvpqGFvX9RKIXWQfiEBKlwUf2bQu7tT46UD8=";
const PASSPHRASE  = "89cd38064e3fca2057a83fb8f5ff1d26489188f750fac6195d2bde146a9d0dfc";
const EOA         = "0x22e61361d964Bb8a068B3dD6A0385200E20B46f3";
const FUNDER      = "0xf936176a7f09097fad1824308ddf08a4ce708d0c";

function sign(secret, ts, method, path) {
  return createHmac("sha256", Buffer.from(secret, "base64"))
    .update(ts + method + path).digest("base64url");
}

async function testKey(label, polyAddress) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = sign(SECRET, ts, "GET", "/auth/api-key");
  const r = await fetch("https://clob.polymarket.com/auth/api-key", {
    method: "GET",
    headers: {
      "POLY_API_KEY": API_KEY,
      "POLY_SIGNATURE": sig,
      "POLY_TIMESTAMP": ts,
      "POLY_PASSPHRASE": PASSPHRASE,
      "POLY_ADDRESS": polyAddress,
    }
  });
  console.log(`[${label}] status=${r.status} → ${(await r.text()).slice(0,200)}`);
}

// Also try deleting and recreating key with correct address
async function deleteKey(polyAddress) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = sign(SECRET, ts, "DELETE", "/auth/api-key");
  const r = await fetch("https://clob.polymarket.com/auth/api-key", {
    method: "DELETE",
    headers: {
      "POLY_API_KEY": API_KEY,
      "POLY_SIGNATURE": sig,
      "POLY_TIMESTAMP": ts,
      "POLY_PASSPHRASE": PASSPHRASE,
      "POLY_ADDRESS": polyAddress,
    }
  });
  console.log(`[DELETE with ${label(polyAddress)}] status=${r.status} → ${(await r.text()).slice(0,200)}`);
}

function label(addr) { return addr === EOA ? "EOA" : "FUNDER"; }

console.log("=== Testing key with EOA ===");
await testKey("EOA", EOA);

console.log("=== Testing key with FUNDER ===");
await testKey("FUNDER", FUNDER);

console.log("\n=== Trying to delete key with EOA (in case it's registered there) ===");
await deleteKey(EOA);

console.log("=== Trying to delete key with FUNDER ===");
await deleteKey(FUNDER);
