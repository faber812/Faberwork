#!/usr/bin/env node
// FABER — рендер сцены HTML в MP4 1080×1920, 30 FPS, H.264 + AAC.
//
//   node render/render.js videos/<id>/scene.html [--voice voice.mp3] [--music music.mp3] [--out out/<id>.mp4]
//
// Длительность берётся из <meta name="duration" content="..."> сцены.
// Во время рендера проверяется каждые 0,5 с: текст за краем кадра, текст в зонах интерфейса TikTok,
// переполнение блоков. После кодирования проверяются размер, FPS, кодеки, длительность и громкость.
// Отчёт: out/<id>.report.json, раскадровка: out/<id>.sheet.jpg.

const { chromium } = require("playwright");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const W = 1080, H = 1920, FPS = 30;
const SAFE = { top: 120, bottom: 420, right: 140, rightFromY: 600 }; // см. docs/style.md
const LUFS = -14;

function args() {
  const a = process.argv.slice(2);
  if (!a[0] || a[0].startsWith("--")) {
    console.error("Использование: node render/render.js videos/<id>/scene.html [--voice f] [--music f] [--out f]");
    process.exit(2);
  }
  const o = { scene: path.resolve(a[0]) };
  for (let i = 1; i < a.length; i += 2) o[a[i].replace(/^--/, "")] = a[i + 1];
  const id = path.basename(path.dirname(o.scene));
  o.out = path.resolve(o.out || path.join(__dirname, "..", "out", `${id}.mp4`));
  // voice.mp3 рядом со сценой подхватывается автоматически
  const auto = path.join(path.dirname(o.scene), "voice.mp3");
  if (!o.voice && fs.existsSync(auto)) o.voice = auto;
  for (const k of ["voice", "music"]) if (o[k]) o[k] = path.resolve(o[k]);
  return o;
}

// Ищет текст за краем кадра, в зонах интерфейса TikTok и переполненные блоки.
function layoutCheck(S) {
  const W = 1080, H = 1920, out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent.trim();
    const el = n.parentElement;
    if (!text || !el || el.closest("[data-safe-ignore]")) continue;
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const r = document.createRange(); r.selectNodeContents(n);
    for (const b of r.getClientRects()) {
      if (b.width < 1 || b.height < 1) continue;
      const where = [];
      if (b.left < -0.5 || b.top < -0.5 || b.right > W + 0.5 || b.bottom > H + 0.5) where.push("за краем кадра");
      else {
        if (b.top < S.top) where.push("зона вкладок TikTok сверху");
        if (b.bottom > H - S.bottom) where.push("зона подписи TikTok снизу");
        if (b.right > W - S.right && b.bottom > S.rightFromY) where.push("зона кнопок TikTok справа");
      }
      if (where.length) out.push({ text: text.slice(0, 40), problem: where.join(", "), box: [b.left, b.top, b.right, b.bottom].map(Math.round) });
    }
  }
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest("[data-safe-ignore]") || !el.textContent.trim()) continue;
    // Рамка/плашка элемента с текстом за краем кадра
    if (el.children.length === 0 && el.checkVisibility({ opacityProperty: true })) {
      const b = el.getBoundingClientRect();
      if (b.width > 1 && (b.left < -0.5 || b.top < -0.5 || b.right > W + 0.5 || b.bottom > H + 0.5))
        out.push({ text: el.textContent.trim().slice(0, 40), problem: "плашка/рамка за краем кадра", box: [b.left, b.top, b.right, b.bottom].map(Math.round) });
    }
    const cs = getComputedStyle(el);
    if ((cs.overflow === "hidden" || cs.overflowX === "hidden") && el.scrollWidth > el.clientWidth + 1 &&
        el.checkVisibility({ opacityProperty: true }))
      out.push({ text: el.textContent.trim().slice(0, 40), problem: "текст не помещается в блок (обрезан)" });
  }
  return out;
}

function ffprobe(file) {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries",
    "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt", "-of", "json", file]).toString());
}

function loudness(file) {
  const r = require("child_process").spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const s = r.stderr.toString().split("Summary:").pop();
  const I = s.match(/I:\s+(-?[\d.]+) LUFS/), P = s.match(/Peak:\s+(-?[\d.]+|-inf) dBFS/);
  return { lufs: I ? Number(I[1]) : null, truePeak: P ? Number(P[1]) : null };
}

(async () => {
  const o = args();
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  const base = o.out.replace(/\.mp4$/, "");
  const silentVideo = `${base}.video.mp4`;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.addInitScript(() => { window.__RENDER__ = true; });
  page.on("pageerror", (e) => { console.error("Ошибка в сцене:", e.message); process.exitCode = 1; });
  await page.goto("file://" + o.scene);
  await page.evaluate(() => document.fonts.ready);
  const duration = await page.evaluate(() => Number(document.querySelector('meta[name="duration"]')?.content));
  if (!duration) throw new Error('В сцене нет <meta name="duration" content="секунды">');
  const hasSeek = await page.evaluate(() => typeof window.__seek === "function");
  if (!hasSeek) throw new Error("Сцена не подключила render/faber.js");

  const frames = Math.round(duration * FPS);
  console.log(`Рендер ${path.relative(process.cwd(), o.scene)}: ${duration} с, ${frames} кадров`);

  const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-c:v", "png", "-framerate", String(FPS), "-i", "-",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(FPS), silentVideo],
    { stdio: ["pipe", "inherit", "inherit"] });
  const ffDone = new Promise((res, rej) => ff.on("close", (c) => (c === 0 ? res() : rej(new Error("ffmpeg: код " + c)))));

  const issues = new Map();
  for (let i = 0; i < frames; i++) {
    const t = i / FPS;
    await page.evaluate((t) => window.__seek(t), t);
    if (i % (FPS / 2) === 0 || i === frames - 1) {
      for (const p of await page.evaluate(layoutCheck, SAFE)) {
        const k = p.text + "|" + p.problem;
        if (!issues.has(k)) issues.set(k, { ...p, time: Number(t.toFixed(2)) });
      }
    }
    const buf = await page.screenshot({ type: "png" });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if (i % 150 === 0) process.stdout.write(`  ${Math.round((i / frames) * 100)}%\r`);
  }
  ff.stdin.end();
  await ffDone;
  await browser.close();

  // Звук: голос + музыка (на 20 dB тише), нормализация до -14 LUFS. Без звука — тихая дорожка.
  const inputs = ["-i", silentVideo];
  let filter;
  if (o.voice || o.music) {
    const parts = [], labels = [];
    let idx = 1;
    if (o.voice) { inputs.push("-i", o.voice); parts.push(`[${idx}:a]aresample=48000,acompressor=threshold=-22dB:ratio=3:attack=5:release=120:makeup=2,apad[v]`); labels.push("[v]"); idx++; }
    if (o.music) { inputs.push("-stream_loop", "-1", "-i", o.music); parts.push(`[${idx}:a]aresample=48000,volume=${o.voice ? "-20dB" : "0dB"}[m]`); labels.push("[m]"); }
    const mix = labels.length > 1 ? `${labels.join("")}amix=inputs=2:duration=first:normalize=0[mx];[mx]` : `${labels[0]}`;
    const pre = `${parts.join(";")};${mix}atrim=0:${duration}`;
    // Проход 1: замер громкости. Проход 2: точная нормализация по замеру.
    const r1 = require("child_process").spawnSync("ffmpeg", ["-hide_banner", "-nostats", ...inputs.slice(2), "-filter_complex",
      pre.replace(/\[(\d+):a\]/g, (m, d) => `[${Number(d) - 1}:a]`) + `,loudnorm=I=${LUFS}:TP=-1.5:LRA=11:print_format=json`, "-f", "null", "-"]);
    const m = JSON.parse(r1.stderr.toString().match(/\{[^{}]*"input_i"[^{}]*\}/)[0]);
    const ln = `loudnorm=I=${LUFS}:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
    filter = `${pre},${ln},afade=t=out:st=${Math.max(0, duration - 0.3)}:d=0.3[a]`;
  } else {
    inputs.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
    filter = `[1:a]atrim=0:${duration}[a]`;
  }
  execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "0:v", "-map", "[a]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", String(duration), "-movflags", "+faststart", o.out]);
  fs.unlinkSync(silentVideo);

  // Проверка файла
  const p = ffprobe(o.out);
  const v = p.streams.find((s) => s.codec_type === "video"), a = p.streams.find((s) => s.codec_type === "audio");
  const real = Number(p.format.duration);
  const fail = [];
  if (!v || v.width !== W || v.height !== H) fail.push(`размер ${v && v.width}×${v && v.height}, нужен ${W}×${H}`);
  if (!v || v.r_frame_rate !== `${FPS}/1`) fail.push(`FPS ${v && v.r_frame_rate}`);
  if (!v || v.codec_name !== "h264" || v.pix_fmt !== "yuv420p") fail.push("видео не H.264/yuv420p");
  if (!a || a.codec_name !== "aac") fail.push("нет AAC-дорожки");
  if (Math.abs(real - duration) > 0.1) fail.push(`длительность ${real.toFixed(2)} с вместо ${duration}`);
  const loud = o.voice || o.music ? loudness(o.out) : { lufs: null, truePeak: null, note: "без звука" };
  if (loud.lufs !== null && Math.abs(loud.lufs - LUFS) > 1.5) fail.push(`громкость ${loud.lufs} LUFS, цель ${LUFS}`);
  const warn = [];
  if (o.voice) {
    const vl = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", o.voice]).toString());
    if (vl > duration + 0.05) fail.push(`озвучка ${vl.toFixed(2)} с длиннее ролика ${duration} с — голос обрезан (нет timing.js?)`);
  }
  if (duration < 20 || duration > 40) warn.push(`длительность ${duration} с вне ориентира 25–35 с`);

  // Раскадровка 12 кадров + последний кадр
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", o.out, "-vf", `fps=12/${duration},scale=270:-2,tile=6x2`, "-frames:v", "1", `${base}.sheet.jpg`]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-sseof", "-0.05", "-i", o.out, "-frames:v", "1", "-update", "1", `${base}.last.png`]);

  const report = { file: path.basename(o.out), duration: real, video: v, audio: a, loudness: loud, layoutIssues: [...issues.values()], fileIssues: fail, warnings: warn };
  fs.writeFileSync(`${base}.report.json`, JSON.stringify(report, null, 2));

  console.log(`\nГотово: ${path.relative(process.cwd(), o.out)} (${real.toFixed(2)} с)`);
  if (loud.lufs !== null) console.log(`Громкость: ${loud.lufs} LUFS, пик ${loud.truePeak} dBTP`);
  const all = [...report.layoutIssues.map((i) => `[${i.time} с] «${i.text}»: ${i.problem}`), ...fail];
  warn.forEach((w) => console.log("Предупреждение: " + w));
  if (all.length) { console.log("\nПРОБЛЕМЫ:"); all.forEach((x) => console.log("  - " + x)); process.exitCode = 1; }
  else console.log("Проверки пройдены.");
})().catch((e) => { console.error(e.message); process.exit(1); });
