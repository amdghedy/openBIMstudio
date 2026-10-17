/* public/js/openbimstudio-autodesk-panel.js
   Properties + Tree drawer for Autodesk-imported element data. */
(function () {
  'use strict';

  var PANEL_ID  = 'obim-autodesk-panel';
  var HANDLE_ID = 'obim-autodesk-handle';

  var state = {
    open:    false,
    tab:     'props',      // 'props' | 'tree'
    query:   '',
    elements: [],
    selected: null,
    page:     0,
    PAGE:     250
  };

  // ---------------------------------------------------------------- styles
  function injectStyles() {
    if (document.getElementById('obim-autodesk-panel-style')) return;
    var s = document.createElement('style');
    s.id = 'obim-autodesk-panel-style';
    s.textContent = [
      '#'+PANEL_ID+'{position:fixed;top:0;right:0;height:100vh;width:420px;',
      'background:#0e1116;color:#e6edf3;border-left:1px solid #1f2630;',
      'z-index:2147483000;display:flex;flex-direction:column;',
      'font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
      'transform:translateX(100%);transition:transform .22s ease;',
      'box-shadow:-8px 0 24px rgba(0,0,0,.35);}',
      '#'+PANEL_ID+'.open{transform:translateX(0);}',
      '#'+PANEL_ID+' .obim-head{display:flex;align-items:center;gap:8px;',
      'padding:10px 12px;border-bottom:1px solid #1f2630;background:#0b0e13;}',
      '#'+PANEL_ID+' .obim-tabs{display:flex;gap:4px;flex:1;}',
      '#'+PANEL_ID+' .obim-tab{padding:6px 12px;border-radius:6px;',
      'background:transparent;color:#8b949e;border:1px solid transparent;',
      'cursor:pointer;font:600 12.5px/1 inherit;}',
      '#'+PANEL_ID+' .obim-tab.active{background:#161b22;color:#e6edf3;',
      'border-color:#1f2630;}',
      '#'+PANEL_ID+' .obim-tab:hover{color:#e6edf3;}',
      '#'+PANEL_ID+' .obim-close{background:transparent;border:none;',
      'color:#8b949e;font-size:18px;cursor:pointer;padding:2px 8px;}',
      '#'+PANEL_ID+' .obim-close:hover{color:#e6edf3;}',
      '#'+PANEL_ID+' .obim-search{padding:10px 12px;border-bottom:1px solid #1f2630;}',
      '#'+PANEL_ID+' .obim-search input{width:100%;box-sizing:border-box;',
      'background:#161b22;color:#e6edf3;border:1px solid #1f2630;',
      'border-radius:6px;padding:8px 10px;font:inherit;outline:none;}',
      '#'+PANEL_ID+' .obim-search input:focus{border-color:#0a84ff;',
      'box-shadow:0 0 0 3px rgba(10,132,255,.15);}',
      '#'+PANEL_ID+' .obim-body{flex:1;overflow:auto;position:relative;}',
      '#'+PANEL_ID+' .obim-list{padding:4px 0;}',
      '#'+PANEL_ID+' .obim-row{padding:7px 12px;border-bottom:1px solid #131820;',
      'cursor:pointer;display:flex;flex-direction:column;gap:2px;}',
      '#'+PANEL_ID+' .obim-row:hover{background:#161b22;}',
      '#'+PANEL_ID+' .obim-row.sel{background:#182435;}',
      '#'+PANEL_ID+' .obim-name{color:#e6edf3;font-weight:500;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '#'+PANEL_ID+' .obim-sub{color:#7d8590;font-size:11.5px;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '#'+PANEL_ID+' .obim-empty{padding:24px 12px;color:#6e7681;text-align:center;}',
      '#'+PANEL_ID+' .obim-detail{border-top:1px solid #1f2630;',
      'background:#0b0e13;max-height:55%;overflow:auto;padding:10px 14px;}',
      '#'+PANEL_ID+' .obim-detail h4{margin:0 0 6px;font-size:13px;color:#e6edf3;}',
      '#'+PANEL_ID+' .obim-detail .obim-id{color:#7d8590;font-size:11.5px;',
      'margin-bottom:8px;}',
      '#'+PANEL_ID+' .obim-detail table{width:100%;border-collapse:collapse;',
      'font-size:12px;}',
      '#'+PANEL_ID+' .obim-detail td{padding:5px 4px;vertical-align:top;',
      'border-bottom:1px solid #131820;}',
      '#'+PANEL_ID+' .obim-detail td:first-child{color:#8b949e;width:42%;}',
      '#'+PANEL_ID+' .obim-detail td:last-child{color:#e6edf3;',
      'word-break:break-word;}',
      '#'+PANEL_ID+' .obim-tree{padding:4px 0;}',
      '#'+PANEL_ID+' .obim-tnode{padding:6px 12px;cursor:pointer;',
      'display:flex;align-items:center;gap:6px;user-select:none;}',
      '#'+PANEL_ID+' .obim-tnode:hover{background:#161b22;}',
      '#'+PANEL_ID+' .obim-tnode .caret{width:10px;color:#7d8590;}',
      '#'+PANEL_ID+' .obim-tnode .label{flex:1;color:#e6edf3;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '#'+PANEL_ID+' .obim-tnode .count{color:#7d8590;font-size:11.5px;}',
      '#'+PANEL_ID+' .obim-tsub{padding-left:22px;}',
      '#'+PANEL_ID+' .obim-foot{padding:8px 12px;border-top:1px solid #1f2630;',
      'color:#7d8590;font-size:11.5px;display:flex;justify-content:space-between;}',
      '#'+PANEL_ID+' .obim-cat{color:#0a84ff;font-size:11.5px;}',
      '#'+HANDLE_ID+'{position:fixed;top:50%;right:0;transform:translateY(-50%);',
      'z-index:2147482999;background:#0a84ff;color:#fff;border:none;',
      'padding:14px 8px;border-radius:8px 0 0 8px;cursor:pointer;',
      'writing-mode:vertical-lr;font:600 12px/1 system-ui,sans-serif;',
      'letter-spacing:1px;box-shadow:-3px 0 12px rgba(0,102,204,.35);}',
      '#'+HANDLE_ID+':hover{background:#0066cc;}'
    ].join('');
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------- helpers
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function getProp(el, name) {
    if (!el || !el.properties) return null;
    for (var i = 0; i < el.properties.length; i++) {
      var p = el.properties[i];
      if (p.displayName === name || p.attributeName === name) return p.displayValue;
    }
    return null;
  }
  function matches(el, q) {
    if (!q) return true;
    if ((el.name || '').toLowerCase().indexOf(q) !== -1) return true;
    if ((el.externalId || '').toLowerCase().indexOf(q) !== -1) return true;
    var c = getProp(el, 'Category');
    if (c && String(c).toLowerCase().indexOf(q) !== -1) return true;
    var t = getProp(el, 'Type Name');
    if (t && String(t).toLowerCase().indexOf(q) !== -1) return true;
    return false;
  }

  // ---------------------------------------------------------------- build
  function buildHandle() {
    if (document.getElementById(HANDLE_ID)) return;
    var h = document.createElement('button');
    h.id = HANDLE_ID;
    h.type = 'button';
    h.textContent = 'AUTODESK';
    h.title = 'Open Autodesk imported data';
    h.addEventListener('click', function () { state.open ? close() : open(); });
    document.body.appendChild(h);
    h.style.display = 'none';
  }

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;
    var p = document.createElement('aside');
    p.id = PANEL_ID;
    p.innerHTML =
      '<div class="obim-head">' +
      '  <div class="obim-tabs">' +
      '    <button class="obim-tab active" data-tab="props">Properties</button>' +
      '    <button class="obim-tab" data-tab="tree">Tree</button>' +
      '  </div>' +
      '  <button class="obim-close" title="Close">&#x2715;</button>' +
      '</div>' +
      '<div class="obim-search"><input type="text" id="obim-q" placeholder="Search name, type, category, externalId…"/></div>' +
      '<div class="obim-body" id="obim-body"></div>' +
      '<div class="obim-foot"><span id="obim-count">0 elements</span><span class="obim-cat">Autodesk</span></div>';
    document.body.appendChild(p);

    p.querySelector('.obim-close').addEventListener('click', close);
    p.querySelectorAll('.obim-tab').forEach(function (t) {
      t.addEventListener('click', function () {
        state.tab = t.getAttribute('data-tab');
        p.querySelectorAll('.obim-tab').forEach(function (x) { x.classList.remove('active'); });
        t.classList.add('active');
        render();
      });
    });
    p.querySelector('#obim-q').addEventListener('input', function (e) {
      state.query = e.target.value.trim().toLowerCase();
      state.page = 0;
      render();
    });
  }

  // ---------------------------------------------------------------- render
  function render() {
    var body = document.getElementById('obim-body');
    if (!body) return;
    body.innerHTML = '';
    if (state.tab === 'tree') renderTree(body);
    else renderList(body);
    document.getElementById('obim-count').textContent = state.elements.length + ' elements';
  }

  function filtered() {
    if (!state.query) return state.elements;
    var q = state.query;
    var out = [];
    for (var i = 0; i < state.elements.length; i++) {
      if (matches(state.elements[i], q)) out.push(state.elements[i]);
    }
    return out;
  }

  function renderList(body) {
    var list = filtered();
    if (!list.length) {
      body.innerHTML = '<div class="obim-empty">No elements match.</div>';
      if (state.selected) renderDetail(body, state.selected);
      return;
    }
    var wrap = document.createElement('div');
    wrap.className = 'obim-list';
    body.appendChild(wrap);

    var shown = 0;
    function chunk() {
      var end = Math.min(shown + state.PAGE, list.length);
      var html = '';
      for (var i = shown; i < end; i++) {
        var el = list[i];
        var cat = getProp(el, 'Category') || '';
        var tn  = getProp(el, 'Type Name') || '';
        html += '<div class="obim-row" data-idx="' + i + '">' +
                  '<div class="obim-name">' + esc(el.name || '(unnamed)') + '</div>' +
                  '<div class="obim-sub">' + esc(cat) + (tn ? ' · ' + esc(tn) : '') + ' · dbId ' + esc(el.dbId) + '</div>' +
                '</div>';
      }
      wrap.insertAdjacentHTML('beforeend', html);
      shown = end;
      if (shown < list.length) requestAnimationFrame(chunk);
    }
    chunk();

    wrap.addEventListener('click', function (e) {
      var row = e.target.closest('.obim-row');
      if (!row) return;
      var idx = +row.getAttribute('data-idx');
      state.selected = list[idx];
      wrap.querySelectorAll('.obim-row.sel').forEach(function (x) { x.classList.remove('sel'); });
      row.classList.add('sel');
      var existing = body.querySelector('.obim-detail');
      if (existing) existing.remove();
      renderDetail(body, state.selected);
    });

    if (state.selected) renderDetail(body, state.selected);
  }

  function renderDetail(body, el) {
    var rows = (el.properties || []).map(function (p) {
      return '<tr><td>' + esc(p.displayName) + '</td><td>' + esc(p.displayValue) + '</td></tr>';
    }).join('');
    var det = document.createElement('div');
    det.className = 'obim-detail';
    det.innerHTML =
      '<h4>' + esc(el.name || '(unnamed)') + '</h4>' +
      '<div class="obim-id">dbId ' + esc(el.dbId) +
      (el.externalId ? ' · externalId ' + esc(el.externalId) : '') + '</div>' +
      '<table>' + rows + '</table>';
    body.appendChild(det);
    det.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderTree(body) {
    var tree = {};
    for (var i = 0; i < state.elements.length; i++) {
      var el  = state.elements[i];
      if (state.query && !matches(el, state.query)) continue;
      var cat = getProp(el, 'Category') || '(unknown)';
      var tn  = getProp(el, 'Type Name') || '(no type)';
      if (!tree[cat]) tree[cat] = {};
      if (!tree[cat][tn]) tree[cat][tn] = [];
      tree[cat][tn].push(el);
    }
    var cats = Object.keys(tree).sort();
    if (!cats.length) {
      body.innerHTML = '<div class="obim-empty">Nothing to show.</div>';
      return;
    }
    var wrap = document.createElement('div');
    wrap.className = 'obim-tree';

    cats.forEach(function (cat) {
      var types = Object.keys(tree[cat]).sort();
      var total = types.reduce(function (a, t) { return a + tree[cat][t].length; }, 0);
      var node = document.createElement('div');
      node.innerHTML =
        '<div class="obim-tnode obim-cat-node">' +
          '<span class="caret">&#x25B6;</span>' +
          '<span class="label">' + esc(cat) + '</span>' +
          '<span class="count">' + total + '</span>' +
        '</div>' +
        '<div class="obim-tsub" style="display:none"></div>';
      var catNode = node.firstChild;
      var sub     = node.lastChild;
      catNode.addEventListener('click', function () {
        var open = sub.style.display !== 'none';
        sub.style.display = open ? 'none' : 'block';
        catNode.querySelector('.caret').textContent = open ? '\u25B6' : '\u25BC';
        if (!open && !sub.dataset.built) {
          sub.dataset.built = '1';
          var html = '';
          types.forEach(function (tn) {
            html += '<div class="obim-tnode obim-type-node">' +
                      '<span class="caret">&#x25B6;</span>' +
                      '<span class="label">' + esc(tn) + '</span>' +
                      '<span class="count">' + tree[cat][tn].length + '</span>' +
                    '</div>' +
                    '<div class="obim-tsub" style="display:none"></div>';
          });
          sub.innerHTML = html;
          sub.querySelectorAll('.obim-type-node').forEach(function (typeNode, ti) {
            var typeSub = typeNode.nextElementSibling;
            var tn = types[ti];
            typeNode.addEventListener('click', function () {
              var to = typeSub.style.display !== 'none';
              typeSub.style.display = to ? 'none' : 'block';
              typeNode.querySelector('.caret').textContent = to ? '\u25B6' : '\u25BC';
              if (!to && !typeSub.dataset.built) {
                typeSub.dataset.built = '1';
                var h = '';
                tree[cat][tn].slice(0, 2000).forEach(function (el) {
                  h += '<div class="obim-row" data-dbid="' + esc(el.dbId) + '">' +
                         '<div class="obim-name">' + esc(el.name || '(unnamed)') + '</div>' +
                         '<div class="obim-sub">dbId ' + esc(el.dbId) + '</div>' +
                       '</div>';
                });
                typeSub.innerHTML = h;
              }
            });
          });
        }
      });
      wrap.appendChild(node);
    });

    wrap.addEventListener('click', function (e) {
      var row = e.target.closest('.obim-row');
      if (!row) return;
      var dbid = row.getAttribute('data-dbid');
      var el = state.elements.find(function (x) { return String(x.dbId) === dbid; });
      if (el) {
        state.selected = el;
        var body = document.getElementById('obim-body');
        var existing = body.querySelector('.obim-detail');
        if (existing) existing.remove();
        renderDetail(body, el);
      }
    });

    body.appendChild(wrap);
  }

  // ---------------------------------------------------------------- control
  function open() {
    var p = document.getElementById(PANEL_ID);
    if (!p) return;
    p.classList.add('open');
    state.open = true;
    var h = document.getElementById(HANDLE_ID);
    if (h) h.style.display = 'none';
  }
  function close() {
    var p = document.getElementById(PANEL_ID);
    if (!p) return;
    p.classList.remove('open');
    state.open = false;
    var h = document.getElementById(HANDLE_ID);
    if (h) h.style.display = '';
  }

  function setElements(list) {
    state.elements = list || [];
    state.page = 0;
    state.selected = null;
    render();
  }

  // ---------------------------------------------------------------- wire
  window.addEventListener('openbimstudio:autodesk-ready', function (e) {
    if (!e.detail || !e.detail.properties) return;
    var p = e.detail.properties;
    setElements(p.elements || []);
    open();
    console.info('[OpenBIMstudio] Autodesk panel populated with', state.elements.length, 'elements.');
  });

  function boot() {
    injectStyles();
    buildHandle();
    buildPanel();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
