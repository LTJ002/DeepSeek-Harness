#!/usr/bin/env node
// apply-no-console-patch.mjs
// 为 dsh-desktop 源码生成与部署版（E:\DeepSeekHarness）逐字节一致的 no-console 补丁产物。
// 部署版 = 源码 + 本脚本注入的补丁；补丁块模板从部署版 main.js 提取（sync 脚本维护缓存文件）。
//
// 用法:
//   node apply-no-console-patch.mjs main    <in-main.js> <patch.cjs> <template-block.txt> <out-main.js>
//   node apply-no-console-patch.mjs bin     <in-bin.js> <out-bin.js>
//   node apply-no-console-patch.mjs plugin  <in-plugin.js> <out-plugin.js>
//   node apply-no-console-patch.mjs extract <patched-main.js> <out-block.txt>
import { readFileSync, writeFileSync } from "node:fs";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const read = (p) => readFileSync(p, "utf8").replace(/^\uFEFF/, "");
const write = (p, s, withBom) => {
  const body = Buffer.from(s, "utf8");
  writeFileSync(p, withBom ? Buffer.concat([BOM, body]) : body);
};

function extractPatchBlock(templateText) {
  const marker = "// ---------- no-console-patch 自愈 ----------";
  const si = templateText.indexOf(marker);
  if (si < 0) throw new Error("template: patch marker not found");
  const fnIdx = templateText.indexOf("function ensureNoConsolePatch() {");
  if (fnIdx < 0) throw new Error("template: ensureNoConsolePatch not found");
  let depth = 0;
  let end = -1;
  for (let i = fnIdx; i < templateText.length; i++) {
    const c = templateText[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error("template: patch block end not found");
  return templateText.slice(si, end + 1);
}

function b64Line(patchCjs) {
  return `const NO_CONSOLE_PATCH_B64 = '${Buffer.from(patchCjs, "utf8").toString("base64")}';`;
}

function patchMain(inPath, patchCjsPath, templatePath, outPath) {
  const src = read(inPath);
  const patchCjs = read(patchCjsPath);
  const template = read(templatePath);
  const block = extractPatchBlock(template).replace(
    /const NO_CONSOLE_PATCH_B64 = '[^']*';/,
    () => b64Line(patchCjs)
  );
  const errors = [];
  const need = (needle, count = 1) => {
    const n = src.split(needle).length - 1;
    if (n !== count) errors.push(`anchor '${needle.slice(0, 70)}' count=${n} want=${count}`);
  };
  let out;
  if (src.includes("function ensureNoConsolePatch() {")) {
    need("const NO_CONSOLE_PATCH_B64 = '");
    const newB64Line = b64Line(patchCjs);
    const m = src.match(/const NO_CONSOLE_PATCH_B64 = '[^']+';/);
    if (m && m[0] !== newB64Line) {
      out = src.replace(/const NO_CONSOLE_PATCH_B64 = '[^']+';/, () => newB64Line);
    } else {
      out = src; // B64 已是最新
    }
  } else {
    need("function runtimeDir() {");
    need("const harnessEnv = Object.assign({}, process.env, { NODE_COMPILE_CACHE: compileCacheDir });");
    need([
      "  return hasSystemPnpm",
      "    ? { ...process.env }",
      "    : { ...process.env, PATH: runtimeDir() + path.delimiter + (process.env.PATH || '') };",
    ].join("\n"));
    need("app.whenReady().then(async () => {");
    out = src
      .replace("function runtimeDir() {", block + "\nfunction runtimeDir() {")
      .replace(
        "const harnessEnv = Object.assign({}, process.env, { NODE_COMPILE_CACHE: compileCacheDir });",
        [
          "const noConsolePreload = path.join(harnessDir(), 'lib', 'no-console-patch.cjs');",
          "      const harnessEnv = Object.assign({}, process.env, {",
          "        NODE_COMPILE_CACHE: compileCacheDir,",
          "        ...(fs.existsSync(noConsolePreload) && !/\\s/.test(noConsolePreload)",
          "          ? { NODE_OPTIONS: '--require=' + noConsolePreload } : {})",
          "      });",
        ].join("\n")
      )
      .replace(
        [
          "  return hasSystemPnpm",
          "    ? { ...process.env }",
          "    : { ...process.env, PATH: runtimeDir() + path.delimiter + (process.env.PATH || '') };",
        ].join("\n"),
        [
          "  const env = hasSystemPnpm",
          "    ? { ...process.env }",
          "    : { ...process.env, PATH: runtimeDir() + path.delimiter + (process.env.PATH || '') };",
          "  const noConsolePreload = path.join(harnessDir(), 'lib', 'no-console-patch.cjs');",
          "  if (fs.existsSync(noConsolePreload) && !/\\s/.test(noConsolePreload)) {",
          "    env.NODE_OPTIONS = [env.NODE_OPTIONS, '--require=' + noConsolePreload].filter(Boolean).join(' ');",
          "  }",
          "  return env;",
        ].join("\n")
      )
      .replace(
        "app.whenReady().then(async () => {",
        [
          "app.whenReady().then(async () => {",
          "  // no-console-patch self-heal: restore patch after kernel/plugin updates",
          "  try { ensureNoConsolePatch(); } catch (err) { appendLog('no-console-patch ensure: ' + (err && err.message || err) + '\\n'); }",
        ].join("\n")
      );
  }
  if (errors.length) throw new Error("main.js patch failed: " + errors.join(" | "));
  write(outPath, out, true); // 部署版 main.js 带 BOM
}

function patchBin(inPath, outPath) {
  const src = read(inPath);
  const toCrlf = (s) => s.replace(/\r?\n/g, "\r\n");
  if (src.includes("no-console-patch")) {
    write(outPath, toCrlf(src), true);
    return;
  }
  const replaced = src.replace(
    /^#!\/usr\/bin\/env node(\r?\n)/,
    '#!\/usr\/bin\/env node$1import "./no-console-patch.cjs";$1'
  );
  if (replaced === src) throw new Error("bin.js: shebang anchor not found");
  write(outPath, toCrlf(replaced), true); // 部署版 bin.js 为 CRLF+BOM
}

function patchPlugin(inPath, outPath) {
  const src = read(inPath);
  if (!src.includes("windowsHide: true")) {
    write(outPath, src, false);
    return;
  }
  const replaced = src.replace(
    /shell: process\.platform === "win32",\r?\n\t\twindowsHide: true/,
    'shell: process.platform === "win32"'
  );
  if (replaced === src) throw new Error("plugin.js: windowsHide anchor not found");
  write(outPath, replaced, false);
}

function extractBlock(inPatchedMain, outPath) {
  const t = read(inPatchedMain);
  const marker = "// ---------- no-console-patch 自愈 ----------";
  const si = t.indexOf(marker);
  if (si < 0) throw new Error("extract: patch marker not found in " + inPatchedMain);
  const fnIdx = t.indexOf("function ensureNoConsolePatch() {");
  if (fnIdx < 0) throw new Error("extract: ensureNoConsolePatch not found in " + inPatchedMain);
  let depth = 0;
  let end = -1;
  for (let i = fnIdx; i < t.length; i++) {
    const c = t[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error("extract: patch block end not found");
  const block = t.slice(si, end + 1).replace(
    /const NO_CONSOLE_PATCH_B64 = '[^']+';/,
    "const NO_CONSOLE_PATCH_B64 = '__B64__';"
  );
  write(outPath, block, false);
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "main": patchMain(args[0], args[1], args[2], args[3]); break;
  case "bin": patchBin(args[0], args[1]); break;
  case "plugin": patchPlugin(args[0], args[1]); break;
  case "extract": extractBlock(args[0], args[1]); break;
  default: throw new Error("unknown cmd: " + cmd);
}
console.log("apply-no-console-patch: " + cmd + " OK");
