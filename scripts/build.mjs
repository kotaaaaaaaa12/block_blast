import { cp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const schemaPath = join(root, "cloudflare/schema.js");
const sql = await readFile(join(root, "migrations/0001_rankings.sql"), "utf8");
const statements = sql.split(";").map(statement => statement.trim()).filter(Boolean);
const schemaSource = "// Generated from migrations/0001_rankings.sql. Do not edit directly.\n" +
  "export const SCHEMA_STATEMENTS = " + JSON.stringify(statements, null, 2) + ";\n";
const previousSchema = await readFile(schemaPath, "utf8").catch(() => "");
if (previousSchema !== schemaSource) await writeFile(schemaPath, schemaSource);
const output = join(root, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ["index.html", "src", "images", "audio", "favicon-32x32.png", "apple-touch-icon.png"]) {
  await cp(join(root, name), join(output, name), { recursive: true });
}
await writeFile(join(output, "_headers"), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: SAMEORIGIN
  Cache-Control: no-cache
`);
console.log("Static game assets are ready in dist/.");
