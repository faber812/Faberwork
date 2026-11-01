#!/usr/bin/env node
// FABER — тайминги реплик по озвучке.
//
//   node render/cues.js videos/<id>/voice.mp3 videos/<id>/lines.txt [--tail 1.4]
//
// lines.txt — текст озвучки, одна реплика на строку (ровно как в сценарии).
// Скрипт находит паузы в голосе и раскладывает реплики по фрагментам речи так,
// чтобы скорость речи (слогов в секунду) у всех реплик была как можно ровнее.
// Длина паузы не важна — работает, даже когда TTS делает все паузы одинаковыми.
// Результат: videos/<id>/timing.js (window.__CUES__ = { starts, duration }). Сцена подключает его через <script src="timing.js">.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const [file, linesFile, ...rest] = process.argv.slice(2);
if (!file || !linesFile) { console.error("Использование: node render/cues.js voice.mp3 lines.txt [--tail 1.4]"); process.exit(2); }
const tail = rest[0] === "--tail" ? Number(rest[1]) : 1.4;

const lines = fs.readFileSync(linesFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const syl = lines.map((l) => Math.max(1, (l.match(/[аеёиоуыэюяaeiouy]/gi) || []).length));
const K = lines.length;

const len = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).stdout.toString());
const log = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "silencedetect=n=-38dB:d=0.18", "-f", "null", "-"]).stderr.toString();

// Фрагменты речи между паузами
const sil = [];
let s0 = null;
for (const line of log.split("\n")) {
  const a = line.match(/silence_start: (-?[\d.]+)/), b = line.match(/silence_end: ([\d.]+)/);
  if (a) s0 = Math.max(0, Number(a[1]));
  if (b && s0 !== null) { sil.push([s0, Number(b[1])]); s0 = null; }
}
if (s0 !== null) sil.push([s0, len]);
const segs = [];
let t = 0;
for (const [a, b] of sil) { if (a - t > 0.05) segs.push([t, a]); t = b; }
if (len - t > 0.05) segs.push([t, len]);
const n = segs.length;
if (n < K) { console.error(`Фрагментов речи ${n}, реплик ${K}: озвучка не разбивается на реплики.`); process.exit(1); }

// Разбиение n фрагментов на K реплик с минимальным разбросом скорости речи (динамика)
const cum = [0];
segs.forEach(([a, b]) => cum.push(cum[cum.length - 1] + (b - a)));
const R = syl.reduce((x, y) => x + y, 0) / cum[n];
const cost = (k, i, j) => Math.log(((cum[j] - cum[i]) * R) / syl[k]) ** 2;
const D = Array.from({ length: K + 1 }, () => Array(n + 1).fill(Infinity));
const P = Array.from({ length: K + 1 }, () => Array(n + 1).fill(-1));
D[0][0] = 0;
for (let k = 1; k <= K; k++)
  for (let j = k; j <= n - (K - k); j++)
    for (let i = k - 1; i < j; i++) {
      const c = D[k - 1][i] + cost(k - 1, i, j);
      if (c < D[k][j]) { D[k][j] = c; P[k][j] = i; }
    }
const idx = [n];
for (let k = K; k > 0; k--) idx.unshift(P[k][idx[0]]);

const starts = idx.slice(0, K).map((i, k) => Number(Math.max(0, segs[i][0] - (k ? 0.08 : 0)).toFixed(2)));
const out = { starts, duration: Number((len + tail).toFixed(2)), voiceLength: Number(len.toFixed(2)) };
// timing.js подключается сценой обычным <script>, поэтому работает и при рендере, и при открытии файла в браузере
fs.writeFileSync(path.join(path.dirname(path.resolve(file)), "timing.js"),
  "// Сгенерировано render/cues.js — не редактировать вручную\nwindow.__CUES__ = " + JSON.stringify(out, null, 2) + ";\n");

console.log(`Озвучка ${len.toFixed(2)} с → ролик ${out.duration} с. Фрагментов речи: ${n}`);
lines.forEach((l, k) => {
  const a = segs[idx[k]][0], b = segs[idx[k + 1] - 1][1];
  const rate = syl[k] / (cum[idx[k + 1]] - cum[idx[k]]);
  console.log(`  ${String(k + 1).padStart(2)}. ${a.toFixed(2)}–${b.toFixed(2)} с  ${rate.toFixed(1)} слог/с  ${l.slice(0, 48)}`);
});
console.log("Если скорость какой-то реплики сильно отличается от остальных — проверьте разбивку на слух.");
