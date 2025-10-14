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
  let listening = false;
  let recording = false;
  let thinking = false;
  let currentAudio = null;
  let silenceTimer = null;
  let preventImmediate = 0;

  // настройки
  const BASE_SIZE = parseInt(window.getComputedStyle(sphere).width) || 80;
  const QUIET_THRESHOLD = 12;
  const QUIET_DURATION = 800;
  const RECORD_AFTER_PAUSE_MS = 1300;
  const MIN_STT_CHARS = 1;

  // userId
  if (!localStorage.getItem("userId")) {
    localStorage.setItem("userId", crypto.randomUUID());
  }
  const userId = localStorage.getItem("userId");

  // === UI: кнопка микрофона ===
  micBtn.addEventListener('click', async () => {
    if (listening) {
      await stopAllListening(true);
    } else {
      await startAllListening();
    }
  });

  // === старт прослушивания ===
  async function startAllListening() {
    try {
      if (!mediaStream) {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }

      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      source = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);

      listening = true;
      micIcon.src = micOnSVG;
      sphere.classList.add('listening');

      monitorAudio();
      startRecorder();

      console.log("🎤 Listening started");
    } catch (err) {
      console.error("Ошибка доступа к микрофону:", err);
    }
  }

  async function stopAllListening(stopStream = false) {
    stopRecorder();
    listening = false;
    sphere.classList.remove('listening');
    micIcon.src = micOffSVG;
    resetSphere();

    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }

    if (stopStream && mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }

    console.log("🔇 Listening stopped");
  }

  function startRecorder() {
    if (!mediaStream) return;
    if (mediaRecorder && (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused')) return;

    chunks = [];
    let mime = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mime)) {
      mime = 'audio/webm';
      if (!MediaRecorder.isTypeSupported(mime)) mime = '';
    }

    try {
      mediaRecorder = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      mediaRecorder = new MediaRecorder(mediaStream);
    }

    mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      recording = false;
      if (chunks.length === 0) {
        if (!thinking && listening) startRecorder();
        return;
      }
      const blob = new Blob(chunks, { type: chunks[0].type || 'audio/webm' });
      await sendBlobToSTT(blob);
      chunks = [];
    };

    try {
      mediaRecorder.start();
      recording = true;
    } catch (err) {
      console.warn('Не удалось стартовать MediaRecorder:', err);
    }
  }

  function stopRecorder() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      try { mediaRecorder.stop(); } catch (e) {}
    }
    recording = false;
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
  }

  function monitorAudio() {
    if (!listening || !analyser) return;
    requestAnimationFrame(monitorAudio);

    analyser.getByteFrequencyData(dataArray);
    const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

    if (!thinking && (!currentAudio || currentAudio.paused)) {
      const maxSize = BASE_SIZE * 1.5;
      const size = Math.min(maxSize, BASE_SIZE + avg / 2);
      sphere.style.width = size + 'px';
      sphere.style.height = size + 'px';
      const lightness = Math.min(70, 50 + avg / 3);
      sphere.style.backgroundColor = `hsl(120,70%,${lightness}%)`;
      sphere.style.boxShadow = `0 0 ${avg / 2}px hsl(120,70%,${lightness}%)`;
    }

    if (avg < QUIET_THRESHOLD) {
      if (!silenceTimer && recording && !thinking) {
        silenceTimer = setTimeout(() => {
          silenceTimer = null;
          stopRecorder();
        }, QUIET_DURATION);
      }
    } else if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  async function sendBlobToSTT(blob) {
    if (!listening) return;
    const now = Date.now();
    if (preventImmediate && now < preventImmediate) return;
    preventImmediate = now + 600;

    thinking = true;
    showThinkingAnimation();

    const form = new FormData();
    form.append('audio', blob, 'speech.webm');

    try {
      const res = await fetch('/api/stt', { method: 'POST', body: form });
      const data = await res.json();
      const recognized = (data.text || data.result || '').trim();

      if (!recognized) {
        thinking = false;
        resetSphere();
        setTimeout(() => { if (listening) startRecorder(); }, 300);
        return;
      }

      thinking = false;
      await sendToAI(recognized);
    } catch (err) {
      console.error('Ошибка STT:', err);
      thinking = false;
      resetSphere();
      setTimeout(() => { if (listening) startRecorder(); }, 500);
    }
  }

  async function sendToAI(userText) {
    if (!listening) return;

    thinking = true;
    showThinkingAnimation();

    if (mediaStream) mediaStream.getTracks().forEach(t => t.enabled = false);

    try {
      const response = await fetch('/api/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, message: userText, voice: 'oksana' })
      });
      const data = await response.json();

      thinking = false;
      sphere.classList.remove('thinking');
      sphere.style.backgroundColor = 'rgb(26, 255, 144)';
      sphere.style.boxShadow = '0 0 25px rgba(26,255,144,0.7)';
      sphere.classList.add('speaking');

      if (data.audio) {
        if (currentAudio) { currentAudio.pause(); currentAudio = null; }

        currentAudio = new Audio('data:audio/mp3;base64,' + data.audio);
        try { await currentAudio.play(); } catch(e){ console.warn(e); }

        currentAudio.onended = () => {
          currentAudio = null;
          resetSphere();
          if (mediaStream) mediaStream.getTracks().forEach(t => t.enabled = true);
          setTimeout(() => { if (listening) startRecorder(); }, 200);
        };
      } else {
        resetSphere();
        if (mediaStream) mediaStream.getTracks().forEach(t => t.enabled = true);
        setTimeout(() => { if (listening) startRecorder(); }, 200);
      }
    } catch (err) {
      console.error('Ошибка sendMessage:', err);
      thinking = false;
      resetSphere();
      if (mediaStream) mediaStream.getTracks().forEach(t => t.enabled = true);
      setTimeout(() => { if (listening) startRecorder(); }, 300);
    }
  }

  function showThinkingAnimation() {
    sphere.classList.add('thinking');
    sphere.style.backgroundColor = 'rgb(5, 229, 203)';
    sphere.style.boxShadow = '0 0 25px rgba(5, 229, 203,0.7)';
  }

  function resetSphere() {
    sphere.classList.remove('speaking', 'thinking');
    sphere.style.width = BASE_SIZE + 'px';
    sphere.style.height = BASE_SIZE + 'px';
    sphere.style.backgroundColor = 'rgb(17, 250, 83)';
    sphere.style.boxShadow = '0 0 20px rgba(17, 250, 83,0.5)';
  }

  async function stopAllAudioAndMic() {
    if (currentAudio) {
      try { currentAudio.pause(); currentAudio.currentTime = 0; } catch(e){}
      currentAudio = null;
    }
    await stopAllListening(true);
    resetSphere();
  }

  // === вкладки ===
  const tabs = document.querySelectorAll('.menu .tab');
  const pages = document.querySelectorAll('.page');

  tabs.forEach(tab => {
    tab.addEventListener('click', e => {
      stopAllAudioAndMic();
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

  // === уроки ===
  let currentLessonCard = null;
  let lessonAudio = null;

  async function loadLessons() {
    try {
      const res = await fetch('backend/lessons/lessons.json');
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
            <p class="lesson-text"></p>
            <div class="lesson-images">
              ${lesson.images ? lesson.images.map(img => `<img src="${img}">`).join('') : ''}
            </div>
            ${lesson.type === 'interactive' ? `<div class="lesson-game"></div>` : ''}
          </div>
        `;

        container.appendChild(card);

        const startBtn = card.querySelector('.lesson-start');
        const content = card.querySelector('.lesson-content');

        startBtn.addEventListener('click', async () => {
          if (currentLessonCard && currentLessonCard !== card) closeLesson(currentLessonCard);

          if (card.classList.contains('expanded')) {
            closeLesson(card);
            return;
          }

          card.classList.add('expanded');
          currentLessonCard = card;


          // Видео
          if (lesson.video) {
            let video = card.querySelector('video.lesson-video');
            if (!video) {
              video = document.createElement('video');
              video.src = `/lessons/${lesson.video}`;
              video.controls = true;
              video.className = 'lesson-video';
              video.style.width = '100%';
              video.style.borderRadius = '12px';
              content.prepend(video);
            }
            video.style.display = 'block';
            lessonAudio = video;
          } else {
            const response = await fetch('/api/tts', {
              method: 'POST',
              headers: {'Content-Type':'application/json'},
              body: JSON.stringify({ text: lesson.text, voice: 'oksana' })
            });
            const data = await response.json();
            if (data.audio) { 
              const audio = new Audio("data:audio/mp3;base64," + data.audio);
              audio.play();
              lessonAudio = audio;
            }
          }

          if (lesson.type === 'interactive' && card.querySelector('.lesson-game').childElementCount === 0) {
  import('./interactive.js').then(module => {
    if (lesson.gameType === 'card-payment') {
      module.createCardPaymentGame(card.querySelector('.lesson-game'), lesson.gameData);
    } else {
      module.createInteractiveGame(card.querySelector('.lesson-game'), lesson.gameData);
    }
  });
}

        });
      });
    } catch (err) {
      console.warn('Не удалось загрузить lessons.json', err);
    }
  }

  function closeLesson(cardToClose) {
  cardToClose.classList.remove('expanded');

  const video = cardToClose.querySelector('video.lesson-video');
  if (video) {
    video.pause();
    video.currentTime = 0;
  }

  if (lessonAudio && lessonAudio !== video) {
    lessonAudio.pause();
    lessonAudio.currentTime = 0;
  }
  lessonAudio = null;

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
