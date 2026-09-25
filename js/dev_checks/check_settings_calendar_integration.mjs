import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function fail_(message) {
  console.error(message);
  process.exit(1);
}

function assertIncludes_(src, needle, message) {
  if (!src.includes(needle)) fail_(message);
}

function assertMatches_(src, re, message) {
  if (!re.test(src)) fail_(message);
}

function run_() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const settingsPath = path.resolve(here, "../pages/settings.js");
  const src = fs.readFileSync(settingsPath, "utf8");

  assertIncludes_(
    src,
    "店舗メールアドレスがGoogleアカウントではない場合、ここでGoogleアカウントを設定してください。各スタッフのカレンダーを作成・共有するアカウントとして使用します。Googleアカウントがない場合、カレンダー連携機能は使用できません。",
    "settings calendar integration: help text must match the approved user-facing copy"
  );
  assertIncludes_(
    src,
    'id="saasCalendarIntegrationEmail"',
    "settings calendar integration: calendar account input is missing"
  );
  assertIncludes_(
    src,
    'placeholder="例: store@example.com"',
    "settings calendar integration: calendar account placeholder should be user-facing"
  );
  if (/id="saasCalendarSecretRef"|認証情報の参照名|Google Calendar secret ref/.test(src)) {
    fail_("settings calendar integration: secret ref must not be exposed in the store admin UI");
  }
  assertMatches_(
    src,
    /let\s+_calendarSecretRefSnapshot\s*=\s*"";/,
    "settings calendar integration: existing secret_ref must have a local snapshot"
  );
  assertMatches_(
    src,
    /_calendarSecretRefSnapshot\s*=\s*String\(row\s*&&\s*row\.secret_ref\s*\|\|\s*""\)\.trim\(\);/,
    "settings calendar integration: load must preserve existing secret_ref"
  );
  assertMatches_(
    src,
    /const\s+calendarSecretRef\s*=\s*_calendarSecretRefSnapshot;/,
    "settings calendar integration: save must reuse existing secret_ref, not a visible input"
  );
  assertMatches_(
    src,
    /if\s*\(!calendarIntegrationEmail\s*&&\s*!calendarSecretRef\s*&&\s*!_calendarIntegrationConfigExists\)\s*return\s*"未設定のため未実行";/,
    "settings calendar integration: empty new stores should not create a calendar override row"
  );
  assertMatches_(
    src,
    /integration_kind:\s*"calendar"[\s\S]*provider_type:\s*"google_calendar"[\s\S]*auth_type:\s*"oauth2"[\s\S]*secret_ref:\s*calendarSecretRef[\s\S]*calendar_integration_email:\s*calendarIntegrationEmail/,
    "settings calendar integration: upsert payload must target the google calendar store override and preserve secret_ref"
  );
  assertMatches_(
    src,
    /const\s+calendarIntegrationEmail\s*=\s*val_\("#saasCalendarIntegrationEmail"\)\.toLowerCase\(\);/,
    "settings calendar integration: replacing the account must save the current input value"
  );
  if (/\bsyncCalendar|provisionStaff|shareCalendar|startOrRenewWatch|watch\/renew|watch\/start/.test(src)) {
    fail_("settings calendar integration: changing the store account must not trigger calendar migration/watch side effects in the pre-implementation UI");
  }
  console.log("check_settings_calendar_integration: ok");
}

run_();
