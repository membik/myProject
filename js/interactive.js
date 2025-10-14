// interactive.js — игра "оплата картой"
export function createCardPaymentGame(container) {
  container.innerHTML = `
    <div class="card-payment-game">
      <h3>Приложи карту к терминалу</h3>
      <div class="terminal-area">
        <img src="backend/lessons/images/terminal0.png" class="terminal" id="terminal">
        <img src="backend/lessons/images/card.png" class="card" id="card">
        <div id="readerZone"></div>
      </div>
      <div class="message" id="message"></div>
    </div>
  `;

  const terminal = container.querySelector('#terminal');
  const card = container.querySelector('#card');
  const message = container.querySelector('#message');
  const readerZone = container.querySelector('#readerZone');

  const successSound = new Audio('backend/lessons/sounds/success.mp3');
  const failSound = new Audio('backend/lessons/sounds/fail.mp3');
  const beepSound = new Audio('backend/lessons/sounds/beep.mp3');

  // Зона считывания
  Object.assign(readerZone.style, {
    position: 'absolute',
    width: '130px',
    height: '66px',
    top: '30px',
    left: '40px',
    borderRadius: '8px',
    backgroundColor: 'rgba(0,255,0,0.15)',
    border: '2px dashed #00ff55',
    pointerEvents: 'none',
    transition: 'background-color 0.3s, box-shadow 0.3s'
  });

  let isDragging = false, offsetX = 0, offsetY = 0;
  let holdStart = null, holdTimer = null;
  let success = false, inReader = false;

  function getCoords(e) {
    if (e.touches) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }

  function isOverReader() {
    const cardRect = card.getBoundingClientRect();
    const zoneRect = readerZone.getBoundingClientRect();
    return !(cardRect.right < zoneRect.left || cardRect.left > zoneRect.right || cardRect.bottom < zoneRect.top || cardRect.top > zoneRect.bottom);
  }

  function startDrag(e) {
    isDragging = true;
    card.style.transition = 'none';
    const { x, y } = getCoords(e);
    const rect = card.getBoundingClientRect();
    offsetX = x - rect.left;
    offsetY = y - rect.top;
  }

  function drag(e) {
    if (!isDragging || success) return;
    const { x, y } = getCoords(e);
    const parentRect = container.querySelector('.terminal-area').getBoundingClientRect();
    card.style.left = `${x - parentRect.left - offsetX}px`;
    card.style.top = `${y - parentRect.top - offsetY}px`;

    const nowOverReader = isOverReader();
    if (nowOverReader && !inReader) {
      inReader = true;
      beepSound.currentTime = 0;
      beepSound.play();
      startHoldCheck();
    } else if (!nowOverReader && inReader) {
      inReader = false;
      stopHoldCheck(true);
    }
  }

  function endDrag() {
    if (!isDragging) return;
    isDragging = false;
    if (inReader) {
      stopHoldCheck(true);
      inReader = false;
    }
    resetCard();
  }

  function startHoldCheck() {
    holdStart = Date.now();
    holdTimer = setInterval(() => {
      const elapsed = Date.now() - holdStart;
      updateGlow(elapsed / 2000);
      if (elapsed >= 2000) {
        clearInterval(holdTimer);
        holdTimer = null;
        successPay();
      }
    }, 100);
  }

  function stopHoldCheck(triggerFail = false) {
    if (!holdStart) return;
    const elapsed = Date.now() - holdStart;
    clearInterval(holdTimer);
    holdTimer = null;
    holdStart = null;
    resetGlow();
    if (triggerFail && elapsed < 2000 && !success) failPay();
  }

  function updateGlow(progress) {
    const p = Math.min(progress, 1);
    readerZone.style.backgroundColor = `rgba(0,255,0,${0.15 + p*0.6})`;
    readerZone.style.boxShadow = `0 0 ${10 + p*30}px rgba(0,255,0,${p})`;
  }

  function resetGlow() {
    readerZone.style.backgroundColor = 'rgba(0,255,0,0.15)';
    readerZone.style.boxShadow = 'none';
  }

  function failGlow() {
    readerZone.style.backgroundColor = 'rgba(255,0,0,0.4)';
    readerZone.style.border = '2px dashed #ff4444';
    readerZone.style.boxShadow = '0 0 25px rgba(255,0,0,0.7)';
    setTimeout(() => {
      readerZone.style.backgroundColor = 'rgba(0,255,0,0.15)';
      readerZone.style.border = '2px dashed #00ff55';
      readerZone.style.boxShadow = 'none';
    }, 700);
  }

  function successGlow() {
    readerZone.style.backgroundColor = 'rgba(0,255,0,0.9)';
    readerZone.style.boxShadow = '0 0 40px rgba(0,255,0,0.9)';
  }

  function failPay() {
    failSound.currentTime = 0;
    failSound.play();
    failGlow();
    terminal.src = 'backend/lessons/images/terminal2.png';
    message.textContent = 'Ошибка: попробуй ещё раз!';
    message.classList.add('error');
    setTimeout(() => {
      terminal.src = 'backend/lessons/images/terminal0.png';
      message.textContent = '';
      message.classList.remove('error');
    }, 1200);
  }

  function successPay() {
  successSound.currentTime = 0;
  successSound.play();
  successGlow();
  terminal.src = 'backend/lessons/images/terminal1.png';
  message.textContent = 'Оплата прошла успешно!';
  message.classList.add('success');

  // Сброс через 2 секунды, чтобы можно было снова
  setTimeout(() => {
    message.textContent = '';
    message.classList.remove('success');
    terminal.src = 'backend/lessons/images/terminal0.png';
    success = false;       // <-- теперь можно снова
  }, 2000);
}

  function resetCard() {
    card.style.transition = 'all 0.4s ease';
    card.style.left = '70%';
    card.style.top = '65%';
    card.style.opacity = '1';
  }

  card.addEventListener('mousedown', startDrag);
  card.addEventListener('touchstart', startDrag);
  window.addEventListener('mousemove', drag);
  window.addEventListener('touchmove', drag);
  window.addEventListener('mouseup', endDrag);
  window.addEventListener('touchend', endDrag);

  setInterval(() => {
    if (!isDragging || success) return;
    const nowOverReader = isOverReader();
    if (nowOverReader && !inReader) {
      inReader = true;
      beepSound.currentTime = 0;
      beepSound.play();
      startHoldCheck();
    } else if (!nowOverReader && inReader) {
      inReader = false;
      stopHoldCheck(true);
    }
  }, 100);

  resetCard();
}
