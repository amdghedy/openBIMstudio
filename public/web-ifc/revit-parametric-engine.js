/* ============================================================================
 * revit-parametric-engine.js
 * Revit-style parametric engine for web-ifc.
 * UMD. Attaches to window.WebIFCWasm when loaded in a browser.
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RevitParametricEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* -------- units -------- */
  var UnitScale = {
    Length: { MILLIMETRE:1e-3, MILLIMETER:1e-3, CENTIMETRE:1e-2, CENTIMETER:1e-2,
              METRE:1, METER:1, FOOT:0.3048, INCH:0.0254 },
    Angle:  { RADIAN:1, DEGREE:Math.PI/180 },
    Area:   { SQUARE_METRE:1, SQUARE_METER:1, SQUARE_MILLIMETRE:1e-6, SQUARE_FOOT:0.09290304 },
    Volume: { CUBIC_METRE:1, CUBIC_METER:1, LITRE:1e-3, LITER:1e-3 }
  };
  function UnitSystem(){ this.length='METRE'; this.angle='RADIAN'; this.area='SQUARE_METRE'; this.volume='CUBIC_METRE'; }
  UnitSystem.prototype.toSI   = function(k,v,u){ var f=(UnitScale[k]||{})[String(u||'').toUpperCase()]; return f===undefined?v:v*f; };
  UnitSystem.prototype.fromSI = function(k,v,u){ var f=(UnitScale[k]||{})[String(u||'').toUpperCase()]; return f===undefined?v:v/f; };
  UnitSystem.detectFromIfc = function(api, modelID){
    var u = new UnitSystem();
    try {
      var ids = api.GetLineIDsWithType(modelID, 180925521);
      if (!ids || ids.size() === 0) return u;
      var ua = api.GetLine(modelID, ids.get(0));
      (ua.Units || []).forEach(function(h){
        var un = api.GetLine(modelID, h.value);
        if (!un || !un.Name) return;
        var n = un.Name.value;
        if (n === 'METRE') u.length = 'METRE';
        else if (n === 'MILLIMETRE') u.length = 'MILLIMETRE';
        else if (n === 'FOOT') u.length = 'FOOT';
      });
    } catch(e){}
    return u;
  };

  /* -------- parameter kinds -------- */
  var ParamKind = Object.freeze({
    Length:'Length', Area:'Area', Volume:'Volume', Angle:'Angle',
    Number:'Number', Integer:'Integer', Text:'Text', YesNo:'YesNo',
    Material:'Material', URL:'URL', FamilyType:'FamilyType'
  });

  function Parameter(spec){
    this.name = spec.name;
    this.kind = spec.kind || ParamKind.Number;
    this.isType = !!spec.isType;
    this.isInstance = spec.isInstance !== undefined ? !!spec.isInstance : !this.isType;
    this.group = spec.group || 'Other';
    this.formula = spec.formula || null;
    this.unit = spec.unit || null;
    this.isReadOnly = !!spec.isReadOnly || !!this.formula;
    this.isShared = !!spec.isShared;
    this.value = spec.default !== undefined ? spec.default : this._default();
  }
  Parameter.prototype._default = function(){
    switch (this.kind) {
      case ParamKind.Number: case ParamKind.Length: case ParamKind.Area:
      case ParamKind.Volume: case ParamKind.Angle: case ParamKind.Integer:
      case ParamKind.YesNo: return 0;
      default: return '';
    }
  };
  Parameter.prototype.coerce = function(v){
    switch (this.kind) {
      case ParamKind.Number: case ParamKind.Length:
      case ParamKind.Area:   case ParamKind.Volume:
      case ParamKind.Angle:  return Number(v) || 0;
      case ParamKind.Integer: return Math.round(Number(v)) || 0;
      case ParamKind.YesNo:   return v ? 1 : 0;
      default: return v == null ? '' : String(v);
    }
  };

  /* -------- formula engine (safe) -------- */
  var FormulaEngine = (function(){
    var FN = {
      sin:Math.sin, cos:Math.cos, tan:Math.tan,
      asin:Math.asin, acos:Math.acos, atan:Math.atan,
      sqrt:Math.sqrt, abs:Math.abs, floor:Math.floor, ceil:Math.ceil,
      round:Math.round, exp:Math.exp, log:Math.log, ln:Math.log,
      log10:Math.log10, pow:Math.pow,
      min:function(){return Math.min.apply(null,arguments);},
      max:function(){return Math.max.apply(null,arguments);},
      if:function(c,a,b){return c?a:b;},
      pi:function(){return Math.PI;}
    };
    function tokenize(src){
      var t=[], i=0;
      while (i < src.length) {
        var c = src[i];
        if (/\s/.test(c)) { i++; continue; }
        if (/[0-9.]/.test(c)) {
          var n=''; while (i<src.length && /[0-9.]/.test(src[i])) n += src[i++];
          t.push({t:'num', v: parseFloat(n)}); continue;
        }
        if (/[A-Za-z_]/.test(c)) {
          var id=''; while (i<src.length && /[A-Za-z0-9_]/.test(src[i])) id += src[i++];
          t.push({t:'id', v:id}); continue;
        }
        var two = src.substr(i,2);
        if (two === '<=' || two === '>=' || two === '==' || two === '!=' || two === '&&' || two === '||') {
          t.push({t:'op', v:two}); i += 2; continue;
        }
        if ('+-*/%^(),<>=!?:'.indexOf(c) >= 0) { t.push({t:'op', v:c}); i++; continue; }
        if (c === '"' || c === "'") {
          var q = c, s = ''; i++;
          while (i < src.length && src[i] !== q) s += src[i++];
          i++; t.push({t:'str', v:s}); continue;
        }
        throw new Error('Unexpected char: ' + c);
      }
      return t;
    }
    var PREC = { '||':1, '&&':2, '==':3, '!=':3, '<':4, '>':4, '<=':4, '>=':4,
                 '+':5, '-':5, '*':6, '/':6, '%':6, '^':7 };
    function parse(tokens){
      var pos = 0;
      function peek(){ return tokens[pos]; }
      function next(){ return tokens[pos++]; }
      function expr(minP){
        var left = unary();
        for (;;) {
          var tk = peek();
          if (!tk || tk.t !== 'op' || !(tk.v in PREC)) break;
          var p = PREC[tk.v]; if (p < minP) break;
          next();
          var right = expr(tk.v === '^' ? p : p + 1);
          left = {t:'bin', op:tk.v, l:left, r:right};
        }
        if (peek() && peek().t === 'op' && peek().v === '?') {
          next();
          var a = expr(0);
          if (!peek() || peek().v !== ':') throw new Error('missing :');
          next();
          var b = expr(0);
          left = {t:'tern', c:left, a:a, b:b};
        }
        return left;
      }
      function unary(){
        var tk = peek();
        if (tk && tk.t === 'op' && (tk.v === '-' || tk.v === '+' || tk.v === '!')) {
          next(); return {t:'un', op:tk.v, e:unary()};
        }
        return primary();
      }
      function primary(){
        var tk = next(); if (!tk) throw new Error('Unexpected end');
        if (tk.t === 'num') return {t:'num', v:tk.v};
        if (tk.t === 'str') return {t:'str', v:tk.v};
        if (tk.t === 'id') {
          if (peek() && peek().t === 'op' && peek().v === '(') {
            next(); var args = [];
            if (!(peek() && peek().v === ')')) {
              args.push(expr(0));
              while (peek() && peek().v === ',') { next(); args.push(expr(0)); }
            }
            if (!peek() || peek().v !== ')') throw new Error('missing )');
            next(); return {t:'call', name:tk.v, args:args};
          }
          return {t:'id', name:tk.v};
        }
        if (tk.t === 'op' && tk.v === '(') {
          var e = expr(0);
          if (!peek() || peek().v !== ')') throw new Error('missing )');
          next(); return e;
        }
        throw new Error('Unexpected token: ' + JSON.stringify(tk));
      }
      var ast = expr(0);
      if (pos !== tokens.length) throw new Error('Trailing tokens');
      return ast;
    }
    function evalAst(a, ctx){
      switch (a.t) {
        case 'num': return a.v;
        case 'str': return a.v;
        case 'id':
          if (a.name in ctx) return ctx[a.name];
          if (a.name in FN) return FN[a.name]();
          throw new Error('Unknown parameter: ' + a.name);
        case 'un':
          var v = evalAst(a.e, ctx);
          return a.op === '-' ? -v : a.op === '+' ? +v : (v ? 0 : 1);
        case 'bin':
          var l = evalAst(a.l, ctx), r = evalAst(a.r, ctx);
          switch (a.op) {
            case '+': return l + r;
            case '-': return l - r;
            case '*': return l * r;
            case '/': return r === 0 ? 0 : l / r;
            case '%': return r === 0 ? 0 : l % r;
            case '^': return Math.pow(l, r);
            case '<': return l < r ? 1 : 0;
            case '>': return l > r ? 1 : 0;
            case '<=': return l <= r ? 1 : 0;
            case '>=': return l >= r ? 1 : 0;
            case '==': return l == r ? 1 : 0;
            case '!=': return l != r ? 1 : 0;
            case '&&': return (l && r) ? 1 : 0;
            case '||': return (l || r) ? 1 : 0;
          }
        case 'tern': return evalAst(a.c, ctx) ? evalAst(a.a, ctx) : evalAst(a.b, ctx);
        case 'call':
          var fn = FN[a.name]; if (!fn) throw new Error('Unknown fn: ' + a.name);
          return fn.apply(null, a.args.map(function(x){return evalAst(x, ctx);}));
      }
    }
    var cache = new Map();
    return {
      compile: function(src){ if (cache.has(src)) return cache.get(src); var ast = parse(tokenize(src)); cache.set(src, ast); return ast; },
      evaluate: function(src, ctx){ return evalAst(this.compile(src), ctx); }
    };
  })();

  /* -------- constraint -------- */
  function Constraint(kind, target, params){ this.kind = kind; this.target = target; this.params = params || {}; }
  Constraint.prototype.satisfied = function(ctx){
    var t = this.target, p = this.params;
    switch (this.kind) {
      case 'equal': { var v = t.map(function(n){return ctx[n];}); return v.every(function(x){return Math.abs(x - v[0]) < 1e-9;}); }
      case 'ratio': return Math.abs(ctx[t[0]] - ctx[t[1]] * (p.factor||1)) < 1e-9;
      case 'lock':  return Math.abs(ctx[t[0]] - (p.value||0)) < 1e-9;
      case 'sum':   return Math.abs(t.reduce(function(s,n){return s+ctx[n];},0) - (p.value||0)) < 1e-9;
      case 'range': return ctx[t[0]] >= (p.min==null?-Infinity:p.min) && ctx[t[0]] <= (p.max==null? Infinity:p.max);
    }
    return true;
  };
  Constraint.prototype.resolve = function(ctx, mutable){
    var t = this.target, p = this.params;
    switch (this.kind) {
      case 'equal': {
        var drivers = t.filter(function(n){return mutable.has(n);});
        if (drivers.length < 2) return false;
        var src = ctx[drivers[0]];
        for (var i = 1; i < drivers.length; i++) ctx[drivers[i]] = src;
        return true;
      }
      case 'ratio': {
        var a = t[0], b = t[1], f = p.factor || 1;
        if (mutable.has(a) && !mutable.has(b)) { ctx[a] = ctx[b] * f; return true; }
        if (mutable.has(b) && !mutable.has(a)) { ctx[b] = ctx[a] / f; return true; }
        return false;
      }
      case 'lock':
        if (mutable.has(t[0])) { ctx[t[0]] = p.value || 0; return true; }
        return false;
    }
    return false;
  };

  /* -------- family / type / instance -------- */
  function Family(name, category){
    this.name = name; this.category = category || 'Generic';
    this.parameters = new Map(); this.instanceParameters = new Map();
    this.formulas = new Map(); this.constraints = [];
    this.types = new Map(); this.geometryRecipe = null;
    this.ifcTypeExpressID = -1;
  }
  Family.prototype.addParameter = function(spec){
    var p = new Parameter(spec);
    (p.isType ? this.parameters : this.instanceParameters).set(p.name, p);
    if (p.formula) this.formulas.set(p.name, p.formula);
    return p;
  };
  Family.prototype.addConstraint = function(c){ this.constraints.push(c); return this; };
  Family.prototype.defineGeometry = function(fn){ this.geometryRecipe = fn; return this; };

  function FamilyType(family, name){
    this.family = family; this.name = name;
    this.params = new Map(); this.instances = new Set(); this.ifcExpressID = -1;
    var self = this;
    family.parameters.forEach(function(p, k){ self.params.set(k, p.value); });
  }
  FamilyType.prototype.set = function(n, v){ this.params.set(n, v); };
  FamilyType.prototype.get = function(n){ return this.params.get(n); };

  function FamilyInstance(expressID, type){
    this.expressID = expressID; this.type = type;
    this.overrides = new Map(); this.placement = null;
  }
  FamilyInstance.prototype.effective = function(name){
    return this.overrides.has(name) ? this.overrides.get(name) : this.type.get(name);
  };

  /* -------- geometry builder -------- */
  var GeometryBuilder = {
    build: function(recipe, params){ if (typeof recipe === 'function') recipe = recipe(params); return this._norm(recipe, params); },
    _val: function(v, p){
      if (typeof v === 'number') return v;
      if (typeof v === 'string') { try { return FormulaEngine.evaluate(v, p); } catch(e){ return 0; } }
      return 0;
    },
    _norm: function(n, p){
      if (!n || typeof n !== 'object') return null;
      var k = n.kind, out = { kind:k, origin: n.origin || {x:0,y:0,z:0} };
      switch (k) {
        case 'Extrusion':
          out.profile = this._norm(n.profile, p);
          out.depth = this._val(n.depth, p);
          out.direction = n.direction || {x:0,y:0,z:1};
          break;
        case 'Revolve':
          out.profile = this._norm(n.profile, p);
          out.axis = n.axis || { origin:{x:0,y:0,z:0}, dir:{x:0,y:1,z:0} };
          out.angle = this._val(n.angle, p);
          break;
        case 'Sweep':
          out.profile = this._norm(n.profile, p);
          out.path = this._norm(n.path, p);
          break;
        case 'Blend':
          out.start = this._norm(n.start, p);
          out.end   = this._norm(n.end, p);
          out.depth = this._val(n.depth, p);
          break;
        case 'Union': case 'Subtract': case 'Intersect':
          out.left  = this._norm(n.left, p);
          out.right = this._norm(n.right, p);
          break;
        case 'Rectangle':
          out.width  = this._val(n.width, p);
          out.height = this._val(n.height, p);
          break;
        case 'Circle':
          out.radius = this._val(n.radius, p);
          break;
        case 'Polygon':
          out.points = (n.points||[]).map(function(pt){ return { x: this._val(pt.x, p), y: this._val(pt.y, p) }; }, this);
          break;
        case 'Transform':
          out.child = this._norm(n.child, p);
          out.translation = n.translation || {x:0,y:0,z:0};
          out.rotationZ = this._val(n.rotationZ||0, p);
          break;
      }
      return out;
    }
  };

  /* -------- IFC bridge -------- */
  function IfcBridge(api, modelID){ this.api = api; this.modelID = modelID; }
  IfcBridge.prototype.readFamilies = function(){
    var fams = new Map(), api = this.api, mid = this.modelID;
    var ids;
    try { ids = api.GetAllLines(mid); } catch(e){ return fams; }
    for (var i = 0; i < ids.size(); i++) {
      var id = ids.get(i), line = api.GetLine(mid, id);
      if (!line || !line.type) continue;
      if (line.ApplicableOccurrence === undefined) continue;
      if (line.HasPropertySets === undefined) continue;
      var name = (line.Name && line.Name.value) || ('Family_' + id);
      var fam = new Family(name, (line.ObjectType && line.ObjectType.value) || 'Generic');
      fam.ifcTypeExpressID = id;
      if (Array.isArray(line.HasPropertySets)) {
        for (var j = 0; j < line.HasPropertySets.length; j++) {
          var h = line.HasPropertySets[j]; if (!h || h.value == null) continue;
          var pset = api.GetLine(mid, h.value); if (!pset || !pset.HasProperties) continue;
          for (var q = 0; q < pset.HasProperties.length; q++) {
            var ph = pset.HasProperties[q]; if (!ph || ph.value == null) continue;
            var prop = api.GetLine(mid, ph.value); if (!prop) continue;
            var pname = (prop.Name && prop.Name.value) || ('Param_' + ph.value);
            var pval = (prop.NominalValue && prop.NominalValue.value);
            fam.addParameter({ name: pname, kind: ParamKind.Number, isType: true, default: pval });
          }
        }
      }
      fams.set(name, fam);
    }
    return fams;
  };
  IfcBridge.prototype.serializeGeometry = function(geom, placement){
    var out = [];
    function rec(node){
      if (!node) return null;
      switch (node.kind) {
        case 'Rectangle': return { __profile:'Rectangle', XDim: node.width, YDim: node.height };
        case 'Circle':    return { __profile:'Circle', Radius: node.radius };
        case 'Polygon':   return { __profile:'Polygon', Points: node.points };
        case 'Extrusion': {
          var prof = rec(node.profile);
          out.push({ type: 477187591, SweptArea: prof, Position: placement, ExtrudedDirection: node.direction, Depth: node.depth });
          return { __solid:'Extrusion' };
        }
        case 'Revolve': {
          var prof2 = rec(node.profile);
          out.push({ type: 1856042241, SweptArea: prof2, Position: placement, Axis: node.axis, Angle: node.angle });
          return { __solid:'Revolve' };
        }
        case 'Union': case 'Subtract': case 'Intersect': {
          rec(node.left); rec(node.right);
          out.push({ type: 2736907675, Operator: node.kind === 'Union' ? 'UNION' : node.kind === 'Subtract' ? 'DIFFERENCE' : 'INTERSECTION' });
          return { __solid:'Boolean' };
        }
        case 'Transform': {
          var child = rec(node.child);
          return { __transform: node, child: child };
        }
      }
      return null;
    }
    rec(geom);
    return out;
  };

  /* -------- transaction -------- */
  function Transaction(engine, label){
    this.engine = engine; this.label = label;
    this.snapshot = engine._snapshot(); this.closed = false;
  }
  Transaction.prototype.rollback = function(){ if (this.closed) return; this.engine._restore(this.snapshot); this.closed = true; };
  Transaction.prototype.commit   = function(){ if (this.closed) return; this.closed = true; this.engine._history.push({ label: this.label, at: Date.now() }); };

  /* -------- engine -------- */
  function RevitParametricEngine(api, modelID, options){
    this.api = api; this.modelID = modelID;
    this.options = Object.assign({ autoRegen: true, onRegenerate: null, onError: null }, options || {});
    this.units = api && modelID != null ? UnitSystem.detectFromIfc(api, modelID) : new UnitSystem();
    this.bridge = api && modelID != null ? new IfcBridge(api, modelID) : null;
    this.families = new Map(); this.instances = new Map();
    this._history = []; this._txn = null; this._dirty = new Set();
  }
  RevitParametricEngine.prototype.loadFamilies = function(){
    if (this.bridge) this.families = this.bridge.readFamilies();
    return this.families;
  };
  RevitParametricEngine.prototype.defineFamily = function(name, spec){
    spec = spec || {};
    var fam = new Family(name, spec.category);
    var i;
    for (i = 0; i < (spec.parameters || []).length; i++) fam.addParameter(spec.parameters[i]);
    for (i = 0; i < (spec.formulas || []).length; i++) {
      var f = spec.formulas[i], eq = f.indexOf('=');
      if (eq < 0) continue;
      fam.formulas.set(f.slice(0, eq).trim(), f.slice(eq + 1).trim());
    }
    for (i = 0; i < (spec.constraints || []).length; i++) fam.addConstraint(spec.constraints[i]);
    if (spec.geometry) fam.defineGeometry(spec.geometry);
    this.families.set(name, fam);
    return fam;
  };
  RevitParametricEngine.prototype.defineType = function(familyName, typeName, overrides){
    var fam = this.families.get(familyName); if (!fam) throw new Error('Unknown family: ' + familyName);
    var t = fam.types.get(typeName);
    if (!t) { t = new FamilyType(fam, typeName); fam.types.set(typeName, t); }
    if (overrides) for (var k in overrides) if (overrides.hasOwnProperty(k)) t.set(k, overrides[k]);
    return t;
  };
  RevitParametricEngine.prototype.bindInstance = function(expressID, familyName, typeName){
    var fam = this.families.get(familyName); if (!fam) throw new Error('Unknown family: ' + familyName);
    var t = fam.types.get(typeName) || this.defineType(familyName, typeName);
    var inst = new FamilyInstance(expressID, t);
    t.instances.add(expressID);
    this.instances.set(expressID, inst);
    this._dirty.add(expressID);
    return inst;
  };
  RevitParametricEngine.prototype._resolve = function(fam, type){
    var ctx = {};
    type.params.forEach(function(v, k){ ctx[k] = v; });
    fam.parameters.forEach(function(p, k){ if (!(k in ctx)) ctx[k] = p.value; });
    var changed = true, passes = 0;
    while (changed && passes++ < 25) {
      changed = false;
      fam.formulas.forEach(function(src, name){
        try {
          var v = FormulaEngine.evaluate(src, ctx);
          if (ctx[name] !== v) { ctx[name] = v; changed = true; }
        } catch(e){}
      });
    }
    var mutable = new Set();
    fam.parameters.forEach(function(_, k){ if (!fam.formulas.has(k)) mutable.add(k); });
    for (var i = 0; i < fam.constraints.length; i++) {
      try { fam.constraints[i].resolve(ctx, mutable); } catch(e){}
    }
    return ctx;
  };
  RevitParametricEngine.prototype.effectiveParameters = function(expressID){
    var inst = this.instances.get(expressID); if (!inst) return null;
    var ctx = this._resolve(inst.type.family, inst.type);
    inst.overrides.forEach(function(v, k){ ctx[k] = v; });
    inst.type.family.instanceParameters.forEach(function(p, k){ if (!(k in ctx)) ctx[k] = p.value; });
    return ctx;
  };
  RevitParametricEngine.prototype.setTypeParameter = function(familyName, typeName, paramName, value){
    var fam = this.families.get(familyName); if (!fam) throw new Error('Unknown family: ' + familyName);
    var t = fam.types.get(typeName); if (!t) throw new Error('Unknown type: ' + typeName);
    var p = fam.parameters.get(paramName); if (!p) throw new Error('Unknown parameter: ' + paramName);
    if (p.isReadOnly) throw new Error('Parameter is formula-driven: ' + paramName);
    t.set(paramName, p.coerce(value));
    var self = this;
    t.instances.forEach(function(id){ self._dirty.add(id); });
    this._maybeRegen();
    return t;
  };
  RevitParametricEngine.prototype.setInstanceParameter = function(expressID, paramName, value){
    var inst = this.instances.get(expressID); if (!inst) throw new Error('Unknown instance: ' + expressID);
    inst.overrides.set(paramName, value);
    this._dirty.add(expressID);
    this._maybeRegen();
    return inst;
  };
  RevitParametricEngine.prototype.addConstraint = function(familyName, c){
    var fam = this.families.get(familyName); if (!fam) throw new Error('Unknown family: ' + familyName);
    fam.addConstraint(c);
    fam.types.forEach(function(t){ t.instances.forEach(this._dirty.add, this._dirty); }, this);
    this._maybeRegen();
    return fam;
  };
  RevitParametricEngine.prototype._maybeRegen = function(){ if (this.options.autoRegen) this.regenerate(); };
  RevitParametricEngine.prototype.regenerate = function(_opts){
    var out = [], self = this;
    this._dirty.forEach(function(id){
      var inst = self.instances.get(id); if (!inst) return;
      var fam = inst.type.family;
      var ctx = self.effectiveParameters(id);
      var geom = fam.geometryRecipe ? GeometryBuilder.build(fam.geometryRecipe, ctx) : null;
      var lines = (geom && self.bridge) ? self.bridge.serializeGeometry(geom, inst.placement) : [];
      out.push({ expressID: id, family: fam.name, type: inst.type.name, parameters: ctx, geometry: geom, ifcLines: lines });
    });
    this._dirty.clear();
    if (this.options.onRegenerate) this.options.onRegenerate(out);
    return out;
  };
  RevitParametricEngine.prototype.beginTransaction = function(label){
    if (this._txn) throw new Error('Transaction already open');
    this._txn = new Transaction(this, label || 'Edit');
    return this._txn;
  };
  RevitParametricEngine.prototype.commit   = function(){ if (!this._txn) return; this._txn.commit();   this._txn = null; };
  RevitParametricEngine.prototype.rollback = function(){ if (!this._txn) return; this._txn.rollback(); this._txn = null; this._dirty.clear(); };
  RevitParametricEngine.prototype._snapshot = function(){ return { families: new Map(this.families), instances: new Map(this.instances) }; };
  RevitParametricEngine.prototype._restore  = function(s){ this.families = s.families; this.instances = s.instances; };
  RevitParametricEngine.prototype.listFamilies = function(){
    var out = [];
    this.families.forEach(function(f, n){
      var params = [];
      f.parameters.forEach(function(_, k){ params.push(k); });
      f.instanceParameters.forEach(function(_, k){ params.push(k); });
      out.push({ name: n, category: f.category, typeCount: f.types.size, parameters: params });
    });
    return out;
  };
  RevitParametricEngine.prototype.listTypes = function(familyName){
    var f = this.families.get(familyName); return f ? Array.from(f.types.keys()) : [];
  };
  RevitParametricEngine.prototype.listInstances = function(familyName, typeName){
    var f = this.families.get(familyName); if (!f) return [];
    var t = f.types.get(typeName); if (!t) return [];
    return Array.from(t.instances);
  };

  RevitParametricEngine.attach = function(api, modelID, options){
    var eng = new RevitParametricEngine(api, modelID, options);
    api.parametric = eng;
    api.createParametricEngine = function(mid, opts){ return RevitParametricEngine.attach(api, mid == null ? modelID : mid, opts); };
    return eng;
  };

  if (root.WebIFCWasm && !root.WebIFCWasm.__revitParametricWrapped) {
    var orig = root.WebIFCWasm;
    var wrapped = async function(){
      var api = await orig.apply(null, arguments);
      api.createParametricEngine = function(modelID, opts){ return RevitParametricEngine.attach(api, modelID, opts); };
      return api;
    };
    Object.keys(orig).forEach(function(k){ try { wrapped[k] = orig[k]; } catch(e){} });
    wrapped.default = wrapped;
    try { Object.defineProperty(wrapped, '__revitParametricWrapped', { value: true }); } catch(e){}
    root.WebIFCWasm = wrapped;
  }

  return {
    RevitParametricEngine: RevitParametricEngine,
    Family: Family, FamilyType: FamilyType, FamilyInstance: FamilyInstance,
    Parameter: Parameter, ParamKind: ParamKind, Constraint: Constraint,
    FormulaEngine: FormulaEngine, GeometryBuilder: GeometryBuilder,
    IfcBridge: IfcBridge, UnitSystem: UnitSystem
  };
});
