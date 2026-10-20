/* ============================================================
 * obs-family-editor.js
 * Modal family editor driven by the Parametric ribbon commands.
 * Works headlessly against BIMParametricEngine.
 * Families persist in localStorage and can be exported as JSON.
 * ============================================================ */
(function () {
  'use strict';
  if (window.__OBS_FAM_EDITOR__) return;
  window.__OBS_FAM_EDITOR__ = true;

  var LS_KEY = 'obs.families.v1';

  // ---------------------------------------------------------------- state
  var state = {
    family: blankFamily(),
    selectedIndex: -1
  };

  function blankFamily() {
    return {
      name: 'NewFamily',
      category: 'Generic',
      parameters: [
        { name: 'Width',  kind: 'Length', isType: true,  default: 1.0, formula: '' },
        { name: 'Height', kind: 'Length', isType: true,  default: 2.0, formula: '' }
      ],
      constraints: [],
      geometry: {
        kind: 'Extrusion',
        profile: { kind: 'Rectangle', width: 'Width', height: 'Height' },
        depth: '0.2',
        origin: { x: 0, y: 0, z: 0 }
      }
    };
  }

  // ---------------------------------------------------------------- DOM
  var host, modal;

  function buildDom() {
    if (host) return;
    host = document.createElement('div');
    host.className = 'obs-fe-backdrop';
    host.innerHTML = ''
      + '<div class="obs-fe-modal" role="dialog" aria-modal="true">'
      +   '<div class="obs-fe-head">'
      +     '<h2>Family Editor</h2>'
      +     '<button class="obs-fe-close" title="Close (Esc)">&times;</button>'
      +   '</div>'
      +   '<div class="obs-fe-body">'
      +     '<div class="obs-fe-left">'
      +       '<div class="obs-fe-section">'
      +         '<h3>Identity</h3>'
      +         '<div class="obs-fe-row">'
      +           '<input class="obs-fe-input" id="fe-name" placeholder="Family name" style="flex:1">'
      +           '<select class="obs-fe-select" id="fe-cat" style="flex:0 0 160px">'
      +             '<option>Generic</option><option>Doors</option><option>Windows</option>'
      +             '<option>Walls</option><option>Columns</option><option>Furniture</option>'
      +             '<option>Equipment</option><option>Lighting</option>'
      +           '</select>'
      +         '</div>'
      +       '</div>'
      +       '<div class="obs-fe-section">'
      +         '<h3>Parameters</h3>'
      +         '<table class="obs-fe-table" id="fe-params">'
      +           '<thead><tr>'
      +             '<th>Name</th>'
      +             '<th class="col-kind">Kind</th>'
      +             '<th class="col-scope">Scope</th>'
      +             '<th>Default</th>'
      +             '<th class="col-formula">Formula</th>'
      +             '<th class="col-del"></th>'
      +           '</tr></thead>'
      +           '<tbody></tbody>'
      +         '</table>'
      +         '<div class="obs-fe-row" style="margin-top:8px">'
      +           '<button class="obs-fe-btn sec" id="fe-add-param">+ Add parameter</button>'
      +         '</div>'
      +       '</div>'
      +       '<div class="obs-fe-section">'
      +         '<h3>Constraints</h3>'
      +         '<div id="fe-constraints"></div>'
      +         '<div class="obs-fe-row" style="margin-top:8px">'
      +           '<button class="obs-fe-btn sec" id="fe-add-cons">+ Add constraint</button>'
      +         '</div>'
      +       '</div>'
      +     '</div>'
      +     '<div class="obs-fe-right">'
      +       '<div class="obs-fe-section">'
      +         '<h3>Geometry recipe</h3>'
      +         '<div id="fe-geo" style="margin-bottom:8px"><span class="obs-fe-geo-badge empty">not set</span></div>'
      +         '<div class="obs-fe-row" style="flex-wrap:wrap">'
      +           '<button class="obs-fe-btn sec" data-geo="Extrusion">Extrusion</button>'
      +           '<button class="obs-fe-btn sec" data-geo="Revolve">Revolve</button>'
      +           '<button class="obs-fe-btn sec" data-geo="Sweep">Sweep</button>'
      +         '</div>'
      +       '</div>'
      +       '<div class="obs-fe-section">'
      +         '<h3>Live preview</h3>'
      +         '<div class="obs-fe-preview" id="fe-preview">edit a parameter to preview</div>'
      +         '<div class="obs-fe-row" style="margin-top:8px">'
      +           '<button class="obs-fe-btn" id="fe-test">Test in scene</button>'
      +         '</div>'
      +       '</div>'
      +       '<div class="obs-fe-section">'
      +         '<h3>Library</h3>'
      +         '<div class="obs-fe-row">'
      +           '<button class="obs-fe-btn sec" id="fe-save-lib">Save to library</button>'
      +         '</div>'
      +         '<div class="obs-fe-row">'
      +           '<select class="obs-fe-select" id="fe-lib" style="flex:1"><option value="">-- load --</option></select>'
      +         '</div>'
      +       '</div>'
      +     '</div>'
      +   '</div>'
      +   '<div class="obs-fe-foot">'
      +     '<div class="obs-fe-hint">Esc closes, Ctrl+S saves to library</div>'
      +     '<div class="obs-fe-actions">'
      +       '<button class="obs-fe-btn sec" id="fe-download">Download JSON</button>'
      +       '<button class="obs-fe-btn sec" id="fe-upload">Upload JSON</button>'
      +       '<button class="obs-fe-btn" id="fe-close">Close</button>'
      +     '</div>'
      +   '</div>'
      + '</div>';
    document.body.appendChild(host);
    modal = host.querySelector('.obs-fe-modal');

    host.querySelector('.obs-fe-close').onclick = close;
    host.querySelector('#fe-close').onclick = close;
    host.addEventListener('mousedown', function (e) { if (e.target === host) close(); });

    document.addEventListener('keydown', function (e) {
      if (!isOpen()) return;
      if (e.key === 'Escape') close();
      if (e.ctrlKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveToLibrary(); }
    });

    host.querySelector('#fe-name').addEventListener('input', function (e) {
      state.family.name = e.target.value || 'NewFamily';
      renderPreview();
    });
    host.querySelector('#fe-cat').addEventListener('change', function (e) {
      state.family.category = e.target.value;
    });

    host.querySelector('#fe-add-param').onclick = function () {
      state.family.parameters.push({ name: 'Param' + (state.family.parameters.length + 1),
                                     kind: 'Number', isType: true, default: 0, formula: '' });
      renderParameters(); renderPreview();
    };

    host.querySelector('#fe-add-cons').onclick = function () {
      state.family.constraints.push({ kind: 'range', target: ['Width'], params: { min: 0.1, max: 10 } });
      renderConstraints(); renderPreview();
    };

    Array.prototype.forEach.call(host.querySelectorAll('[data-geo]'), function (b) {
      b.onclick = function () { setGeoKind(b.dataset.geo); };
    });

    host.querySelector('#fe-test').onclick = testInScene;
    host.querySelector('#fe-save-lib').onclick = saveToLibrary;
    host.querySelector('#fe-download').onclick = downloadJson;
    host.querySelector('#fe-upload').onclick = uploadJson;

    var libSel = host.querySelector('#fe-lib');
    libSel.onchange = function () {
      if (!libSel.value) return;
      var lib = loadLibrary();
      if (lib[libSel.value]) {
        state.family = JSON.parse(JSON.stringify(lib[libSel.value]));
        refreshAll();
        renderPreview();
      }
    };
  }

  function isOpen() { return host && host.classList.contains('is-open'); }
  function open() { buildDom(); renderLibrarySelect(); refreshAll(); renderPreview(); host.classList.add('is-open'); }
  function close() { if (host) host.classList.remove('is-open'); }

  // ---------------------------------------------------------------- render
  function refreshAll() {
    host.querySelector('#fe-name').value = state.family.name;
    host.querySelector('#fe-cat').value = state.family.category;
    renderParameters();
    renderConstraints();
    renderGeoBadge();
  }

  function renderParameters() {
    var tbody = host.querySelector('#fe-params tbody');
    tbody.innerHTML = '';
    var paramNames = state.family.parameters.map(function (p) { return p.name; });

    state.family.parameters.forEach(function (p, i) {
      var tr = document.createElement('tr');

      // name
      var tdName = document.createElement('td');
      var inName = document.createElement('input');
      inName.value = p.name;
      inName.oninput = function () {
        p.name = inName.value;
        renderPreview();
      };
      tdName.appendChild(inName);
      tr.appendChild(tdName);

      // kind
      var tdKind = document.createElement('td');
      var selKind = document.createElement('select');
      ['Length','Area','Volume','Angle','Number','Integer','Text','YesNo'].forEach(function (k) {
        var o = document.createElement('option'); o.value = k; o.textContent = k;
        if (p.kind === k) o.selected = true;
        selKind.appendChild(o);
      });
      selKind.onchange = function () { p.kind = selKind.value; renderPreview(); };
      tdKind.appendChild(selKind);
      tr.appendChild(tdKind);

      // scope
      var tdScope = document.createElement('td');
      tdScope.className = 'col-scope';
      var selScope = document.createElement('select');
      [['Type', true], ['Instance', false]].forEach(function (pair) {
        var o = document.createElement('option'); o.value = String(pair[1]); o.textContent = pair[0];
        if (p.isType === pair[1]) o.selected = true;
        selScope.appendChild(o);
      });
      selScope.onchange = function () { p.isType = (selScope.value === 'true'); };
      tdScope.appendChild(selScope);
      tr.appendChild(tdScope);

      // default
      var tdDef = document.createElement('td');
      var inDef = document.createElement('input');
      inDef.value = p.default == null ? '' : p.default;
      inDef.oninput = function () {
        var v = inDef.value;
        p.default = (p.kind === 'Text' || p.kind === 'Material' || p.kind === 'URL') ? v : Number(v);
        if (isNaN(p.default)) p.default = 0;
        renderPreview();
      };
      tdDef.appendChild(inDef);
      tr.appendChild(tdDef);

      // formula
      var tdForm = document.createElement('td');
      tdForm.className = 'col-formula';
      var inForm = document.createElement('input');
      inForm.value = p.formula || '';
      inForm.placeholder = p.name ? 'e.g. Width * 2' : '';
      inForm.oninput = function () {
        p.formula = inForm.value.trim();
        validateFormula(p, inForm);
        renderPreview();
      };
      tdForm.appendChild(inForm);
      tr.appendChild(tdForm);

      // delete
      var tdDel = document.createElement('td');
      tdDel.className = 'col-del';
      var btnDel = document.createElement('button');
      btnDel.innerHTML = '&times;';
      btnDel.title = 'Delete parameter';
      btnDel.onclick = function () {
        state.family.parameters.splice(i, 1);
        renderParameters(); renderPreview();
      };
      tdDel.appendChild(btnDel);
      tr.appendChild(tdDel);

      tbody.appendChild(tr);

      validateFormula(p, inForm);
    });
  }

  function validateFormula(p, inputEl) {
    inputEl.classList.remove('formula-invalid');
    if (!p.formula) return;
    try {
      var RE = window.BIMParametricEngine;
      if (!RE || !RE.FormulaEngine) return;
      var ctx = {};
      state.family.parameters.forEach(function (q) { ctx[q.name] = 1; });
      ctx[p.name] = 1;
      RE.FormulaEngine.evaluate(p.formula, ctx);
    } catch (e) {
      inputEl.classList.add('formula-invalid');
      inputEl.title = e.message;
    }
  }

  function renderConstraints() {
    var hostEl = host.querySelector('#fe-constraints');
    hostEl.innerHTML = '';
    if (!state.family.constraints.length) {
      hostEl.innerHTML = '<div style="color:#7f8a9a;font-size:11px;padding:4px 0">No constraints</div>';
      return;
    }
    state.family.constraints.forEach(function (c, i) {
      var div = document.createElement('div');
      div.className = 'obs-fe-constraint';

      var selKind = document.createElement('select');
      ['equal','ratio','lock','sum','range'].forEach(function (k) {
        var o = document.createElement('option'); o.value = k; o.textContent = k;
        if (c.kind === k) o.selected = true;
        selKind.appendChild(o);
      });
      selKind.onchange = function () {
        c.kind = selKind.value;
        c.params = defaultConsParams(c.kind);
        renderConstraints(); renderPreview();
      };
      div.appendChild(selKind);

      var inTarget = document.createElement('input');
      inTarget.className = 'obs-fe-cons-target';
      inTarget.value = (c.target || []).join(',');
      inTarget.placeholder = 'Width,Height';
      inTarget.oninput = function () {
        c.target = inTarget.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        renderPreview();
      };
      div.appendChild(inTarget);

      var inParams = document.createElement('input');
      inParams.className = 'obs-fe-cons-params';
      inParams.value = JSON.stringify(c.params || {});
      inParams.placeholder = '{"factor":2}';
      inParams.oninput = function () {
        try { c.params = JSON.parse(inParams.value || '{}'); inParams.style.color = ''; }
        catch (e) { inParams.style.color = '#f87171'; }
        renderPreview();
      };
      div.appendChild(inParams);

      var btnDel = document.createElement('button');
      btnDel.innerHTML = '&times;';
      btnDel.onclick = function () {
        state.family.constraints.splice(i, 1);
        renderConstraints(); renderPreview();
      };
      div.appendChild(btnDel);

      hostEl.appendChild(div);
    });
  }

  function defaultConsParams(kind) {
    switch (kind) {
      case 'ratio': return { factor: 1 };
      case 'lock':  return { value: 0 };
      case 'sum':   return { value: 0 };
      case 'range': return { min: 0, max: 10 };
      default:      return {};
    }
  }

  function renderGeoBadge() {
    var hostEl = host.querySelector('#fe-geo');
    var g = state.family.geometry;
    if (!g) { hostEl.innerHTML = '<span class="obs-fe-geo-badge empty">not set</span>'; return; }
    hostEl.innerHTML = '<span class="obs-fe-geo-badge">' + g.kind + '</span>';
  }

  function setGeoKind(kind) {
    if (kind === 'Extrusion') {
      state.family.geometry = {
        kind: 'Extrusion',
        profile: { kind: 'Rectangle', width: state.family.parameters[0] ? state.family.parameters[0].name : '1', height: state.family.parameters[1] ? state.family.parameters[1].name : '1' },
        depth: state.family.parameters[2] ? state.family.parameters[2].name : '0.2',
        origin: { x: 0, y: 0, z: 0 }
      };
    } else if (kind === 'Revolve') {
      state.family.geometry = {
        kind: 'Revolve',
        profile: { kind: 'Rectangle', width: 'Width', height: '0.1' },
        axis: { origin: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 1, z: 0 } },
        angle: '6.283'
      };
    } else if (kind === 'Sweep') {
      state.family.geometry = {
        kind: 'Sweep',
        profile: { kind: 'Circle', radius: '0.1' },
        path: { kind: 'Polygon', points: [{ x: 0, y: 0 }, { x: 'Width', y: 0 }] }
      };
    }
    renderGeoBadge(); renderPreview();
  }

  function renderPreview() {
    var hostEl = host.querySelector('#fe-preview');
    var RE = window.BIMParametricEngine;
    if (!RE) { hostEl.innerHTML = '<span class="err">BIMParametricEngine not loaded</span>'; return; }

    var engine = null;
    try {
      var p = window.OpenBIMStudio && window.OpenBIMStudio.parametric;
      engine = p && p.getEngine ? p.getEngine() : null;
    } catch (e) {}

    if (!engine) {
      hostEl.innerHTML = '<span class="err">No engine attached. Load an IFC first or click "Test in scene".</span>';
      return;
    }

    try {
      // Snapshot current families map, insert temp family, resolve, revert
      var famName = '__obs_preview__';
      var tmpEngine = new RE.BIMParametricEngine(null, 0, { autoRegen: false });
      var spec = {
        category: state.family.category,
        parameters: state.family.parameters.map(function (p) {
          return { name: p.name, kind: p.kind, isType: p.isType, default: p.default };
        }),
        formulas: state.family.parameters.filter(function (p) { return p.formula; })
                                          .map(function (p) { return p.name + ' = ' + p.formula; }),
        constraints: state.family.constraints.map(function (c) {
          return new RE.Constraint(c.kind, c.target, c.params);
        }),
        geometry: function () { return state.family.geometry; }
      };
      tmpEngine.defineFamily(famName, spec);
      tmpEngine.defineType(famName, 'Default');
      tmpEngine.bindInstance(1, famName, 'Default');

      var ctx = tmpEngine.effectiveParameters(1);
      var diff = tmpEngine.regenerate();

      var lines = [];
      Object.keys(ctx).forEach(function (k) {
        lines.push('<span class="k">' + k + '</span>: <span class="v">' + ctx[k] + '</span>');
      });
      if (diff[0] && diff[0].geometry) {
        lines.push('');
        lines.push('<span class="k">geometry</span>: <span class="v">' + diff[0].geometry.kind + '</span>');
      }
      hostEl.innerHTML = lines.join('\n');
    } catch (e) {
      hostEl.innerHTML = '<span class="err">' + e.message + '</span>';
    }
  }

  // ---------------------------------------------------------------- actions
  function testInScene() {
    var RE = window.BIMParametricEngine;
    if (!RE) { alert('BIMParametricEngine not loaded'); return; }
    var engine = null;
    try {
      var p = window.OpenBIMStudio && window.OpenBIMStudio.parametric;
      engine = p && p.getEngine ? p.getEngine() : null;
    } catch (e) {}
    if (!engine) { alert('No engine attached. Load an IFC first.'); return; }

    var famName = state.family.name || 'TestFamily';
    var spec = {
      category: state.family.category,
      parameters: state.family.parameters.map(function (p) {
        return { name: p.name, kind: p.kind, isType: p.isType, default: p.default };
      }),
      formulas: state.family.parameters.filter(function (p) { return p.formula; })
                                        .map(function (p) { return p.name + ' = ' + p.formula; }),
      constraints: state.family.constraints.map(function (c) {
        return new RE.Constraint(c.kind, c.target, c.params);
      }),
      geometry: function () { return state.family.geometry; }
    };

    engine.defineFamily(famName, spec);
    engine.defineType(famName, 'Default');
    var fakeID = Math.floor(Math.random() * 900000) + 100000;
    engine.bindInstance(fakeID, famName, 'Default');
    var diff = engine.regenerate();
    console.info('[OBS-family-editor] test placed instance', fakeID, diff);
    alert('Test placed instance #' + fakeID + ' using family "' + famName + '".');
  }

  // ---------------------------------------------------------------- library
  function loadLibrary() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveLibrary(lib) {
    localStorage.setItem(LS_KEY, JSON.stringify(lib));
  }
  function saveToLibrary() {
    var lib = loadLibrary();
    lib[state.family.name] = JSON.parse(JSON.stringify(state.family));
    saveLibrary(lib);
    renderLibrarySelect();
    console.info('[OBS-family-editor] saved to library:', state.family.name);
  }
  function renderLibrarySelect() {
    var sel = host.querySelector('#fe-lib');
    var lib = loadLibrary();
    sel.innerHTML = '<option value="">-- load --</option>';
    Object.keys(lib).sort().forEach(function (k) {
      var o = document.createElement('option'); o.value = k; o.textContent = k;
      sel.appendChild(o);
    });
  }

  function downloadJson() {
    var blob = new Blob([JSON.stringify(state.family, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.family.name || 'family') + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 500);
  }
  function uploadJson() {
    var input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.onchange = function () {
      var f = input.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          state.family = JSON.parse(r.result);
          refreshAll(); renderPreview();
        } catch (e) { alert('Invalid JSON: ' + e.message); }
      };
      r.readAsText(f);
    };
    input.click();
  }

  // ---------------------------------------------------------------- ribbon wiring
  window.addEventListener('obs:param-ribbon-command', function (e) {
    var cmd = e.detail && e.detail.command;
    switch (cmd) {
      case 'fam-new':   state.family = blankFamily(); open(); break;
      case 'fam-load':  open(); host.querySelector('#fe-lib').focus(); break;
      case 'fam-edit':  open(); break;
      case 'fam-types': open(); break;

      case 'prm-add':   open(); host.querySelector('#fe-add-param').click(); break;
      case 'prm-form':  open(); {
        var inputs = host.querySelectorAll('#fe-params .col-formula input');
        if (inputs.length) inputs[inputs.length - 1].focus();
      } break;
      case 'prm-cnst':  open(); host.querySelector('#fe-add-cons').click(); break;
      case 'prm-grp':   open(); break;

      case 'geo-ext':   open(); setGeoKind('Extrusion'); break;
      case 'geo-rev':   open(); setGeoKind('Revolve');   break;
      case 'geo-swp':   open(); setGeoKind('Sweep');     break;
      case 'geo-bln':   open(); setGeoKind('Extrusion'); break;
      case 'geo-boo':   open(); break;

      case 'anl-regen': {
        var eng = window.OpenBIMStudio?.parametric?.getEngine?.();
        if (eng) { var d = eng.regenerate(); console.info('[OBS-family-editor] regen', d); }
      } break;
      case 'anl-diff': {
        var eng2 = window.OpenBIMStudio?.parametric?.getEngine?.();
        if (eng2) { console.table(eng2.regenerate({ dryRun: true })); }
      } break;
      case 'anl-save': {
        var eng3 = window.OpenBIMStudio?.parametric?.getEngine?.();
        if (eng3 && eng3.downloadIFC) eng3.downloadIFC('parametric.ifc');
      } break;

      case 'lib-samp': open(); saveToLibrary(); break;
      case 'lib-tmpl': open(); renderLibrarySelect(); break;
    }
  });

  // public handle
  window.OBSFamilyEditor = {
    open: open,
    close: close,
    getState: function () { return state; },
    load: function (family) { state.family = JSON.parse(JSON.stringify(family)); open(); }
  };

  console.info('[OBS-family-editor] ready. Ribbon commands wired.');
})();
