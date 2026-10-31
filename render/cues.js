#!/usr/bin/env node
// FABER — тайминги реплик по паузам в озвучке.
//
//   node render/cues.js videos/<id>/voice.mp3 <число_реплик> [--tail 1.6]
//
// Находит паузы, берёт (N−1) самых длинных как границы реплик и пишет videos/<id>/cues.json:
//   { "starts": [начало реплики 1, 2, ...], "duration": длина ролика }
// Сцена читает cues.json и подстраивает анимации и субтитры под голос.
// Озвучку генерировать с пустой строкой между репликами — так паузы между ними длиннее, чем внутри.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const [file, nArg, ...rest] = process.argv.slice(2);
if (!file || !nArg) { console.error("Использование: node render/cues.js voice.mp3 <число_реплик> [--tail 1.6]"); process.exit(2); }
const N = Number(nArg);
const tail = rest[0] === "--tail" ? Number(rest[1]) : 1.6;

const len = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).stdout.toString());
const log = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "silencedetect=n=-38dB:d=0.18", "-f", "null", "-"]).stderr.toString();

const sil = [];
let s = null;
for (const line of log.split("\n")) {
  const a = line.match(/silence_start: (-?[\d.]+)/), b = line.match(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/);
  if (a) s = Math.max(0, Number(a[1]));
  if (b && s !== null) { sil.push({ start: s, end: Number(b[1]), d: Number(b[2]) }); s = null; }
}

const first = sil.length && sil[0].start < 0.05 ? sil.shift().end : 0;          // тишина в начале файла
const inner = sil.filter((x) => x.end < len - 0.05);                            // без тишины в конце
if (inner.length < N - 1) { console.error(`Нашлось ${inner.length} пауз, нужно ${N - 1}. Проверьте число реплик или паузы в озвучке.`); process.exit(1); }

const cuts = inner.slice().sort((a, b) => b.d - a.d).slice(0, N - 1).sort((a, b) => a.start - b.start);
const starts = [first, ...cuts.map((c) => Math.max(0, c.end - 0.08))].map((x) => Number(x.toFixed(2)));
const out = { starts, duration: Number((len + tail).toFixed(2)), voiceLength: Number(len.toFixed(2)) };

const dst = path.join(path.dirname(path.resolve(file)), "cues.json");
fs.writeFileSync(dst, JSON.stringify(out, null, 2) + "\n");
console.log(`Озвучка ${len.toFixed(2)} с → ролик ${out.duration} с`);
starts.forEach((t, i) => console.log(`  реплика ${i + 1}: ${t.toFixed(2)} с` + (i ? `  (пауза ${cuts[i - 1].d.toFixed(2)} с)` : "")));
console.log("Записано: " + path.relative(process.cwd(), dst));
