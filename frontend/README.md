# AI Autonomous Warehouse Digital Twin — Frontend (Phase 1–6)

瀏覽器原生的 3D 倉庫數位分身。Phase 1 交付「3D Foundation」（完整倉庫場景 + 介面版面），Phase 2 交付「Robot Simulation」（20 台機器人在本地確定性模擬引擎中真的運作）。

## 啟動

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc 型別檢查 + vite build → dist/
npm run preview    # 預覽 dist/
npm test           # vitest：A* 正確性、引擎 20 分鐘壓力測試、確定性、低電量轉移、人員入侵封鎖
npm run sim:stats  # 無畫面跑 12000 tick 並列印 KPI（效能基準：~0.1 ms/tick）
```

需求：Node 18+。不需要任何外部資源（無 HDR / GLB 下載），離線可跑。

## Phase 1 完成的內容

- `AppShell`：三欄 + 底列 CSS Grid，與「預期完成介面.png」版面一致
- `Scene3D`：React Three Fiber (WebGL2)。貨架 / 箱子以 InstancedMesh 三個 draw call 畫完；輸送帶、工作站、充電樁、停車區、限制區、碼頭、卡車、Zone 霓虹框、20 台程序化 AMR、人員 / 堆高機 NPC、虛擬攝影機與 FOV 錐
- 品質等級 Low / Medium / High（TopBar 齒輪切換）：Low 無陰影無後製、Medium 陰影 + Bloom、High 加 SSAO + Vignette + ContactShadows
- `MapView2D` / Traffic / Heatmap：從 `warehouse_layout.json` 建導航網格畫 2D 俯視圖；Traffic 與 Heatmap 目前用假熱區
- 互動：點擊機器人（3D 或 2D）選取，右欄 Selected Robot 更新並飛到該機器人；點 Zone 標籤聚焦；Alerts / Event Log / Task Queue 點擊跳到相關機器人；Live Camera 分頁點切換攝影機
- FPS 計數器（右下）

## Phase 2 完成的內容

- `simulation/astar.ts`：8 方向格點 A*（禁止切角、binary heap、臨時障礙、擁塞成本）
- `simulation/engine.ts`：確定性模擬引擎（固定 seed PRNG、100 ms tick、純資料 TwinState）
  - 機器人狀態機：IDLE → TASK_ASSIGNED → NAVIGATING → PICKING → TRANSPORTING → DELIVERING → COMPLETED；OBSTACLE_DETECTED → REPLANNING；LOW_BATTERY → TASK_TRANSFER → GOING_TO_CHARGE → CHARGING
  - 移動：加速度、轉彎減速、人行道限速；格點佔用 + 下一格預約避讓，被擋 2.5 s 自動重新規劃（以其他機器人為臨時障礙）
  - 電池：依速度與載貨消耗，<20% 警告、<10% 危急，運送中估算剩餘電量不足就轉移任務並去充電（6 座充電樁排隊）
  - 任務：自動產生 PICK / REPLENISH / TRANSPORT，含優先權；Fleet Manager 以距離、電量、負載、擁塞、健康加權評分指派，並輸出可解釋的候選清單（`recent_decisions`）
  - KPI、Zone 擁塞、事件（ring 500）、Alerts、throughput 曲線、交通熱圖全部由引擎產生
  - 情境注入 API（`engine.inject`）：機器人故障、電量設定、輸送帶故障、攝影機離線、人員入侵（封鎖 Zone + 重新規劃）、任務爆量 — Phase 4 的故障注入 UI 直接接這裡
- `simulation/runner.ts`：rAF 迴圈，真實時間 × 倍速換算 tick 數，每幀最多 40 tick
- 前端：機器人位置指數平滑（模擬 10 Hz → 畫面 60 Hz）、輪子轉動、真實 A* 路徑線（載貨橘、去充電藍）、TopBar 播放/暫停/重置/倍速、模擬時鐘（08:00 起）、Map/Traffic/Heatmap 讀引擎交通資料

## 目錄

```
src/
  schema/twin_state.ts      # 資料契約 (與 docs/schema/twin_state.py 對應)
  layout/warehouse_layout.json  # 倉庫唯一真相來源 (由 docs/layout/gen_layout.py 產生)
  layout/types.ts, navgrid.ts   # layout 型別、導航網格產生
  state/store.ts            # zustand：TwinState、選取、視角、品質
  simulation/astar.ts       # A*
  simulation/engine.ts      # 模擬引擎 (Phase 3 搬到後端時以此為規格)
  simulation/runner.ts      # 引擎 ↔ store 的 rAF 迴圈
  tests/engine.test.ts      # vitest
  components/shell/         # TopBar
  components/panels/        # 左欄 / 右欄 / 底列面板
  components/scene/         # 3D 場景各子元件
  components/views/         # Viewport (頁籤/工具列)、MapView2D
  components/ui/            # Panel、StatRow、Icon 等共用元件
```

## 在 Intel Arc 筆電上的效能建議

預設 Medium。若 FPS < 30：先切 Low（TopBar 齒輪），再考慮把 `Scene3D.tsx` 的 `dpr` 上限降到 1。Live Camera 面板是第二個 WebGL context（`frameloop="demand"`，只在切換時重繪），Phase 2 機器人開始移動後會改成固定 5 FPS 更新。

## Phase 3 完成的內容

- `services/ws.ts`：WebSocket client。FULL 整份取代、PATCH 以 id 合併（null = 刪除）、events prepend、base_tick 不符自動 RESYNC、分頁回前景自動 RESYNC、斷線 3 秒重連。
- `simulation/runner.ts`：資料來源切換。連上後端 → store 完全由後端驅動（TopBar 藍色 BACKEND）；連不上或斷線 → 本地引擎從當下畫面的狀態接手（橘色 LOCAL），不會跳回 tick 0。
- `simControl`：播放 / 暫停 / 倍速 / 重置 / 注入 / 建任務的統一入口，online 送 WebSocket 指令，否則操作本地引擎。後端是權威：另一個分頁按暫停，這邊也會同步。
- Heatmap / Traffic：online 時讀後端每 30 tick 送的 HEATMAP 層，local 時讀本地引擎。

## Phase 4 完成的內容（Operations）

- **Scenarios 抽屜**（TopBar ⚡）：Robot Failure / Low Battery / Conveyor Failure / Human Intrusion / Traffic Congestion / Camera Failure / Task Burst，以及 Demo 10 的三合一。下方「Active」由 TwinState 推導出目前生效的注入，可一鍵 Clear（機器人復原、輸送帶恢復、攝影機上線、人員離開、限速解除）。
- **AI Ops 抽屜**（TopBar 🧠）：8 個 KPI tile + Fleet Manager 決策卡片（✓ 理由、被拒絕者原因、權重快照）— 規格 2️⃣5️⃣ 的可解釋性，Phase 5 的 Copilot 對話會接在同一個抽屜。
- **Audit Log**（鈴鐺或 Event Log 的 View All）：online 從後端 SQLite 抓 500 筆，local 用 ring；嚴重度 / 來源 / 關鍵字篩選，匯出 CSV / JSON，點列跳到機器人。
- **Tasks**（View All Tasks）：全部任務含時間軸與 parent 任務；建立任務表單（來源/目的地來自 layout.locations）。
- **Robot Detail**（View Details）：規格 3️⃣ 全欄位 + 累計統計 + 該機器人事件 + Fail / Restore / Battery→8% 按鈕。
- Alerts 可 ✓ 確認；Live Camera 有 A / B / C / D / Dock 分頁，攝影機離線顯示 NO SIGNAL；Task Overview 多 Utilization。
- 引擎（TS 與 Python 同步）：輸送帶故障讓所供應工作站的卸貨時間 ×4（`layout.conveyors[].feeds`），這就是 Demo 04 的瓶頸；交通擁塞注入 = Zone 內限速 + A* 成本；感測器讀值與輸送帶吞吐由真實狀態推導；所有注入可解除。

## Phase 5 完成的內容（AI）

- **Operations Copilot**（AI Ops 抽屜）：建議問題 chips、對話、回答裡的 R03 / A3812 / E123 可點擊跳轉（機器人 → 選取；任務 → 任務表；事件 → Audit Log）；回覆以 `request_id` 對應，多個問題同時在飛也不會錯位。後端有 `OPENAI_API_KEY` 時走 LLM（結構化 JSON 輸出、引用只允許快照裡存在的 id），沒有時走規則式分析，UI 會標示 `gpt-4o-mini` 或 `rule-based`。
- **VLM Perception**（Live Camera）：Analyze 把當前畫面縮成 512px JPEG 送 `/api/vlm/observe`，回傳的偵測框與信心值疊在畫面上；auto 5s 可連續監看。無 key 時後端用 ground truth 模擬（標示 `sim`）。
- 引擎（TS 與 Python 同步）：**deadlock breaker** — 距工作站 ≤3 格且前方被佔就就地作業（不再 10 台排同一格）、互相擋住時空車讓載貨車 / 編號大的讓路（back-off 到旁邊空格再回來）、斜向移動連正交鄰格一起預約（杜絕 X 形擦撞）。Demo 10 三合一 30 分鐘不再卡死（263 任務 vs 修正前 44）。
- 測試：碰撞判定改為物理距離（任兩台 < 0.5 m 即失敗）+ 複合故障 30 分鐘吞吐下限。

## Phase 6 完成的內容（What-if）

- **What-if 抽屜**（TopBar ⑂）：勾選情境（R07 故障、Conveyor #03、Zone B 人員、Zone C 擁塞、攝影機、Peak demand +20 任務、R03 低電量）、時長 1–10 分鐘、是否比較 Baseline → RUN。後端複製 LIVE 引擎兩份（同 tick、同亂數狀態）跑完回傳：12 項指標的 Baseline / Scenario / Δ 對照表（紅綠依「越高越好」判定）、AI 建議、情境中的關鍵事件；**Apply scenario to LIVE** 把同一組注入打到 LIVE。LIVE 全程不受影響。

## Phase 7（Robotics Extension）接口

- ROS 2 / Webots：後端 `SimEngine.step()` 是唯一推進點，把 `robots[id].position/heading` 改成從 ROS topic 讀、`path` 改成送 nav goal，其餘（任務、KPI、事件、AI）不用動。`TwinState` 契約不變，前端零修改。
- 已知限制：機器人之間只有格點避讓，沒有真正的多機協同規劃（CBS）；閒置機器人回停車區時可能短暫互相等待；Live Camera 面板是第二個 WebGL context，低階 GPU 可考慮改成 RenderTarget 貼圖。

## 部署

前端是純靜態檔，後端是長駐的 WebSocket 服務（不能用 serverless）。

**後端 → Render（免費）**：New → Blueprint → 指向 repo，`backend/render.yaml` 會被讀取。部署完成後拿到 `https://<name>.onrender.com`，到 Environment 把 `TWIN_CORS_ORIGINS` 改成前端網域。免費方案閒置 15 分鐘會休眠，喚醒約 30 秒——前端在這段時間會顯示 LOCAL 並用本地引擎，後端醒來後自動接回。
也可用 `backend/Dockerfile` 部署到 Fly.io（`fly.toml` 已附）、Railway 或 Cloud Run。

**前端 → Vercel**：Import repo，Root Directory 選 `frontend`，Environment Variables 加 `VITE_WS_URL = wss://<name>.onrender.com/ws`（注意是 **wss**，HTTPS 頁面不能連 ws）。`vercel.json` 已設好 Vite 與 SPA rewrite。

GitHub Pages 也可以，但要在 `vite.config.ts` 加 `base: "/<repo-name>/"`，並在 Actions 的 build 步驟設 `VITE_WS_URL`。
