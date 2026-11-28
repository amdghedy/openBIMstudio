import { ctx } from "./context";
const registry = new Map();
const registeredAt = new Map();
const readyResolvers = new Map();
/**
 * Register a service. Re-registration overwrites and wakes any pending
 * `ready()` calls. This is what happens during HMR or a project reload.
 */
export function register(key, value) {
    if (!registry.has(key))
        registeredAt.set(key, Date.now());
    registry.set(key, value);
    // Mirror into the legacy ctx.features bag so unmigrated code keeps working.
    try {
        ctx.features[key] = value;
    }
    catch {
        /* */
    }
    const waiters = readyResolvers.get(key);
    if (waiters) {
        readyResolvers.delete(key);
        for (const cb of waiters) {
            try {
                cb(value);
            }
            catch { /* */ }
        }
    }
}
export function use(key) {
    const v = registry.get(key);
    if (!v) {
        throw new ServiceNotReadyError(key);
    }
    return v;
}
export function tryUse(key) {
    return registry.get(key) ?? null;
}
export function hasService(key) {
    return registry.has(key);
}
/**
 * Resolve when the service is registered. If it is already registered, the
 * returned promise resolves on the next microtask so callers can always
 * `await` without branching.
 */
export function ready(key) {
    const existing = registry.get(key);
    if (existing)
        return Promise.resolve(existing);
    return new Promise((resolve) => {
        const list = readyResolvers.get(key) ?? [];
        list.push(resolve);
        readyResolvers.set(key, list);
    });
}
export class ServiceNotReadyError extends Error {
    key;
    constructor(key) {
        super(`Service "${String(key)}" was requested before it was registered. ` +
            `Call services.ready("${String(key)}") to await it, or use ` +
            `services.tryUse("${String(key)}") if it is optional.`);
        this.key = key;
        this.name = "ServiceNotReadyError";
    }
}
/** Convenience re-exports for call sites. */
export const services = {
    get selection() { return use("selection"); },
    get authoring() { return use("authoring"); },
    get family() { return use("family"); },
    get camera() { return use("camera"); },
    get clash() { return use("clash"); },
    get fragEdit() { return use("fragEdit"); },
    get issues() { return use("issues"); },
    get schedules() { return use("schedules"); },
    get projects() { return use("projects"); },
    get planView() { return use("planView"); },
    get appLoader() { return use("appLoader"); },
    get commandPalette() { return use("commandPalette"); },
    register,
    ready,
    use,
    tryUse,
    has: hasService,
    lifecycle: serviceLifecycle,
    missing: missingServices,
};
/* ══════════════════════════════════════════════════════════════════════
   Debug helpers
   ══════════════════════════════════════════════════════════════════════ */
export function listRegisteredServices() {
    return [...registry.keys()];
}
/** Print a snapshot of registered services to the console. */
export function dumpServiceRegistry() {
    console.group("[services] registry");
    for (const k of listRegisteredServices()) {
        console.log("  •", k);
    }
    console.groupEnd();
}
/** Snapshot of every registered service: when it became ready + waiters left. */
export function serviceLifecycle() {
    return [...registry.keys()].map((key) => ({
        key,
        registeredAt: registeredAt.get(key) ?? 0,
        pendingWaiters: readyResolvers.get(key)?.length ?? 0,
    }));
}
/**
 * Boot watchdog: which of the expected services are still missing.
 * Returns the missing subset — empty means everything booted as designed.
 * Consumed by the boot-health layer at finalize time.
 */
export function missingServices(keys) {
    return keys.filter((k) => !registry.has(k));
}
