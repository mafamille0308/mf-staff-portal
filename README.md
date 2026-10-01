# mf-staff-portal

## デプロイ前チェック（必須）

以下をローカルで実行し、すべて `ok` になることを確認する。

1. Frontend pages API 利用ルールチェック（一括）

```bash
node frontend/js/dev_checks/run_frontend_checks.mjs
```

チェック内容:
- `pages/*` に `callCloudRunPortal` 直呼びがないこと
- `pages/*` に `/portal/*` endpoint 直書きがないこと（`portal_api.js` 以外）
- `portal_api.js` の export 名が `portal<Resource><Action>_` 形式であること
- `portal_api/*` の export 関数に未使用がないこと

2. Frontend pages での `/portal/*` 直書き・`callCloudRunPortal` 直呼び禁止チェック（単体実行）

```bash
node frontend/js/dev_checks/check_page_portal_api_usage.mjs
```

3. Cloud Run ルート静的スモーク

```bash
cd backend/calendar-webhook
npm run test:smoke
```
