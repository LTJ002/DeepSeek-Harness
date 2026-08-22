'use strict';
/*
 * DeepSeek Harness 本地补丁：统一解决 Windows 下子进程弹出黑色控制台窗口（黑框）的问题。
 *
 * 原理：Windows 上 spawn 一个控制台程序（git.exe、pnpm.cmd、node.exe、rg.exe 等）时，
 * 若未指定 windowsHide:true（CREATE_NO_WINDOW），即使父进程本身无控制台，也会新开一个
 * 可见的黑框窗口。harness 内核中大量子进程调用未设置该选项（git 检查/快照、pnpm 装插件、
 * rg 搜索等），本补丁在进程启动最早阶段 hook child_process 的全部 spawn 变体
 * （spawn / spawnSync / exec / execSync / execFile / execFileSync / fork），
 * 为未显式指定 windowsHide 的调用自动补上 true，一处补丁全局生效。
 *
 * 覆盖范围：程序启动、源代码管理调用 git、插件安装（dsh plugin add 转发 pnpm）、
 * 以及任何后续安装的插件在 harness 进程内调用的子进程，都会自动带 windowsHide。
 *
 * 兼容性说明：
 *  - 显式传了 windowsHide:false 的调用（确实想看到窗口）会被保留，不受影响；
 *  - 可通过环境变量 DSH_NO_CONSOLE_PATCH=0 临时整体禁用本补丁（用于排查问题）。
 *
 * 位置：resources/harness/lib/no-console-patch.cjs
 * 注入：bin.js 顶部 import "./no-console-patch.cjs"（由 apply-no-console-patch.cmd 维护）
 * 恢复：内核升级或插件更新后 lib/ 被官方包覆盖时，重新运行
 *       resources/patch/apply-no-console-patch.cmd 即可恢复。
 */

if (process.platform !== 'win32' || process.env.DSH_NO_CONSOLE_PATCH === '0') {
	module.exports = null;
	return;
}
// 全局幂等：若进程级预加载补丁（NODE_OPTIONS --require 本补丁文件）
// 已经应用过，这里直接退出，避免重复包裹 child_process。
if (globalThis.__DSH_NO_CONSOLE_PATCHED__) {
	module.exports = null;
	return;
}
globalThis.__DSH_NO_CONSOLE_PATCHED__ = true;

// 传播：让本进程派生的所有 node 子进程（worker / 子代理 / 工具进程）自动加载本补丁。
// 否则子进程是全新进程，内部再 spawn git/bash 时仍会弹黑框（补丁只管得到当前进程）。
try {
	const file = __filename.replace(/\\/g, '/');
	if (!/\s/.test(file)) {
		const req = `--require=${file}`;
		const cur = process.env.NODE_OPTIONS || '';
		if (!cur.includes(req)) process.env.NODE_OPTIONS = [cur, req].filter(Boolean).join(' ');
		if (process.env.DSH_NO_CONSOLE_PATCH === undefined) process.env.DSH_NO_CONSOLE_PATCH = '1';
	}
} catch {}

// worker_threads 注入：worker 是独立 JS 环境，不继承 NODE_OPTIONS，
// 其中 `import { spawn }` 快照到原始 child_process 后仍会弹窗。
// 通过 worker_threads 模块的 Worker 构造函数，把 --require=本补丁 追加到 execArgv，
// 使 worker 启动即预加载补丁（此时其 ESM 图未链接，快照拿到补丁后的 spawn）。
try {
	const file2 = __filename.replace(/\\/g, '/');
	if (!/\s/.test(file2)) {
		const Module = require('node:module');
		const origLoad2 = Module._load;
		Module._load = function (request, parent, isMain) {
			const loaded = origLoad2.apply(this, arguments);
			if (request === 'node:worker_threads' && loaded && loaded.Worker && !loaded.Worker.__dshNoConsolePatched) {
				try {
					const OrigWorker = loaded.Worker;
					const req2 = `--require=${file2}`;
					loaded.Worker = class Worker extends OrigWorker {
						constructor(filename, options) {
							if (options && typeof options === 'object' && options.execArgv !== undefined && options.execArgv !== null) {
								const arr = Array.isArray(options.execArgv) ? options.execArgv : [options.execArgv];
								if (!arr.includes(req2)) options = { ...options, execArgv: [...arr, req2] };
							} else {
								options = { ...(options || {}), execArgv: [req2] };
							}
							super(filename, options);
						}
					};
					// 保留类名兼容（部分代码检查 constructor.name 或 instanceof）
					Object.defineProperty(loaded.Worker, 'name', { value: 'Worker' });
					loaded.Worker.__dshNoConsolePatched = true;
				} catch {}
			}
			return loaded;
		};
	}
} catch {}

const cp = require('node:child_process');

let applied = false;

/** 是否是一个"选项对象"（而非数组 / RegExp / String 对象等）。 */
const isOpts = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp) && !(v instanceof String);

/**
 * 为未显式指定 windowsHide 的选项补上 true。
 * 返回新对象而非原地修改调用方的 options，避免后续复用 options 时出现意外副作用；
 * 显式写了 windowsHide（无论 true/false）则原样返回。
 */
function withHide(options) {
	if (options === undefined || options === null) return { windowsHide: true };
	if (isOpts(options)) {
		if (options.windowsHide === undefined) return { ...options, windowsHide: true };
		return options;
	}
	return options;
}

/** spawn(command[, args][, options]) / spawnSync 同签名。 */
function patchSpawnLike(name) {
	const orig = cp[name];
	cp[name] = function (command, args, options) {
		if (isOpts(args)) return orig.call(this, command, withHide(args));
		return orig.call(this, command, args, withHide(options));
	};
}

/** exec(command[, options][, callback]) / execSync(command[, options])。 */
function patchExecLike(name) {
	const orig = cp[name];
	cp[name] = function (command, options, callback) {
		if (typeof options === 'function') {
			callback = options;
			options = undefined;
		}
		return orig.call(this, command, withHide(options), callback);
	};
}

/** execFile(file[, args][, options][, callback]) / execFileSync(file[, args][, options])。 */
function patchExecFileLike(name) {
	const orig = cp[name];
	cp[name] = function (file, args, options, callback) {
		if (typeof args === 'function') {
			callback = args;
			args = undefined;
			options = undefined;
		} else if (isOpts(args)) {
			callback = options;
			options = args;
			args = undefined;
		} else if (typeof options === 'function') {
			callback = options;
			options = undefined;
		}
		return orig.call(this, file, args, withHide(options), callback);
	};
}

/** fork(modulePath[, args][, options]) —— fork 内部走的是原生的 spawn 闭包，必须单独包一层。 */
function patchFork() {
	if (typeof cp.fork !== 'function') return;
	const orig = cp.fork;
	cp.fork = function (modulePath, args, options) {
		if (isOpts(args)) return orig.call(this, modulePath, withHide(args));
		return orig.call(this, modulePath, args, withHide(options));
	};
}

function apply() {
	if (applied) return; // 幂等：避免重复注入时重复包裹
	applied = true;
	patchSpawnLike('spawn');
	patchSpawnLike('spawnSync');
	patchExecLike('exec');
	patchExecLike('execSync');
	patchExecFileLike('execFile');
	patchExecFileLike('execFileSync');
	patchFork();
	// node-pty：Windows 下强制 ConPTY（伪控制台无可见窗口），
	// 避免侧边栏终端 / bash / pwsh 的 PTY 拉起时闪黑框（node-pty 不走 child_process）。
	try {
		const Module = require('node:module');
		const origLoad = Module._load;
		Module._load = function (request, parent, isMain) {
			const loaded = origLoad.apply(this, arguments);
			if (request === 'node-pty' && loaded && typeof loaded.spawn === 'function' && !loaded.__dshNoConsolePatched) {
				try {
					const origSpawn = loaded.spawn;
					loaded.spawn = function (file, args, options) {
						if (process.platform === 'win32') {
							if (isOpts(options)) {
								if (options.useConpty === undefined) options = { ...options, useConpty: true };
								return origSpawn.call(this, file, args, options);
							}
							if (isOpts(args)) {
								if (args.useConpty === undefined) args = { ...args, useConpty: true };
								return origSpawn.call(this, file, args);
							}
						}
						return origSpawn.apply(this, arguments);
					};
					loaded.__dshNoConsolePatched = true;
				} catch {}
			}
			return loaded;
		};
	} catch {}
}

apply();

// ===== 新增：koffi CreateProcessAsUserW 弹窗修复（沙箱黑框/蓝框） =====
// 背景：dsh-sandbox-windows-acl 沙箱通过 koffi 直接调 Win32 CreateProcessAsUserW，
// 不走 child_process，上述 hook 管不到。其 dwCreationFlags 只有 CREATE_SUSPENDED(4)，
// 无 CREATE_NO_WINDOW(0x08000000)——父进程无控制台时（桌面版场景），系统会为
// git/pwsh 等控制台程序新建可见终端窗口（黑框=conhost，蓝框=Windows Terminal）。
// 修复：包装 koffi.load() 返回的 lib（Proxy 绕过原生只读属性），给
// CreateProcessAsUserW 自动补上 CREATE_NO_WINDOW。经实测（本机 Win11）受限 token
// 下加该标志不会触发官方注释担心的 0xC0000142，git/pwsh 沙箱内正常运行。
// 覆盖两条链路：
//   A. 本进程 CJS require('koffi') —— 同步包装 exports.load；
//   B. 本进程 ESM import 'koffi'（含 --require 预加载的隔离上下文，
//      registerHooks 是进程级全局钩子，对主入口 ESM 模块图同样生效）——
//      通过 registerHooks resolve 把 koffi 重定向到同目录 koffi-shim.mjs，
//      shim 内包装原实例后 re-export。
const KOFFI_MARK = '__dshNoConsolePatched';

/** 构造包装后的 koffi.load：lib.func 绑定 CreateProcessAsUserW 时返回加 CREATE_NO_WINDOW 的包装。 */
function makeKoffiLoadWrapper(origLoad) {
	const proxyCache = new WeakMap();
	return function (...args) {
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
											if (typeof flags === 'number' && (flags & 0x08000000) === 0) {
												callArgs[6] = flags | 0x08000000;
											}
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
}

if (process.platform === 'win32') {
	// A. CJS 实例
	try {
		const koffi = require('koffi');
		if (koffi && typeof koffi.load === 'function' && !koffi[KOFFI_MARK]) {
			koffi.load = makeKoffiLoadWrapper(koffi.load);
			koffi[KOFFI_MARK] = true;
		}
	} catch {}

	// B. ESM 实例（registerHooks 全局生效，覆盖 --require 预加载的隔离上下文）
	try {
		const { registerHooks } = require('node:module');
		if (typeof registerHooks === 'function' && !globalThis.__DSH_KOFFI_HOOKS_REGISTERED__) {
			globalThis.__DSH_KOFFI_HOOKS_REGISTERED__ = true;
			const path = require('node:path');
			const fs = require('node:fs');
			const url = require('node:url');
			const shimPath = path.join(__dirname, 'koffi-shim.mjs');
			if (!fs.existsSync(shimPath)) {
				const koffiUrl = url.pathToFileURL(path.join(__dirname, '..', 'node_modules', 'koffi', 'index.js')).href;
				const shimSource = `import koffi from ${JSON.stringify(koffiUrl)};
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
`;
				fs.writeFileSync(shimPath, shimSource, 'utf8');
			}
			const shimUrl = url.pathToFileURL(shimPath).href;
			registerHooks({
				resolve(specifier, context, nextResolve) {
					if (specifier === 'koffi' || specifier.startsWith('koffi/')) {
						return { url: shimUrl, shortCircuit: true };
					}
					return nextResolve(specifier, context);
				}
			});
		}
	} catch {}
}

module.exports = null;
