import assert from "node:assert/strict";
import { retirementResults_, retirementFailureMessage_ } from "../pages/settings_retirement_result.js";

assert.deepEqual(retirementResults_(null), []);
assert.equal(retirementFailureMessage_({ error: "supabase visits update failed" }).includes("supabase"), false);
assert.match(retirementFailureMessage_({ detail: { visit_results: [{ visit_id: "V1", status: "success", sync_errors: ["failed"] }] } }), /カレンダー/);
assert.deepEqual(retirementResults_({ detail: { visit_results: [{}] } }), []);
const rows = [
  { visit_id: "V1", status: "success", warning: "請求書は変更していません。" },
  { visit_id: "V2", status: "success", sync_errors: ["failed"] },
  { visit_id: "V3", status: "failed" },
];
for (const payload of [{ visit_results: rows }, { detail: { visit_results: rows } }]) {
  const result = retirementResults_(payload);
  assert.equal(result.length, 3);
  assert.equal(result[0].label, "変更済み");
  assert.equal(result[0].warning, rows[0].warning);
  assert.equal(result[1].label, "変更済み・カレンダー同期要確認");
  assert.equal(result[2].label, "処理失敗・保存状態を確認");
}
for (const [action, label] of [["handover", "引継ぎ済み"], ["cancel", "取消済み"]]) {
  assert.equal(retirementResults_({ future_visit_action: action, visit_results: rows })[0].label, label);
  const result = retirementResults_({ detail: { visit_results: rows.map((row) => ({ ...row, action })) } });
  assert.equal(result[0].label, label);
  assert.equal(result[1].label, `${label}・カレンダー同期要確認`);
}
console.log("check_settings_retirement_result: ok");
