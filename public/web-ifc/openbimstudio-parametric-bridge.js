/* ============================================================================
 * openbimstudio-parametric-bridge.js
 * Runtime bridge: hooks WebIFCWasm so every OpenModel() automatically
 * receives a parametric engine (api.parametric).
 *
 * Emits:
 *   window event 'obs:parametric-ready'      -> { api, modelID, engine }
 *   window event 'obs:parametric-regenerate' -> { modelID, diff }
 *
 * Access anywhere:
 *   window.OpenBIMStudio.parametric.getEngine()
 *   window.OpenBIMStudio.parametric.getModelID()
 * ========================================================================== */
(function () {
  'use strict';
  if (window.__OBS_PARAMETRIC_BRIDGE__) return;
  window.__OBS_PARAMETRIC_BRIDGE__ = true;

  var engine = null;
  var currentModelID = null;
  var currentApi = null;

  function patchWasm() {
    if (!window.WebIFCWasm) return false;
    if (window.WebIFCWasm.__obsWrapped) return true;
    if (!window.RevitParametricEngine) {
      console.warn('[OBS-parametric] RevitParametricEngine not loaded yet - retrying');
      return false;
    }

    var orig = window.WebIFCWasm;
    var wrapped = async function () {
      var api = await orig.apply(null, arguments);

      if (api && typeof api.OpenModel === 'function' && !api.__obsOpenPatched) {
        var origOpen = api.OpenModel.bind(api);

        api.OpenModel = function () {
          var modelID = origOpen.apply(null, arguments);
          try {
            var eng = api.createParametricEngine(modelID, {
              autoRegen: false,
              onRegenerate: function (diff) {
                try {
                  window.dispatchEvent(new CustomEvent('obs:parametric-regenerate', {
                    detail: { modelID: modelID, diff: diff }
                  }));
                } catch (e) {}
              },
              onError: function (e) { console.warn('[OBS-parametric]', e); }
            });

            engine = eng;
            currentModelID = modelID;
            currentApi = api;
            api.parametric = eng;

            window.OpenBIMStudio = window.OpenBIMStudio || {};
            window.OpenBIMStudio.parametric = window.OpenBIMStudio.parametric || {};
            window.OpenBIMStudio.parametric.engine    = eng;
            window.OpenBIMStudio.parametric.modelID   = modelID;
            window.OpenBIMStudio.parametric.api       = api;
            window.OpenBIMStudio.parametric.getEngine = function () { return engine; };
            window.OpenBIMStudio.parametric.getModelID= function () { return currentModelID; };

            try {
              window.dispatchEvent(new CustomEvent('obs:parametric-ready', {
                detail: { api: api, modelID: modelID, engine: eng }
              }));
            } catch (e) {}

            try { eng.loadFamilies(); } catch (e) {}
          } catch (e) {
            console.warn('[OBS-parametric] failed to attach engine:', e);
          }
          return modelID;
        };

        try { Object.defineProperty(api, '__obsOpenPatched', { value: true }); } catch (e) {}
      }
      return api;
    };

    Object.keys(orig).forEach(function (k) {
      try { wrapped[k] = orig[k]; } catch (e) {}
    });
    wrapped.default = wrapped;
    try { Object.defineProperty(wrapped, '__obsWrapped', { value: true }); } catch (e) {}

    window.WebIFCWasm = wrapped;
    console.info('[OBS-parametric] WebIFCWasm hooked');
    return true;
  }

  var tries = 0;
  var poll = setInterval(function () {
    tries++;
    if (patchWasm() || tries > 400) { clearInterval(poll); }
  }, 50);

  window.OpenBIMStudio = window.OpenBIMStudio || {};
  window.OpenBIMStudio.parametric = window.OpenBIMStudio.parametric || {};
  window.OpenBIMStudio.parametric.getEngine  = function () { return engine; };
  window.OpenBIMStudio.parametric.getModelID = function () { return currentModelID; };
  window.OpenBIMStudio.parametric.ready = function (cb) {
    if (engine) return cb(engine, currentModelID);
    window.addEventListener('obs:parametric-ready', function (e) {
      cb(e.detail.engine, e.detail.modelID);
    }, { once: true });
  };
})();
