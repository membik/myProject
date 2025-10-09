document.addEventListener('DOMContentLoaded', () => {
  const micBtn = document.getElementById('micBtn');
  const micIcon = document.getElementById('micIcon');
  const sphere = document.getElementById('sphere');

  const micOnSVG = "icon/mic-mute.svg";
  const micOffSVG = "icon/mic.svg";

  // Audio / visualizer
  let audioCtx = null;
  let analyser = null;
  let dataArray = null;
  let source = null;
  let mediaStream = null;
  let streamInitialized = false;

  // Recognition
  let recognition = null;
  let recognitionRunning = false;

  let listening = false;               // UI state: микрофон активен
  let baseSize = parseInt(window.getComputedStyle(sphere).width);

  // Device / UA heuristics
  const ua = navigator.userAgent || "";
  const isMobile = /iPhone|iPad|iPod|Android/i.test(ua);
  // heuristics for problematic embedded browsers/webviews
  const isTelegramWebView = /Telegram/i.test(ua);
  const isYandexBrowser = /YaApp|YaBrowser|Yandex/i.test(ua);
  const isProblematicWebView = isTelegramWebView || isYandexBrowser || /wv|WebView/i.test(ua);

  // Abort + audio states
  let currentAudio = null;
  let currentAbortController = null;
  let thinking = false;

  // Watchdog
  let recognitionWatchdog = null;
  const RECOGNITION_TIMEOUT = 8000; // ms — если распознавание "зависло", принудительно сбрасываем

  // Генерация уникального ID пользователя (как было)
  if (!localStorage.getItem("userId")) {
    const newUserId = crypto.randomUUID();
    localStorage.setItem("userId", newUserId);
    console.log("Создан новый userId:", newUserId);
  }
  const userId = localStorage.getItem("userId");

  // Создаём объект распознавания речи один раз
  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.lang = 'ru-RU';
    recognition.interimResults = false;
    recognition.continuous = false; // мы хотим короткие сессии
  } else {
    // Если нет поддержки — предупредим, но оставим визуализацию (если доступна)
    console.warn("Ваш браузер не поддерживает Web Speech API (SpeechRecognition).");
  }

  // Инициализация visualizer (getUserMedia + AudioContext) — вызывается 1 раз.
  async function initVisualizer() {
    if (streamInitialized) return true;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      source = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);

      streamInitialized = true;
      return true;
    } catch (err) {
      console.error("initVisualizer: ошибка доступа к микрофону:", err);
      return false;
    }
  }

  // Остановить visualizer (не уничтожаем recognition)
  function stopVisualizer() {
    try {
      if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
      }
    } catch (e) { /* ignore */ }
    mediaStream = null;
    source = null;
    analyser = null;
    dataArray = null;
    audioCtx = null;
    streamInitialized = false;
  }

  // Визуализация звука шарика
  function visualizeAudio() {
    if (!listening || !analyser || !dataArray) return;
    requestAnimationFrame(visualizeAudio);

    analyser.getByteFrequencyData(dataArray);
    const avgVolume = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

    const maxSize = baseSize * (isMobile ? 1.8 : 1.5);
    // чуть усилить чувствительность для мобильных/тихих микрофонов
    const sensitivity = isMobile ? 2.5 : 1.5;
    const size = Math.min(maxSize, baseSize + avgVolume * sensitivity / 8);
    sphere.style.width = size + 'px';
    sphere.style.height = size + 'px';

    const lightness = Math.min(70, 45 + avgVolume * sensitivity / 20);
    sphere.style.backgroundColor = `hsl(120,70%,${lightness}%)`;
    sphere.style.boxShadow = `0 0 ${Math.max(6, avgVolume * sensitivity / 6)}px hsl(120,70%,${lightness}%)`;
  }

  function resetSphere() {
    sphere.style.width = baseSize + 'px';
    sphere.style.height = baseSize + 'px';
    sphere.style.backgroundColor = 'rgb(17, 250, 83)';
    sphere.style.boxShadow = '0 0 20px rgba(17, 250, 83,0.5)';
    sphere.classList.remove('speaking', 'thinking');
  }

  function showThinkingAnimation() {
    if (!thinking) return;
    sphere.classList.add('thinking');
    sphere.style.backgroundColor = 'rgb(5, 229, 203)';
    sphere.style.boxShadow = '0 0 25px rgba(5, 229, 203,0.7)';
    // не рекурсивно запускаем showThinkingAnimation — визуализация продолжается через CSS класс
  }

  // Watchdog: если нет результата/конца речи — принудительно останавливаем распознавание и visualizer
  function startRecognitionWatchdog() {
    clearRecognitionWatchdog();
    recognitionWatchdog = setTimeout(() => {
      console.warn("Recognition watchdog triggered — принудительная остановка (возможно зависание).");
      // остановим распознавание и visualizer, чтобы вернуть систему в норму
      try {
        if (recognition && recognitionRunning) recognition.stop();
      } catch (e) { /* ignore */ }
      recognitionRunning = false;
      stopVisualizer();
      listening = false;
      micIcon.src = micOffSVG;
      resetSphere();
    }, RECOGNITION_TIMEOUT);
  }

  function clearRecognitionWatchdog() {
    if (recognitionWatchdog) {
      clearTimeout(recognitionWatchdog);
      recognitionWatchdog = null;
    }
  }

  // main mic button handler
  micBtn.addEventListener('click', async () => {
    // если сейчас активно - выключаем
    if (listening) {
      // остановим распознавание и визуализацию
      try {
        if (recognition && recognitionRunning) recognition.stop();
      } catch (e) {}
      recognitionRunning = false;

      stopVisualizer();
      listening = false;
      micIcon.src = micOffSVG;
      resetSphere();

      // cancel any pending fetch
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
      }
      return;
    }

    // при новом клике прерываем TTS/текущие ответы ИИ
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      currentAudio = null;
      resetSphere();
    }
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
      thinking = false;
      resetSphere();
    }

    // Перед стартом распознавания — инициализируем visualizer **только если** безопасно.
    // Для проблемных webviews (Telegram, Yandex) — НЕ инициализируем visualizer одновременно,
    // т.к. это ломает SpeechRecognition в их окружении.
    const safeToInitVisualizer = !isProblematicWebView;

    if (safeToInitVisualizer) {
      const ok = await initVisualizer();
      if (!ok) {
        // если не удалось получить доступ к микрофону для визуализации — всё равно попробуем запускать recognition,
        // возможно вебapi даст звук для распознавания без visualizer
        console.warn("initVisualizer не удался, но попытаемся запустить распознавание без визуализации.");
      }
    } else {
      // Для проблемных webview: пытаемся НЕ создавать getUserMedia, чтобы не вызывать двойные окна/конфликты.
      // Всё равно можно попытаться запустить recognition — он может сам запросить доступ.
      console.log("Запуск в проблемном webview — визуализатор пропущен, чтобы избежать конфликтов.");
    }

    // Если нет поддержки распознавания — если visualizer доступен — включаем только его (индикатор),
    // иначе показываем ошибку.
    if (!recognition) {
      if (streamInitialized) {
        listening = true;
        micIcon.src = micOnSVG;
        visualizeAudio();
        // без recognition мы не сможем получить текст — просто визуализация
      } else {
        alert("Распознавание речи не поддерживается в этом браузере и доступ к микрофону не получен.");
      }
      return;
    }

    // Запускаем распознавание
    try {
      recognition.start();
      recognitionRunning = true;
      listening = true;
      micIcon.src = micOnSVG;

      // Если visualizer инициализирован — запускаем визуализацию
      if (streamInitialized) visualizeAudio();

      // Запускаем watchdog — если распознавание повисло, он нас спасёт
      startRecognitionWatchdog();
    } catch (err) {
      console.error("Ошибка запуска recognition.start():", err);
      recognitionRunning = false;
      // в случае ошибки попробуем инициализировать visualizer (если не делали) и показать сообщение
      if (!streamInitialized && !isProblematicWebView) {
        await initVisualizer();
        if (streamInitialized) {
          listening = true;
          micIcon.src = micOnSVG;
          visualizeAudio();
        }
      }
    }
  });

  // Обработчики recognition
  recognition.onstart = () => {
    // распознавание началось
    console.log("speech recognition started");
    // не убираем визуализацию — она уже запущена при необходимости
  };

  recognition.onspeechstart = () => {
    console.log("speech started");
    // очистим watchdog — есть активная речь
    clearRecognitionWatchdog();
  };

  recognition.onspeechend = () => {
    console.log("speech ended (onspeechend)");
    // обычно speechend означает конец фразы — в любом случае ждём onresult или onend
    // но поставим небольшую таймаут-защиту: если onresult не придёт, watchdog остановит всё
    startRecognitionWatchdog();
  };

  recognition.onresult = async (event) => {
    clearRecognitionWatchdog();
    recognitionRunning = false;

    const userMessage = event.results[0][0].transcript;
    console.log("Recognized:", userMessage);

    // остановим локально запись/визуализацию, чтобы перейти в состояние "ИИ думает"
    try { if (recognitionRunning) recognition.stop(); } catch (e) {}
    recognitionRunning = false;

    listening = false;
    micIcon.src = micOffSVG;

    // остановим visualizer (но не удаляем streamInitialized — можно переиспользовать)
    // в некоторых окружениях лучше оставить stream открытым, но мы остановим визуализацию
    // чтобы избежать конфликтов при воспроизведении TTS
    // (но не закрываем полностью streamInitialized, оставим возможность переиспользования)
    if (streamInitialized) {
      // не закрываем stream полностью — оставим, но визуализация прекратится из-за listening=false
    }

    // Отправляем запрос на бэкенд
    try {
      thinking = true;
      showThinkingAnimation();

      currentAbortController = new AbortController();
      const response = await fetch('/api/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, message: userMessage, voice: 'oksana' }),
        signal: currentAbortController.signal
      });

      const data = await response.json();
      thinking = false;
      currentAbortController = null;

      // показываем speaking animation
      sphere.classList.remove('thinking');
      sphere.style.backgroundColor = 'rgb(26, 255, 144)';
      sphere.style.boxShadow = '0 0 25px rgba(26, 255, 144,0.7)';
      sphere.classList.add('speaking');

      if (data.audio) {
        if (currentAudio) {
          currentAudio.pause();
          currentAudio.currentTime = 0;
        }
        currentAudio = new Audio("data:audio/mp3;base64," + data.audio);
        currentAudio.play();
        currentAudio.onended = () => {
          resetSphere();
          currentAudio = null;
          // после окончания ответа — можно (по желанию) реинициировать visualizer, но оставим пользователя нажать микрофон.
        };
      } else {
        resetSphere();
      }
    } catch (err) {
      thinking = false;
      sphere.classList.remove('thinking');
      if (err.name === 'AbortError') {
        console.log("Запрос к ИИ прерван (Abort).");
      } else {
        console.error("Ошибка при отправке запроса к /api/sendMessage:", err);
      }
      resetSphere();
    }
  };

  recognition.onend = () => {
    console.log("recognition.onend fired");
    clearRecognitionWatchdog();
    recognitionRunning = false;
    // Если мы были в состоянии listening (пользователь нажал микрофон), но onresult не пришёл,
    // на мобильных браузерах это может означать, что распознавание "зависло" — watchdog об этом позаботится.
    // В нормальном сценарии onresult уже сработал и мы в состоянии "ИИ думает" или "ждём следующего клика".
  };

  recognition.onerror = (ev) => {
    console.warn("recognition.onerror:", ev && ev.error);
    clearRecognitionWatchdog();
    recognitionRunning = false;
    // при ошибке — приводим интерфейс в норму
    listening = false;
    micIcon.src = micOffSVG;
    resetSphere();
    // в некоторых окружениях ошибка может быть recoverable — пользователь сможет нажать ещё раз.
  };

  // === Переход между вкладками ===
  const tabs = document.querySelectorAll('.menu .tab');
  const pages = document.querySelectorAll('.page');

  tabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      const targetPage = tab.dataset.page;

      tabs.forEach(t => t.classList.remove('active', 'chat-tab', 'avatars-tab', 'learning-tab'));
      tab.classList.add('active');
      if (targetPage === 'home') tab.classList.add('chat-tab');
      if (targetPage === 'avatars') tab.classList.add('avatars-tab');
      if (targetPage === 'learning') tab.classList.add('learning-tab');

      pages.forEach(page => {
        if (page.id === targetPage) page.classList.add('active');
        else page.classList.remove('active');
      });
    });
  });

  // ==================== Загрузка уроков (без изменений логики) ====================
  let currentLessonCard = null;
  let currentLessonAudio = null;

  async function loadLessons() {
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

      const startBtn = card.querySelector('.lesson-start');
      const pauseBtn = card.querySelector('.lesson-pause');
      const content = card.querySelector('.lesson-content');

      let audio = null;
      let paused = false;

      startBtn.addEventListener('click', async () => {
        if (currentLessonCard && currentLessonCard !== card) closeLesson(currentLessonCard);
        if (card.classList.contains('expanded')) { closeLesson(card); return; }

        card.classList.add('expanded');
        content.style.display = 'block';
        currentLessonCard = card;

        if (!audio) {
          const response = await fetch('/api/tts', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ text: lesson.text, voice: 'oksana' })
          });
          const data = await response.json();
          if (data.audio) {
            audio = new Audio("data:audio/mp3;base64," + data.audio);
            audio.play();
            currentLessonAudio = audio;
          }
        } else if (!paused) {
          audio.play();
          currentLessonAudio = audio;
        }

        if (lesson.type === 'interactive' && card.querySelector('.lesson-game').childElementCount === 0) {
          createInteractiveGame(card.querySelector('.lesson-game'), lesson.gameData);
        }
      });

      pauseBtn.addEventListener('click', () => {
        if (!audio) return;
        if (paused) { audio.play(); paused = false; }
        else { audio.pause(); paused = true; }
      });
    });
  }

  function closeLesson(cardToClose) {
    const content = cardToClose.querySelector('.lesson-content');
    content.style.display = 'none';
    cardToClose.classList.remove('expanded');

    if (currentLessonAudio) {
      currentLessonAudio.pause();
      currentLessonAudio.currentTime = 0;
      currentLessonAudio = null;
    }

    const gameContainer = cardToClose.querySelector('.lesson-game');
    if (gameContainer) gameContainer.innerHTML = '';

    if (currentLessonCard === cardToClose) currentLessonCard = null;
  }

  function createInteractiveGame(container, gameData) {
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.alignItems = 'center';
    container.style.gap = '10px';
    container.style.marginTop = '10px';

    const basket = document.createElement('img');
    basket.src = gameData.target;
    basket.style.width = '80px';
    basket.style.border = '2px dashed #fff';
    basket.style.borderRadius = '12px';
    container.appendChild(basket);

    gameData.items.forEach(itemSrc => {
      const item = document.createElement('img');
      item.src = itemSrc;
      item.style.width = '60px';
      item.draggable = true;
      item.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', itemSrc));
      container.appendChild(item);
    });

    basket.addEventListener('dragover', e => e.preventDefault());
    basket.addEventListener('drop', e => {
      const src = e.dataTransfer.getData('text/plain');
      const droppedItem = Array.from(container.querySelectorAll('img')).find(img => img.src.endsWith(src));
      if (droppedItem) droppedItem.remove();
    });
  }

  loadLessons();
});
