// Prints the wrangler command to register the first admin.
// Usage: node scripts/seed-admin.mjs 923001234567 "Your Name" Admin
const [phone, name, role = "Admin"] = process.argv.slice(2);
if (!phone || !name) {
  console.error('Usage: node scripts/seed-admin.mjs <phone-with-country-code> "<name>" [role]');
  process.exit(1);
}
const value = JSON.stringify({ phone, name, role, isAdmin: true });
console.log(`npx wrangler kv key put --binding=TEAM "user:${phone}" '${value}'`);
