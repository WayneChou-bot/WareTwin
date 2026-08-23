# warehouse_layout.json 格式說明

## 目的

這一份檔案是倉庫的「唯一真相來源」。3D 場景（Three.js）、導航網格（A*）、Map View、Heatmap、Camera 清單、任務的 source/destination 全部從同一份 layout 產生，不允許任何一方自己硬編座標。這樣做的好處是：改一份檔案，四個視角同時一致；What-if 與測試也能載入不同的 layout 做對照。

配套檔案：`gen_layout.py`（產生範例的腳本，改參數重跑即可）、`warehouse_layout.json`（範例，100×70 m、4 Zone、160 貨架、3 輸送帶、6 充電站、14 攝影機、20 台機器人出生點）、`layout_preview.png`（俯視預覽）。

## 座標系

右手座標、單位公尺。`x` 是倉庫長邊（0 → 100），`z` 是短邊（0 → 70），`y` 是高度。`z = 0` 是碼頭側（Inbound / Outbound），`z = 70` 是充電與 Packing 側。2D 欄位一律寫 `[x, z]`，3D 欄位一律寫 `[x, y, z]`。`rotation` / `heading` 為繞 y 軸的弧度，0 指向 +x。矩形 `rect` 寫 `[x0, z0, x1, z1]`，多邊形 `polygon` 寫 `[[x, z], ...]`，順時針或逆時針皆可。

## 頂層結構

```jsonc
{
  "schema_version": "1.0",
  "id": "wh-main-v1",              // TwinState.layout_id 對應這個值
  "name": "Main Warehouse (100x70m)",
  "units": "m",
  "size":  { "width": 100, "depth": 70, "height": 12 },
  "grid":  { "cell_size": 1.0, "cols": 100, "rows": 70 },   // 導航網格解析度
  "zones": [...], "docks": [...], "racks": [...], "conveyors": [...],
  "stations": [...], "charging_stations": [...], "parking": [...],
  "restricted_areas": [...], "walkways": [...],
  "cameras": [...], "sensors": [...],
  "locations": [...],             // 任務可引用的所有「可到達位置」
  "obstacles": [...],             // 靜態雜物（柱子、臨時堆放）
  "spawn": { "robots": [...] }
}
```

## 各區段欄位

**zones** — 每個 Zone 一筆：`id`（"A".."D"，與 TwinState.zones 的 key 相同）、`name`、`color`（UI 與 3D 邊框共用的 hex）、`polygon`。Zone 之間刻意留出中央走道（x 46–54）與輸送帶走廊（z 32–38），機器人在 Zone 外也能通行，Zone 只是統計與封鎖的邏輯單位。

**docks** — `id`、`kind`（INBOUND | OUTBOUND）、`zone`、`rect`、`door`（門的 2D 位置，3D 畫門用）。每個 dock 會自動在 `locations` 產生一筆同 id 的可到達位置。

**racks** — 這是數量最多的區段，3D 用 InstancedMesh 一次畫完。`id`、`zone`、`position`（左前角，y=0）、`size`（`[長, 高, 深]`）、`rotation`、`levels`（層數，畫箱子用）、`model`（GLB 名稱）、`blocks_grid`（true 表示佔用的格子在導航網格中為障礙）。

**conveyors** — `id`（"CV01"，與 TwinState.conveyors 的 key 相同）、`name`（UI 顯示「Conveyor #03」）、`zone`、`path`（折線 2D 點列）、`width`、`speed_mps`、`direction`（FORWARD | REVERSE）、`blocks_grid`、`feeds`（這條輸送帶供應的工作站 id；輸送帶故障時該站的卸貨停留時間 ×4，這是 Demo 04 瓶頸的來源）。輸送帶是障礙，機器人不能穿越；若需要「跨越點」，在 `path` 中間斷開成兩條。

**stations** — Packing / Sorting 等工作站：`id`、`kind`、`zone`、`rect`、`access_point`（機器人停靠的 2D 點，必須在 rect 外且為可通行格）。同樣自動產生對應的 `locations`。

**charging_stations** — `id`（"CHG-01"）、`zone`、`position`、`heading`（停靠朝向）、`power_kw`（電池模型充電速率）、`access_point`。

**parking** — `id`、`zone`、`rect`、`slots`。閒置機器人的待命區，Fleet Manager 把 IDLE 機器人送回這裡。

**restricted_areas** — `rect` + `robots_allowed: false`，導航網格直接標為障礙。

**walkways** — 人行道：`polygon`、`robots_allowed`、`speed_limit_mps`。機器人可通行但需減速；Human Intrusion 注入時，人員會優先沿 walkway 出現。

**cameras** — `id`（"CAM-B03"）、`zone`、`position`（含高度）、`look_at`、`fov_deg`、`range_m`。3D 場景裡的 Virtual CCTV 就是用這些參數建立一台 PerspectiveCamera 渲染到 RenderTarget；Phase 5 把那張 RenderTarget 截圖送 VLM。

**sensors** — `id`、`kind`（LIDAR | IR | WEIGHT | TEMP | PRESENCE）、`zone`、`position`。第一版只是場景裝飾與狀態顯示，不影響模擬。

**locations** — 任務系統唯一認得的「位置」字典。每筆有 `id`、`kind`（SHELF | PACKING | SORTING | INBOUND | OUTBOUND | CHARGING）、`zone`、`rack_id`（SHELF 才有）、`level_range`、`access_point`。**TaskState.source / destination 只能填這裡的 id**，模擬引擎用 `access_point` 當 A* 的目標格。範例裡每個貨架 bay 的兩側各有一個 SHELF location（`SHELF-A01` … `SHELF-A80`），所以 4 個 Zone 共 320 個可存取貨位，加上 docks、stations、charging 共 333 筆。

**obstacles** — 臨時障礙：`id`、`rect` 或 `polygon`、`blocks_grid`。範例為空；故障注入時（例如掉落貨物）可動態加入，但動態障礙建議走 TwinState.people / events，不要回寫 layout。

**spawn.robots** — 20 台機器人的初始 `id`、`position`、`heading`、`battery`。模擬 RESET 時從這裡重建。

## 導航網格的產生規則

網格由 `size` 與 `grid.cell_size` 決定（範例為 100×70 = 7,000 格）。一格被標為障礙，若且唯若它與任何 `blocks_grid: true` 的 rack / conveyor、任何 `restricted_areas`、或倉庫外牆相交。walkway 不是障礙，但格子帶有 `speed_factor`（0.8 m/s 上限）。這個規則寫成一個純函式 `buildNavGrid(layout) → Uint8Array`，前後端各實作一份並用相同的 layout 做單元測試比對結果，確保 Map View 畫的牆和後端 A* 認得的牆一致。

## 驗證規則（載入時必須檢查）

所有 `id` 在全檔案內唯一；`locations[].access_point` 必須落在可通行格；`spawn.robots[].position` 必須落在可通行格且互不重疊；每個 `zone` 引用都必須存在於 `zones`；`conveyors[].path` 至少 2 點；rack 不得超出倉庫邊界。建議寫成 `validate_layout(layout)` 回傳錯誤列表，CI 對每個 layout 檔跑一次。

## 範例的設計意圖

範例刻意模仿預期完成介面圖的佈局：碼頭在上、Zone A/B 在上半、Zone C/D 在下半、輸送帶橫貫中央並在右側（Conveyor #03）轉向 Packing，充電站在左下、停車區在正下方。Conveyor #03 被放在 Zone D 的末端通往 PACK-01，這樣 Demo 04「Conveyor #03 停止」會真的造成 Packing 端的瓶頸，而不是只是換個顏色。

如果要改尺寸或密度，直接改 `gen_layout.py` 頂部的參數（`W, D`、每 Zone 排數 `n_rows`、每排 bay 數）重新產生即可。


## floors / lifts（Phase 8）

- `floors`: `[{id, name, elevation, footprint?}]` — 樓層清單；`elevation` 為樓板頂面高度 (m)，`footprint` 是二樓以上樓板的多邊形（之外視為不存在的樓板 = 障礙）。
- `lifts`: `[{id, cell:[c,r], floors:[…], ride_ticks}]` — 貨梯；`cell` 在所有它連接的樓層都必須可走。一次載一台機器人，`ride_ticks` 為搭乘時間。
- `racks` / `locations` / `zones` / `cameras` / `spawn.robots` 皆可帶 `floor`（預設 1）。每個樓層有獨立導航網格（見 navgrid 的 floor 參數）。
