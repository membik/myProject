document.addEventListener("DOMContentLoaded", () => {
  const micBtn = document.getElementById("micBtn");
  const micIcon = document.getElementById("micIcon");
  const sphere = document.getElementById("sphere");

  const micOnSVG = "icon/mic-mute.svg";
  const micOffSVG = "icon/mic.svg";

  let audioCtx, analyser, dataArray, source, mediaStream;
  let recognition = null;
  let listening = false;
  let baseSize = parseInt(window.getComputedStyle(sphere).width);
  let silenceTimer = null;
  let thinking = false;

  // --- userAgent лог ---
  const ua = navigator.userAgent;
  console.log("UserAgent:", ua);
  alert("UA:\n" + ua.substring(0, 180) + (ua.length > 180 ? "..." : ""));

  // --- SpeechRecognition ---
  if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.lang = "ru-RU";
    recognition.interimResults = false;
    recognition.continuous = false;
    console.log("SpeechRecognition создан");
  } else {
    console.warn("Распознавание речи не поддерживается");
  }

  // === Основной обработчик кнопки ===
  micBtn.addEventListener("click", async () => {
    if (listening) {
      stopAll("manual stop");
      return;
    }

    console.log("▶ Нажата кнопка, запускаем микрофон...");
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log("✅ getUserMedia успешно");

      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") await audioCtx.resume();

      source = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);

      listening = true;
      micIcon.src = micOnSVG;
      visualizeAudio();
      startRecognition();
      startSilenceTimer();
    } catch (err) {
      console.error("Ошибка при доступе к микрофону:", err);
      alert("Ошибка доступа к микрофону: " + err.message);
    }
  });

  // === Запуск распознавания ===
  function startRecognition() {
    if (!recognition) {
      console.warn("Нет SpeechRecognition — работаем только с визуализацией.");
      return;
    }

    try {
      recognition.start();
      console.log("🟢 SpeechRecognition start()");
    } catch (err) {
      console.error("SpeechRecognition start() error:", err);
    }

    recognition.onresult = async (event) => {
      console.log("🎤 Распознано:", event.results[0][0].transcript);
      const text = event.results[0][0].transcript;
      stopAll("got result");

      thinking = true;
      showThinkingAnimation();

      try {
        const res = await fetch("/api/sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, voice: "oksana" }),
        });
        const data = await res.json();
        thinking = false;

        if (data.audio) {
          const audio = new Audio("data:audio/mp3;base64," + data.audio);
          audio.play();
          audio.onended = resetSphere;
        } else {
          resetSphere();
        }
      } catch (e) {
        console.error("Ошибка запроса к нейросети:", e);
        resetSphere();
      }
    };

    recognition.onerror = (e) => {
      console.error("SpeechRecognition error:", e.error);
      stopAll("error");
    };

    recognition.onend = () => {
      console.log("🔴 SpeechRecognition onend()");
      stopAll("onend");
    };
  }

  // === Анимация сферы ===
  function visualizeAudio() {
    if (!listening || !analyser) return;
    requestAnimationFrame(visualizeAudio);

    analyser.getByteFrequencyData(dataArray);
    const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

    const size = baseSize + avg / 2;
    sphere.style.width = size + "px";
    sphere.style.height = size + "px";
    const lightness = Math.min(70, 50 + avg / 3);
    sphere.style.backgroundColor = `hsl(120,70%,${lightness}%)`;
  }

  function showThinkingAnimation() {
    sphere.classList.add("thinking");
    sphere.style.backgroundColor = "rgb(5,229,203)";
  }

  function resetSphere() {
    sphere.classList.remove("thinking");
    sphere.style.width = baseSize + "px";
    sphere.style.height = baseSize + "px";
    sphere.style.backgroundColor = "rgb(17,250,83)";
  }

  // === Таймер молчания (если нет речи 5 сек — стоп) ===
  function startSilenceTimer() {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      console.log("⏹ Нет звука 5 сек — авто стоп.");
      stopAll("silence timeout");
    }, 5000);
  }

  function stopAll(reason = "") {
    console.log("⛔ stopAll()", reason);
    clearTimeout(silenceTimer);

    if (recognition) {
      try {
        recognition.stop();
      } catch {}
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
    }
    listening = false;
    micIcon.src = micOffSVG;
    resetSphere();
  }
});
