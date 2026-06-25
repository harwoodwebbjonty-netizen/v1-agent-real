import "./style.css";
import { initAuth } from "./auth";
import { initTabBar } from "./components/tabBar";
import { initIdentitySwitcher } from "./identitySwitcher";
import { initTabRouter } from "./router";
import { initSidebarToggle } from "./sidebarToggle";
import { initTheme, toggleTheme } from "./theme";
import { initUpdater } from "./updater";
import { initActionCentre } from "./views/actionCentre";
import { initAnalytics } from "./views/analytics";
import { initCalendar } from "./views/calendar";
import { initCallQueue } from "./views/callQueue";
import { initColdCallLists } from "./views/coldCallLists";
import { initDashboard } from "./views/dashboard";
import { initEmailWriter } from "./views/emailWriter";
import { initOpportunityWorkspace } from "./views/opportunityWorkspace";
import { initSalesIntelligence } from "./views/salesIntelligence";
import { initSequences } from "./views/sequences";
import { initSettings } from "./views/settings";

initTheme();
initIdentitySwitcher();
initDashboard();
initActionCentre();
initCallQueue();
initOpportunityWorkspace();
initColdCallLists();
initSalesIntelligence();
initEmailWriter();
initSequences();
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
void initUpdater();
