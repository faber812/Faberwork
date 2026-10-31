# Faberwork

Производство коротких вертикальных видео FABER WORK для TikTok: сцена HTML/SVG → покадровый рендер в Chromium (Playwright) → MP4 через FFmpeg.

## Структура

| Путь | Что там |
|---|---|
| `CLAUDE.md` | Инструкции для Claude: стратегия, правила хука, достоверность, формат сценария |
| `facts/faber-offer.md` | Что FABER реально делает для кандидата. Единственный источник для обещаний в роликах |
| `docs/style.md` | Визуальный стиль: палитра, шрифты, композиция, безопасные зоны TikTok, громкость |
| `content/registry.md` | Реестр роликов и метрики публикаций |
| `styles/faber.css` | Стиль сцен (цвета, шрифты, плашки, субтитры) |
| `render/faber.js` | Помощники для сцен: появление, субтитры, счётчики |
| `render/render.js` | Рендер и автопроверки |
| `videos/<id>/scene.html` | Сцена одного ролика (+ сценарий и озвучка рядом) |
| `assets/fonts` | Шрифты Inter и DejaVu Sans Mono (свободные лицензии) |

## Как сделать ролик

1. Сценарий по шаблону из `CLAUDE.md` → `videos/<id>/script.md`.
2. Сцена → `videos/<id>/scene.html` (образец: `videos/000_test/scene.html`). Длительность — в `<meta name="duration">`.
3. Озвучка → `videos/<id>/voice.mp3`.
4. Рендер:

```bash
npm install          # один раз
npx playwright install chromium   # один раз, если Chromium ещё не установлен
node render/render.js videos/<id>/scene.html --voice videos/<id>/voice.mp3 [--music music.mp3]
```

Результат: `out/<id>.mp4`, отчёт `out/<id>.report.json`, раскадровка `out/<id>.sheet.jpg`, последний кадр `out/<id>.last.png`.

Предпросмотр без рендера: открыть `scene.html` в браузере.

## Что проверяет рендер

- 1080×1920, 30 FPS, H.264 yuv420p + AAC 48 кГц;
- длительность совпадает со сценой;
- громкость −14 LUFS (звук нормализуется автоматически), пик ≤ −1.5 dBTP;
- каждые 0,5 с: текст за краем кадра, текст в зонах интерфейса TikTok, текст, обрезанный блоком.

Если есть проблемы — они печатаются в конце, команда завершается с кодом 1.
