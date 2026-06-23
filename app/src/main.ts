import "./style.css";
import { initAuth } from "./auth";
import { initTabBar } from "./components/tabBar";
import { initIdentitySwitcher } from "./identitySwitcher";
import { initTabRouter } from "./router";
import { initSidebarToggle } from "./sidebarToggle";
import { initTheme, toggleTheme } from "./theme";
import { initAnalytics } from "./views/analytics";
import { initCalendar } from "./views/calendar";
import { initColdCallLists } from "./views/coldCallLists";
import { initDashboard } from "./views/dashboard";
import { initEmailWriter } from "./views/emailWriter";
import { initSalesIntelligence } from "./views/salesIntelligence";
import { initSettings } from "./views/settings";

initTheme();
initIdentitySwitcher();
initDashboard();
initColdCallLists();
initSalesIntelligence();
initEmailWriter();
initCalendar();
initAnalytics();
initSettings();
initTabBar();
initTabRouter();
initSidebarToggle();

document.querySelector<HTMLButtonElement>("#theme-toggle-btn")!.addEventListener("click", () => {
  toggleTheme();
});

void initAuth();
