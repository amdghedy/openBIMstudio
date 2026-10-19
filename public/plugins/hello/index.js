/**
 * Hello World sample plugin — minimum-viable SDK demo.
 */
(function () {
  if (!window.__obsRegisterPlugin) {
    console.warn("[hello] __obsRegisterPlugin bridge not available — host too old?");
    return;
  }

  window.__obsRegisterPlugin(
    {
      id: "hello",
      name: "Hello World (Sample Plugin)",
      version: "1.0.0",
      sdkVersion: 1,
      capabilities: ["ui.command", "ui.notification"],
    },
    function (api) {
      const { obs, log } = api;

      return {
        activate: function () {
          log.info("Hello plugin activated");
          obs.ui.registerCommand({
            id: "hello.say",
            label: "Hello from Plugin",
            hint: "Demo command — shows a notification",
            run: function () {
              obs.notify.info("Hello from the openBIMstudio Plugin SDK!");
              log.info("Command run");
            },
          });
        },
        deactivate: function () {
          log.info("Hello plugin deactivated");
          obs.ui.unregisterCommand("hello.say");
        },
      };
    },
  );
})();
