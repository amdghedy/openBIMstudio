/**
 * Plugin loader — loads runtime plugins from /public/plugins/*.js
 *
 * Plugins live in public/ so they can be authored/replaced without a
 * rebuild. Vite serves them as-is, so we load them with <script> tags
 * rather than import(), which would trip Vite's "public files are not
 * importable" rule.
 */

const loaded = new Set<string>();

function loadScript(url: string, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (loaded.has(name)) return resolve();

    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.dataset.obsPlugin = name;
    s.onload = () => {
      loaded.add(name);
      resolve();
    };
    s.onerror = () => reject(new Error(`Failed to load plugin: ${url}`));
    document.head.appendChild(s);
  });
}

export async function loadPlugins(): Promise<void> {
  const plugins = ["hello"]; // names in public/plugins/*.js
  for (const p of plugins) {
    try {
      await loadScript(`/plugins/${p}.js`, p);
      console.log(`[plugins] loaded ${p}`);
    } catch (e) {
      console.warn("[plugins]", e);
    }
  }
}