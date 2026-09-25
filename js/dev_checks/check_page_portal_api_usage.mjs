import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function listJsFiles_(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (e.isFile() && e.name.endsWith(".js")) out.push(p);
    }
  }
  return out;
}

function run_() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pagesDir = path.resolve(here, "../pages");
  const files = listJsFiles_(pagesDir);
  const allowed = path.join(pagesDir, "portal_api.js");
  const allowedDir = path.join(pagesDir, "portal_api");
  const hits = [];

  for (const p of files) {
    if (p === allowed || p.startsWith(`${allowedDir}${path.sep}`)) continue;
    const src = fs.readFileSync(p, "utf8");
    if (/callCloudRunPortal\s*\(/.test(src)) {
      hits.push(path.relative(pagesDir, p));
      continue;
    }
    if (/["'`]\/portal\//.test(src)) {
      hits.push(path.relative(pagesDir, p));
    }
  }

  if (hits.length) {
    console.error("Direct portal endpoint usage is disallowed in pages/* (use portal_api.js):");
    for (const h of hits) console.error(`- ${h}`);
    process.exitCode = 1;
    return;
  }
  console.log("check_page_portal_api_usage: ok");
}

run_();
