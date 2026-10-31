// FABER — помощники для сцен. Подключение в scene.html:
//   <script src="../../render/faber.js"></script>
// Все анимации создаются через Web Animations API и перематываются рендером покадрово,
// поэтому результат одинаковый при каждом рендере.

(function () {
  const F = {};
  const D = () => Number(document.querySelector('meta[name="duration"]').content);

  const ENTER = {
    fade: [{ opacity: 0 }, { opacity: 1 }],
    up: [{ opacity: 0, transform: "translateY(40px)" }, { opacity: 1, transform: "translateY(0)" }],
    pop: [{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "scale(1.08)", offset: 0.7 }, { opacity: 1, transform: "scale(1)" }],
    stamp: [{ opacity: 0, transform: "scale(2.2) rotate(-8deg)" }, { opacity: 1, transform: "scale(1) rotate(-8deg)" }],
  };

  // Показать элемент с start до end (секунды). enter — тип появления, dur — длительность появления.
  F.show = function (el, start, end = D(), { enter = "fade", dur = 0.25, exit = 0.15 } = {}) {
    if (typeof el === "string") el = document.querySelector(el);
    el.style.opacity = 0;
    el.animate(ENTER[enter], { delay: start * 1000, duration: dur * 1000, fill: "both", easing: "cubic-bezier(.2,.8,.2,1)" });
    if (end < D()) {
      el.animate([{ opacity: 1 }, { opacity: 0 }], { delay: end * 1000, duration: exit * 1000, fill: "forwards", composite: "replace" });
    }
    return el;
  };

  // Субтитры: [[start, end, "текст с <b>выделением</b>"], ...]
  F.subs = function (list, parent = document.body) {
    list.forEach(([s, e, html]) => {
      const el = document.createElement("div");
      el.className = "sub";
      el.innerHTML = html;
      parent.appendChild(el);
      F.show(el, s, e, { enter: "up", dur: 0.18, exit: 0.08 });
    });
  };

  // Счётчик числа от a до b за время [start, end]. format — функция форматирования.
  F.counter = function (el, a, b, start, end, format = (v) => Math.round(v).toLocaleString("ru-RU")) {
    if (typeof el === "string") el = document.querySelector(el);
    F._hooks.push((t) => {
      const k = Math.min(1, Math.max(0, (t - start) / (end - start)));
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = format(a + (b - a) * e);
    });
  };

  // Произвольная функция от времени: F.onTime(t => {...})
  F._hooks = [];
  F.onTime = (fn) => F._hooks.push(fn);

  // Вызывается рендером на каждом кадре.
  window.__seek = function (t) {
    document.getAnimations().forEach((a) => { a.pause(); a.currentTime = t * 1000; });
    F._hooks.forEach((fn) => fn(t));
  };

  // Предпросмотр в обычном браузере: открыть scene.html — сцена проигрывается в реальном времени.
  window.addEventListener("load", () => {
    if (window.__RENDER__) return;
    const t0 = performance.now();
    const tick = () => { const t = (performance.now() - t0) / 1000; F._hooks.forEach((fn) => fn(t % D())); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });

  window.F = F;
})();
