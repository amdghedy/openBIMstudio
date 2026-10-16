/* ============================================================================
 *  OpenBIMstudio - Autodesk Viewer Importer  (no APS credentials required)
 *  --------------------------------------------------------------------------
 *  Adds a floating "Import from Autodesk" button. Clicking it opens a modal:
 *
 *    Step 1 - Open the Autodesk Viewer tab (paste URL + "Open viewer")
 *    Step 2 - Click "Copy properties script" or "Copy geometry script",
 *             paste into the viewer's DevTools console, press Enter.
 *             A .json or .glb file downloads.
 *    Step 3 - Drop that file onto the drop-zone in the modal.
 *
 *  The button never talks to APS itself - extraction runs inside the
 *  Autodesk viewer using its public JavaScript API.
 * ============================================================================ */
(function () {
  'use strict';

  var BTN_ID   = 'obim-autodesk-btn';
  var MODAL_ID = 'obim-autodesk-modal';

  /* -------------------------------------------------------------- snippets */

  var SCRIPT_PROPERTIES = [
    "(async function(){",
    "  var v = window.NOP_VIEWER || (window.Autodesk && Autodesk.Viewing && Autodesk.Viewing.NOP_VIEWER) || null;",
    "  if(!v || !v.model){ return console.error('[OpenBIMstudio] No Autodesk viewer / model on this page.'); }",
    "  var model = v.model;",
    
"  var it = model.getInstanceTree ? model.getInstanceTree() : model.getObjectTree();",
    "  var dbIds = [];",
    "  if (it && typeof it.enumNodeChildren === 'function') { it.enumNodeChildren(it.getRootId(), function(id){ dbIds.push(id); }, true); }",
    "  else if (it && typeof it.getAllObjects === 'function') { dbIds = it.getAllObjects(); }",
    "  else { return console.error('[OpenBIMstudio] Viewer does not expose a usable instance tree.'); }"
,
    "  console.log('[OpenBIMstudio] Reading', dbIds.length, 'objects...');",
    "  var elements = await new Promise(function(res, rej){",
    "    model.getBulkProperties(dbIds, null, res, rej);",
    "  });",
    "  var extMap = await new Promise(function(res){",
    "    try { model.getExternalIdMapping(res, function(){ res({}); }); } catch(e){ res({}); }",
    "  });",
    "  var data = (model.getData && model.getData()) || {};",
    "  var payload = {",
    "    source: 'autodesk-viewer',",
    "    path: 'A-properties',",
    "    exportedAt: new Date().toISOString(),",
    "    urn: data.urn || null,",
    "    documentId: data.documentId || data.parentDocumentId || null,",
    "    elements: elements.map(function(e){",
    "      return {",
    "        dbId: e.dbId,",
    "        externalId: (extMap && extMap[e.dbId]) || e.externalId || null,",
    "        name: e.name,",
    "        properties: e.properties",
    "      };",
    "    })",
    "  };",
    "  var blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});",
    "  var url  = URL.createObjectURL(blob);",
    "  var a    = document.createElement('a');",
    "  a.href = url; a.download = 'autodesk-properties.json';",
    "  document.body.appendChild(a); a.click();",
    "  setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); }, 1000);",
    "  console.log('[OpenBIMstudio] Saved autodesk-properties.json (' + elements.length + ' objects)');",
    "})().catch(function(e){ console.error(e); });"
  ].join("\n");

  var SCRIPT_GEOMETRY = [
    "(async function(){",
    "  var v = window.NOP_VIEWER || (window.Autodesk && Autodesk.Viewing && Autodesk.Viewing.NOP_VIEWER) || null;",
    "  if(!v || !v.model){ return console.error('[OpenBIMstudio] No Autodesk viewer / model on this page.'); }",
    "  var names = ['Autodesk.Viewing.GeometryExporterExtension','GeometryExporterExtension'];",
    "  var ext = null;",
    "  for (var i=0;i<names.length;i++){",
    "    try { ext = await v.loadExtension(names[i]); if(ext) break; } catch(e){ /* try next */ }",
    "  }",
    "  if(!ext){",
    "    return console.error('[OpenBIMstudio] GeometryExporter not available. Before the viewer is initialised, run: Autodesk.Viewing.FeatureFlags.set(Autodesk.Viewing.PublicFeatureFlags.SceneAPI, true);');",
    "  }",
    "  try {",
    "    if(typeof ext.download === 'function'){",
    "      await ext.download({ format: 'glb', filename: 'autodesk-scene.glb' });",
    "    } else if(typeof ext.export === 'function'){",
    "      await ext.export('glb', 'autodesk-scene.glb');",
    "    } else {",
    "      throw new Error('GeometryExporter has no download/export method.');",
    "    }",
    "    console.log('[OpenBIMstudio] Saved autodesk-scene.glb');",
    "  } catch(e){",
    "    console.error('[OpenBIMstudio] Geometry export failed:', e);",
    "  }",
    "})().catch(function(e){ console.error(e); });"
  ].join("\n");

  /* ---------------------------------------------------------------- styles */

  function injectStyles() {
    if (document.getElementById('obim-autodesk-style')) return;
    var s = document.createElement('style');
    s.id = 'obim-autodesk-style';
    s.textContent = [
      '#' + BTN_ID + '{position:fixed;left:20px;bottom:20px;z-index:2147483200;',
      'padding:12px 18px;border-radius:24px;border:none;cursor:pointer;',
      'font:600 14px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
      'color:#fff;background:linear-gradient(135deg,#0a84ff,#0066cc);',
      'box-shadow:0 6px 18px rgba(0,102,204,.35);',
      'transition:transform .15s ease,box-shadow .15s ease;}',
      '#' + BTN_ID + ':hover{transform:translateY(-2px);',
      'box-shadow:0 10px 24px rgba(0,102,204,.45);}',
      '#' + MODAL_ID + '{position:fixed;inset:0;z-index:2147483640;display:none;',
      'align-items:center;justify-content:center;background:rgba(0,0,0,.45);',
      'backdrop-filter:blur(3px);',
      'font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}',
      '#' + MODAL_ID + '.open{display:flex;}',
      '#' + MODAL_ID + ' .obim-card{width:min(640px,94vw);max-height:92vh;',
      'overflow:auto;background:#fff;border-radius:14px;padding:22px 22px 18px;',
      'box-shadow:0 24px 60px rgba(0,0,0,.25);}',
      '#' + MODAL_ID + ' h3{margin:0 0 6px;font-size:18px;}',
      '#' + MODAL_ID + ' h4{margin:14px 0 6px;font-size:14px;}',
      '#' + MODAL_ID + ' p.hint{margin:0 0 10px;color:#666;font-size:12.5px;}',
      '#' + MODAL_ID + ' label{display:block;font-weight:600;margin:10px 0 4px;',
      'font-size:12.5px;}',
      '#' + MODAL_ID + ' input{width:100%;box-sizing:border-box;padding:10px 12px;',
      'border:1px solid #d0d5dd;border-radius:8px;font:inherit;outline:none;}',
      '#' + MODAL_ID + ' input:focus{border-color:#0a84ff;',
      'box-shadow:0 0 0 3px rgba(10,132,255,.15);}',
      '#' + MODAL_ID + ' .obim-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;}',
      '#' + MODAL_ID + ' button{padding:9px 14px;border-radius:8px;',
      'border:1px solid transparent;font:600 13px/1 inherit;cursor:pointer;}',
      '#' + MODAL_ID + ' button.primary{background:#0a84ff;color:#fff;}',
      '#' + MODAL_ID + ' button.ghost{background:#fff;color:#333;',
      'border-color:#d0d5dd;}',
      '#' + MODAL_ID + ' .obim-drop{margin-top:10px;border:2px dashed #c8d2e0;',
      'border-radius:10px;padding:22px 14px;text-align:center;color:#5b6b82;',
      'font-size:13px;background:#f8fafc;transition:border-color .15s,background .15s;}',
      '#' + MODAL_ID + ' .obim-drop.hover{border-color:#0a84ff;background:#eef6ff;',
      'color:#0a84ff;}',
      '#' + MODAL_ID + ' .obim-status{margin-top:10px;font-size:12.5px;',
      'min-height:16px;color:#555;}',
      '#' + MODAL_ID + ' .obim-status.err{color:#c0392b;}',
      '#' + MODAL_ID + ' .obim-status.ok{color:#1e8e3e;}',
      '#' + MODAL_ID + ' .obim-actions{display:flex;gap:10px;justify-content:flex-end;',
      'margin-top:16px;}'
    ].join('');
    document.head.appendChild(s);
  }

  /* ---------------------------------------------------------------- helpers */

  function copyText(text, btn) {
    var done = function () {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(function () { btn.textContent = old; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text, done); });
    } else {
      legacyCopy(text, done);
    }
  }
  function legacyCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done && done(); } catch (e) {}
    ta.remove();
  }

  function kindOf(name, mime) {
    name = (name || '').toLowerCase();
    mime = (mime || '').toLowerCase();
    if (name.slice(-4) === '.ifc' || mime.indexOf('ifc') !== -1) return 'ifc';
    if (name.slice(-4) === '.glb' || name.slice(-5) === '.gltf') return 'glb';
    if (name.slice(-5) === '.json') return 'json';
    return 'unknown';
  }

  function dispatch(kind, file, parsed) {
    var hooks = {
      ifc: [
        ['OpenBIMStudio.loadIfcFile', function () { return window.OpenBIMStudio && window.OpenBIMStudio.loadIfcFile && window.OpenBIMStudio.loadIfcFile(file); }],
        ['loadIfcFile',              function () { return window.loadIfcFile && window.loadIfcFile(file); }],
        ['loadIfc',                  function () { return window.loadIfc && window.loadIfc(file); }],
        ['ifcLoader.load',           function () { return window.ifcLoader && window.ifcLoader.load && window.ifcLoader.load(file, true); }],
        ['viewer.IFC.loadIfcFile',   function () { return window.viewer && window.viewer.IFC && window.viewer.IFC.loadIfcFile && window.viewer.IFC.loadIfcFile(file); }]
      ],
      glb: [
        ['OpenBIMStudio.loadGLB',    function () { return window.OpenBIMStudio && window.OpenBIMStudio.loadGLB && window.OpenBIMStudio.loadGLB(file); }],
        ['loadGLB',                  function () { return window.loadGLB && window.loadGLB(file); }],
        ['loadGLTF',                 function () { return window.loadGLTF && window.loadGLTF(file); }],
        ['viewer.loadGLTF',          function () { return window.viewer && window.viewer.loadGLTF && window.viewer.loadGLTF(file); }]
      ],
      json: [
        ['OpenBIMStudio.loadProperties', function () { return window.OpenBIMStudio && window.OpenBIMStudio.loadProperties && window.OpenBIMStudio.loadProperties(parsed); }],
        ['loadProperties',               function () { return window.loadProperties && window.loadProperties(parsed); }]
      ]
    };
    var list = hooks[kind] || [];
    for (var i = 0; i < list.length; i++) {
      try {
        var r = list[i][1]();
        if (r !== undefined && r !== false) {
          console.info('[OpenBIMStudio] handed to ' + list[i][0] + '()');
          return true;
        }
      } catch (e) {
        console.warn('hook ' + list[i][0] + ' failed:', e);
      }
    }
    var evName = kind === 'ifc'  ? 'openbimstudio:load-ifc'
               : kind === 'glb'  ? 'openbimstudio:load-glb'
               : kind === 'json' ? 'openbimstudio:load-properties'
               : 'openbimstudio:load-file';
    window.dispatchEvent(new CustomEvent(evName, {
      detail: { file: file, parsed: parsed, kind: kind }
    }));
    console.warn('[OpenBIMStudio] No built-in hook for "' + kind + '"; dispatched "' + evName + '".');
    return false;
  }

  function handleFile(file, statusEl) {
    var kind = kindOf(file.name, file.type);
    statusEl.className = 'obim-status';
    statusEl.textContent = 'Received ' + file.name + ' (' + kind + ') - processing...';

    if (kind === 'json') {
      file.text().then(function (txt) {
        var parsed = null;
        try { parsed = JSON.parse(txt); }
        catch (e) {
          statusEl.className = 'obim-status err';
          statusEl.textContent = 'Invalid JSON: ' + e.message;
          return;
        }
        var ok = dispatch(kind, file, parsed);
        statusEl.className = 'obim-status ' + (ok ? 'ok' : '');
        statusEl.textContent = ok ? 'Properties imported.'
                                  : 'Dispatched openbimstudio:load-properties (bind it in your app).';
      });
      return;
    }
    var ok = dispatch(kind, file, null);
    statusEl.className = 'obim-status ' + (ok ? 'ok' : '');
    statusEl.textContent = ok ? 'Imported.'
                              : 'Dispatched ' + kind + ' event - bind it in your app to handle the file.';
  }

  /* ----------------------------------------------------------------- modal */

  function buildModal() {
    if (document.getElementById(MODAL_ID)) return;

    var m = document.createElement('div');
    m.id = MODAL_ID;
    m.innerHTML =
      '<div class="obim-card" role="dialog" aria-modal="true">' +
      '  <h3>Import from Autodesk Viewer</h3>' +
      '  <p class="hint">No APS credentials required. Extraction runs inside the Autodesk viewer tab using its JavaScript API.</p>' +

      '  <h4>Step 1 &mdash; Open the Autodesk Viewer</h4>' +
      '  <label for="obim-link">Viewer URL (optional, for convenience)</label>' +
      '  <input id="obim-link" type="text" placeholder="https://viewer.autodesk.com/..."/>' +
      '  <div class="obim-row">' +
      '    <button class="ghost" id="obim-open">Open viewer in new tab</button>' +
      '  </div>' +

      '  <h4>Step 2 &mdash; Copy an extraction script</h4>' +
      '  <p class="hint">In the viewer tab open DevTools (F12) &rarr; Console, paste the script, press Enter. A file will download.</p>' +
      '  <div class="obim-row">' +
      '    <button class="primary" id="obim-copy-props">Copy properties script (.json)</button>' +
      '    <button class="primary" id="obim-copy-geom">Copy geometry script (.glb)</button>' +
      '  </div>' +

      '  <h4>Step 3 &mdash; Drop the downloaded file here</h4>' +
      '  <div class="obim-drop" id="obim-drop">' +
      '    Drop <b>.json</b> (properties) or <b>.glb</b>/<b>.gltf</b> (geometry) here &mdash; or click to browse' +
      '    <input id="obim-file" type="file" accept=".json,.glb,.gltf,.ifc" style="display:none"/>' +
      '  </div>' +

      '  <div class="obim-status" id="obim-status"></div>' +
      '  <div class="obim-actions">' +
      '    <button class="ghost" id="obim-close">Close</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(m);

    m.addEventListener('click', function (e) { if (e.target === m) m.classList.remove('open'); });
    m.querySelector('#obim-close').addEventListener('click', function () { m.classList.remove('open'); });

    m.querySelector('#obim-open').addEventListener('click', function () {
      var url = m.querySelector('#obim-link').value.trim() || 'https://viewer.autodesk.com/';
      window.open(url, '_blank', 'noopener');
    });
    m.querySelector('#obim-copy-props').addEventListener('click', function (e) { copyText(SCRIPT_PROPERTIES, e.currentTarget); });
    m.querySelector('#obim-copy-geom').addEventListener('click',  function (e) { copyText(SCRIPT_GEOMETRY,  e.currentTarget); });

    var drop      = m.querySelector('#obim-drop');
    var fileInput = m.querySelector('#obim-file');
    var status    = m.querySelector('#obim-status');

    drop.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0], status);
    });
    ['dragenter','dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); drop.classList.add('hover'); });
    });
    ['dragleave','drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); drop.classList.remove('hover'); });
    });
    drop.addEventListener('drop', function (e) {
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files[0]) handleFile(dt.files[0], status);
    });
  }

  /* ---------------------------------------------------------------- button */

  function buildButton() {
    if (document.getElementById(BTN_ID)) return;
    var b = document.createElement('button');
    b.id = BTN_ID;
    b.type = 'button';
    b.textContent = 'Import from Autodesk';
    b.title = 'Import properties or geometry from an Autodesk Viewer session';
    b.addEventListener('click', function () {
      buildModal();
      document.getElementById(MODAL_ID).classList.add('open');
    });
    document.body.appendChild(b);
  }

  function boot() {
    injectStyles();
    buildButton();
    console.info('[OpenBIMStudio] Autodesk importer ready (viewer-side, no APS).');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();




/* ─────────────────────────────────────────────────────────────
   Relocate the blue Autodesk button into the Insert tab.
   ───────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  var BTN_ID = 'obim-autodesk-btn';

  var style = document.createElement('style');
  style.textContent = [
    '#' + BTN_ID + '.obim-in-ribbon{position:static!important;left:auto!important;',
    'bottom:auto!important;top:auto!important;right:auto!important;',
    'padding:6px 10px!important;border-radius:4px!important;',
    'font:600 11px/1.2 system-ui,sans-serif!important;',
    'background:#0a84ff!important;box-shadow:none!important;',
    'transform:none!important;display:inline-flex!important;',
    'align-items:center!important;gap:4px!important;',
    'margin:2px 4px!important;white-space:nowrap!important;}',
    '#' + BTN_ID + '.obim-in-ribbon:hover{transform:none!important;',
    'background:#0066cc!important;box-shadow:none!important;}'
  ].join('');
  document.head.appendChild(style);

  function findInsertPanel() {
    var explicit = document.querySelector('[data-tab="insert"], [data-ribbon="insert"]');
    if (explicit) return explicit;

    var all = document.querySelectorAll('button, a, [role="tab"], [class*="tab"], [class*="Tab"]');
    for (var i = 0; i < all.length; i++) {
      var t = (all[i].textContent || '').trim();
      if (t !== 'Insert') continue;

      var aria = all[i].getAttribute('aria-controls');
      if (aria) {
        var p = document.getElementById(aria);
        if (p) return p;
      }
      var sib = all[i].nextElementSibling;
      while (sib) {
        if (sib.className && /ribbon|panel|content|tab/i.test(sib.className)) return sib;
        sib = sib.nextElementSibling;
      }
      var parent = all[i].parentElement;
      if (parent && parent.nextElementSibling) return parent.nextElementSibling;
    }
    return null;
  }

  var tries = 0;
  function relocate() {
    var btn = document.getElementById(BTN_ID);
    if (!btn) return false;
    var panel = findInsertPanel();
    if (!panel) return false;
    if (btn.parentElement === panel) return true;
    /* disabled: /* disabled: panel.appendChild(btn); */ */
    btn.classList.add('obim-in-ribbon');
    console.info('[OpenBIMStudio] Autodesk button relocated to Insert tab');
    return true;
  }

  var iv = setInterval(function () {
    tries++;
    if (relocate() || tries > 120) clearInterval(iv);
  }, 250);
})();