import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function fail_(message) {
  console.error(message);
  process.exit(1);
}

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

function listPortalApiExportedFns_(filePath) {
  const src = fs.readFileSync(filePath, "utf8");
  const out = [];
  const re = /export\s+async\s+function\s+([A-Za-z0-9_]+)\s*\(/g;
  let m = null;
  while ((m = re.exec(src)) !== null) out.push(String(m[1] || ""));
  return out;
}

function run_() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const jsRoot = path.resolve(here, "..");
  const pagesDir = path.resolve(here, "../pages");
  const files = listJsFiles_(pagesDir);
  const portalApiPath = path.join(pagesDir, "portal_api.js");
  const portalApiDir = path.join(pagesDir, "portal_api");
  const allowed = portalApiPath;
  const hits = [];

  for (const p of files) {
    const inPortalApiDir = p.startsWith(`${portalApiDir}${path.sep}`);
    if (p === allowed || inPortalApiDir) continue;
    const src = fs.readFileSync(p, "utf8");
    if (/callCloudRunPortal\s*\(/.test(src) || /["'`]\/portal\//.test(src)) {
      hits.push(path.relative(pagesDir, p));
    }
  }

  if (hits.length) {
    fail_(
      "run_frontend_checks failed: direct portal endpoint usage is disallowed in pages/* (use portal_api.js)\n" +
      hits.map((h) => `- ${h}`).join("\n")
    );
  }

  const portalApiFiles = [portalApiPath].concat(listJsFiles_(portalApiDir));
  const portalApiSource = portalApiFiles.map((p) => fs.readFileSync(p, "utf8")).join("\n");
  const exportedFns = [];
  const exportFnRe = /export\s+async\s+function\s+([A-Za-z0-9_]+)\s*\(/g;
  let match = null;
  while ((match = exportFnRe.exec(portalApiSource)) !== null) {
    exportedFns.push(String(match[1] || ""));
  }
  if (!exportedFns.length) {
    fail_("run_frontend_checks failed: portal_api.js has no exported async function");
  }
  const badNames = exportedFns.filter((name) => !/^portal[A-Z][A-Za-z0-9]*_$/.test(name));
  if (badNames.length) {
    fail_(
      "run_frontend_checks failed: portal_api.js export naming must match ^portal[A-Z][A-Za-z0-9]*_$\n" +
      badNames.map((name) => `- ${name}`).join("\n")
    );
  }
  const uniqueNames = new Set(exportedFns);
  if (uniqueNames.size !== exportedFns.length) {
    fail_("run_frontend_checks failed: duplicated export name in portal_api.js");
  }

  const endpointMatches = portalApiSource.match(/["'`]\/portal\/[^"'`]+["'`]/g) || [];
  if (!endpointMatches.length) {
    fail_("run_frontend_checks failed: portal_api.js has no /portal/ endpoint literal");
  }
  const badEndpoints = endpointMatches
    .map((x) => x.slice(1, -1))
    .filter((ep) => !ep.startsWith("/portal/"));
  if (badEndpoints.length) {
    fail_(
      "run_frontend_checks failed: portal_api.js has non-portal endpoint literals\n" +
      badEndpoints.map((ep) => `- ${ep}`).join("\n")
    );
  }

  // 未使用の portal API 関数を禁止（_core の内部関数は対象外）
  const exportedFnSet = new Set();
  const domainFiles = listJsFiles_(portalApiDir).filter((p) => !p.endsWith(`${path.sep}_core.js`));
  for (const p of domainFiles) {
    for (const fn of listPortalApiExportedFns_(p)) exportedFnSet.add(fn);
  }
  const allJsFiles = listJsFiles_(jsRoot);
  const usageTargets = allJsFiles.filter((p) => !p.startsWith(`${portalApiDir}${path.sep}`));
  const unused = [];
  for (const fn of Array.from(exportedFnSet)) {
    const re = new RegExp(`\\b${fn}\\b`);
    let used = false;
    for (const p of usageTargets) {
      const src = fs.readFileSync(p, "utf8");
      if (re.test(src)) {
        used = true;
        break;
      }
    }
    if (!used) unused.push(fn);
  }
  if (unused.length) {
    fail_(
      "run_frontend_checks failed: unused portal API exports detected\n" +
      unused.map((fn) => `- ${fn}`).join("\n")
    );
  }
  console.log("run_frontend_checks: ok");
}

run_();
