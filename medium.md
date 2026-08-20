# 我對 LINE Bot 說「收藏第二間」：用 Gemini Function Calling，讓 Cafe Bot 從會推薦變成會做事

前一版的 Cafe Bot，已經可以做到一件很實用的事：

使用者在 LINE 裡分享位置，Bot 會透過 Vertex AI 的 Google Maps Grounding，找出附近幾間咖啡廳，整理成繁體中文，再附上可以直接打開的 Google Maps 卡片。

後來我又替它加上「換一批」和「更適合工作」，讓使用者不用重新分享位置，也能接著上一輪繼續找店。

做到這裡，它其實已經是一個滿完整的咖啡廳推薦 Bot 了。

但我開始想一件事：

如果推薦結果裡真的出現一間喜歡的店，我還是得自己複製店名、另外記下來，或再打開行事曆安排時間。

那 Bot 能不能不只告訴我「有哪些店」，而是真的聽懂：

> 收藏第二間，這週六下午兩點去。

然後幫我把後面的事情準備好？

這就是這次 `line-cafe-action-agent` 的起點。

---

## 從回答問題，到真的採取行動

一般的聊天機器人很會回答，但回答完通常就結束了。

例如我說「收藏第二間」，模型當然可以回我一句：

> 好的，已為你收藏第二間咖啡廳。

問題是，它可能只是在「說」自己完成了，資料庫裡根本什麼都沒有。

這次使用的 Gemini Function Calling，解決的就是這個落差。

我先告訴 Gemini，目前有哪些工具可以使用：

```text
save_cafe            收藏咖啡廳
list_saved_cafes     查看收藏
remove_saved_cafe    刪除收藏
plan_cafe_visit      安排咖啡行程
```

當使用者輸入「收藏第二間」時，Gemini 不需要自己操作 Firestore，而是回傳一個結構化的工具呼叫：

```json
{
  "name": "save_cafe",
  "args": {
    "cafe_number": 2
  }
}
```

如果使用者說的是：

> 下週六下午兩點安排第二間。

Gemini 就會選擇另一個工具，並把自然語言裡的時間整理成後端能處理的格式：

```json
{
  "name": "plan_cafe_visit",
  "args": {
    "cafe_number": 2,
    "start_time": "2026-08-29T14:00:00+08:00",
    "duration_minutes": 90
  }
}
```

這裡最重要的觀念是：

> Gemini 負責理解使用者想做什麼，程式負責判斷這件事能不能做，以及真正把它做完。

我很喜歡這個分工。因為它保留了自然語言的彈性，又不需要把資料庫的控制權直接交給模型。

---

## 「第二間」看似簡單，Bot 其實要先記得上一輪

Function Calling 可以判斷 `cafe_number: 2`，但後端還有一個更基本的問題：第二間到底是哪一間？

這個答案只能來自使用者剛才看到的推薦結果。

所以每次 Maps Grounding 找完咖啡廳後，程式除了把推薦卡片送到 LINE，也會把這一批店家暫存在 Firestore：

```text
使用者 ID
所在對話
本次推薦的咖啡廳清單
建立時間
到期時間
```

這份推薦紀錄有效 30 分鐘。

之後使用者說「收藏第二間」，後端就能依照同一位使用者、同一個對話，安全地找回剛才那份清單，再取得其中的第二間。

如果使用者還沒傳過位置、清單已經過期，或指定了不存在的「第 99 間」，程式都不會硬猜，而是請他重新分享位置。

這讓我再次感受到，很多看起來很自然的 AI 體驗，背後其實不是只靠一個 prompt。

模型負責理解「第二間」，但系統仍然要替它準備一份可信的上下文。

---

## 我不希望 Gemini 一判斷完，就直接改資料庫

收藏店家看起來不是什麼危險操作，但只要開始做 Function Calling，就很容易繼續加上刪除、預約、建立行程，甚至未來可能出現付費功能。

所以這一版從一開始就沒有設計成「模型說做就做」。

當 Gemini 判斷出工具之後，後端會先建立一筆有效 10 分鐘的 pending action，再回傳兩顆 LINE 按鈕：

```text
確認執行
取消
```

這筆待確認操作會記住：

- 是哪一位使用者提出的
- 發生在哪一個 LINE 對話
- 想收藏或刪除哪間店
- 如果是行程，預定時間是什麼
- 這次操作何時過期

只有原本的使用者在原本的對話裡按下確認，後端才會真正寫入 Firestore。

確認時還會使用 Firestore Transaction，一次完成狀態檢查與資料寫入。這可以避免使用者連點兩次「確認執行」，結果收藏出現兩筆，或同一個刪除動作被重複執行。

整體流程變成：

```text
使用者輸入自然語言
        ↓
Gemini 選擇 Function
        ↓
後端驗證店家與參數
        ↓
建立 pending action
        ↓
LINE 顯示確認／取消
        ↓
Firestore Transaction 正式執行
```

這多了一次點擊，卻換來一個很清楚的安全邊界。

Function Calling 讓 Bot 更有能力；確認機制則確保能力不會變成失控。

---

## Google Calendar 先用連結，不急著碰 OAuth

我原本想像的完整句子是：

> 收藏第二間，週六下午兩點提醒我，順便加到行事曆。

但如果要讓 Bot 直接寫進每位使用者的 Google Calendar，就必須處理 Google OAuth，包括登入、授權、token 保存與撤銷。

這些都做得到，但對第一版來說，範圍一下子會變得很大。

所以我和 Codex 先選擇一條比較輕巧的路：產生 Google Calendar 預填連結。

使用者確認行程後，Bot 會提供「加入行事曆」按鈕。點開後，活動名稱、開始與結束時間、咖啡廳名稱及 Maps 連結都已經填好，使用者只要再按一次儲存。

這樣做有幾個好處：

- Bot 不需要取得使用者的 Google 帳號權限
- 不需要保存 OAuth token
- 使用者仍然保有最後確認權
- 第一版可以先把主要體驗跑通

它不是功能最滿的做法，卻是很適合 MVP 的做法。

至於真正的 LINE 定時推播提醒，我把它留到下一階段。之後可以透過 Cloud Tasks，在指定時間觸發 LINE Push Message；但這牽涉到排程任務的認證、重試與避免重複推播，我不想為了讓功能清單看起來完整，就在第一版匆忙塞進去。

---

## 最真實的測試插曲：我明明輸入「收藏第二間」，怎麼還叫我傳位置？

程式完成後，我先跑了 TypeScript build、單元測試和本機 `/health`。

六項測試全部通過，服務也能正常啟動，程式碼接著推上新的 GitHub repo。

我拿起手機輸入：

> 收藏第二間

結果 LINE 跳出來的，卻還是舊 Bot 的「傳送目前位置」。

第一眼很容易懷疑是不是 Function Calling 沒有成功，或 Firestore 沒讀到推薦紀錄。但比對新版程式後，很快發現這段回覆根本不是新版本會說的話。

真正的原因很單純：

> 新程式雖然已經在 GitHub，卻還沒有部署；LINE Webhook 當然仍然連著舊服務。

這個插曲很小，卻是一個非常典型的雲端開發現場。

程式碼完成、測試通過、GitHub 有更新，都不代表手機上的 LINE 已經在跑那份程式。

要確認使用者實際碰到哪個版本，還是要沿著整條鏈路檢查：

```text
GitHub repo
  → Cloud Build
  → Cloud Run revision
  → LINE Webhook endpoint
  → 手機上的實際互動
```

---

## 部署時，我還是選擇讓新舊服務先並存

這次沒有直接覆蓋舊的 `codex-postback-action`，而是建立一個新的 Cloud Run service：

```text
line-cafe-action-agent
```

部署前，我先檢查既有 Cafe Bot 使用的 runtime service account，確認它已經具備：

- Vertex AI 權限
- Firestore 權限
- Service Usage 權限

也確認專案裡的 Firestore 是 Native mode，而且位置和 Cloud Run 一致。

新服務部署後，先做 `/health`，確認新的 revision 已經 Ready，再讀取 LINE 目前真正使用中的舊 Webhook endpoint。

最後才執行切換：

```text
保留舊服務
  → 部署新服務
  → Health Check
  → 切換 LINE Webhook
  → 執行 LINE 官方 Verify
  → 失敗就自動切回舊 endpoint
```

這次 LINE 官方測試回傳：

```json
{
  "success": true,
  "statusCode": 200,
  "reason": "OK"
}
```

Cloud Logging 也沒有出現 error，新 Webhook 才正式保留下來。

我在前一次 Postback 專案裡學到「發布前先想好怎麼回去」，這次就直接把同一個原則用在新的 Action Agent 上。

---

## 現在，這個 Bot 可以怎麼用？

完成後的實際操作很簡單。

先在 LINE 裡傳送位置，等 Bot 回傳附近咖啡廳，再直接輸入：

```text
收藏第二間
查看我的收藏
刪除收藏第一間
下週六下午兩點安排第二間
```

「收藏」和「刪除」都會先要求確認；「安排行程」確認後，除了收藏店家，也會提供 Google Calendar 與 Google Maps 按鈕。

這些句子不需要完全固定。

因為前面負責理解意圖的是 Gemini，所以使用者也可以用比較自然的說法。後端最後收到的，仍然會是穩定、可驗證的結構化參數。

這正是我覺得 Function Calling 最有趣的地方：

它不是只讓聊天機器人多背幾種指令，而是讓「人習慣的說法」和「系統需要的格式」之間，有一個真正能工作的翻譯層。

---

## 這次我真正做的，不只是收藏功能

回頭看，這次表面上只是替 Cafe Bot 加了收藏與行事曆。

但整個專案真正跨出去的一步，是讓 Bot 從「提供資訊」進入「執行操作」。

而這一步不能只靠模型變聰明，還需要把幾個角色分清楚：

- Gemini 負責理解自然語言與選擇工具
- Firestore 負責保存上下文、收藏與待確認操作
- 後端負責驗證參數與控制權限
- LINE Postback 負責取得使用者最後確認
- Google Calendar 連結負責把行程安全地交回使用者

我這次最想留下的一句話是：

> 好的 AI Agent，不是什麼都讓 AI 自己做，而是讓 AI 知道該叫哪個工具，再由系統安全地把事情完成。

下一步，我想替它加入真正的 LINE 定時提醒。到了指定時間，Bot 不只是把行程放進 Calendar，而是會主動傳訊息說：「你收藏的咖啡時間快到了。」

到那時候，這個 Cafe Bot 就會再往前一步，從會找店、會收藏，變成真的會陪我安排生活的咖啡助理。

---

## 本篇完整程式碼

GitHub：
https://github.com/zonawang/line-cafe-action-agent

更多 LINE Bot 與 AI 實作紀錄：
https://github.com/zonawang/zona-ai-learning-lab

