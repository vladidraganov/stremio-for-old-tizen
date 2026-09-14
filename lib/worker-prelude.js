/*
 * Prepended to the stremio-core worker.
 *
 * Chromium 47 (Tizen 3.0) has no `Reflect` - it shipped in Chrome 49, the same
 * release as `Proxy`, which this TV also reports as missing.
 *
 * This matters because wasm-bindgen populates web_sys `RequestInit` through
 * Reflect.set:
 *
 *     __wbg_set_... = function(A,e,a){ return Reflect.set(i(A), i(e), i(a)); }
 *
 * web_sys's RequestInit setters discard the result in release builds
 * (debug_assert! is compiled out), so a throwing Reflect.set fails silently:
 * `method`, `body` and `headers` are never applied, `new Request(url, {})`
 * defaults to GET, and every POST endpoint on api.strem.io answers 405.
 *
 * The worker bundles core-js for Promise only, so nothing else supplies this.
 */
(function () {
  var g = (typeof self !== 'undefined') ? self
        : (typeof globalThis !== 'undefined') ? globalThis
        : this;
  if (!g) return;

  if (typeof g.Reflect === 'undefined' || g.Reflect === null) { g.Reflect = {}; }
  var R = g.Reflect;

  function def(name, fn) { if (typeof R[name] !== 'function') { R[name] = fn; } }

  /* The one wasm-bindgen actually depends on. Must return a boolean. */
  def('set', function (target, key, value, receiver) {
    try {
      (arguments.length > 3 ? receiver : target)[key] = value;
      return true;
    } catch (e) { return false; }
  });

  def('get', function (target, key, receiver) {
    return (arguments.length > 2 ? receiver : target)[key];
  });

  def('has', function (target, key) { return key in target; });

  def('deleteProperty', function (target, key) {
    try { delete target[key]; return true; } catch (e) { return false; }
  });

  def('apply', function (fn, thisArg, args) {
    return Function.prototype.apply.call(fn, thisArg, args);
  });

  def('construct', function (Target, args) {
    var bound = [null];
    for (var i = 0; i < args.length; i++) { bound.push(args[i]); }
    return new (Function.prototype.bind.apply(Target, bound))();
  });

  def('defineProperty', function (target, key, desc) {
    try { Object.defineProperty(target, key, desc); return true; } catch (e) { return false; }
  });

  def('getOwnPropertyDescriptor', function (target, key) {
    return Object.getOwnPropertyDescriptor(target, key);
  });

  def('ownKeys', function (target) {
    var keys = Object.getOwnPropertyNames(target);
    if (Object.getOwnPropertySymbols) {
      keys = keys.concat(Object.getOwnPropertySymbols(target));
    }
    return keys;
  });

  def('getPrototypeOf', function (target) { return Object.getPrototypeOf(target); });

  def('setPrototypeOf', function (target, proto) {
    try {
      if (Object.setPrototypeOf) { Object.setPrototypeOf(target, proto); }
      else { target.__proto__ = proto; }
      return true;
    } catch (e) { return false; }
  });

  def('isExtensible', function (target) { return Object.isExtensible(target); });

  def('preventExtensions', function (target) {
    try { Object.preventExtensions(target); return true; } catch (e) { return false; }
  });
})();
