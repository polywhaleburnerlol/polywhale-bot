import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const key = Buffer.from(process.env.ENCRYPTION_SECRET, "utf-8");

function checkField(name, text) {
  try {
    if (!text) throw new Error("Field is totally empty!");
    const parts = text.split(":");
    if (parts.length !== 3) {
        throw new Error(`Format error. Expected 3 parts separated by colons, but found ${parts.length}.`);
    }
    
    const [ivHex, tagHex, encHex] = parts;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]);
    console.log(`✅ ${name} is PERFECT`);
  } catch (err) {
    console.error(`❌ ${name} FAILED: ${err.message}`);
  }
}

async function runDiagnostics() {
  console.log("🔍 Fetching from Supabase...\n");
  const { data, error } = await supabase.from("clients").select("*").eq("is_active", true);
  
  if (error) return console.error("Database error:", error.message);
  if (!data || data.length === 0) return console.log("No active clients found.");
  
  const client = data[0];
  checkField("private_key", client.private_key);
  checkField("poly_api_key", client.poly_api_key);
  checkField("poly_secret", client.poly_secret);
  checkField("poly_passphrase", client.poly_passphrase);
}

runDiagnostics();