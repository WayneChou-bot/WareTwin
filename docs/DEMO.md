# Demo 腳本（規格書 ⭐ 十個 Demo Scenario）

啟動：`dev.ps1`（後端 conda 環境 + 前端），瀏覽器開 http://localhost:5173，TopBar 看到 **BACKEND** 藍色徽章。建議先按 **10×** 跑 2 分鐘讓倉庫「熱起來」，再按回 **1×** 展示。每個 Demo 後用 Scenarios → Active → Clear 或 TopBar ↻ Reset 還原。

| # | Demo | 操作 | 看什麼 |
|---|---|---|---|
| 01 | Normal Operation | 10× 跑 2 分鐘 → 1× | 20 台機器人沿 A* 路徑運作；Task Queue 流動；Throughput 曲線上升；切 HEATMAP 看中央走道變熱 |
| 02 | Low Battery | Scenarios → Low Battery → 選一台 TRANSPORTING 的機器人 → Set 8% | Alerts 出現 Battery Critical；Event Log「low battery — task re-queued as #A38xx」；機器人去充電樁（路徑變藍）；Fleet Overview Charging +1 |
| 03 | Human Intrusion | Scenarios → Human Intrusion → Zone B → 60 s → Inject；右欄 Live Camera 切到 B、按 **Analyze** | 3D 裡 Zone B 變紅 ⛔、出現 ⚠ HUMAN；VLM 偵測框 HUMAN DETECTED；Event Log：Human detected → Zone B marked BLOCKED → Rx rerouted；60 s 後自動解除 |
| 04 | Conveyor Failure | Scenarios → Conveyor Failure → Conveyor #03 → Stop | 3D 輸送帶閃紅；System Status Conveyors = Error；Packing 01 前機器人排隊（Traffic View 右下角變熱）；AI Ops KPI 的 Avg wait 上升 |
| 05 | Robot Failure | Scenarios → Robot Failure → R07 → Fail | R07 灰色 OFFLINE；它的任務 TRANSFERRED 並以 HIGH 重新排入；AI Ops 決策卡片顯示新指派與理由 |
| 06 | Traffic Congestion | Scenarios → Traffic Congestion → Zone C → 80% → Inject | Zone C 橘框 ⚠；機器人在 C 內減速；MAP VIEW 看到路徑繞開 C；Alerts「Traffic Delay · speed limited」 |
| 07 | Sensor Failure | Scenarios → Camera Failure → CAM-B03 → Offline；Live Camera 切到 B 的第 3 台 | 畫面 NO SIGNAL；System Status CCTV = Warning；3D 裡攝影機變灰 |
| 08 | What-if R07 Failure | What-if → 勾 R07 failure → 5 min → RUN | 對照表：Baseline vs Scenario；說明「車隊有餘裕，吞吐只掉 2%、任務時間 +x s」；再勾 Conveyor #03 + Peak demand 重跑，看差異放大；**Apply scenario to LIVE** |
| 09 | AI Optimization | 先做 04 或 10 → AI Ops → 問「Why is throughput dropping?」「How can we improve throughput?」 | 回答引用 CV03 / Zone / 機器人 id，可點擊跳轉；回覆底下顯示 `gpt-4o-mini`（或 `rule-based`） |
| 10 | AI Autonomous Decision | Scenarios → **Demo 10 · Compound → Run all three** | 三個 Alert 同時出現；Event Log 追溯鏈：Human detected → Zone B BLOCKED → CV03 STOPPED → R07 re-queued → Rx assigned (AI decision) → rerouted；AI Ops 問「Which conveyor is the bottleneck?」；What-if 跑同一組比較「如果沒處理會怎樣」 |

## 講稿重點（30 秒版）

「這是一個瀏覽器原生的倉庫數位分身。左邊是車隊與任務 KPI，中間是 20 台 AMR 的即時 3D，右邊是虛擬 CCTV 與事件。後端 Python 引擎每 100 ms 推進一次，WebSocket 只送變動的欄位。我可以注入故障——人員闖入 Zone B——VLM 從攝影機畫面辨識出人，Zone 封鎖，受影響的機器人立刻重新規劃。Fleet Manager 的每個指派都有可解釋的理由。最後，What-if 把整個 Twin 複製一份、注入故障跑五分鐘，告訴我如果輸送帶壞掉吞吐會掉多少、該怎麼應對。」

## 常見狀況

- 徽章是橘色 **LOCAL**：後端沒開或還在啟動。前端會用內建引擎照常運作，但 Copilot / VLM / What-if 需要後端。
- Copilot 回覆開頭 `[LLM unavailable: …]`：API key 或網路問題，已自動退回規則式分析，Demo 不會中斷。
- 想要「每次一樣」的展示：後端 `TWIN_SEED` 固定（預設 42），按 ↻ Reset 就會從同一個起點重來。
