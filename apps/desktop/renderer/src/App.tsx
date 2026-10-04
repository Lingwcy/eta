import { useDesktopShell } from "@/agent/use-desktop-shell";
import { DesktopTabBar } from "@/components/tabs/desktop-tab-bar";
import { DesktopPanels } from "@/components/tabs/desktop-panels";

export function App() {
  const shell = useDesktopShell();
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[#f3f3f3] font-sans text-[#292b2e] antialiased [--rail-width:50px] [--sidebar-width:170px] min-[701px]:[--sidebar-width:190px] min-[901px]:[--sidebar-width:210px] min-[1600px]:[--sidebar-width:230px]">
      <DesktopTabBar
        state={shell.navigation.state}
        tabs={shell.navigation.tabs}
        items={shell.items}
        collapsed={shell.collapsed}
        onToggle={shell.toggleSidebar}
        onOverlay={shell.setOverlay}
        onPreview={shell.browser.capture}
      />
      <DesktopPanels shell={shell} />
    </div>
  );
}
