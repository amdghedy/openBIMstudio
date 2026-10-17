/* ============================================================
 * obs-parametric-ribbon.js
 * On DOM ready, finds the Parametric ribbon container and replaces
 * its inner content with an Architecture-styled grouped ribbon.
 *
 * Detection is tolerant: it looks for the tab button whose text is
 * exactly "Parametric", then scans for the sibling panel it controls.
 * ============================================================ */
(function () {
  'use strict';
  if (window.__OBS_PARAM_RIBBON__) return;
  window.__OBS_PARAM_RIBBON__ = true;

  // ---------- SVG icons (22x22, stroke-based, matches Arch look) ----------
  var I = {
    family:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 10l9-6 9 6v10H3z"/><path d="M9 20v-6h6v6"/></svg>',
    load:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 19h16"/></svg>',
    edit:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14 6l4 4"/></svg>',
    types:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="4"/><rect x="3" y="10" width="18" height="4"/><rect x="3" y="16" width="18" height="4"/></svg>',

    param:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 12h16"/><circle cx="8" cy="12" r="3"/><circle cx="16" cy="12" r="3"/></svg>',
    formula: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 5h6l-6 14h6"/><path d="M14 8h5"/><path d="M14 16h5"/><path d="M16.5 8v8"/></svg>',
    constrain:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 6h16"/><path d="M4 18h16"/><path d="M8 6v12"/><path d="M16 6v12"/></svg>',
    group:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/></svg>',

    extrude: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6" y="6" width="8" height="8"/><path d="M10 10l6 6"/><path d="M18 4v6"/><path d="M18 4l3 3"/><path d="M18 4l-3 3"/></svg>',
    revolve: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><ellipse cx="12" cy="12" rx="6" ry="8"/><path d="M4 12h16"/></svg>',
    sweep:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 18c4-2 8-10 16-12"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/></svg>',
    blend:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 4h12l-4 16H10z"/></svg>',
    boolean: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="12" r="6"/><circle cx="14" cy="12" r="6"/></svg>',

    regen:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 12a8 8 0 1 1 3 6"/><path d="M4 18v-4h4"/></svg>',
    diff:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="8" height="14"/><rect x="13" y="5" width="8" height="14"/><path d="M9 9h6"/><path d="M9 15h6"/></svg>',
    persist: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 4h11l3 3v13H5z"/><rect x="8" y="4" width="8" height="5"/><rect x="8" y="13" width="8" height="7"/></svg>',

    samples: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="8" height="8"/><rect x="13" y="3" width="8" height="8"/><rect x="3" y="13" width="8" height="8"/><rect x="13" y="13" width="8" height="8"/></svg>',
    tmpl:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4h16v5H4z"/><path d="M4 11h16v9H4z"/></svg>'
  };

  // ---------- ribbon definition (mirrors Architecture grouping) ----------
  var GROUPS = [
    { label: 'FAMILY', buttons: [
      { id: 'fam-new',   name: 'New Family',  ico: I.family },
      { id: 'fam-load',  name: 'Load Family', ico: I.load   },
      { id: 'fam-edit',  name: 'Edit Family', ico: I.edit   },
      { id: 'fam-types', name: 'Types',       ico: I.types  }
    ]},
    { label: 'PARAMETERS', buttons: [
      { id: 'prm-add',   name: 'Add',        ico: I.param    },
      { id: 'prm-form',  name: 'Formula',    ico: I.formula  },
      { id: 'prm-cnst',  name: 'Constraint', ico: I.constrain},
      { id: 'prm-grp',   name: 'Group',      ico: I.group    }
    ]},
    { label: 'GEOMETRY', buttons: [
      { id: 'geo-ext',  name: 'Extrude', ico: I.extrude },
      { id: 'geo-rev',  name: 'Revolve', ico: I.revolve },
      { id: 'geo-swp',  name: 'Sweep',   ico: I.sweep   },
      { id: 'geo-bln',  name: 'Blend',   ico: I.blend   },
      { id: 'geo-boo',  name: 'Boolean', ico: I.boolean }
    ]},
    { label: 'ANALYZE', buttons: [
      { id: 'anl-regen', name: 'Regenerate', ico: I.regen   },
      { id: 'anl-diff',  name: 'Diff',       ico: I.diff    },
      { id: 'anl-save',  name: 'Persist IFC',ico: I.persist }
    ]},
    { label: 'LIBRARY', buttons: [
      { id: 'lib-samp', name: 'Samples',   ico: I.samples },
      { id: 'lib-tmpl', name: 'Templates', ico: I.tmpl    }
    ]}
  ];

  function findPanel() {
    // Strategy 1: element with data-tab="parametric"
    var el = document.querySelector('[data-tab="parametric"], [data-ribbon="parametric"]');
    if (el) return el;

    // Strategy 2: find the tab button by text, then its controlled panel
    var all = document.querySelectorAll('button, a, [role="tab"], .tab, [class*="tab"]');
    for (var i = 0; i < all.length; i++) {
      var t = (all[i].textContent || '').trim();
      if (t === 'Parametric') {
        var aria = all[i].getAttribute('aria-controls');
        if (aria) {
          var p = document.getElementById(aria);
          if (p) return p;
        }
        // Look for next sibling panel with class containing 'ribbon' or 'panel'
        var sib = all[i].nextElementSibling;
        while (sib) {
          if (sib.className && /ribbon|panel|content|tab/i.test(sib.className)) return sib;
          sib = sib.nextElementSibling;
        }
        // Fallback: nearest common ancestor's next element
        var parent = all[i].parentElement;
        if (parent && parent.nextElementSibling) return parent.nextElementSibling;
      }
    }
    return null;
  }

  function buildGroup(g) {
    var wrap = document.createElement('div');
    wrap.className = 'obs-rb-group';

    var row = document.createElement('div');
    row.className = 'obs-rb-group-row';
    g.buttons.forEach(function (b) {
      var btn = document.createElement('button');
      btn.className = 'obs-rb-btn';
      btn.type = 'button';
      btn.dataset.obsCmd = b.id;
      btn.innerHTML = '<span class="obs-rb-ico">' + b.ico + '</span>'
                    + '<span class="obs-rb-name">' + b.name + '</span>';
      row.appendChild(btn);
    });

    var lbl = document.createElement('div');
    lbl.className = 'obs-rb-label';
    lbl.textContent = g.label;

    wrap.appendChild(row);
    wrap.appendChild(lbl);
    return wrap;
  }

  function buildRibbon() {
    var root = document.createElement('div');
    root.className = 'obs-ribbon-arch';
    GROUPS.forEach(function (g) { root.appendChild(buildGroup(g)); });
    return root;
  }

  function wireEvents(root) {
    root.addEventListener('click', function (e) {
      var btn = e.target.closest('.obs-rb-btn');
      if (!btn) return;
      var cmd = btn.dataset.obsCmd;
      // Broadcast; any listener (app, bridge, extension) can react.
      window.dispatchEvent(new CustomEvent('obs:param-ribbon-command', {
        detail: { command: cmd, source: 'parametric-ribbon' }
      }));
      console.info('[OBS-ribbon] command:', cmd);
    });
  }

  function apply() {
    var panel = findPanel();
    if (!panel) { return false; }
    // Idempotent: skip if we already replaced it
    if (panel.querySelector && panel.querySelector('.obs-ribbon-arch')) return true;

    var ribbon = buildRibbon();
    wireEvents(ribbon);

    // Preserve any state classes the original panel had
    var cls = panel.className || '';
    panel.className = cls.replace(/obs-ribbon-arch/g, '').trim() + ' obs-ribbon-panel';
    panel.innerHTML = '';
    panel.appendChild(ribbon);
    console.info('[OBS-ribbon] Parametric ribbon restyled');
    return true;
  }

  // Try a few times - app frameworks mount asynchronously
  var tries = 0;
  var t = setInterval(function () {
    tries++;
    if (apply() || tries > 100) clearInterval(t);
  }, 150);

  // Also re-apply on demand
  window.OBSRestyleParametric = function () {
    var p = findPanel();
    if (p && p.querySelector) {
      var old = p.querySelector('.obs-ribbon-arch');
      if (old) old.remove();
    }
    return apply();
  };
})();
