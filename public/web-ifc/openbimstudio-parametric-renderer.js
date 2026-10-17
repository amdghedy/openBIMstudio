/* ============================================================================
 * openbimstudio-parametric-renderer.js
 * Registry so your app can plug its own renderer into the parametric engine.
 *
 * Public API:
 *   window.OpenBIMStudio.parametric.registerRenderer({
 *     name: 'three' | 'babylon' | 'custom',
 *     updateElement: function (expressID, geometry, record) {},
 *     removeElement: function (expressID) {},
 *     clear: function () {}
 *   });
 *
 * Auto fallback: if window.THREE exists and no renderer is registered,
 * a naive BoxGeometry adapter attaches itself to window.__obsScene.
 * ========================================================================== */
(function () {
  'use strict';
  var bus = window.OpenBIMStudio = window.OpenBIMStudio || {};
  bus.parametric = bus.parametric || {};

  var active = null;
  var queue = [];

  function dispatch(record) {
    if (!active) { queue.push(record); return; }
    try { active.updateElement(record.expressID, record.geometry, record); }
    catch (e) { console.warn('[OBS-renderer] updateElement failed:', e); }
  }

  function flushQueue() {
    while (queue.length && active) dispatch(queue.shift());
  }

  bus.parametric.registerRenderer = function (impl) {
    if (!impl || typeof impl.updateElement !== 'function') {
      throw new Error('registerRenderer requires { updateElement }');
    }
    active = {
      name: impl.name || 'custom',
      updateElement: impl.updateElement,
      removeElement: impl.removeElement || function () {},
      clear: impl.clear || function () {}
    };
    console.info('[OBS-renderer] registered:', active.name);
    flushQueue();
    return active;
  };

  bus.parametric.getRenderer = function () { return active; };

  window.addEventListener('obs:parametric-regenerate', function (e) {
    var diff = (e.detail && e.detail.diff) || [];
    for (var i = 0; i < diff.length; i++) dispatch(diff[i]);
  });

  // ---- naive Three.js fallback (only if no explicit renderer registered) ----
  function tryAutoThree() {
    if (active) return;
    if (!window.THREE) return;
    if (window.__obsRendererAttached) return;
    window.__obsRendererAttached = true;

    var scene = window.__obsScene;
    if (!scene) {
      console.info('[OBS-renderer] THREE detected but window.__obsScene is missing. '
                 + 'Assign your scene to window.__obsScene or call registerRenderer().');
      return;
    }
    var meshes = new Map();
    var mat = new THREE.MeshStandardMaterial({ color: 0x66aaff, side: THREE.DoubleSide });

    function dispose(mesh) {
      if (mesh.geometry) mesh.geometry.dispose();
      scene.remove(mesh);
    }

    bus.parametric.registerRenderer({
      name: 'three-fallback',
      updateElement: function (expressID, geom) {
        if (!geom || geom.kind !== 'Extrusion') return;
        var w = geom.profile.width  || 0.5;
        var d = geom.profile.height || 0.5;
        var h = geom.depth || 1;

        var mesh = meshes.get(expressID);
        if (mesh) dispose(mesh);
        mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        if (geom.origin) mesh.position.set(geom.origin.x || 0, geom.origin.z || 0, geom.origin.y || 0);
        scene.add(mesh);
        meshes.set(expressID, mesh);
      },
      removeElement: function (expressID) {
        var m = meshes.get(expressID); if (m) { dispose(m); meshes.delete(expressID); }
      },
      clear: function () {
        meshes.forEach(dispose); meshes.clear();
      }
    });
    console.info('[OBS-renderer] Three.js fallback attached to window.__obsScene');
  }

  // Poll for THREE (bundle may load after this script)
  var tries = 0;
  var t = setInterval(function () {
    tries++;
    tryAutoThree();
    if (active || tries > 200) clearInterval(t);
  }, 100);
})();
