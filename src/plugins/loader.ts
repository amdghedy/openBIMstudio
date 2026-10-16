export async function loadPlugins() {
  const resp = await fetch('/manifest.json');
  if (!resp.ok) return console.warn('No manifest found');
  const manifest = await resp.json();
  const pluginsTab = document.querySelector('#plugins-tab .ribbon-tab-content');

  for (const entry of manifest.plugins) {
    try {
      const mod = await import(entry.url);
      if (typeof mod.register === 'function') {
        mod.register({
          api: (window as any).bimAPI,
          store: (window as any).bimStore,
          addRibbonButton: (label: string, onClick: () => void) => {
            const btn = document.createElement('button');
            btn.textContent = label;
            btn.onclick = onClick;
            pluginsTab?.appendChild(btn);
          },
        });
        console.log(`Plugin ${entry.name} loaded`);
      }
    } catch (e) {
      console.error('Failed to load plugin', entry.name, e);
    }
  }
}
