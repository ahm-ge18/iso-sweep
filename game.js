(() => {
  "use strict";

  const canvas = document.getElementById("game");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const dom = {
    score: document.getElementById("score"),
    chain: document.getElementById("chain"),
    chainMeter: document.getElementById("chainMeter"),
    kills: document.getElementById("kills"),
    uptime: document.getElementById("uptime"),
    intro: document.getElementById("intro"),
    hint: document.getElementById("hint"),
    hintCopy: document.getElementById("hintCopy"),
    status: document.getElementById("status"),
    statusText: document.getElementById("statusText"),
    toast: document.getElementById("toast"),
  };

  const TAU = Math.PI * 2;
  const GRID = 9;
  const CENTER = (GRID - 1) / 2;
  const PX = 0.64;
  const PY = 0.32;
  const ZPX = 0.5;
  const CHAIN_WINDOW = 2.4;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;

  const audio = {
    bgm: new Audio("audio/bgm.mp3"),
    shatter: new Audio("audio/shatter_01.mp3"),
    activeSfx: new Set(),
    bgmStarted: false,
    bgmStarting: false,
    bgmFadeFrame: 0,
    bgmVolume: 0.16,
    sfxVolume: 0.42,
  };

  audio.bgm.loop = true;
  audio.bgm.preload = "auto";
  audio.bgm.volume = 0;
  audio.bgm.setAttribute("playsinline", "");

  audio.shatter.preload = "auto";
  audio.shatter.volume = audio.sfxVolume;
  audio.shatter.setAttribute("playsinline", "");

  const state = {
    time: 0,
    lastTime: 0,
    started: false,
    introHidden: false,
    player: {
      x: CENTER,
      y: CENTER,
      z: 0.08,
      dash: null,
      trail: [],
    },
    enemies: [],
    particles: [],
    rings: [],
    flashes: [],
    nearestId: null,
    score: 0,
    kills: 0,
    chain: 1,
    lastKillAt: -CHAIN_WINDOW * 2,
    spawnTimer: 1.1,
    spawnInterval: 1.35,
    maxEnemies: 10,
    nextEnemyId: 1,
    buffered: false,
    autoAttackAt: 0,
    attackReadyAt: 0,
    shake: 0,
    shakeX: 0,
    shakeY: 0,
    statusText: "",
    statusMode: "",
    statusHoldUntil: 0,
    hudSecond: -1,
  };

  const pointer = { x: 0, y: 0 };
  let W = 0;
  let H = 0;
  let DPR = 1;
  let SCALE = 80;
  let CX = 0;
  let CY = 0;
  let dust = [];
  let toastTimeout = 0;
  let hintTimeout = 0;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (min, max) => min + Math.random() * (max - min);

  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);

  function easeOutBack(t) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  function project(x, y, z = 0) {
    const dx = x - CENTER;
    const dy = y - CENTER;
    return {
      x: CX + (dx - dy) * PX * SCALE,
      y: CY + (dx + dy) * PY * SCALE - z * ZPX * SCALE,
    };
  }

  function haptic(pattern) {
    if (!navigator.vibrate) return;
    try {
      navigator.vibrate(pattern);
    } catch (_) {
      /* Vibration is an enhancement, never a requirement. */
    }
  }

  function startAudio() {
    if (audio.bgmStarted || audio.bgmStarting) return;
    audio.bgmStarting = true;

    let playback;
    try {
      playback = audio.bgm.play();
    } catch (_) {
      audio.bgmStarting = false;
      return;
    }

    if (!playback || !playback.then) {
      audio.bgmStarting = false;
      return;
    }

    playback
      .then(() => {
        audio.bgmStarting = false;
        if (audio.bgmStarted) return;
        audio.bgmStarted = true;
        fadeInBackgroundMusic();
      })
      .catch(() => {
        audio.bgmStarting = false;
        // Browsers may reject playback until a later user gesture.
      });
  }

  function fadeInBackgroundMusic() {
    window.cancelAnimationFrame(audio.bgmFadeFrame);
    const startedAt = performance.now();
    const duration = 1200;

    const tick = (now) => {
      const progress = clamp((now - startedAt) / duration, 0, 1);
      audio.bgm.volume = audio.bgmVolume * easeOutCubic(progress);
      if (progress < 1) {
        audio.bgmFadeFrame = window.requestAnimationFrame(tick);
      }
    };

    audio.bgmFadeFrame = window.requestAnimationFrame(tick);
  }

  function playShatter() {
    startAudio();

    // Every impact gets its own audio element, so overlapping hits all ring
    // out fully instead of restarting or cutting off the previous shatter.
    const sound = new Audio(audio.shatter.src);
    sound.loop = false;
    sound.preload = "auto";
    sound.volume = audio.sfxVolume;
    sound.setAttribute("playsinline", "");

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      audio.activeSfx.delete(sound);
      sound.removeAttribute("src");
      sound.load();
    };

    audio.activeSfx.add(sound);
    sound.addEventListener("ended", cleanup, { once: true });
    sound.addEventListener("error", cleanup, { once: true });

    try {
      const playback = sound.play();
      if (playback && playback.catch) playback.catch(cleanup);
    } catch (_) {
      cleanup();
      // Audio is an enhancement, never a requirement.
    }
  }

  function setStatus(text, mode = "", hold = 0) {
    state.statusText = text;
    state.statusMode = mode;
    state.statusHoldUntil = hold ? state.time + hold : 0;
    if (dom.statusText.textContent !== text) dom.statusText.textContent = text;
    dom.status.classList.toggle("is-active", mode === "active");
    dom.status.classList.toggle("is-alert", mode === "alert");
  }

  function refreshStatus() {
    if (state.time < state.statusHoldUntil) return;

    let text = "SYNCED";
    let mode = "";

    if (state.player.dash) {
      text = state.buffered ? "QUEUED" : "INTERCEPTING";
      mode = "active";
    } else if (state.buffered || state.autoAttackAt) {
      text = "QUEUED";
      mode = "active";
    } else if (state.enemies.length === 0) {
      text = "AWAITING SIGNAL";
      mode = "alert";
    }

    if (text !== state.statusText || mode !== state.statusMode) setStatus(text, mode);
    dom.hint.classList.toggle("is-muted", state.enemies.length === 0);
  }

  function pad(value, size) {
    return String(value).padStart(size, "0");
  }

  function updateScoreUI(animate) {
    dom.score.textContent = pad(state.score, 5);
    dom.kills.textContent = pad(state.kills, 3);

    if (animate && !reducedMotion && dom.score.animate) {
      dom.score.animate(
        [
          { transform: "translateY(-3px) scale(1.035)", opacity: 0.72 },
          { transform: "translateY(0) scale(1)", opacity: 1 },
        ],
        { duration: 250, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    }
  }

  function updateChainUI(animate) {
    dom.chain.textContent = `CHAIN ×${state.chain}`;
    dom.chain.classList.toggle("is-hot", state.chain > 1);

    if (animate && state.chain > 1 && !reducedMotion && dom.chain.animate) {
      dom.chain.animate(
        [
          { transform: "scale(1.2)", opacity: 1 },
          { transform: "scale(1)", opacity: 1 },
        ],
        { duration: 280, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    }
  }

  function updateUptime(force = false) {
    const second = Math.floor(state.time);
    if (!force && second === state.hudSecond) return;
    state.hudSecond = second;

    const minutes = Math.floor(second / 60);
    const seconds = second % 60;
    const hours = Math.floor(minutes / 60);

    dom.uptime.textContent = hours > 0
      ? `${pad(hours, 2)}:${pad(minutes % 60, 2)}:${pad(seconds, 2)}`
      : `${pad(minutes, 2)}:${pad(seconds, 2)}`;
  }

  function showToast(text, duration = 850) {
    window.clearTimeout(toastTimeout);
    dom.toast.textContent = text;
    dom.toast.classList.add("is-visible");
    toastTimeout = window.setTimeout(() => {
      dom.toast.classList.remove("is-visible");
    }, duration);
  }

  function hideIntro() {
    if (state.introHidden) return;
    state.introHidden = true;
    dom.intro.classList.add("is-hidden");
  }

  function pulseHint() {
    window.clearTimeout(hintTimeout);
    dom.hint.classList.add("is-pressing");
    hintTimeout = window.setTimeout(() => {
      dom.hint.classList.remove("is-pressing");
    }, 110);
  }

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    DPR = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    CX = W * 0.5;
    CY = H * 0.5;

    const widthScale = (W * (W < 680 ? 0.91 : 0.84)) / ((GRID - 1) * 2 * PX);
    const heightScale = (H * (H < 560 ? 0.68 : 0.645)) / ((GRID - 1) * 2 * PY + 1.6);
    SCALE = clamp(Math.min(widthScale, heightScale, 112), 18, 112);

    initDust();
  }

  function initDust() {
    const count = Math.round(clamp((W * H) / 23000, 28, 95));
    dust = Array.from({ length: count }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      size: Math.random() < 0.16 ? 1.5 : 0.8,
      alpha: rand(0.035, 0.18),
      speed: rand(1.4, 8.5),
      phase: Math.random() * TAU,
      depth: rand(0.2, 1),
    }));
  }

  function pickSpawnTile() {
    const occupied = new Set(state.enemies.map((enemy) => `${enemy.x},${enemy.y}`));
    const playerX = Math.round(state.player.x);
    const playerY = Math.round(state.player.y);

    for (let attempt = 0; attempt < 44; attempt += 1) {
      const x = Math.floor(Math.random() * GRID);
      const y = Math.floor(Math.random() * GRID);
      const key = `${x},${y}`;
      if (occupied.has(key)) continue;

      const playerDistance = Math.hypot(x - state.player.x, y - state.player.y);
      if (playerDistance < 1.55) continue;

      let closestEnemy = Infinity;
      for (const enemy of state.enemies) {
        closestEnemy = Math.min(closestEnemy, Math.hypot(x - enemy.x, y - enemy.y));
      }
      if (closestEnemy < 0.8) continue;

      return { x, y };
    }

    let best = null;
    let bestDistance = -Infinity;
    for (let x = 0; x < GRID; x += 1) {
      for (let y = 0; y < GRID; y += 1) {
        if (occupied.has(`${x},${y}`)) continue;
        const distance = Math.hypot(x - state.player.x, y - state.player.y);
        if (distance > bestDistance) {
          bestDistance = distance;
          best = { x, y };
        }
      }
    }

    if (best) return best;
    return { x: playerX === 0 ? GRID - 1 : 0, y: playerY === 0 ? GRID - 1 : 0 };
  }

  function spawnEnemy() {
    if (state.enemies.length >= state.maxEnemies) return null;

    const tile = pickSpawnTile();
    if (!tile) return null;

    const enemy = {
      id: state.nextEnemyId,
      x: tile.x,
      y: tile.y,
      born: state.time,
      phase: Math.random() * TAU,
    };

    state.nextEnemyId += 1;
    state.enemies.push(enemy);

    const ground = project(enemy.x, enemy.y, 0.012);
    state.rings.push({
      x: ground.x,
      y: ground.y,
      life: 0.52,
      maxLife: 0.52,
      r0: SCALE * 0.06,
      r1: SCALE * 0.42,
      alpha: 0.18,
      width: 1,
      dash: [1.2, 5],
    });

    return enemy;
  }

  function seedField() {
    for (let i = 0; i < 3; i += 1) {
      const enemy = spawnEnemy();
      if (enemy) enemy.born = state.time - 0.5 + i * 0.2;
    }
    state.spawnTimer = 0.95;
  }

  function findNearestEnemy() {
    let nearest = null;
    let nearestDistance = Infinity;
    const player = state.player;

    for (const enemy of state.enemies) {
      const dx = enemy.x - player.x;
      const dy = enemy.y - player.y;
      const distance = dx * dx + dy * dy;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = enemy;
      }
    }

    return nearest;
  }

  function queueAttack() {
    if (state.buffered) return;
    state.buffered = true;
    setStatus("QUEUED", "active");
    haptic([5, 16, 5]);
  }

  function requestAttack() {
    pulseHint();
    startAudio();

    if (!state.started) {
      state.started = true;
      hideIntro();
    }

    const player = state.player;

    if (player.dash) {
      queueAttack();
      return;
    }

    if (state.time < state.attackReadyAt) {
      queueAttack();
      return;
    }

    const target = findNearestEnemy();
    if (!target) {
      setStatus("NO SIGNAL", "alert", 0.85);
      showToast("NO SIGNAL // HOLD POSITION", 900);
      haptic([3, 28, 3]);
      return;
    }

    beginDash(target);
  }

  function beginDash(enemy) {
    const player = state.player;
    const dx = enemy.x - player.x;
    const dy = enemy.y - player.y;
    const distance = Math.hypot(dx, dy);

    player.dash = {
      fromX: player.x,
      fromY: player.y,
      toX: enemy.x,
      toY: enemy.y,
      targetId: enemy.id,
      elapsed: 0,
      duration: clamp(0.4 + distance * 0.052, 0.43, 0.78),
      arc: 0.42 + Math.min(0.22, distance * 0.035),
    };
    player.trail.length = 0;

    state.buffered = false;
    state.autoAttackAt = 0;
    state.attackReadyAt = 0;
    state.nearestId = enemy.id;

    setStatus("INTERCEPTING", "active");
    haptic(7);
  }

  function finishDash() {
    const player = state.player;
    const dash = player.dash;
    if (!dash) return;

    player.x = dash.toX;
    player.y = dash.toY;
    player.z = 0.08;
    player.dash = null;

    const target = state.enemies.find((enemy) => enemy.id === dash.targetId);
    if (target) killEnemy(target);

    state.attackReadyAt = state.time + 0.04;

    if (state.buffered) {
      state.buffered = false;
      state.autoAttackAt = state.time + 0.11;
    }
  }

  function killEnemy(enemy) {
    const index = state.enemies.indexOf(enemy);
    if (index >= 0) state.enemies.splice(index, 1);

    const chained = state.time - state.lastKillAt <= CHAIN_WINDOW;
    state.chain = chained ? Math.min(9, state.chain + 1) : 1;
    state.lastKillAt = state.time;
    state.kills += 1;
    state.score += 100 * state.chain;
    state.shake = reducedMotion ? 0 : Math.min(9, 4.2 + state.chain * 0.62);

    addKillEffects(enemy);
    playShatter();

    updateScoreUI(true);
    updateChainUI(true);
    setStatus("CLEARED", "active", 0.3);

    showToast(state.chain > 1 ? `CHAIN ×${state.chain} // +${100 * state.chain}` : "SIGNAL CLEARED", 760);

    const pattern = state.chain > 1
      ? [9, 14, 13, 18, 18]
      : [9, 18, 16];
    haptic(pattern);
  }

  function addKillEffects(enemy) {
    const ground = project(enemy.x, enemy.y, 0.012);
    const top = project(enemy.x, enemy.y, 0.42);
    const particleCount = reducedMotion ? 7 : 20;

    for (let i = 0; i < particleCount; i += 1) {
      const angle = rand(0, TAU);
      const speed = rand(25, 170) * (SCALE / 82);
      const life = rand(0.38, 0.9);

      state.particles.push({
        x: top.x + rand(-5, 5),
        y: top.y + rand(-8, 4),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed * 0.72 - rand(4, 40),
        gravity: rand(40, 100),
        drag: rand(1.3, 2.8),
        life,
        maxLife: life,
        size: rand(1.1, 3.2) * (SCALE / 82),
        rotation: rand(0, TAU),
        spin: rand(-7, 7),
        kind: Math.random() < 0.24 ? "line" : "square",
      });
    }

    state.rings.push({
      x: ground.x,
      y: ground.y,
      life: 0.62,
      maxLife: 0.62,
      r0: SCALE * 0.16,
      r1: SCALE * 0.92,
      alpha: 0.54,
      width: 1.3,
      dash: [1.4, 5],
    });

    state.rings.push({
      x: ground.x,
      y: ground.y,
      life: 0.98,
      maxLife: 0.98,
      r0: SCALE * 0.08,
      r1: SCALE * 1.35,
      alpha: 0.18,
      width: 1,
      dash: [1, 8],
    });

    state.flashes.push({
      x: top.x,
      y: top.y,
      life: 0.22,
      maxLife: 0.22,
      radius: SCALE * 0.46,
    });
  }

  function update(dt) {
    state.time += dt;

    updateDust(dt);
    updateSpawner(dt);
    updatePlayer(dt);
    updateEnemies(dt);
    updateEffects(dt);
    updateChain();

    if (!state.player.dash && state.autoAttackAt && state.time >= state.autoAttackAt) {
      state.autoAttackAt = 0;
      const target = findNearestEnemy();
      if (target) beginDash(target);
      else state.buffered = false;
    }

    if (state.shake > 0.05) {
      state.shake = Math.max(0, state.shake - dt * 34);
      const strength = state.shake;
      state.shakeX = Math.sin(state.time * 104) * strength;
      state.shakeY = Math.cos(state.time * 79) * strength * 0.64;
    } else {
      state.shake = 0;
      state.shakeX = 0;
      state.shakeY = 0;
    }

    state.nearestId = state.player.dash
      ? state.player.dash.targetId
      : (findNearestEnemy()?.id ?? null);

    refreshStatus();
    updateUptime();

    const chainRemaining = state.chain > 1
      ? clamp(1 - (state.time - state.lastKillAt) / CHAIN_WINDOW, 0, 1)
      : 0;
    dom.chainMeter.style.transform = `scaleX(${chainRemaining.toFixed(3)})`;
  }

  function updateDust(dt) {
    for (const mote of dust) {
      mote.y -= mote.speed * dt;
      mote.x += Math.sin(state.time * 0.22 + mote.phase) * dt * 1.8;
      if (mote.y < -8) {
        mote.y = H + 8;
        mote.x = Math.random() * W;
      }
      if (mote.x < -8) mote.x = W + 8;
      if (mote.x > W + 8) mote.x = -8;
    }
  }

  function updateSpawner(dt) {
    state.spawnInterval = Math.max(0.46, 1.35 - state.kills * 0.018);
    state.maxEnemies = Math.min(20, 10 + Math.floor(state.kills / 8));

    state.spawnTimer -= dt;
    if (state.spawnTimer > 0) return;

    if (state.enemies.length < state.maxEnemies) {
      spawnEnemy();
    }

    const pressure = state.enemies.length / state.maxEnemies;
    state.spawnTimer = state.spawnInterval * rand(0.78, 1.22) * (pressure > 0.82 ? 1.8 : 1);
  }

  function updatePlayer(dt) {
    const player = state.player;

    for (const mote of player.trail) {
      mote.life += dt;
    }
    player.trail = player.trail.filter((mote) => mote.life < 0.32);

    if (player.dash) {
      const dash = player.dash;
      dash.elapsed += dt;
      const raw = clamp(dash.elapsed / dash.duration, 0, 1);
      const eased = easeInOutCubic(raw);

      player.x = lerp(dash.fromX, dash.toX, eased);
      player.y = lerp(dash.fromY, dash.toY, eased);
      player.z = 0.08 + Math.sin(Math.PI * raw) * dash.arc;

      if (player.trail.length === 0 || state.time - player.trail[player.trail.length - 1].at > 0.012) {
        player.trail.push({
          x: player.x,
          y: player.y,
          z: player.z,
          life: 0,
          at: state.time,
        });
      }

      if (raw >= 1) finishDash();
    } else {
      const bob = Math.sin(state.time * 2.2) * 0.015;
      player.z = 0.08 + bob;
    }
  }

  function updateEnemies(dt) {
    for (const enemy of state.enemies) {
      const age = state.time - enemy.born;
      if (age < 0) continue;
      enemy.phase += dt * 0.22;
    }
  }

  function updateEffects(dt) {
    for (const particle of state.particles) {
      particle.life -= dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vy += particle.gravity * dt;
      particle.vx *= Math.max(0, 1 - particle.drag * dt);
      particle.rotation += particle.spin * dt;
    }
    state.particles = state.particles.filter((particle) => particle.life > 0);

    for (const ring of state.rings) ring.life -= dt;
    state.rings = state.rings.filter((ring) => ring.life > 0);

    for (const flash of state.flashes) flash.life -= dt;
    state.flashes = state.flashes.filter((flash) => flash.life > 0);
  }

  function updateChain() {
    if (state.chain > 1 && state.time - state.lastKillAt > CHAIN_WINDOW) {
      state.chain = 1;
      updateChainUI(false);
    }
  }

  function roundedPolyPath(points, radius) {
    const count = points.length;
    if (count < 3) return;

    let shortest = Infinity;
    for (let i = 0; i < count; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % count];
      shortest = Math.min(shortest, Math.hypot(b.x - a.x, b.y - a.y));
    }
    const corner = Math.min(radius, shortest * 0.46);

    ctx.beginPath();
    for (let i = 0; i < count; i += 1) {
      const previous = points[(i - 1 + count) % count];
      const current = points[i];
      const next = points[(i + 1) % count];

      const inLength = Math.hypot(previous.x - current.x, previous.y - current.y) || 1;
      const outLength = Math.hypot(next.x - current.x, next.y - current.y) || 1;

      const before = {
        x: current.x + ((previous.x - current.x) / inLength) * corner,
        y: current.y + ((previous.y - current.y) / inLength) * corner,
      };
      const after = {
        x: current.x + ((next.x - current.x) / outLength) * corner,
        y: current.y + ((next.y - current.y) / outLength) * corner,
      };

      if (i === 0) ctx.moveTo(before.x, before.y);
      else ctx.lineTo(before.x, before.y);
      ctx.quadraticCurveTo(current.x, current.y, after.x, after.y);
    }
    ctx.closePath();
  }

  function drawAmbient() {
    const driftX = pointer.x * 16;
    const driftY = pointer.y * 10;

    for (const mote of dust) {
      const x = mote.x + driftX * mote.depth;
      const y = mote.y + driftY * mote.depth;
      const twinkle = 0.72 + Math.sin(state.time * 0.7 + mote.phase) * 0.28;
      ctx.fillStyle = `rgba(255, 255, 255, ${mote.alpha * twinkle})`;
      ctx.fillRect(x, y, mote.size, mote.size);
    }

    // A barely visible horizon keeps the empty space from feeling flat.
    const horizon = ctx.createLinearGradient(0, H * 0.43, 0, H * 0.57);
    horizon.addColorStop(0, "rgba(255, 255, 255, 0)");
    horizon.addColorStop(0.5, "rgba(255, 255, 255, 0.018)");
    horizon.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = horizon;
    ctx.fillRect(0, H * 0.43, W, H * 0.14);
  }

  function boardPoints() {
    return [
      project(0, 0, 0),
      project(GRID - 1, 0, 0),
      project(GRID - 1, GRID - 1, 0),
      project(0, GRID - 1, 0),
    ];
  }

  function drawBoard() {
    const top = boardPoints();
    const radius = clamp(SCALE * 0.46, 11, 42);
    const slab = SCALE * 0.27;
    const bottom = top.map((point) => ({ x: point.x, y: point.y + slab }));

    const halo = ctx.createRadialGradient(CX, CY, SCALE * 0.1, CX, CY, SCALE * 5.6);
    halo.addColorStop(0, "rgba(255, 255, 255, 0.035)");
    halo.addColorStop(0.48, "rgba(255, 255, 255, 0.011)");
    halo.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = halo;
    ctx.fillRect(CX - SCALE * 6, CY - SCALE * 4, SCALE * 12, SCALE * 8);

    const floorShadow = ctx.createRadialGradient(
      CX,
      CY + SCALE * 0.38,
      SCALE * 0.2,
      CX,
      CY + SCALE * 0.38,
      SCALE * 5.4,
    );
    floorShadow.addColorStop(0, "rgba(0, 0, 0, 0.56)");
    floorShadow.addColorStop(0.55, "rgba(0, 0, 0, 0.24)");
    floorShadow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = floorShadow;
    ctx.save();
    ctx.translate(CX, CY + SCALE * 0.38);
    ctx.scale(1, 0.46);
    ctx.beginPath();
    ctx.arc(0, 0, SCALE * 5.4, 0, TAU);
    ctx.fill();
    ctx.restore();

    roundedPolyPath(bottom, radius + 1);
    const underGradient = ctx.createLinearGradient(CX, CY - SCALE * 2.5, CX, CY + SCALE * 3.1);
    underGradient.addColorStop(0, "#0c0d0f");
    underGradient.addColorStop(0.65, "#08090a");
    underGradient.addColorStop(1, "#050607");
    ctx.fillStyle = underGradient;
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = 1;
    ctx.setLineDash([1.2, 5]);
    ctx.stroke();

    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
    ctx.lineWidth = 1;
    ctx.setLineDash([1, 5]);
    for (const index of [1, 2, 3]) {
      ctx.beginPath();
      ctx.moveTo(top[index].x, top[index].y);
      ctx.lineTo(bottom[index].x, bottom[index].y);
      ctx.stroke();
    }
    ctx.restore();

    roundedPolyPath(top, radius);
    const surface = ctx.createLinearGradient(CX, CY - SCALE * 2.7, CX, CY + SCALE * 3);
    surface.addColorStop(0, "#15181b");
    surface.addColorStop(0.45, "#101215");
    surface.addColorStop(1, "#0a0b0d");
    ctx.fillStyle = surface;
    ctx.fill();

    drawBoardGrid(top, radius);

    const inner = top.map((point) => ({
      x: CX + (point.x - CX) * 0.962,
      y: CY + (point.y - CY) * 0.962,
    }));
    roundedPolyPath(inner, radius * 0.9);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.075)";
    ctx.lineWidth = 1;
    ctx.setLineDash([1.2, 7]);
    ctx.stroke();

    roundedPolyPath(top, radius);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.34)";
    ctx.lineWidth = 1.15;
    ctx.setLineDash([1.8, 6.4]);
    ctx.stroke();

    // Four tiny corner markers echo the rounded cubes on the field.
    const corners = [
      [0, 0],
      [GRID - 1, 0],
      [GRID - 1, GRID - 1],
      [0, GRID - 1],
    ];
    for (const [x, y] of corners) {
      drawCube(x, y, 0, {
        half: 0.075,
        height: 0.065,
        alpha: 0.32,
        glow: false,
        core: false,
        nodes: false,
        radius: 1.8,
        topFillA: "rgba(255, 255, 255, 0.035)",
        topFillB: "rgba(255, 255, 255, 0.012)",
        leftFill: "rgba(255, 255, 255, 0.009)",
        rightFill: "rgba(255, 255, 255, 0.014)",
        stroke: "rgba(255, 255, 255, 0.34)",
        sideStroke: "rgba(255, 255, 255, 0.16)",
      });
    }

    const center = project(CENTER, CENTER, 0);
    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.11)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(center.x - 5, center.y);
    ctx.lineTo(center.x + 5, center.y);
    ctx.moveTo(center.x, center.y - 3);
    ctx.lineTo(center.x, center.y + 3);
    ctx.stroke();
    ctx.restore();
  }

  function drawBoardGrid(top, radius) {
    ctx.save();
    roundedPolyPath(top, radius);
    ctx.clip();

    const dotGap = clamp(SCALE * 0.105, 4.5, 11);
    ctx.lineCap = "round";

    for (let index = 0; index < GRID; index += 1) {
      const major = index === 0 || index === GRID - 1 || index % 3 === 0;
      ctx.strokeStyle = major ? "rgba(255, 255, 255, 0.155)" : "rgba(255, 255, 255, 0.072)";
      ctx.lineWidth = major ? 1 : 0.8;
      ctx.setLineDash([1, dotGap]);

      const verticalA = project(index, 0, 0);
      const verticalB = project(index, GRID - 1, 0);
      ctx.beginPath();
      ctx.moveTo(verticalA.x, verticalA.y);
      ctx.lineTo(verticalB.x, verticalB.y);
      ctx.stroke();

      const horizontalA = project(0, index, 0);
      const horizontalB = project(GRID - 1, index, 0);
      ctx.beginPath();
      ctx.moveTo(horizontalA.x, horizontalA.y);
      ctx.lineTo(horizontalB.x, horizontalB.y);
      ctx.stroke();
    }

    const sweepPhase = (state.time * 0.075) % 1;
    const sweepSum = sweepPhase * (GRID * 2 - 0.8);
    const sweepX0 = Math.max(0, sweepSum - (GRID - 1));
    const sweepX1 = Math.min(GRID - 1, sweepSum);
    const sweepA = project(sweepX0, sweepSum - sweepX0, 0);
    const sweepB = project(sweepX1, sweepSum - sweepX1, 0);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.09)";
    ctx.lineWidth = 1.25;
    ctx.setLineDash([1, 7]);
    ctx.beginPath();
    ctx.moveTo(sweepA.x, sweepA.y);
    ctx.lineTo(sweepB.x, sweepB.y);
    ctx.stroke();

    ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
    for (let x = 0; x < GRID; x += 1) {
      for (let y = 0; y < GRID; y += 1) {
        const point = project(x, y, 0);
        ctx.fillRect(point.x - 0.65, point.y - 0.65, 1.3, 1.3);
      }
    }

    ctx.restore();
  }

  function drawCube(x, y, baseZ, options) {
    const {
      half,
      height,
      alpha = 1,
      glow = false,
      core = false,
      nodes = false,
      radius = 4,
      topFillA = "rgba(255, 255, 255, 0.035)",
      topFillB = "rgba(255, 255, 255, 0.012)",
      leftFill = "rgba(255, 255, 255, 0.009)",
      rightFill = "rgba(255, 255, 255, 0.017)",
      stroke = "rgba(255, 255, 255, 0.62)",
      sideStroke = "rgba(255, 255, 255, 0.24)",
    } = options;

    if (alpha <= 0.01) return;

    const topZ = baseZ + height;
    const a = project(x - half, y - half, topZ);
    const b = project(x + half, y - half, topZ);
    const c = project(x + half, y + half, topZ);
    const d = project(x - half, y + half, topZ);
    const drop = height * ZPX * SCALE;
    const bBottom = { x: b.x, y: b.y + drop };
    const cBottom = { x: c.x, y: c.y + drop };
    const dBottom = { x: d.x, y: d.y + drop };

    ctx.save();
    ctx.globalAlpha = alpha;

    if (glow) {
      const center = project(x, y, topZ);
      const glowRadius = SCALE * 0.9;
      const glowGradient = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, glowRadius);
      glowGradient.addColorStop(0, "rgba(255, 255, 255, 0.11)");
      glowGradient.addColorStop(0.46, "rgba(255, 255, 255, 0.035)");
      glowGradient.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = glowGradient;
      ctx.fillRect(center.x - glowRadius, center.y - glowRadius, glowRadius * 2, glowRadius * 2);
    }

    roundedPolyPath([d, c, cBottom, dBottom], radius);
    ctx.fillStyle = leftFill;
    ctx.fill();
    ctx.strokeStyle = sideStroke;
    ctx.lineWidth = 1;
    ctx.setLineDash([1, 3.4]);
    ctx.stroke();

    roundedPolyPath([c, b, bBottom, cBottom], radius);
    ctx.fillStyle = rightFill;
    ctx.fill();
    ctx.strokeStyle = sideStroke;
    ctx.stroke();

    roundedPolyPath([a, b, c, d], radius);
    const topGradient = ctx.createLinearGradient(a.x, a.y, c.x, c.y);
    topGradient.addColorStop(0, topFillA);
    topGradient.addColorStop(1, topFillB);
    ctx.fillStyle = topGradient;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([1.2, 4.3]);
    ctx.stroke();

    if (nodes) {
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255, 255, 255, 0.68)";
      for (const point of [a, b, c, d]) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, Math.max(1.1, SCALE * 0.014), 0, TAU);
        ctx.fill();
      }
    }

    if (core) {
      const center = project(x, y, topZ);
      const size = Math.max(4, SCALE * 0.072);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      ctx.lineWidth = 1.1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(center.x, center.y - size);
      ctx.lineTo(center.x + size, center.y);
      ctx.lineTo(center.x, center.y + size);
      ctx.lineTo(center.x - size, center.y);
      ctx.closePath();
      ctx.stroke();

      ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
      ctx.beginPath();
      ctx.arc(center.x, center.y, Math.max(1.2, SCALE * 0.013), 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawBeacon(x, y, baseZ, options) {
    const {
      phase = 0,
      length = SCALE * 0.2,
      alpha = 0.34,
      player = false,
    } = options;

    const top = project(x, y, baseZ);
    const bob = Math.sin(state.time * 2 + phase) * SCALE * 0.016;
    const tip = { x: top.x, y: top.y - length - bob };

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
    ctx.lineWidth = 1;
    ctx.setLineDash([1, 3.3]);
    ctx.beginPath();
    ctx.moveTo(top.x, top.y - 2);
    ctx.lineTo(tip.x, tip.y + 3);
    ctx.stroke();

    const size = player ? Math.max(2.7, SCALE * 0.034) : Math.max(1.7, SCALE * 0.022);
    ctx.translate(tip.x, tip.y);
    ctx.rotate(state.time * 0.55 + phase);
    ctx.strokeStyle = player ? "rgba(255, 255, 255, 0.96)" : "rgba(255, 255, 255, 0.6)";
    ctx.lineWidth = player ? 1.3 : 1;
    ctx.setLineDash([]);

    if (player) {
      ctx.shadowColor = "rgba(255, 255, 255, 0.8)";
      ctx.shadowBlur = 9;
    }

    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size, 0);
    ctx.lineTo(0, size);
    ctx.lineTo(-size, 0);
    ctx.closePath();
    ctx.stroke();

    if (player) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      ctx.beginPath();
      ctx.arc(0, 0, 1.15, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawShadow(x, y, radius, strength, luminous) {
    const point = project(x, y, 0.006);
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.scale(1, 0.46);

    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    if (luminous) {
      gradient.addColorStop(0, `rgba(255, 255, 255, ${0.12 * strength})`);
      gradient.addColorStop(0.4, `rgba(255, 255, 255, ${0.035 * strength})`);
      gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
    } else {
      gradient.addColorStop(0, `rgba(0, 0, 0, ${0.52 * strength})`);
      gradient.addColorStop(0.58, `rgba(0, 0, 0, ${0.22 * strength})`);
      gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    }

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawTrail() {
    const trail = state.player.trail;
    if (trail.length === 0) return;

    ctx.save();
    for (const mote of trail) {
      const point = project(mote.x, mote.y, mote.z);
      const life = clamp(1 - mote.life / 0.32, 0, 1);
      ctx.fillStyle = `rgba(255, 255, 255, ${life * 0.33})`;
      const size = lerp(1, 2.5, life) * (SCALE / 82);
      ctx.fillRect(point.x - size * 0.5, point.y - size * 0.5, size, size);
    }
    ctx.restore();
  }

  function drawReticle(target) {
    if (!target) return;

    const radius = 0.4 + Math.sin(state.time * 2.6) * 0.018;
    const rotation = state.time * 0.5;
    const points = [];

    for (let i = 0; i <= 40; i += 1) {
      const angle = rotation + (i / 40) * TAU;
      points.push(project(
        target.x + Math.cos(angle) * radius,
        target.y + Math.sin(angle) * radius,
        0.012,
      ));
    }

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.42)";
    ctx.lineWidth = 1.1;
    ctx.setLineDash([1.4, 4.7]);
    ctx.lineDashOffset = -state.time * 22;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.56)";
    ctx.setLineDash([]);
    for (let i = 0; i < 4; i += 1) {
      const angle = rotation + (i / 4) * TAU;
      const start = project(
        target.x + Math.cos(angle) * 0.48,
        target.y + Math.sin(angle) * 0.48,
        0.012,
      );
      const end = project(
        target.x + Math.cos(angle) * 0.57,
        target.y + Math.sin(angle) * 0.57,
        0.012,
      );
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    }

    const cross = project(target.x, target.y, 0.012);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
    ctx.beginPath();
    ctx.moveTo(cross.x - 3, cross.y);
    ctx.lineTo(cross.x + 3, cross.y);
    ctx.moveTo(cross.x, cross.y - 2);
    ctx.lineTo(cross.x, cross.y + 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawTrajectory(target) {
    if (!target || state.player.dash) return;

    const player = state.player;
    const distance = Math.hypot(target.x - player.x, target.y - player.y);
    if (distance < 0.18) return;

    const start = project(player.x, player.y, 0.012);
    const end = project(target.x, target.y, 0.012);

    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.105)";
    ctx.lineWidth = 1;
    ctx.lineCap = "round";
    ctx.setLineDash([1.2, 8]);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();

    const travel = (state.time * 0.52) % 1;
    const pulse = project(
      lerp(player.x, target.x, travel),
      lerp(player.y, target.y, travel),
      0.012,
    );
    ctx.setLineDash([]);
    ctx.fillStyle = `rgba(255, 255, 255, ${0.18 + Math.sin(travel * Math.PI) * 0.3})`;
    ctx.fillRect(pulse.x - 1.2, pulse.y - 1.2, 2.4, 2.4);
    ctx.restore();
  }

  function drawWorldObjects() {
    const objects = [];
    const player = state.player;

    for (const enemy of state.enemies) {
      const progress = clamp((state.time - enemy.born) / 0.55, 0, 1);
      if (progress <= 0) continue;
      const scale = clamp(easeOutBack(progress), 0, 1.09);
      const alpha = easeOutCubic(progress);
      const ground = project(enemy.x, enemy.y, 0);
      objects.push({ type: "enemy", enemy, scale, alpha, depth: ground.y });
    }

    objects.push({
      type: "player",
      depth: project(player.x, player.y, 0).y,
    });

    objects.sort((a, b) => a.depth - b.depth);

    for (const object of objects) {
      if (object.type === "enemy") {
        const { enemy, scale, alpha } = object;
        const hover = Math.sin(state.time * 1.9 + enemy.phase) * 0.015;
        const baseZ = 0.035 + hover;
        const half = 0.245 * scale;
        const height = 0.365 * scale;
        drawCube(enemy.x, enemy.y, baseZ, {
          half,
          height,
          alpha,
          glow: false,
          core: false,
          nodes: false,
          radius: clamp(SCALE * 0.045, 2, 5.5),
          topFillA: "rgba(255, 255, 255, 0.032)",
          topFillB: "rgba(255, 255, 255, 0.008)",
          leftFill: "rgba(255, 255, 255, 0.007)",
          rightFill: "rgba(255, 255, 255, 0.014)",
          stroke: "rgba(255, 255, 255, 0.55)",
          sideStroke: "rgba(255, 255, 255, 0.2)",
        });
        drawBeacon(enemy.x, enemy.y, baseZ + height, {
          phase: enemy.phase,
          length: SCALE * 0.18,
          alpha: alpha * 0.42,
          player: false,
        });
      } else {
        const lift = clamp(player.z, 0.08, 1.2);
        drawCube(player.x, player.y, player.z, {
          half: 0.29,
          height: 0.51,
          alpha: 1,
          glow: true,
          core: true,
          nodes: true,
          radius: clamp(SCALE * 0.062, 2.4, 7),
          topFillA: "rgba(255, 255, 255, 0.075)",
          topFillB: "rgba(255, 255, 255, 0.022)",
          leftFill: "rgba(255, 255, 255, 0.018)",
          rightFill: "rgba(255, 255, 255, 0.036)",
          stroke: "rgba(255, 255, 255, 0.9)",
          sideStroke: "rgba(255, 255, 255, 0.42)",
        });
        drawBeacon(player.x, player.y, player.z + 0.51, {
          phase: 0,
          length: SCALE * 0.3 + lift * SCALE * 0.04,
          alpha: 0.92,
          player: true,
        });
      }
    }
  }

  function drawShadows() {
    const player = state.player;

    for (const enemy of state.enemies) {
      const progress = clamp((state.time - enemy.born) / 0.55, 0, 1);
      if (progress <= 0) continue;
      const scale = clamp(easeOutBack(progress), 0, 1.09);
      drawShadow(enemy.x, enemy.y, SCALE * 0.39 * scale, 0.76, false);
    }

    const lift = clamp((player.z - 0.08) / 0.62, 0, 1);
    drawShadow(
      player.x,
      player.y,
      SCALE * 0.5 * (1 - lift * 0.26),
      0.86 / (1 + lift * 0.9),
      true,
    );
  }

  function drawEffects() {
    for (const ring of state.rings) {
      const progress = 1 - ring.life / ring.maxLife;
      const radius = lerp(ring.r0, ring.r1, easeOutQuint(progress));
      const alpha = ring.alpha * (1 - progress);

      ctx.save();
      ctx.translate(ring.x, ring.y);
      ctx.scale(1, 0.46);
      ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.lineWidth = ring.width;
      ctx.setLineDash(ring.dash);
      ctx.lineDashOffset = -progress * 26;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    for (const flash of state.flashes) {
      const progress = 1 - flash.life / flash.maxLife;
      const radius = flash.radius * (0.68 + progress * 0.72);
      const alpha = (1 - progress) * 0.22;
      const gradient = ctx.createRadialGradient(flash.x, flash.y, 0, flash.x, flash.y, radius);
      gradient.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
      gradient.addColorStop(0.32, `rgba(255, 255, 255, ${alpha * 0.42})`);
      gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(flash.x - radius, flash.y - radius, radius * 2, radius * 2);
    }

    for (const particle of state.particles) {
      const life = clamp(particle.life / particle.maxLife, 0, 1);
      const alpha = Math.pow(life, 0.85);
      ctx.save();
      ctx.translate(particle.x, particle.y);
      ctx.rotate(particle.rotation);
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.72})`;
      ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.62})`;

      if (particle.kind === "line") {
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(-particle.size * 1.5, 0);
        ctx.lineTo(particle.size * 1.5, 0);
        ctx.stroke();
      } else {
        ctx.fillRect(-particle.size * 0.5, -particle.size * 0.5, particle.size, particle.size);
      }
      ctx.restore();
    }
  }

  function render() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);

    drawAmbient();

    ctx.save();
    ctx.translate(state.shakeX, state.shakeY);

    drawBoard();

    const renderTarget = state.player.dash
      ? state.enemies.find((enemy) => enemy.id === state.player.dash.targetId) ?? null
      : findNearestEnemy();

    drawTrajectory(renderTarget);
    drawReticle(renderTarget);
    drawShadows();
    drawTrail();
    drawWorldObjects();
    drawEffects();

    ctx.restore();
  }

  function loop(now) {
    if (!state.lastTime) state.lastTime = now;
    const dt = Math.min((now - state.lastTime) / 1000, 0.05);
    state.lastTime = now;

    update(dt);
    render();
    window.requestAnimationFrame(loop);
  }

  window.addEventListener("keydown", (event) => {
    if (event.code !== "Space" && event.key !== " ") return;
    event.preventDefault();
    if (event.repeat) return;
    requestAttack();
  });

  window.addEventListener("keydown", startAudio, { once: true });
  window.addEventListener("pointerdown", startAudio, { once: true, passive: true });

  canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    requestAttack();
  });

  window.addEventListener("pointermove", (event) => {
    pointer.x = event.clientX / Math.max(1, W) - 0.5;
    pointer.y = event.clientY / Math.max(1, H) - 0.5;
  }, { passive: true });

  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", resize);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      state.lastTime = performance.now();
    }
  });

  if (coarsePointer) {
    document.querySelectorAll("kbd").forEach((key) => {
      key.textContent = "TAP";
    });
    dom.hintCopy.textContent = "SLIDE TO NEAREST SIGNAL";
  }

  resize();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  updateScoreUI(false);
  updateChainUI(false);
  updateUptime(true);
  setStatus("SYNCED");
  seedField();
  updateScoreUI(false);

  window.requestAnimationFrame(loop);
})();
