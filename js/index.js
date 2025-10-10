// index.js — финальная версия: оригинальные анимации + непрерывный режим
document.addEventListener('DOMContentLoaded', () => {
  const micBtn = document.getElementById('micBtn');
  const micIcon = document.getElementById('micIcon');
  const sphere = document.getElementById('sphere');

  const micOnSVG = "icon/mic-mute.svg";
  const micOffSVG = "icon/mic.svg";

  // аудио и анализ
  let audioCtx = null;
  let analyser = null;
  let dataArray = null;
  let source = null;
  let mediaStream = null;

  // запись
  let mediaRecorder = null;
  let chunks = [];

  // состояния
  let listening = false;      // логическое: слушаем ли мы (включен режим)
  let recording = false;      // в данный момент идет запись (MediaRecorder)
  let thinking = false;       // ИИ думает / ждём ответа
  let currentAudio = null;    // объект Audio для TTS
  let silenceTimer = null;    // таймер тишины для авто-стопа записи
  let preventImmediate = 0;   // защита от мгновенных повторных срабатываний

  // настройки (можешь подправить)
  const BASE_SIZE = parseInt(window.getComputedStyle(sphere).width) || 80;
  const QUIET_THRESHOLD = 12;     // порог для avgVolume (Uint8) — тише этого считается паузой
  const QUIET_DURATION = 800;     // мс молчания до остановки записи
  const RECORD_AFTER_PAUSE_MS = 1300; // сколько записывать после паузы (кусок для STT)
  const MIN_STT_CHARS = 1;        // минимальная длина текста, чтобы посылать в ИИ

  // userId
  if (!localStorage.getItem("userId")) {
    localStorage.setItem("userId", crypto.randomUUID());
  }
  const userId = localStorage.getItem("userId");

  // === UI: кнопка микрофона ===
  micBtn.addEventListener('click', async () => {
    if (listening) {
      // выключаем полностью
      await stopAllListening(true);
    } else {
      // включаем режим прослушивания
      await startAllListening();
    }
  });

  // === старт прослушивания: открываем микрофон, запускаем анализатор и старт записи ===
  async function startAllListening() {
    try {
      // если уже есть поток — не запрашиваем повторно
      if (!mediaStream) {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }

      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      // source/analyser
      source = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);

      listening = true;
      micIcon.src = micOnSVG;
      sphere.classList.add('listening');

      // запускаем визуализацию/VAD
      monitorAudio();

      // начинаем запись (MediaRecorder) — держим открытой запись, будем останавливать на паузу
      startRecorder();

      console.log("🎤 Listening started");
    } catch (err) {
      console.error("Ошибка доступа к микрофону:", err);
    }
  }

  // === stop: полностью выключаем микрофон и все таймеры ===
  async function stopAllListening(stopStream = false) {
  // остановим запись если идёт
  stopRecorder();

  // остановим визуализацию (listening=false)
  listening = false;
  sphere.classList.remove('listening');
  micIcon.src = micOffSVG;
  resetSphere();

  // если ИИ говорит — остановим воспроизведение
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }

  // остановить tracks если нужно (при полном выключении)
  if (stopStream && mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }

  console.log("🔇 Listening stopped");
}

  // === Recorder ===
  function startRecorder() {
    if (!mediaStream) return;
    // если уже записываем — ничего не делаем
    if (mediaRecorder && (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused')) return;

    chunks = [];
    // предпочтительный MIME: webm opus — сервер конвертирует
    let mime = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mime)) {
      mime = 'audio/webm';
      if (!MediaRecorder.isTypeSupported(mime)) mime = '';
    }

    try {
      mediaRecorder = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      // fallback
      mediaRecorder = new MediaRecorder(mediaStream);
    }

    mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      recording = false;
      // если нет данных — просто возобновляем слушание
      if (chunks.length === 0) {
        if (!thinking && listening) startRecorder(); // перезапустим запись
        return;
      }

      const blob = new Blob(chunks, { type: chunks[0].type || 'audio/webm' });
      // отправляем blob на сервер STT
      await sendBlobToSTT(blob);
      chunks = [];
    };

    try {
      mediaRecorder.start();
      recording = true;
      // console.log('Recorder started', mediaRecorder.mimeType);
    } catch (err) {
      console.warn('Не удалось стартовать MediaRecorder:', err);
    }
  }

  function stopRecorder() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      try {
        mediaRecorder.stop();
      } catch (e) { /* ignore */ }
    }
    recording = false;
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
  }

// === визуализация и VAD ===
function monitorAudio() {
  if (!listening || !analyser) return;
  requestAnimationFrame(monitorAudio);

  analyser.getByteFrequencyData(dataArray);
  const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

  // 💡 не меняем цвет/размер, если сейчас нейросеть думает
  if (!thinking && (!currentAudio || currentAudio.paused)) {
    const maxSize = BASE_SIZE * 1.5;
    const size = Math.min(maxSize, BASE_SIZE + avg / 2);
    sphere.style.width = size + 'px';
    sphere.style.height = size + 'px';

    const lightness = Math.min(70, 50 + avg / 3);
    sphere.style.backgroundColor = `hsl(120,70%,${lightness}%)`; // зелёная гамма
    sphere.style.boxShadow = `0 0 ${avg / 2}px hsl(120,70%,${lightness}%)`;
  }

  // VAD таймер для остановки записи...
  if (avg < QUIET_THRESHOLD) {
    if (!silenceTimer && recording && !thinking) {
      silenceTimer = setTimeout(() => {
        silenceTimer = null;
        stopRecorder();
      }, QUIET_DURATION);
    }
  } else {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }
}


  // === отправка blob на сервер STT и обработка результата ===
  async function sendBlobToSTT(blob) {
    // защита от спама: не слать слишком часто
    const now = Date.now();
    if (preventImmediate && now < preventImmediate) return;
    preventImmediate = now + 600; // небольшой буфер

    thinking = true;
    showThinkingAnimation();

    const form = new FormData();
    // отправляем webm/ogg — на сервере есть ffmpeg-конвертер
    form.append('audio', blob, 'speech.webm');

    try {
      const res = await fetch('/api/stt', { method: 'POST', body: form });
      const data = await res.json();

      // Yandex возвращает result или text — проверим несколько полей
      const recognized = (data.text || data.result || '').trim();

      if (!recognized) {
        // пустой результат — просто сбросим состояние и снова начнём слушать
        console.log('STT вернул пустой результат, возобновляем прослушивание');
        thinking = false;
        resetSphere();
        // небольшой задержка, чтобы избежать мгновенного повторного срабатывания
        setTimeout(() => {
          if (listening) startRecorder();
        }, 300);
        return;
      }

      console.log('STT распознал:', recognized);
      thinking = false;
      // отправляем распознанный текст в AI
      await sendToAI(recognized);
    } catch (err) {
      console.error('Ошибка STT:', err);
      thinking = false;
      resetSphere();
      // возобновляем запись через короткую задержку
      setTimeout(() => {
        if (listening) startRecorder();
      }, 500);
    }
  }

  // === отправка в AI и воспроизведение TTS ===
  async function sendToAI(userText) {
    // отображаем думание
    thinking = true;
    showThinkingAnimation();

    // отключаем запись/входной звук, чтобы не "слушать" TTS
    // но не полностью закрываем поток — просто делаем tracks.enabled = false
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.enabled = false);
    }

    try {
      const response = await fetch('/api/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, message: userText, voice: 'oksana' })
      });
      const data = await response.json();

      thinking = false;
      // переключаем в визуальный режим "говорит" (твои цвета: салатовый)
      sphere.classList.remove('thinking');
      sphere.style.backgroundColor = 'rgb(26, 255, 144)'; // speaking color from original
      sphere.style.boxShadow = '0 0 25px rgba(26,255,144,0.7)';
      sphere.classList.add('speaking');

      if (data.audio) {
        if (currentAudio) {
          currentAudio.pause();
          currentAudio = null;
        }

        currentAudio = new Audio('data:audio/mp3;base64,' + data.audio);

        // Когда ИИ говорит — мы явно НЕ слушаем (tracks.enabled = false уже выставлено).
        // Воспроизводим:
        try {
          await currentAudio.play();
        } catch (e) {
          // autoplay может блокироваться — всё равно дождёмся события ended
          console.warn('Playback start failed (autoplay?)', e);
        }

        currentAudio.onended = () => {
          // когда ИИ закончил - вернём всё как было и снова начнём слушать
          currentAudio = null;
          resetSphere();
          // включаем tracks обратно
          if (mediaStream) mediaStream.getTracks().forEach(t => t.enabled = true);
          // небольшая пауза и запускаем запись снова
          setTimeout(() => {
            if (listening) startRecorder();
          }, 200);
        };
      } else {
        // нет audio -> просто вернём слушание
        resetSphere();
        if (mediaStream) mediaStream.getTracks().forEach(t => t.enabled = true);
        setTimeout(() => {
          if (listening) startRecorder();
        }, 200);
      }
    } catch (err) {
      console.error('Ошибка sendMessage:', err);
      thinking = false;
      resetSphere();
      if (mediaStream) mediaStream.getTracks().forEach(t => t.enabled = true);
      setTimeout(() => {
        if (listening) startRecorder();
      }, 300);
    }
  }

  // === анимация мышления (как в оригинале: бирюзовый статичный стиль) ===
  function showThinkingAnimation() {
    sphere.classList.add('thinking');
    sphere.style.backgroundColor = 'rgb(5, 229, 203)'; // бирюзовый
    sphere.style.boxShadow = '0 0 25px rgba(5, 229, 203,0.7)';
    // не запускаем бесконечную рекурсию: оставляем стиль — визуализация vd уже работает
  }

  // === сброс к оригинальному виду ===
  function resetSphere() {
    sphere.classList.remove('speaking', 'thinking');
    sphere.style.width = BASE_SIZE + 'px';
    sphere.style.height = BASE_SIZE + 'px';
    sphere.style.backgroundColor = 'rgb(17, 250, 83)'; // оригинальный зелёный
    sphere.style.boxShadow = '0 0 20px rgba(17, 250, 83,0.5)';
  }

  // === загрузка уроков и вкладки (как у тебя было) ===
  // скопируем твою реализацию загрузки уроков (упрощенно), чтобы не ломать UI
  async function loadLessons() {
    try {
      const res = await fetch('backend/lessons.json');
      const lessons = await res.json();
      const container = document.getElementById('lessonsGrid');
      lessons.forEach(lesson => {
        const card = document.createElement('div');
        card.className = 'lesson-card';
        card.dataset.id = lesson.id;
        card.innerHTML = `
          <div class="lesson-header">
            <img src="${lesson.icon}" class="lesson-icon">
            <h2 class="lesson-title">${lesson.title}</h2>
            <button class="lesson-start">▶</button>
          </div>
          <div class="lesson-content">
            <p class="lesson-text">${lesson.text}</p>
            <div class="lesson-images">
              ${lesson.images ? lesson.images.map(img => `<img src="${img}">`).join('') : ''}
            </div>
            ${lesson.type === 'interactive' ? `<div class="lesson-game"></div>` : ''}
            <button class="lesson-pause">⏸</button>
          </div>
        `;
        container.appendChild(card);
        // минимальная логика кнопок — при желании можно вернуть полную реализацию
      });
    } catch (err) {
      console.warn('Не удалось загрузить lessons.json', err);
    }
  }

  // === инициализация вкладок (твоя логика) ===
  const tabs = document.querySelectorAll('.menu .tab');
  const pages = document.querySelectorAll('.page');
  tabs.forEach(tab => {
    tab.addEventListener('click', e => {
      e.preventDefault();
      const targetPage = tab.dataset.page;
      tabs.forEach(t => t.classList.remove('active', 'chat-tab', 'avatars-tab', 'learning-tab'));
      tab.classList.add('active');
      if (targetPage === 'home') tab.classList.add('chat-tab');
      if (targetPage === 'avatars') tab.classList.add('avatars-tab');
      if (targetPage === 'learning') tab.classList.add('learning-tab');
      pages.forEach(page => page.id === targetPage ? page.classList.add('active') : page.classList.remove('active'));
    });
  });

  // старт загрузки уроков
  loadLessons();

  // если страница перекрыта фокусом, убедимся, что аудиоконтекст может быть возобновлён при первом клике пользователя
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  });
});
