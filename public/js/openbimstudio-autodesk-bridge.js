/* public/js/openbimstudio-autodesk-bridge.js
   Consumes openbimstudio:load-properties dispatched by autodesk-import.js */
(function () {
  'use strict';
  console.info('[OpenBIMstudio] Autodesk bridge loaded.');

  window.addEventListener('openbimstudio:load-properties', function (evt) {
    var p = evt.detail.parsed;
    if (!p || !p.elements) return console.warn('[OpenBIMstudio] Empty payload.');

    console.log('[OpenBIMstudio] Received ' + p.elements.length + ' Autodesk elements');

    // Preview first 10 in a table
    console.table(p.elements.slice(0, 10).map(function (e) {
      return { dbId: e.dbId, name: e.name, externalId: e.externalId };
    }));

    // Stash globally for other modules
    window.OpenBIMStudio = window.OpenBIMStudio || {};
    window.OpenBIMStudio.autodesk = window.OpenBIMStudio.autodesk || {};
    window.OpenBIMStudio.autodesk.lastProperties = p;

    // Broadcast a secondary event so any UI panel can pick it up
    window.dispatchEvent(new CustomEvent('openbimstudio:autodesk-ready', {
      detail: { properties: p }
    }));

    // Category histogram (quick sanity check)
    var byCategory = {};
    p.elements.forEach(function (e) {
      var c = (e.properties || []).find(function (x) {
        return x.displayName === 'Category' || x.attributeName === 'Category';
      });
      var key = c ? c.displayValue : '(unknown)';
      byCategory[key] = (byCategory[key] || 0) + 1;
    });
    console.log('[OpenBIMstudio] Categories:', byCategory);
  });
})();
