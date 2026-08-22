import koffi from "file:///E:/DeepSeekHarness/resources/harness/node_modules/koffi/index.js";
const MARK = '__dshNoConsolePatched';
if (koffi && typeof koffi.load === 'function' && !koffi[MARK]) {
  const proxyCache = new WeakMap();
  const origLoad = koffi.load;
  koffi.load = function (...args) {
    const lib = origLoad.apply(this, args);
    if (lib && typeof lib.func === 'function') {
      let proxied = proxyCache.get(lib);
      if (!proxied) {
        proxied = new Proxy(lib, {
          get(target, prop, receiver) {
            if (prop === 'func') {
              return function (abi, name, result, params) {
                const fn = target.func.call(target, abi, name, result, params);
                if (name === 'CreateProcessAsUserW' && typeof fn === 'function') {
                  return function (...callArgs) {
                    if (callArgs.length >= 7) {
                      const flags = callArgs[6];
                      if (typeof flags === 'number' && (flags & 0x08000000) === 0) callArgs[6] = flags | 0x08000000;
                    }
                    return fn.apply(this, callArgs);
                  };
                }
                return fn;
              };
            }
            return Reflect.get(target, prop, receiver);
          }
        });
        proxyCache.set(lib, proxied);
      }
      return proxied;
    }
    return lib;
  };
  koffi[MARK] = true;
}
export default koffi;
