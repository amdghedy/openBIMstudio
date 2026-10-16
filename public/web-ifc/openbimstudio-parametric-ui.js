/* ============================================================================
 * openbimstudio-parametric-ui.js
 * Floating panel that auto-discovers families and shows parameter sliders.
 * Zero app code needed. Toggle with Ctrl+Shift+P or click the header.
 * ========================================================================== */
(function () {
  'use strict';
  if (window.__OBS_PARAM_UI__) return;
  window.__OBS_PARAM_UI__ = true;

  var style = document.createElement('style');
  style.textContent = [
    '#obs-param-panel{position:fixed;right:16px;bottom:16px;width:320px;max-height:70vh;overflow:auto;',
    'background:#0f1116;color:#e6e8ee;font:12px/1.4 -apple-system,Segoe UI,sans-serif;',
    'border:1px solid #2a2f3a;border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.35);z-index:2147483647;}',
    '#obs-param-panel header{padding:8px 10px;background:#161a22;border-bottom:1px solid #2a2f3a;',
    'cursor:pointer;display:flex;justify-content:space-between;align-items:center;font-weight:600;color:#9cf;}',
    '#obs-param-panel .body{padding:10px;}',
    '#obs-param-panel.collapsed .body{display:none;}',
    '#obs-param-panel select,#obs-param-panel input[type=text],#obs-param-panel input[type=number]',
    '{width:100%;background:#0b0d12;color:#e6e8ee;border:1px solid #2a2f3a;border-radius:4px;padding:4px 6px;}',
    '#obs-param-panel .row{margin:6px 0;}',
    '#obs-param-panel .row label{display:flex;justify-content:space-between;color:#9aa4b2;font-size:11px;}',
    '#obs-param-panel input[type=range]{width:100%;}',
    '#obs-param-panel .btns{display:flex;gap:6px;margin-top:8px;}',
    '#obs-param-panel button{flex:1;background:#2563eb;color:#fff;border:0;border-radius:4px;padding:6px;cursor:pointer;}',
    '#obs-param-panel button.sec{background:#2a2f3a;}',
    '#obs-param-panel .empty{color:#6b7280;font-style:italic;padding:6px 0;}'
  ].join('');
  document.head.appendChild(style);

  var panel = document.createElement('div');
  panel.id = 'obs-param-panel';
  panel.innerHTML = ''
    + '<header><span>Parametric</span><span id="obs-param-toggle">[ - ]</span></header>'
    + '<div class="body">'
    +   '<div id="obs-param-content"><div class="empty">Waiting for a model...</div></div>'
    + '</div>';
  document.body.appendChild(panel);

  document.querySelector('#obs-param-panel header').addEventListener('click', function () {
    panel.classList.toggle('collapsed');
    document.getElementById('obs-param-toggle').textContent =
      panel.classList.contains('collapsed') ? '[ + ]' : '[ - ]';
  });

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
      e.preventDefault();
      panel.classList.toggle('collapsed');
    }
  });

  var currentEngine = null;
  var currentFamily = null;
  var currentType   = null;
  var typeSnapshot  = null;

  function getParamKind(engine, familyName, pname) {
    var fam = engine.families.get(familyName);
    if (!fam) return 'Number';
    var p = fam.parameters.get(pname) || fam.instanceParameters.get(pname);
    return (p && p.kind) || 'Number';
  }

  function render() {
    var content = document.getElementById('obs-param-content');
    content.innerHTML = '';

    if (!currentEngine) {
      content.innerHTML = '<div class="empty">Waiting for a model...</div>';
      return;
    }

    var families = currentEngine.listFamilies();
    if (!families.length) {
      content.innerHTML = '<div class="empty">No families in this IFC. Use engine.defineFamily() to add one.</div>';
      return;
    }

    var famSel = document.createElement('select');
    families.forEach(function (f) {
      var o = document.createElement('option');
      o.value = f.name; o.textContent = f.name + ' (' + f.typeCount + ')';
      famSel.appendChild(o);
    });
    if (currentFamily && families.some(function (f) { return f.name === currentFamily; })) {
      famSel.value = currentFamily;
    } else {
      currentFamily = families[0].name;
    }
    content.appendChild(row('Family', famSel));

    var types = currentEngine.listTypes(currentFamily);
    if (!types.length) {
      content.innerHTML += '<div class="empty">This family has no types yet.</div>';
      return;
    }
    var typeSel = document.createElement('select');
    types.forEach(function (t) {
      var o = document.createElement('option'); o.value = t; o.textContent = t;
      typeSel.appendChild(o);
    });
    if (currentType && types.indexOf(currentType) >= 0) typeSel.value = currentType;
    else currentType = types[0];
    content.appendChild(row('Type', typeSel));

    var fam = currentEngine.families.get(currentFamily);
    var typeObj = fam.types.get(currentType);
    var params = [];
    fam.parameters.forEach(function (p, k) { params.push([k, p]); });
    fam.instanceParameters.forEach(function (p, k) { params.push([k, p]); });

    params.forEach(function (pair) {
      var pname = pair[0], pdef = pair[1];
      var kind  = pdef.kind;
      var val   = typeObj.get(pname);
      content.appendChild(paramRow(pname, kind, val, pdef.isReadOnly));
    });

    var btns = document.createElement('div');
    btns.className = 'btns';
    var bUndo = document.createElement('button');
    bUndo.className = 'sec'; bUndo.textContent = 'Revert';
    bUndo.onclick = function () {
      if (!typeSnapshot) return;
      typeSnapshot.forEach(function (v, k) { typeObj.set(k, v); });
      currentEngine._dirty.clear();
      currentEngine.regenerate();
      render();
    };
    var bSave = document.createElement('button');
    bSave.textContent = 'Download IFC';
    bSave.onclick = function () {
      if (currentEngine.downloadIFC) {
        currentEngine.downloadIFC('openbimstudio-parametric.ifc');
      } else {
        alert('Persistence module not loaded. Add openbimstudio-parametric-persist.js');
      }
    };
    btns.appendChild(bUndo); btns.appendChild(bSave);
    content.appendChild(btns);

    function onFamilyChange() {
      currentFamily = famSel.value;
      currentType   = null;
      render();
    }
    famSel.onchange = onFamilyChange;
    typeSel.onchange = function () { currentType = typeSel.value; render(); };
  }

  function row(label, inputEl) {
    var d = document.createElement('div'); d.className = 'row';
    var l = document.createElement('label'); l.textContent = label;
    d.appendChild(l); d.appendChild(inputEl);
    return d;
  }

  function paramRow(name, kind, value, readOnly) {
    var d = document.createElement('div'); d.className = 'row';
    var l = document.createElement('label');
    var spanVal = document.createElement('span'); spanVal.textContent = (value == null ? '' : value);
    l.textContent = name; l.appendChild(spanVal);
    d.appendChild(l);

    if (kind === 'YesNo') {
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!value;
      cb.disabled = !!readOnly;
      cb.onchange = function () { apply(name, cb.checked ? 1 : 0, spanVal, cb.checked ? 1 : 0); };
      d.appendChild(cb);
    } else if (kind === 'Text' || kind === 'Material' || kind === 'URL' || kind === 'FamilyType') {
      var ti = document.createElement('input');
      ti.type = 'text'; ti.value = value == null ? '' : value;
      ti.disabled = !!readOnly;
      ti.onchange = function () { apply(name, ti.value, spanVal, ti.value); };
      d.appendChild(ti);
    } else {
      var isInt = (kind === 'Integer');
      var step = isInt ? 1 : (kind === 'Length' ? 0.01 : 0.1);
      var num = Number(value) || 0;
      var rng = document.createElement('input');
      rng.type = 'range';
      var min = Math.min(0, num * 0.1);
      var max = Math.max(1, num * 3);
      if (kind === 'Length') { min = 0; max = Math.max(1, num * 3); }
      rng.min = min; rng.max = max; rng.step = step; rng.value = num;
      rng.disabled = !!readOnly;
      rng.oninput = function () { apply(name, parseFloat(rng.value), spanVal, parseFloat(rng.value).toFixed(2)); };
      d.appendChild(rng);
    }
    return d;
  }

  function apply(name, value, spanVal, displayVal) {
    if (!currentEngine) return;
    if (!typeSnapshot) {
      typeSnapshot = new Map(currentEngine.families.get(currentFamily).types.get(currentType).params);
    }
    try {
      currentEngine.setTypeParameter(currentFamily, currentType, name, value);
      spanVal.textContent = displayVal;
    } catch (e) {
      console.warn('[OBS-ui]', e);
    }
  }

  window.addEventListener('obs:parametric-ready', function (e) {
    currentEngine = e.detail.engine;
    currentFamily = null;
    currentType   = null;
    typeSnapshot  = null;
    render();
  });

  // Also expose a manual refresh
  window.OpenBIMStudio = window.OpenBIMStudio || {};
  window.OpenBIMStudio.parametric = window.OpenBIMStudio.parametric || {};
  window.OpenBIMStudio.parametric.refreshUI = render;
})();
