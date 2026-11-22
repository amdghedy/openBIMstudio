/* ============================================================
 * obs-family-editor.js — enhanced Family Creator engine
 * Parameters · types · constraints · geometry recipes · templates
 * Placement · shared params · library · sketch handoff · JSON I/O
 * ============================================================ */
(function () {
  'use strict';
  if (window.__OBS_FAM_EDITOR__) return;
  window.__OBS_FAM_EDITOR__ = true;

  var LS_KEY = 'obs.families.v1';
  var LS_SHARED = 'obs.families.shared.v1';

  var CATEGORIES = [
    'Generic', 'Doors', 'Windows', 'Walls', 'Columns', 'Beams', 'Slabs',
    'Furniture', 'Equipment', 'Lighting', 'Plumbing', 'Electrical',
    'HVAC', 'Site', 'Annotation', 'Specialty Equipment'
  ];

  var PARAM_KINDS = ['Length', 'Number', 'Angle', 'YesNo', 'Text', 'Material', 'Integer'];

  var PROFILE_KINDS = ['Rectangle', 'Circle', 'Ellipse', 'Polygon', 'Custom'];

  function blankFamily() {
    return {
      name: 'NewFamily',
      category: 'Generic',
      description: '',
      manufacturer: '',
      model: '',
      version: '1.0',
      placement: { kind: 'LevelBased', host: 'None', workPlane: 'XY' },
      parameters: [
        { name: 'Width', kind: 'Length', isType: true, default: 1.0, formula: '', group: 'Dimensions' },
        { name: 'Height', kind: 'Length', isType: true, default: 2.0, formula: '', group: 'Dimensions' },
        { name: 'Depth', kind: 'Length', isType: true, default: 0.2, formula: '', group: 'Dimensions' }
      ],
      types: [{ name: 'Default', values: {} }],
      constraints: [],
      sharedParamRefs: [],
      geometry: {
        kind: 'Extrusion',
        profile: { kind: 'Rectangle', width: 'Width', height: 'Height' },
        depth: 'Depth',
        angle: '360',
        path: '',
        origin: { x: 0, y: 0, z: 0 },
        solid: true,
        voids: []
      }
    };
  }

  function templateDoor() {
    var f = blankFamily();
    f.name = 'Single Door';
    f.category = 'Doors';
    f.description = 'Rectangular single-leaf door';
    f.parameters = [
      { name: 'Width', kind: 'Length', isType: true, default: 0.9, formula: '', group: 'Dimensions' },
      { name: 'Height', kind: 'Length', isType: true, default: 2.1, formula: '', group: 'Dimensions' },
      { name: 'Thickness', kind: 'Length', isType: true, default: 0.04, formula: '', group: 'Dimensions' },
      { name: 'FrameWidth', kind: 'Length', isType: true, default: 0.05, formula: '', group: 'Frame' }
    ];
    f.types = [
      { name: '900 × 2100', values: { Width: 0.9, Height: 2.1 } },
      { name: '800 × 2000', values: { Width: 0.8, Height: 2.0 } }
    ];
    f.geometry = {
      kind: 'Extrusion',
      profile: { kind: 'Rectangle', width: 'Width', height: 'Height' },
      depth: 'Thickness',
      origin: { x: 0, y: 0, z: 0 },
      solid: true,
      voids: []
    };
    f.placement = { kind: 'HostBased', host: 'Wall', workPlane: 'XY' };
    return f;
  }

  function templateWindow() {
    var f = blankFamily();
    f.name = 'Fixed Window';
    f.category = 'Windows';
    f.parameters = [
      { name: 'Width', kind: 'Length', isType: true, default: 1.2, formula: '', group: 'Dimensions' },
      { name: 'Height', kind: 'Length', isType: true, default: 1.4, formula: '', group: 'Dimensions' },
      { name: 'SillHeight', kind: 'Length', isType: false, default: 0.9, formula: '', group: 'Placement' },
      { name: 'Frame', kind: 'Length', isType: true, default: 0.05, formula: '', group: 'Frame' }
    ];
    f.types = [
      { name: '1200 × 1400', values: { Width: 1.2, Height: 1.4 } },
      { name: '600 × 900', values: { Width: 0.6, Height: 0.9 } }
    ];
    f.geometry.depth = '0.08';
    f.placement = { kind: 'HostBased', host: 'Wall', workPlane: 'XY' };
    return f;
  }

  function templateColumn() {
    var f = blankFamily();
    f.name = 'Rectangular Column';
    f.category = 'Columns';
    f.parameters = [
      { name: 'Width', kind: 'Length', isType: true, default: 0.3, formula: '', group: 'Dimensions' },
      { name: 'Depth', kind: 'Length', isType: true, default: 0.3, formula: '', group: 'Dimensions' },
      { name: 'Height', kind: 'Length', isType: false, default: 3.0, formula: '', group: 'Dimensions' }
    ];
    f.types = [
      { name: '300 × 300', values: { Width: 0.3, Depth: 0.3 } },
      { name: '400 × 400', values: { Width: 0.4, Depth: 0.4 } }
    ];
    f.geometry = {
      kind: 'Extrusion',
      profile: { kind: 'Rectangle', width: 'Width', height: 'Depth' },
      depth: 'Height',
      origin: { x: 0, y: 0, z: 0 },
      solid: true,
      voids: []
    };
    f.placement = { kind: 'LevelBased', host: 'None', workPlane: 'XY' };
    return f;
  }

  function templateFurniture() {
    var f = blankFamily();
    f.name = 'Table';
    f.category = 'Furniture';
    f.parameters = [
      { name: 'Length', kind: 'Length', isType: true, default: 1.6, formula: '', group: 'Dimensions' },
      { name: 'Width', kind: 'Length', isType: true, default: 0.8, formula: '', group: 'Dimensions' },
      { name: 'Height', kind: 'Length', isType: true, default: 0.75, formula: '', group: 'Dimensions' }
    ];
    f.geometry.profile = { kind: 'Rectangle', width: 'Length', height: 'Width' };
    f.geometry.depth = 'Height';
    return f;
  }

  var TEMPLATES = {
    blank: { label: 'Blank family', factory: blankFamily },
    door: { label: 'Single door', factory: templateDoor },
    window: { label: 'Fixed window', factory: templateWindow },
    column: { label: 'Rectangular column', factory: templateColumn },
    furniture: { label: 'Table / furniture', factory: templateFurniture }
  };

  var state = {
    family: blankFamily(),
    selectedType: 0,
    tab: 'params'
  };

  var host, modal;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildDom() {
    if (host) return;
    host = document.createElement('div');
    host.className = 'obs-fe-backdrop';
    host.innerHTML = ''
      + '<div class="obs-fe-modal" role="dialog" aria-modal="true" aria-label="Family Creator">'
      +   '<div class="obs-fe-head">'
      +     '<div class="obs-fe-head-titles">'
      +       '<h2>Family Creator</h2>'
      +       '<span class="obs-fe-sub">Parametric types · geometry · constraints · library</span>'
      +     '</div>'
      +     '<div class="obs-fe-head-actions">'
      +       '<button type="button" class="obs-fe-btn sec" id="fe-new" title="New blank family">New</button>'
      +       '<button type="button" class="obs-fe-btn sec" id="fe-clone" title="Duplicate current family">Clone</button>'
      +       '<button type="button" class="obs-fe-btn sec" id="fe-sketch" title="Open sketch editor">Sketch</button>'
      +       '<button type="button" class="obs-fe-close" title="Close (Esc)">&times;</button>'
      +     '</div>'
      +   '</div>'
      +   '<div class="obs-fe-toolbar">'
      +     '<label>Template <select class="obs-fe-select" id="fe-template"></select></label>'
      +     '<button type="button" class="obs-fe-btn sec" id="fe-apply-tmpl">Apply template</button>'
      +     '<span class="obs-fe-toolbar-sep"></span>'
      +     '<label>Library <select class="obs-fe-select" id="fe-lib"></select></label>'
      +     '<button type="button" class="obs-fe-btn sec" id="fe-del-lib" title="Delete from library">Delete</button>'
      +   '</div>'
      +   '<div class="obs-fe-tabs" role="tablist">'
      +     '<button type="button" class="obs-fe-tab is-active" data-tab="identity">Identity</button>'
      +     '<button type="button" class="obs-fe-tab" data-tab="params">Parameters</button>'
      +     '<button type="button" class="obs-fe-tab" data-tab="types">Types</button>'
      +     '<button type="button" class="obs-fe-tab" data-tab="constraints">Constraints</button>'
      +     '<button type="button" class="obs-fe-tab" data-tab="geometry">Geometry</button>'
      +     '<button type="button" class="obs-fe-tab" data-tab="placement">Placement</button>'
      +     '<button type="button" class="obs-fe-tab" data-tab="shared">Shared</button>'
      +     '<button type="button" class="obs-fe-tab" data-tab="preview">Preview</button>'
      +   '</div>'
      +   '<div class="obs-fe-body">'
      +     '<div class="obs-fe-pane" data-pane="identity">'
      +       '<div class="obs-fe-section"><h3>Family identity</h3>'
      +         '<div class="obs-fe-grid2">'
      +           '<label>Name<input class="obs-fe-input" id="fe-name" placeholder="Family name"></label>'
      +           '<label>Category<select class="obs-fe-select" id="fe-cat"></select></label>'
      +           '<label>Version<input class="obs-fe-input" id="fe-version" placeholder="1.0"></label>'
      +           '<label>Manufacturer<input class="obs-fe-input" id="fe-mfr" placeholder="Optional"></label>'
      +           '<label class="obs-fe-span2">Model / type mark<input class="obs-fe-input" id="fe-model" placeholder="Optional"></label>'
      +           '<label class="obs-fe-span2">Description<textarea class="obs-fe-input obs-fe-textarea" id="fe-desc" rows="3" placeholder="What this family represents"></textarea></label>'
      +         '</div></div>'
      +     '</div>'
      +     '<div class="obs-fe-pane" data-pane="params" hidden>'
      +       '<div class="obs-fe-section"><h3>Parameters</h3>'
      +         '<table class="obs-fe-table" id="fe-params"><thead><tr>'
      +           '<th>Name</th><th class="col-kind">Kind</th><th class="col-scope">Type</th>'
      +           '<th>Group</th><th>Default</th><th class="col-formula">Formula</th><th class="col-del"></th>'
      +         '</tr></thead><tbody></tbody></table>'
      +         '<div class="obs-fe-row" style="margin-top:8px;gap:8px;flex-wrap:wrap">'
      +           '<button type="button" class="obs-fe-btn sec" id="fe-add-param">+ Parameter</button>'
      +           '<button type="button" class="obs-fe-btn sec" id="fe-add-length">+ Length</button>'
      +           '<button type="button" class="obs-fe-btn sec" id="fe-add-yesno">+ Yes/No</button>'
      +           '<button type="button" class="obs-fe-btn sec" id="fe-dup-param">Duplicate selected</button>'
      +         '</div></div>'
      +     '</div>'
      +     '<div class="obs-fe-pane" data-pane="types" hidden>'
      +       '<div class="obs-fe-section"><h3>Type catalog</h3>'
      +         '<p class="obs-fe-help">Each type can override type-parameter defaults. Instance parameters stay on the instance.</p>'
      +         '<div id="fe-types"></div>'
      +         '<div class="obs-fe-row" style="margin-top:8px">'
      +           '<button type="button" class="obs-fe-btn sec" id="fe-add-type">+ Type</button>'
      +         '</div></div>'
      +     '</div>'
      +     '<div class="obs-fe-pane" data-pane="constraints" hidden>'
      +       '<div class="obs-fe-section"><h3>Constraints</h3>'
      +         '<div id="fe-constraints"></div>'
      +         '<div class="obs-fe-row" style="margin-top:8px;gap:8px;flex-wrap:wrap">'
      +           '<button type="button" class="obs-fe-btn sec" id="fe-add-cons">+ Range</button>'
      +           '<button type="button" class="obs-fe-btn sec" id="fe-add-cons-eq">+ Equality</button>'
      +           '<button type="button" class="obs-fe-btn sec" id="fe-add-cons-ratio">+ Ratio</button>'
      +         '</div></div>'
      +     '</div>'
      +     '<div class="obs-fe-pane" data-pane="geometry" hidden>'
      +       '<div class="obs-fe-section"><h3>Geometry recipe</h3>'
      +         '<div id="fe-geo-badge" style="margin-bottom:8px"></div>'
      +         '<div class="obs-fe-row" style="flex-wrap:wrap;gap:6px;margin-bottom:10px">'
      +           '<button type="button" class="obs-fe-btn sec" data-geo="Extrusion">Extrusion</button>'
      +           '<button type="button" class="obs-fe-btn sec" data-geo="Revolve">Revolve</button>'
      +           '<button type="button" class="obs-fe-btn sec" data-geo="Sweep">Sweep</button>'
      +           '<button type="button" class="obs-fe-btn sec" data-geo="Blend">Blend</button>'
      +           '<button type="button" class="obs-fe-btn sec" data-geo="Boolean">Boolean</button>'
      +         '</div>'
      +         '<div class="obs-fe-grid2" id="fe-geo-fields">'
      +           '<label>Profile<select class="obs-fe-select" id="fe-profile"></select></label>'
      +           '<label>Depth / height<input class="obs-fe-input" id="fe-depth" placeholder="Depth or param name"></label>'
      +           '<label>Profile width param<input class="obs-fe-input" id="fe-prof-w" placeholder="Width"></label>'
      +           '<label>Profile height param<input class="obs-fe-input" id="fe-prof-h" placeholder="Height"></label>'
      +           '<label>Revolve angle<input class="obs-fe-input" id="fe-angle" placeholder="360 or param"></label>'
      +           '<label>Sweep path<input class="obs-fe-input" id="fe-path" placeholder="Optional path id"></label>'
      +           '<label>Origin X<input class="obs-fe-input" id="fe-ox" type="number" step="0.01"></label>'
      +           '<label>Origin Y<input class="obs-fe-input" id="fe-oy" type="number" step="0.01"></label>'
      +           '<label>Origin Z<input class="obs-fe-input" id="fe-oz" type="number" step="0.01"></label>'
      +           '<label class="obs-fe-check"><input type="checkbox" id="fe-solid" checked> Solid (vs void form)</label>'
      +         '</div>'
      +         '<div class="obs-fe-row" style="margin-top:10px">'
      +           '<button type="button" class="obs-fe-btn sec" id="fe-add-void">+ Void extrusion</button>'
      +         '</div>'
      +         '<div id="fe-voids" style="margin-top:8px"></div>'
      +       '</div>'
      +     '</div>'
      +     '<div class="obs-fe-pane" data-pane="placement" hidden>'
      +       '<div class="obs-fe-section"><h3>Placement & hosting</h3>'
      +         '<div class="obs-fe-grid2">'
      +           '<label>Placement<select class="obs-fe-select" id="fe-place-kind">'
      +             '<option value="LevelBased">Level-based</option>'
      +             '<option value="HostBased">Host-based</option>'
      +             '<option value="FaceBased">Face-based</option>'
      +             '<option value="WorkPlane">Work plane</option>'
      +             '<option value="LineBased">Line-based</option>'
      +             '<option value="TwoPoint">Two-point adaptive</option>'
      +           '</select></label>'
      +           '<label>Host<select class="obs-fe-select" id="fe-place-host">'
      +             '<option>None</option><option>Wall</option><option>Floor</option><option>Ceiling</option>'
      +             '<option>Roof</option><option>Face</option><option>RefPlane</option>'
      +           '</select></label>'
      +           '<label>Work plane<select class="obs-fe-select" id="fe-place-wp">'
      +             '<option>XY</option><option>XZ</option><option>YZ</option>'
      +           '</select></label>'
      +         '</div>'
      +         '<p class="obs-fe-help">Hosting is metadata for placement tools; geometry is still defined on the Geometry tab.</p>'
      +       '</div>'
      +     '</div>'
      +     '<div class="obs-fe-pane" data-pane="shared" hidden>'
      +       '<div class="obs-fe-section"><h3>Shared parameter references</h3>'
      +         '<p class="obs-fe-help">Shared params are stored in this browser and can be bound into any family.</p>'
      +         '<div id="fe-shared-list"></div>'
      +         '<div class="obs-fe-row" style="margin-top:8px;gap:8px">'
      +           '<input class="obs-fe-input" id="fe-shared-name" placeholder="Shared param name" style="flex:1">'
      +           '<select class="obs-fe-select" id="fe-shared-kind"></select>'
      +           '<button type="button" class="obs-fe-btn sec" id="fe-shared-add">Add shared</button>'
      +           '<button type="button" class="obs-fe-btn sec" id="fe-shared-bind">Bind into family</button>'
      +         '</div></div>'
      +     '</div>'
      +     '<div class="obs-fe-pane" data-pane="preview" hidden>'
      +       '<div class="obs-fe-section"><h3>Resolved preview</h3>'
      +         '<div class="obs-fe-preview" id="fe-preview">—</div>'
      +         '<div class="obs-fe-row" style="margin-top:8px;gap:8px">'
      +           '<button type="button" class="obs-fe-btn sec" id="fe-validate">Validate formulas</button>'
      +           '<button type="button" class="obs-fe-btn sec" id="fe-refresh-preview">Refresh</button>'
      +         '</div></div>'
      +     '</div>'
      +   '</div>'
      +   '<div class="obs-fe-foot">'
      +     '<span class="obs-fe-hint">Esc close · Ctrl+S save library · Types override type params</span>'
      +     '<div class="obs-fe-actions">'
      +       '<button type="button" class="obs-fe-btn sec" id="fe-upload">Import JSON</button>'
      +       '<button type="button" class="obs-fe-btn sec" id="fe-download">Export JSON</button>'
      +       '<button type="button" class="obs-fe-btn sec" id="fe-test">Test in scene</button>'
      +       '<button type="button" class="obs-fe-btn pri" id="fe-save-lib">Save to library</button>'
      +     '</div>'
      +   '</div>'
      + '</div>';

    document.body.appendChild(host);

    // category / profile / shared kind options
    var cat = host.querySelector('#fe-cat');
    CATEGORIES.forEach(function (c) {
      var o = document.createElement('option'); o.textContent = c; cat.appendChild(o);
    });
    var prof = host.querySelector('#fe-profile');
    PROFILE_KINDS.forEach(function (c) {
      var o = document.createElement('option'); o.textContent = c; o.value = c; prof.appendChild(o);
    });
    var sk = host.querySelector('#fe-shared-kind');
    PARAM_KINDS.forEach(function (c) {
      var o = document.createElement('option'); o.textContent = c; sk.appendChild(o);
    });
    var tmpl = host.querySelector('#fe-template');
    Object.keys(TEMPLATES).forEach(function (k) {
      var o = document.createElement('option'); o.value = k; o.textContent = TEMPLATES[k].label; tmpl.appendChild(o);
    });

    host.querySelector('.obs-fe-close').onclick = close;
    host.addEventListener('click', function (e) { if (e.target === host) close(); });
    document.addEventListener('keydown', function (e) {
      if (!isOpen()) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveToLibrary(); }
    });

    Array.prototype.forEach.call(host.querySelectorAll('.obs-fe-tab'), function (tab) {
      tab.onclick = function () { setTab(tab.dataset.tab); };
    });

    host.querySelector('#fe-new').onclick = function () {
      state.family = blankFamily(); state.selectedType = 0; refreshAll(); renderPreview();
    };
    host.querySelector('#fe-clone').onclick = function () {
      var f = JSON.parse(JSON.stringify(state.family));
      f.name = (f.name || 'Family') + ' Copy';
      state.family = f; refreshAll(); renderPreview();
    };
    host.querySelector('#fe-sketch').onclick = function () {
      try {
        window.dispatchEvent(new CustomEvent('obs-toast', { detail: { kind: 'info', message: 'Opening sketch editor…' } }));
      } catch (e) {}
      // Prefer TypeScript sketch module if the app loaded it
      if (window.__obsOpenFamilySketch) {
        window.__obsOpenFamilySketch();
        return;
      }
      import('/src/features/family-sketch-editor.ts').catch(function () {
        // production: dynamic from app bundle is not available; dispatch event
        window.dispatchEvent(new CustomEvent('obs:open-family-sketch'));
      });
    };
    host.querySelector('#fe-apply-tmpl').onclick = function () {
      var key = host.querySelector('#fe-template').value;
      var t = TEMPLATES[key];
      if (!t) return;
      state.family = t.factory();
      state.selectedType = 0;
      refreshAll(); renderPreview();
    };

    host.querySelector('#fe-name').addEventListener('input', function (e) {
      state.family.name = e.target.value || 'NewFamily'; renderPreview();
    });
    host.querySelector('#fe-cat').addEventListener('change', function (e) {
      state.family.category = e.target.value;
    });
    host.querySelector('#fe-version').addEventListener('input', function (e) {
      state.family.version = e.target.value;
    });
    host.querySelector('#fe-mfr').addEventListener('input', function (e) {
      state.family.manufacturer = e.target.value;
    });
    host.querySelector('#fe-model').addEventListener('input', function (e) {
      state.family.model = e.target.value;
    });
    host.querySelector('#fe-desc').addEventListener('input', function (e) {
      state.family.description = e.target.value;
    });

    host.querySelector('#fe-add-param').onclick = function () { addParam('Number', 0); };
    host.querySelector('#fe-add-length').onclick = function () { addParam('Length', 1.0); };
    host.querySelector('#fe-add-yesno').onclick = function () { addParam('YesNo', 0); };
    host.querySelector('#fe-dup-param').onclick = duplicateSelectedParam;

    host.querySelector('#fe-add-type').onclick = function () {
      ensureTypes();
      state.family.types.push({ name: 'Type ' + (state.family.types.length + 1), values: {} });
      state.selectedType = state.family.types.length - 1;
      renderTypes();
    };

    host.querySelector('#fe-add-cons').onclick = function () {
      state.family.constraints.push({ kind: 'range', target: ['Width'], params: { min: 0.1, max: 10 } });
      renderConstraints();
    };
    host.querySelector('#fe-add-cons-eq').onclick = function () {
      state.family.constraints.push({ kind: 'equal', target: ['Width', 'Height'], params: {} });
      renderConstraints();
    };
    host.querySelector('#fe-add-cons-ratio').onclick = function () {
      state.family.constraints.push({ kind: 'ratio', target: ['Width', 'Height'], params: { ratio: 1.5 } });
      renderConstraints();
    };

    Array.prototype.forEach.call(host.querySelectorAll('[data-geo]'), function (b) {
      b.onclick = function () { setGeoKind(b.dataset.geo); };
    });
    ['fe-profile', 'fe-depth', 'fe-prof-w', 'fe-prof-h', 'fe-angle', 'fe-path', 'fe-ox', 'fe-oy', 'fe-oz', 'fe-solid'].forEach(function (id) {
      var el = host.querySelector('#' + id);
      if (!el) return;
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', readGeoFields);
      el.addEventListener('change', readGeoFields);
    });
    host.querySelector('#fe-add-void').onclick = function () {
      if (!state.family.geometry.voids) state.family.geometry.voids = [];
      state.family.geometry.voids.push({
        kind: 'Extrusion',
        profile: { kind: 'Rectangle', width: '0.2', height: '0.2' },
        depth: 'Depth',
        origin: { x: 0, y: 0, z: 0 }
      });
      renderVoids();
    };

    host.querySelector('#fe-place-kind').onchange = function (e) {
      ensurePlacement(); state.family.placement.kind = e.target.value;
    };
    host.querySelector('#fe-place-host').onchange = function (e) {
      ensurePlacement(); state.family.placement.host = e.target.value;
    };
    host.querySelector('#fe-place-wp').onchange = function (e) {
      ensurePlacement(); state.family.placement.workPlane = e.target.value;
    };

    host.querySelector('#fe-shared-add').onclick = addSharedParam;
    host.querySelector('#fe-shared-bind').onclick = bindSharedIntoFamily;

    host.querySelector('#fe-test').onclick = testInScene;
    host.querySelector('#fe-save-lib').onclick = saveToLibrary;
    host.querySelector('#fe-download').onclick = downloadJson;
    host.querySelector('#fe-upload').onclick = uploadJson;
    host.querySelector('#fe-validate').onclick = validateFormulas;
    host.querySelector('#fe-refresh-preview').onclick = renderPreview;
    host.querySelector('#fe-del-lib').onclick = deleteFromLibrary;

    var libSel = host.querySelector('#fe-lib');
    libSel.onchange = function () {
      if (!libSel.value) return;
      var lib = loadLibrary();
      if (lib[libSel.value]) {
        state.family = normalizeFamily(JSON.parse(JSON.stringify(lib[libSel.value])));
        state.selectedType = 0;
        refreshAll(); renderPreview();
      }
    };
  }

  function normalizeFamily(f) {
    if (!f.parameters) f.parameters = [];
    if (!f.types) f.types = [{ name: 'Default', values: {} }];
    if (!f.constraints) f.constraints = [];
    if (!f.geometry) f.geometry = blankFamily().geometry;
    if (!f.placement) f.placement = { kind: 'LevelBased', host: 'None', workPlane: 'XY' };
    if (!f.sharedParamRefs) f.sharedParamRefs = [];
    f.parameters.forEach(function (p) {
      if (!p.group) p.group = 'Dimensions';
    });
    return f;
  }

  function ensureTypes() {
    if (!state.family.types || !state.family.types.length) {
      state.family.types = [{ name: 'Default', values: {} }];
    }
  }
  function ensurePlacement() {
    if (!state.family.placement) state.family.placement = { kind: 'LevelBased', host: 'None', workPlane: 'XY' };
  }

  function addParam(kind, defVal) {
    state.family.parameters.push({
      name: 'Param' + (state.family.parameters.length + 1),
      kind: kind || 'Number',
      isType: true,
      default: defVal != null ? defVal : 0,
      formula: '',
      group: 'Dimensions'
    });
    renderParameters();
  }

  function duplicateSelectedParam() {
    var idx = state._selParam;
    if (idx == null || !state.family.parameters[idx]) {
      alert('Select a parameter row first (click its name field).');
      return;
    }
    var p = JSON.parse(JSON.stringify(state.family.parameters[idx]));
    p.name = p.name + '_2';
    state.family.parameters.splice(idx + 1, 0, p);
    renderParameters();
  }

  function setTab(name) {
    state.tab = name;
    Array.prototype.forEach.call(host.querySelectorAll('.obs-fe-tab'), function (t) {
      t.classList.toggle('is-active', t.dataset.tab === name);
    });
    Array.prototype.forEach.call(host.querySelectorAll('.obs-fe-pane'), function (p) {
      p.hidden = p.dataset.pane !== name;
    });
    if (name === 'preview') renderPreview();
    if (name === 'shared') renderShared();
    if (name === 'types') renderTypes();
    if (name === 'geometry') { writeGeoFields(); renderVoids(); }
  }

  function isOpen() { return host && host.classList.contains('is-open'); }
  function open() {
    buildDom();
    state.family = normalizeFamily(state.family);
    renderLibrarySelect();
    refreshAll();
    renderPreview();
    setTab(state.tab || 'identity');
    host.classList.add('is-open');
  }
  function close() { if (host) host.classList.remove('is-open'); }

  function refreshAll() {
    state.family = normalizeFamily(state.family);
    host.querySelector('#fe-name').value = state.family.name || '';
    host.querySelector('#fe-cat').value = state.family.category || 'Generic';
    host.querySelector('#fe-version').value = state.family.version || '';
    host.querySelector('#fe-mfr').value = state.family.manufacturer || '';
    host.querySelector('#fe-model').value = state.family.model || '';
    host.querySelector('#fe-desc').value = state.family.description || '';
    ensurePlacement();
    host.querySelector('#fe-place-kind').value = state.family.placement.kind || 'LevelBased';
    host.querySelector('#fe-place-host').value = state.family.placement.host || 'None';
    host.querySelector('#fe-place-wp').value = state.family.placement.workPlane || 'XY';
    renderParameters();
    renderTypes();
    renderConstraints();
    writeGeoFields();
    renderVoids();
    renderGeoBadge();
    renderShared();
  }

  function renderParameters() {
    var tbody = host.querySelector('#fe-params tbody');
    tbody.innerHTML = '';
    state.family.parameters.forEach(function (p, i) {
      var tr = document.createElement('tr');
      if (state._selParam === i) tr.classList.add('is-selected');
      tr.innerHTML = ''
        + '<td><input data-f="name" value="' + esc(p.name) + '"></td>'
        + '<td class="col-kind"><select data-f="kind">' + PARAM_KINDS.map(function (k) {
          return '<option' + (k === p.kind ? ' selected' : '') + '>' + k + '</option>';
        }).join('') + '</select></td>'
        + '<td class="col-scope"><input data-f="isType" type="checkbox"' + (p.isType ? ' checked' : '') + ' title="Type parameter"></td>'
        + '<td><input data-f="group" value="' + esc(p.group || 'Dimensions') + '"></td>'
        + '<td><input data-f="default" value="' + esc(p.default) + '"></td>'
        + '<td class="col-formula"><input data-f="formula" value="' + esc(p.formula || '') + '" placeholder="e.g. Width * 2"></td>'
        + '<td class="col-del"><button type="button" data-del title="Remove">&times;</button></td>';
      tr.addEventListener('focusin', function () { state._selParam = i; });
      tr.querySelectorAll('[data-f]').forEach(function (el) {
        el.addEventListener('change', function () {
          var f = el.getAttribute('data-f');
          if (f === 'isType') p.isType = el.checked;
          else if (f === 'default') {
            var n = Number(el.value);
            p.default = el.value === '' || Number.isNaN(n) ? el.value : n;
          } else p[f] = el.value;
          renderPreview();
        });
        el.addEventListener('input', function () {
          var f = el.getAttribute('data-f');
          if (f === 'name' || f === 'formula' || f === 'group') p[f] = el.value;
        });
      });
      tr.querySelector('[data-del]').onclick = function () {
        state.family.parameters.splice(i, 1);
        renderParameters(); renderPreview();
      };
      tbody.appendChild(tr);
    });
  }

  function renderTypes() {
    ensureTypes();
    var box = host.querySelector('#fe-types');
    box.innerHTML = '';
    var typeParams = state.family.parameters.filter(function (p) { return p.isType; });
    state.family.types.forEach(function (t, i) {
      var card = document.createElement('div');
      card.className = 'obs-fe-type' + (state.selectedType === i ? ' is-active' : '');
      var head = document.createElement('div');
      head.className = 'obs-fe-type-head';
      head.innerHTML = '<input class="obs-fe-input" data-tn value="' + esc(t.name) + '">'
        + '<button type="button" class="obs-fe-btn sec" data-act>Select</button>'
        + '<button type="button" data-tdel title="Delete type">&times;</button>';
      head.querySelector('[data-tn]').onchange = function (e) { t.name = e.target.value; };
      head.querySelector('[data-act]').onclick = function () {
        state.selectedType = i; renderTypes(); renderPreview();
      };
      head.querySelector('[data-tdel]').onclick = function () {
        if (state.family.types.length <= 1) return;
        state.family.types.splice(i, 1);
        if (state.selectedType >= state.family.types.length) state.selectedType = 0;
        renderTypes();
      };
      card.appendChild(head);
      var body = document.createElement('div');
      body.className = 'obs-fe-type-body';
      if (!typeParams.length) {
        body.innerHTML = '<span class="obs-fe-help">Mark parameters as Type to override them per type.</span>';
      } else {
        typeParams.forEach(function (p) {
          var row = document.createElement('label');
          row.className = 'obs-fe-type-row';
          var val = t.values && t.values[p.name] != null ? t.values[p.name] : p.default;
          row.innerHTML = '<span>' + esc(p.name) + '</span><input class="obs-fe-input" value="' + esc(val) + '">';
          row.querySelector('input').onchange = function (e) {
            if (!t.values) t.values = {};
            var n = Number(e.target.value);
            t.values[p.name] = e.target.value === '' || Number.isNaN(n) ? e.target.value : n;
            renderPreview();
          };
          body.appendChild(row);
        });
      }
      card.appendChild(body);
      box.appendChild(card);
    });
  }

  function renderConstraints() {
    var box = host.querySelector('#fe-constraints');
    box.innerHTML = '';
    var names = state.family.parameters.map(function (p) { return p.name; });
    state.family.constraints.forEach(function (c, i) {
      var row = document.createElement('div');
      row.className = 'obs-fe-constraint';
      var targets = (c.target || []).join(', ');
      var paramsStr = c.params ? JSON.stringify(c.params) : '{}';
      row.innerHTML = ''
        + '<select data-k><option>range</option><option>equal</option><option>ratio</option><option>min</option><option>max</option></select>'
        + '<input class="obs-fe-input obs-fe-cons-target" data-t value="' + esc(targets) + '" placeholder="ParamA, ParamB">'
        + '<input class="obs-fe-input obs-fe-cons-params" data-p value="' + esc(paramsStr) + '" placeholder=\'{"min":0.1}\'>'
        + '<button type="button" data-del>&times;</button>';
      row.querySelector('[data-k]').value = c.kind || 'range';
      row.querySelector('[data-k]').onchange = function (e) { c.kind = e.target.value; };
      row.querySelector('[data-t]').onchange = function (e) {
        c.target = e.target.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      };
      row.querySelector('[data-p]').onchange = function (e) {
        try { c.params = JSON.parse(e.target.value || '{}'); } catch (err) { /* keep */ }
      };
      row.querySelector('[data-del]').onclick = function () {
        state.family.constraints.splice(i, 1); renderConstraints();
      };
      box.appendChild(row);
    });
    if (!state.family.constraints.length) {
      box.innerHTML = '<div class="obs-fe-help">No constraints. Add range, equality, or ratio rules.</div>';
    }
  }

  function setGeoKind(kind) {
    if (!state.family.geometry) state.family.geometry = blankFamily().geometry;
    state.family.geometry.kind = kind;
    if (kind === 'Revolve' && !state.family.geometry.angle) state.family.geometry.angle = '360';
    if (kind === 'Blend') {
      state.family.geometry.profile2 = state.family.geometry.profile2 || {
        kind: 'Rectangle', width: 'Width', height: 'Height'
      };
    }
    writeGeoFields();
    renderGeoBadge();
    renderPreview();
  }

  function writeGeoFields() {
    var g = state.family.geometry || blankFamily().geometry;
    host.querySelector('#fe-profile').value = (g.profile && g.profile.kind) || 'Rectangle';
    host.querySelector('#fe-depth').value = g.depth != null ? g.depth : '';
    host.querySelector('#fe-prof-w').value = (g.profile && g.profile.width) || 'Width';
    host.querySelector('#fe-prof-h').value = (g.profile && g.profile.height) || 'Height';
    host.querySelector('#fe-angle').value = g.angle != null ? g.angle : '';
    host.querySelector('#fe-path').value = g.path || '';
    host.querySelector('#fe-ox').value = (g.origin && g.origin.x) || 0;
    host.querySelector('#fe-oy').value = (g.origin && g.origin.y) || 0;
    host.querySelector('#fe-oz').value = (g.origin && g.origin.z) || 0;
    host.querySelector('#fe-solid').checked = g.solid !== false;
    renderGeoBadge();
  }

  function readGeoFields() {
    var g = state.family.geometry || (state.family.geometry = blankFamily().geometry);
    if (!g.profile) g.profile = { kind: 'Rectangle', width: 'Width', height: 'Height' };
    if (!g.origin) g.origin = { x: 0, y: 0, z: 0 };
    g.profile.kind = host.querySelector('#fe-profile').value;
    g.profile.width = host.querySelector('#fe-prof-w').value || 'Width';
    g.profile.height = host.querySelector('#fe-prof-h').value || 'Height';
    g.depth = host.querySelector('#fe-depth').value;
    g.angle = host.querySelector('#fe-angle').value;
    g.path = host.querySelector('#fe-path').value;
    g.origin.x = Number(host.querySelector('#fe-ox').value) || 0;
    g.origin.y = Number(host.querySelector('#fe-oy').value) || 0;
    g.origin.z = Number(host.querySelector('#fe-oz').value) || 0;
    g.solid = host.querySelector('#fe-solid').checked;
    renderGeoBadge();
    renderPreview();
  }

  function renderGeoBadge() {
    var el = host.querySelector('#fe-geo-badge');
    var g = state.family.geometry;
    if (!g || !g.kind) {
      el.innerHTML = '<span class="obs-fe-geo-badge empty">not set</span>';
      return;
    }
    el.innerHTML = '<span class="obs-fe-geo-badge">' + esc(g.kind)
      + ' · ' + esc((g.profile && g.profile.kind) || 'profile')
      + (g.solid === false ? ' · void' : ' · solid')
      + '</span>';
  }

  function renderVoids() {
    var box = host.querySelector('#fe-voids');
    var voids = (state.family.geometry && state.family.geometry.voids) || [];
    if (!voids.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<h4 class="obs-fe-h4">Voids</h4>';
    voids.forEach(function (v, i) {
      var row = document.createElement('div');
      row.className = 'obs-fe-constraint';
      row.innerHTML = '<span>Void ' + (i + 1) + ' · ' + esc(v.kind || 'Extrusion') + '</span>'
        + '<button type="button" data-del>&times;</button>';
      row.querySelector('[data-del]').onclick = function () {
        state.family.geometry.voids.splice(i, 1); renderVoids();
      };
      box.appendChild(row);
    });
  }

  function loadShared() {
    try { return JSON.parse(localStorage.getItem(LS_SHARED) || '[]'); }
    catch (e) { return []; }
  }
  function saveShared(list) {
    localStorage.setItem(LS_SHARED, JSON.stringify(list));
  }

  function renderShared() {
    var box = host.querySelector('#fe-shared-list');
    var list = loadShared();
    if (!list.length) {
      box.innerHTML = '<div class="obs-fe-help">No shared parameters yet.</div>';
      return;
    }
    box.innerHTML = '';
    list.forEach(function (sp, i) {
      var row = document.createElement('div');
      row.className = 'obs-fe-constraint';
      row.innerHTML = '<strong>' + esc(sp.name) + '</strong> <span class="obs-fe-help">' + esc(sp.kind) + '</span>'
        + '<button type="button" data-del>&times;</button>';
      row.querySelector('[data-del]').onclick = function () {
        list.splice(i, 1); saveShared(list); renderShared();
      };
      box.appendChild(row);
    });
  }

  function addSharedParam() {
    var name = (host.querySelector('#fe-shared-name').value || '').trim();
    if (!name) return;
    var kind = host.querySelector('#fe-shared-kind').value;
    var list = loadShared();
    if (list.some(function (s) { return s.name === name; })) {
      alert('Shared parameter already exists');
      return;
    }
    list.push({ name: name, kind: kind });
    saveShared(list);
    host.querySelector('#fe-shared-name').value = '';
    renderShared();
  }

  function bindSharedIntoFamily() {
    var list = loadShared();
    if (!list.length) { alert('Add a shared parameter first'); return; }
    var names = list.map(function (s) { return s.name; });
    var pick = prompt('Shared param name to bind:\n' + names.join(', '), names[0]);
    if (!pick) return;
    var sp = list.find(function (s) { return s.name === pick; });
    if (!sp) { alert('Not found'); return; }
    if (state.family.parameters.some(function (p) { return p.name === sp.name; })) {
      alert('Family already has a parameter with that name');
      return;
    }
    state.family.parameters.push({
      name: sp.name, kind: sp.kind, isType: true, default: 0, formula: '', group: 'Shared', shared: true
    });
    if (!state.family.sharedParamRefs) state.family.sharedParamRefs = [];
    if (state.family.sharedParamRefs.indexOf(sp.name) < 0) state.family.sharedParamRefs.push(sp.name);
    renderParameters();
    setTab('params');
  }

  function resolveParamsLocal() {
    var map = {};
    state.family.parameters.forEach(function (p) {
      map[p.name] = p.default;
    });
    ensureTypes();
    var t = state.family.types[state.selectedType] || state.family.types[0];
    if (t && t.values) {
      Object.keys(t.values).forEach(function (k) { map[k] = t.values[k]; });
    }
    // simple formula pass (name = expr with + - * / and param names)
    state.family.parameters.forEach(function (p) {
      if (!p.formula) return;
      try {
        var expr = String(p.formula);
        Object.keys(map).forEach(function (k) {
          expr = expr.replace(new RegExp('\\b' + k + '\\b', 'g'), String(Number(map[k]) || 0));
        });
        if (/^[\d\s+\-*/().]+$/.test(expr)) {
          // eslint-disable-next-line no-new-func
          map[p.name] = Function('"use strict"; return (' + expr + ');')();
        }
      } catch (e) { /* leave default */ }
    });
    return map;
  }

  function validateFormulas() {
    var errors = [];
    var names = state.family.parameters.map(function (p) { return p.name; });
    state.family.parameters.forEach(function (p) {
      if (!p.formula) return;
      var expr = String(p.formula);
      var tokens = expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
      tokens.forEach(function (tok) {
        if (names.indexOf(tok) < 0 && !/^(sin|cos|tan|abs|min|max|sqrt)$/i.test(tok)) {
          errors.push(p.name + ': unknown token "' + tok + '"');
        }
      });
    });
    var el = host.querySelector('#fe-preview');
    if (errors.length) {
      el.innerHTML = errors.map(function (e) { return '<span class="err">' + esc(e) + '</span>'; }).join('\n');
    } else {
      el.innerHTML = '<span class="v">Formulas look consistent with parameter names.</span>';
      renderPreview();
    }
  }

  function renderPreview() {
    var el = host.querySelector('#fe-preview');
    if (!el) return;
    var map = resolveParamsLocal();
    var lines = [];
    lines.push('<span class="k">family</span>: <span class="v">' + esc(state.family.name) + '</span> · ' + esc(state.family.category));
    ensureTypes();
    var t = state.family.types[state.selectedType];
    if (t) lines.push('<span class="k">type</span>: <span class="v">' + esc(t.name) + '</span>');
    lines.push('');
    Object.keys(map).forEach(function (k) {
      lines.push('<span class="k">' + esc(k) + '</span>: <span class="v">' + esc(map[k]) + '</span>');
    });
    var g = state.family.geometry;
    if (g) {
      lines.push('');
      lines.push('<span class="k">geometry</span>: <span class="v">' + esc(g.kind) + '</span> / ' + esc((g.profile && g.profile.kind) || ''));
      lines.push('<span class="k">depth</span>: <span class="v">' + esc(g.depth) + '</span>');
      if (g.voids && g.voids.length) lines.push('<span class="k">voids</span>: <span class="v">' + g.voids.length + '</span>');
    }
    ensurePlacement();
    lines.push('');
    lines.push('<span class="k">placement</span>: <span class="v">' + esc(state.family.placement.kind)
      + '</span> host=' + esc(state.family.placement.host));

    // Try engine if available
    try {
      var RE = window.BIMParametricEngine;
      if (RE) {
        var tmpEngine = new RE.BIMParametricEngine(null, 0, { autoRegen: false });
        var famName = '__obs_preview__';
        var spec = {
          category: state.family.category,
          parameters: state.family.parameters.map(function (p) {
            return { name: p.name, kind: p.kind, isType: p.isType, default: p.default };
          }),
          formulas: state.family.parameters.filter(function (p) { return p.formula; })
            .map(function (p) { return p.name + ' = ' + p.formula; }),
          constraints: (state.family.constraints || []).map(function (c) {
            return RE.Constraint ? new RE.Constraint(c.kind, c.target, c.params) : c;
          }),
          geometry: function () { return state.family.geometry; }
        };
        tmpEngine.defineFamily(famName, spec);
        tmpEngine.defineType(famName, 'Default');
        tmpEngine.bindInstance(1, famName, 'Default');
        var ctx = tmpEngine.effectiveParameters(1);
        lines.push('');
        lines.push('<span class="k">engine</span>: <span class="v">resolved</span>');
        Object.keys(ctx || {}).forEach(function (k) {
          lines.push('<span class="k">eng.' + esc(k) + '</span>: <span class="v">' + esc(ctx[k]) + '</span>');
        });
      }
    } catch (e) {
      lines.push('');
      lines.push('<span class="err">engine: ' + esc(e.message) + '</span>');
    }
    el.innerHTML = lines.join('\n');
  }

  function testInScene() {
    var RE = window.BIMParametricEngine;
    if (!RE) { alert('BIMParametricEngine not loaded'); return; }
    var engine = null;
    try {
      var p = window.OpenBIMStudio && window.OpenBIMStudio.parametric;
      engine = p && p.getEngine ? p.getEngine() : null;
    } catch (e) {}
    if (!engine) { alert('No engine attached. Load an IFC or open the 3D platform first.'); return; }

    var famName = state.family.name || 'TestFamily';
    try {
      var spec = {
        category: state.family.category,
        parameters: state.family.parameters.map(function (p) {
          return { name: p.name, kind: p.kind, isType: p.isType, default: p.default };
        }),
        formulas: state.family.parameters.filter(function (p) { return p.formula; })
          .map(function (p) { return p.name + ' = ' + p.formula; }),
        constraints: (state.family.constraints || []).map(function (c) {
          return RE.Constraint ? new RE.Constraint(c.kind, c.target, c.params) : c;
        }),
        geometry: function () { return state.family.geometry; }
      };
      engine.defineFamily(famName, spec);
      ensureTypes();
      state.family.types.forEach(function (t) {
        try { engine.defineType(famName, t.name, t.values || {}); } catch (e) { /* */ }
      });
      var typeName = (state.family.types[state.selectedType] || state.family.types[0]).name;
      var id = Date.now() % 1000000;
      engine.bindInstance(id, famName, typeName);
      engine.regenerate();
      alert('Bound test instance #' + id + ' · ' + famName + ' / ' + typeName);
    } catch (e) {
      alert('Test failed: ' + e.message);
    }
  }

  function loadLibrary() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
    catch (e) { return {}; }
  }

  function saveToLibrary() {
    var lib = loadLibrary();
    var name = state.family.name || 'NewFamily';
    lib[name] = JSON.parse(JSON.stringify(state.family));
    localStorage.setItem(LS_KEY, JSON.stringify(lib));
    renderLibrarySelect();
    try {
      window.dispatchEvent(new CustomEvent('obs-toast', {
        detail: { kind: 'success', message: 'Saved family “' + name + '” to library' }
      }));
    } catch (e) {
      alert('Saved “' + name + '” to library');
    }
  }

  function deleteFromLibrary() {
    var sel = host.querySelector('#fe-lib');
    if (!sel.value) return;
    if (!confirm('Delete library entry “' + sel.value + '”?')) return;
    var lib = loadLibrary();
    delete lib[sel.value];
    localStorage.setItem(LS_KEY, JSON.stringify(lib));
    renderLibrarySelect();
  }

  function renderLibrarySelect() {
    var sel = host.querySelector('#fe-lib');
    var lib = loadLibrary();
    var cur = sel.value;
    sel.innerHTML = '<option value="">— library —</option>';
    Object.keys(lib).sort().forEach(function (k) {
      var o = document.createElement('option');
      o.value = k; o.textContent = k + ' (' + (lib[k].category || '') + ')';
      sel.appendChild(o);
    });
    if (cur && lib[cur]) sel.value = cur;
  }

  function downloadJson() {
    var blob = new Blob([JSON.stringify(state.family, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.family.name || 'family') + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  function uploadJson() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = function () {
      var f = input.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          state.family = normalizeFamily(JSON.parse(r.result));
          state.selectedType = 0;
          refreshAll(); renderPreview();
        } catch (e) { alert('Invalid JSON: ' + e.message); }
      };
      r.readAsText(f);
    };
    input.click();
  }

  // Ribbon / app command wiring
  window.addEventListener('obs:param-ribbon-command', function (e) {
    var cmd = (e.detail && (e.detail.command || e.detail.id)) || '';
    switch (cmd) {
      case 'fam-new': state.family = blankFamily(); open(); break;
      case 'fam-load': open(); host.querySelector('#fe-lib').focus(); break;
      case 'fam-edit': open(); break;
      case 'fam-types': open(); setTab('types'); break;
      case 'prm-add': open(); setTab('params'); host.querySelector('#fe-add-param').click(); break;
      case 'prm-form': open(); setTab('params'); break;
      case 'prm-cnst': open(); setTab('constraints'); break;
      case 'geo-ext': open(); setTab('geometry'); setGeoKind('Extrusion'); break;
      case 'geo-rev': open(); setTab('geometry'); setGeoKind('Revolve'); break;
      case 'geo-swp': open(); setTab('geometry'); setGeoKind('Sweep'); break;
      case 'geo-bln': open(); setTab('geometry'); setGeoKind('Blend'); break;
      case 'geo-boo': open(); setTab('geometry'); setGeoKind('Boolean'); break;
      case 'lib-samp': open(); saveToLibrary(); break;
      case 'lib-tmpl': open(); break;
      default: break;
    }
  });

  window.addEventListener('obs:open-family-sketch', function () {
    // App shell may listen and open TypeScript sketch editor
  });

  window.OBSFamilyEditor = {
    open: open,
    close: close,
    getState: function () { return state; },
    load: function (family) {
      state.family = normalizeFamily(JSON.parse(JSON.stringify(family)));
      state.selectedType = 0;
      open();
    },
    templates: function () { return Object.keys(TEMPLATES); },
    newFromTemplate: function (key) {
      var t = TEMPLATES[key];
      if (t) { state.family = t.factory(); state.selectedType = 0; open(); }
    }
  };

  console.info('[OBS-family-editor] enhanced Family Creator ready');
})();
