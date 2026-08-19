// 从官方图标 PNG 生成多尺寸 ICO（NSIS/Windows 兼容）
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require(path.join(__dirname, '..', 'harness', 'node_modules', 'sharp'));
let pngToIco = require(path.join(__dirname, '..', 'node_modules', 'png-to-ico'));
if (pngToIco && pngToIco.default) pngToIco = pngToIco.default;

(async () => {
  const src = path.join(__dirname, 'icon.png');
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ico-'));
  const files = [];
  for (const size of sizes) {
    const file = path.join(tmpDir, `${size}.png`);
    await sharp(src).resize(size, size).png().toFile(file);
    files.push(file);
  }
  const buf = await pngToIco(files);
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), buf);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('wrote icon.ico', buf.length, 'bytes with sizes', sizes.join(','));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
