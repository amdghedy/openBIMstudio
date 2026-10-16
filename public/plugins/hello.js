// public/plugins/hello.js
window.__obsPlugin_hello = {
  name: "hello",
  activate() { console.log("[hello plugin] activated"); },
};
console.log("[hello plugin] registered");