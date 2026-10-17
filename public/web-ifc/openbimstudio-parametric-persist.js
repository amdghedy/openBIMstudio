/* ============================================================================
 * openbimstudio-parametric-persist.js
 * Write-back support:
 *   engine.toIFC()                -> Uint8Array of the current model
 *   engine.downloadIFC(filename)  -> triggers browser download
 *   engine.persist(diff)          -> writes ifcLines into the model (best-effort)
 * Auto-persists after every regenerate when window.__obsAutoPersist === true.
 * ========================================================================== */
(function () {
  'use strict';
  if (window.__OBS_PARAM_PERSIST__) return;
  window.__OBS_PARAM_PERSIST__ = true;

  function findModelApi(engine) {
    if (engine.api) return engine.api;
    if (window.OpenBIMStudio && window.OpenBIMStudio.parametric) {
      return window.OpenBIMStudio.parametric.api;
    }
    return null;
  }

  function nextExpressID(api, modelID) {
    try {
      if (typeof api.GetMaxExpressID === 'function') {
        return api.GetMaxExpressID(modelID) + 1;
      }
    } catch (e) {}
    // Fallback: scan all lines
    var max = 0;
    var ids = api.GetAllLines(modelID);
    for (var i = 0; i < ids.size(); i++) { var v = ids.get(i); if (v > max) max = v; }
    return max + 1;
  }

  function writeLine(api, modelID, line) {
    if (typeof api.CreateIfcEntity === 'function') {
      var id = api.CreateIfcEntity(modelID, line.type);
      api.WriteLine(modelID, id, line);
      return id;
    }
    if (typeof api.WriteLine === 'function') {
      var nid = nextExpressID(api, modelID);
      api.WriteLine(modelID, nid, line);
      return nid;
    }
    throw new Error('web-ifc API has no WriteLine/CreateIfcEntity');
  }

  function attachPersistence(engine, modelID) {
    if (!engine || engine.__persistAttached) return engine;
    var api = findModelApi(engine);
    if (!api) { console.warn('[OBS-persist] no api reference on engine'); return engine; }

    engine.__persistAttached = true;

    engine.toIFC = function () {
      if (typeof api.SaveModel !== 'function') {
        throw new Error('SaveModel not available on this web-ifc build');
      }
      var bytes = api.SaveModel(modelID);
      return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    };

    engine.downloadIFC = function (filename) {
      var bytes = engine.toIFC();
      var blob  = new Blob([bytes], { type: 'application/x-step' });
      var url   = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename || 'model.ifc';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 500);
      return bytes;
    };

    engine.persist = function (diff) {
      if (!Array.isArray(diff)) throw new Error('persist(diff) requires the diff array from regenerate()');
      var written = 0;
      for (var i = 0; i < diff.length; i++) {
        var rec = diff[i];
        if (!rec.ifcLines || !rec.ifcLines.length) continue;
        for (var j = 0; j < rec.ifcLines.length; j++) {
          try { writeLine(api, modelID, rec.ifcLines[j]); written++; }
          catch (e) { console.warn('[OBS-persist] writeLine failed:', e); }
        }
      }
      console.info('[OBS-persist] wrote', written, 'entity line(s)');
      return written;
    };

    // Optional auto-persist on regen
    var origRegen = engine.regenerate.bind(engine);
    engine.regenerate = function () {
      var diff = origRegen.apply(null, arguments);
      if (window.__obsAutoPersist) {
        try { engine.persist(diff); } catch (e) { console.warn('[OBS-persist]', e); }
      }
      return diff;
    };

    return engine;
  }

  window.addEventListener('obs:parametric-ready', function (e) {
    var engine = e.detail.engine;
    var modelID = e.detail.modelID;
    try { attachPersistence(engine, modelID); console.info('[OBS-persist] attached'); }
    catch (err) { console.warn('[OBS-persist] attach failed:', err); }
  });

  window.OpenBIMStudio = window.OpenBIMStudio || {};
  window.OpenBIMStudio.parametric = window.OpenBIMStudio.parametric || {};
  window.OpenBIMStudio.parametric.enableAutoPersist = function (on) {
    window.__obsAutoPersist = on !== false;
    console.info('[OBS-persist] autoPersist =', window.__obsAutoPersist);
  };
})();
