// Firefox may expose `self` without the WebGPU GPUShaderStage constants.
// Three.js reads these during module evaluation, before the app can mount.
(function installGpuShaderStageFallback(scope) {
  if (scope.GPUShaderStage) return;
  Object.defineProperty(scope, "GPUShaderStage", {
    configurable: true,
    enumerable: false,
    value: Object.freeze({ VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }),
    writable: false,
  });
})(globalThis);
