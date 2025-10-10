document.addEventListener('DOMContentLoaded', () => {
  const micBtn = document.getElementById('micBtn');
  const micIcon = document.getElementById('micIcon');
  const sphere = document.getElementById('sphere');

  const micOnSVG = "icon/mic-mute.svg";
  const micOffSVG = "icon/mic.svg";

  let audioCtx, analyser, dataArray, source, mediaStream;
  let mediaRecorder, chunks = [];
  let listening = false;
  let baseSize = parseInt(window.getComputedStyle(sphere).width);
  let currentAudio = null;
  let thinking = false;
  let silenceTimer = null;

  // === Генерация userId ===
  if (!localStorage.getItem("userId")) {
    const newUserId = crypto.randomUUID();
    localStorage.setItem("userId", newUserId);
  }
  const userId = localStorage.getItem("userId");

  // === Микрофон ===
  micBtn.addEventListener('click', async () => {
    if (listening) {
      stopRecording();
      return;
    }

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      source = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);

      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm;codecs=opus' });
      chunks = [];

      mediaRecorder.ondataavailable = e => chunks.push(e.data);
      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const formData = new FormData();
        formData.append('audio', blob, 'record.webm');

        thinking = true;
        showThinkingAnimation();

        try {
          const sttRes = await fetch('/api/stt', { method: 'POST', body: formData });
          const sttData = await sttRes.json();

          if (sttData.text) {
            await sendToAI(sttData.text);
          } else {
            resetSphere();
          }
        } catch (err) {
          console.error("Ошибка STT:", err);
          resetSphere();
        }
      };

      mediaRecorder.start();
      listening = true;
      micIcon.src = micOnSVG;
      visualizeAudio();
    } catch (err) {
      console.error("Ошибка доступа к микрофону:", err);
    }
  });

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
    if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
    listening = false;
    micIcon.src = micOffSVG;
    resetSphere();
  }

  function resetSphere() {
    sphere.style.width = baseSize + 'px';
    sphere.style.height = baseSize + 'px';
    sphere.style.backgroundColor = 'rgb(17, 250, 83)';
    sphere.style.boxShadow = '0 0 20px rgba(17, 250, 83,0.5)';
    sphere.classList.remove('speaking', 'thinking');
  }

 function visualizeAudio() {
  if (!listening || !analyser) return;
  requestAnimationFrame(visualizeAudio);

  analyser.getByteFrequencyData(dataArray);
  const avgVolume = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

  // анимация шара
  const maxSize = baseSize * 1.5;
  const size = Math.min(maxSize, baseSize + avgVolume / 2);
  sphere.style.width = size + 'px';
  sphere.style.height = size + 'px';
  const lightness = Math.min(70, 50 + avgVolume / 3);
  sphere.style.backgroundColor = `hsl(120,70%,${lightness}%)`;
  sphere.style.boxShadow = `0 0 ${avgVolume/2}px hsl(120,70%,${lightness}%)`;

  // авто-стоп при низкой громкости (тихая пауза)
  const QUIET_THRESHOLD = 10; // порог громкости
  const QUIET_DURATION = 800; // мс, сколько держим перед остановкой

  if (avgVolume < QUIET_THRESHOLD) {
    if (!silenceTimer) silenceTimer = setTimeout(() => stopRecording(), QUIET_DURATION);
  } else {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }
}


  function showThinkingAnimation() {
    if (!thinking) return;
    sphere.classList.add('thinking');
    sphere.style.backgroundColor = 'rgb(5, 229, 203)';
    sphere.style.boxShadow = '0 0 25px rgba(5, 229, 203,0.7)';
    requestAnimationFrame(showThinkingAnimation);
  }

  async function sendToAI(userMessage) {
    try {
      const response = await fetch('/api/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, message: userMessage, voice: 'oksana' })
      });

      const data = await response.json();
      thinking = false;

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
        };
      } else resetSphere();
    } catch (err) {
      console.error(err);
      thinking = false;
      resetSphere();
    }
  }

  // === Вкладки ===
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

  // === Уроки ===
  let currentLessonCard = null;
  let lessonAudio = null;

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
      let audio = null, paused = false;

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
          if (data.audio) { audio = new Audio("data:audio/mp3;base64," + data.audio); audio.play(); lessonAudio = audio; }
        } else if (!paused) { audio.play(); lessonAudio = audio; }

        if (lesson.type === 'interactive' && card.querySelector('.lesson-game').childElementCount === 0)
          createInteractiveGame(card.querySelector('.lesson-game'), lesson.gameData);
      });

      pauseBtn.addEventListener('click', () => {
        if (!audio) return;
        if (paused) { audio.play(); paused = false; } else { audio.pause(); paused = true; }
      });
    });
  }

  function closeLesson(cardToClose) {
    const content = cardToClose.querySelector('.lesson-content');
    content.style.display = 'none';
    cardToClose.classList.remove('expanded');

    if (lessonAudio) { lessonAudio.pause(); lessonAudio.currentTime = 0; lessonAudio = null; }

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
