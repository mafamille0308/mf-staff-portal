import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function fail_(message) {
  console.error(message);
  process.exit(1);
}

function run_() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pagesDir = path.resolve(here, "../pages");

  const targets = [
    { file: "visits_list.js", exportRe: /export\s+async\s+function\s+renderVisitsList\s*\(/ },
    { file: "visit_detail.js", exportRe: /export\s+async\s+function\s+renderVisitDetail\s*\(/ },
    { file: "invoices.js", exportRe: /export\s+async\s+function\s+renderInvoicesPage\s*\(/ },
    { file: "settings.js", exportRe: /export\s+async\s+function\s+renderSettings\s*\(/ },
    { file: "customer_detail.js", exportRe: /export\s+async\s+function\s+renderCustomerDetail\s*\(/ },
    { file: "register.js", exportRe: /export\s+function\s+renderRegisterTab\s*\(/ },
  ];

  for (const t of targets) {
    const p = path.join(pagesDir, t.file);
    if (!fs.existsSync(p)) fail_(`check_cross_page_regression failed: missing file ${t.file}`);
    const src = fs.readFileSync(p, "utf8");
    if (!t.exportRe.test(src)) {
      fail_(`check_cross_page_regression failed: expected export not found in ${t.file}`);
    }
  }

  // visits pages should use the new unified visits policy module.
  const visitsListSrc = fs.readFileSync(path.join(pagesDir, "visits_list.js"), "utf8");
  const visitDetailSrc = fs.readFileSync(path.join(pagesDir, "visit_detail.js"), "utf8");
  if (!/from\s+["']\.\/visits_policy\.js["']/.test(visitsListSrc) || !/from\s+["']\.\/visits_policy\.js["']/.test(visitDetailSrc)) {
    fail_("check_cross_page_regression failed: visit pages must import ./visits_policy.js");
  }

  console.log("check_cross_page_regression: ok");
}

run_();
