import crypto from "node:crypto";

const keyStr = process.env.ENCRYPTION_SECRET;
if (!keyStr || keyStr.length !== 32) {
  console.error("❌ ENCRYPTION_SECRET in .env.env must be exactly 32 characters!");
  process.exit(1);
}

const key = Buffer.from(keyStr, "utf-8");

function encrypt(text) {
  if (!text) return "Missing value in .env.env";
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

console.log("\n🔒 COPY THESE INTO YOUR SUPABASE 'clients' TABLE:\n");
console.log("private_key:\n" + encrypt(process.env.PRIVATE_KEY) + "\n");
console.log("poly_api_key:\n" + encrypt(process.env.POLY_API_KEY) + "\n");
console.log("poly_secret:\n" + encrypt(process.env.POLY_SECRET) + "\n");
console.log("poly_passphrase:\n" + encrypt(process.env.POLY_PASSPHRASE) + "\n");