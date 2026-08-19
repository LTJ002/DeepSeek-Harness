// 用 web 端官方 favicon.svg（DeepSeek 鲸鱼）生成桌面应用图标
const fs = require('fs');
const path = require('path');
const sharp = require(path.join(__dirname, '..', 'harness', 'node_modules', 'sharp'));

const sourceCandidates = [
  path.join(__dirname, '..', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'favicon.svg'),
  path.join(__dirname, '..', 'harness', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'favicon.svg')
];
const source = sourceCandidates.find((p) => fs.existsSync(p));
if (!source) throw new Error('official favicon.svg not found');
let svg = fs.readFileSync(source, 'utf8');

// 与官方 favicon 一致的黑白样式：白底 + 黑鲸鱼
svg = svg.replace(/<style>[\s\S]*?<\/style>/, '');
svg = svg.replace(/fill="#000"/, 'fill="#000000"');

const size = 1024;
const scale = 768 / 50; // 原 viewBox 50，占画面 768px
const pad = (size - 50 * scale) / 2;
const full = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <clipPath id="round"><rect width="${size}" height="${size}" rx="230" ry="230"/></clipPath>
  </defs>
  <g clip-path="url(#round)">
    <rect width="${size}" height="${size}" fill="#ffffff"/>
    <g transform="translate(${pad},${pad}) scale(${scale})">${svg}</g>
  </g>
</svg>`;

const out = path.join(__dirname, 'icon.png');
sharp(Buffer.from(full)).png().toFile(out).then((info) => {
  console.log('wrote', out, info.width + 'x' + info.height);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
