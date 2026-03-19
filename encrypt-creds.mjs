import "dotenv/config";
import crypto from "node:crypto";

const key = Buffer.from(process.env.ENCRYPTION_SECRET, "utf-8");

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf-8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
}

// ── PASTE YOUR VALUES FROM POLYMARKET UI HERE ──
const API_KEY    = "019d0551-9125-7300-a7e8-41e72133dbad";
const SECRET     = "m1FdFckDLWpsikcTiUupV8jl27HF_LGGAz0RiAgEQ5c=";
const PASSPHRASE = "9142d3789ad07ca120844222e062b68ab3a6e315de1417b494ccdf2bc76cff11";

if (API_KEY === "PASTE_KEY_HERE") {
  console.error("❌ Edit encrypt-creds.mjs and paste your values first");
  process.exit(1);
}

console.log("\nEncrypted values — paste into Supabase:\n");
console.log("  poly_api_key:    ", encrypt(API_KEY));
console.log("  poly_secret:     ", encrypt(SECRET));
console.log("  poly_passphrase: ", encrypt(PASSPHRASE));
