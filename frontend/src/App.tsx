import { useEffect } from "react";
import { TopBar } from "./components/shell/TopBar";
import { useSimulationRunner } from "./simulation/runner";
import { Viewport } from "./components/views/Viewport";
import { AlertsPanel, FleetOverviewPanel, SystemStatusPanel, TaskOverviewPanel } from "./components/panels/LeftPanels";
import { EventLogPanel, LiveCameraPanel, SelectedRobotPanel } from "./components/panels/RightPanels";
import { RobotStatusPanel, TaskQueuePanel, ThroughputPanel } from "./components/panels/BottomPanels";
import { ScenariosDrawer } from "./components/ops/ScenariosDrawer";
import { OpsDrawer } from "./components/ops/OpsDrawer";
import { Modals } from "./components/ops/Modals";
import { WhatIfDrawer } from "./components/ops/WhatIfDrawer";

/**
 * 版面以 1536×860 CSS px 為基準設計；視窗更小時整體等比縮小，確保所有面板完整可見
 * (Windows 125% 縮放的 1080p ≈ 1536×750)。用 transform 而不是 CSS zoom：zoom 會讓 R3F 量到的畫布尺寸被縮兩次。
 */
const DESIGN_W = 1536, DESIGN_H = 860;
function useFitScale() {
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const z = Math.min(1, window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
      root.style.setProperty("--ui-scale", z < 0.995 ? z.toFixed(4) : "1");
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);
}

export default function App() {
  useFitScale();
  useSimulationRunner();
  return (
    <div className="shell">
      <TopBar />
      <div className="shell-body">
        <aside className="col-left">
          <FleetOverviewPanel />
          <TaskOverviewPanel />
          <SystemStatusPanel />
          <AlertsPanel />
        </aside>
        <main className="center"><Viewport /></main>
        <aside className="col-right">
          <SelectedRobotPanel />
          <LiveCameraPanel />
          <EventLogPanel />
        </aside>
        <footer className="bottom">
          <TaskQueuePanel />
          <ThroughputPanel />
          <RobotStatusPanel />
        </footer>
      </div>
      <ScenariosDrawer />
      <OpsDrawer />
      <WhatIfDrawer />
      <Modals />
    </div>
  );
}
