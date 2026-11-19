/**
 * Firefox exposes `self` even when WebGPU is unavailable, but does not expose
 * the WebGPU `GPUShaderStage` constants. Three.js 0.182 reads that global
 * while evaluating its WebGPU/TSL bundle, so the missing property can abort
 * the entire application before the WebGL viewer mounts.
 *
 * Keep this shim deliberately small and standards-compatible: it only fills
 * the absent constants and never replaces a browser-provided implementation.
 */

type ShaderStageConstants = {
  readonly VERTEX: 1;
  readonly FRAGMENT: 2;
  readonly COMPUTE: 4;
};

const scope = globalThis as typeof globalThis & {
  GPUShaderStage?: ShaderStageConstants;
};

if (!scope.GPUShaderStage) {
  Object.defineProperty(scope, "GPUShaderStage", {
    configurable: true,
    enumerable: false,
    value: Object.freeze({ VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 } satisfies ShaderStageConstants),
    writable: false,
  });
}
