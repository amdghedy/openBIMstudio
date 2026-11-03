import { setupRibbon } from "./ribbon";
import { setupStatusBar } from "./status-bar";
import { setupFullscreenChrome } from "./fullscreen-chrome";
import { setupHomeScreen, showHome } from "./home-screen";

export function setupShell() {
  setupRibbon();
  setupStatusBar();
  setupFullscreenChrome(); // full screen (F11 / CAD button) hides ribbon + status bar
  setupHomeScreen();
  showHome(); // the app always starts at the landing screen
}
