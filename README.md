# LINE Cafe Action Agent

一個會「採取行動」的 LINE 咖啡廳助理。使用者分享位置後，Bot 透過 Vertex AI Google Maps Grounding 推薦附近咖啡廳；接著可用自然語言請 Gemini 收藏店家、管理收藏，或安排咖啡行程。

## MVP 功能

- LINE 原生位置訊息與 Google Maps Grounding 推薦
- Gemini Function Calling：`save_cafe`、`list_saved_cafes`、`remove_saved_cafe`、`plan_cafe_visit`
- Firestore 保存最近一批推薦、收藏與待確認操作
- 所有新增／刪除操作均需 LINE Postback 二次確認
- 行程確認後產生 Google Calendar 預填連結，不需存取使用者的 Google 帳號
- Google Maps 來源卡片、Loading Animation、結構化 log

可測試的對話：

```text
收藏第二間
查看我的收藏
刪除收藏第一間
這週六下午兩點安排第二間
```

## 流程

```text
LINE 位置 → Gemini Maps Grounding → 推薦卡片 → Firestore 暫存
LINE 文字 → Gemini Function Calling → 待確認操作 → Postback 確認
                                              ├─ 收藏／刪除 → Firestore
                                              └─ 安排行程 → Calendar 連結
```

## 本機設定

需要 Node.js 20 以上、Google Cloud Application Default Credentials，以及一個 LINE Messaging API channel。

```bash
npm install
cp .env.example .env
gcloud auth application-default login
npm run dev
```

`.env` 必填：

```dotenv
LINE_CHANNEL_SECRET=...
LINE_CHANNEL_ACCESS_TOKEN=...
GOOGLE_CLOUD_PROJECT=...
```

其餘模型、地區與 Firestore collection 名稱都有預設值，請參考 [.env.example](./.env.example)。

## Google Cloud 權限

Cloud Run runtime service account 至少需要：

- `roles/aiplatform.user`
- `roles/datastore.user`

並啟用：

```bash
gcloud services enable aiplatform.googleapis.com firestore.googleapis.com run.googleapis.com cloudbuild.googleapis.com
```

Firestore 必須使用 Native mode。建議替下列欄位建立 TTL policy：

- `cafe-action-contexts.expiresAt`
- `cafe-pending-actions.expiresAt`

TTL 只負責日後清理；程式本身仍會即時拒絕過期操作。

## Cloud Run 部署

Webhook 在回覆 HTTP 200 後繼續執行 Gemini 與 LINE API 工作，因此部署時必須使用 `--no-cpu-throttling`：

```bash
gcloud run deploy line-cafe-action-agent \
  --source . \
  --region asia-east1 \
  --allow-unauthenticated \
  --no-cpu-throttling \
  --service-account YOUR_RUNTIME_SERVICE_ACCOUNT \
  --set-env-vars GOOGLE_CLOUD_PROJECT=YOUR_PROJECT,GOOGLE_CLOUD_LOCATION=global
```

另外以 Secret Manager 或 Cloud Run secret env vars 設定 `LINE_CHANNEL_SECRET` 與 `LINE_CHANNEL_ACCESS_TOKEN`，再把 LINE Webhook URL 指向：

```text
https://YOUR_CLOUD_RUN_URL/webhook
```

## 安全設計

- Gemini 只提出工具呼叫，不會直接寫入資料。
- 寫入前會建立 10 分鐘有效的 pending action，並綁定原使用者與原對話。
- Postback 確認時以 Firestore Transaction 驗證擁有者、期限及是否執行過。
- Calendar 採預填連結，Bot 不取得 Google Calendar OAuth 權限。

## 下一階段

- Cloud Tasks 定時觸發 LINE Push Message 提醒
- 使用者時區設定
- 收藏標籤與搜尋
- Google Calendar OAuth 直接建立／取消活動
