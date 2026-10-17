import { setupRibbon } from "./ribbon";
import { setupStatusBar } from "./status-bar";
import { setupHomeScreen, showHome } from "./home-screen";

export function setupShell() {
  setupRibbon();
  setupStatusBar();
  setupHomeScreen();
  showHome(); // the app always starts at the landing screen
}