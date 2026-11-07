// Popup landing page for the Microsoft sign-in redirect. It only hands the
// URL fragment to the window that opened it (same origin) and closes itself.
(function () {
  try {
    if (window.opener && window.location.hash) {
      window.opener.postMessage({ type: "obs-auth", hash: window.location.hash }, window.location.origin);
    }
  } catch (e) { /* opener gone */ }
  history.replaceState(null, "", window.location.pathname);
  document.getElementById("m").textContent = "You can close this window.";
  setTimeout(function () { window.close(); }, 200);
})();
