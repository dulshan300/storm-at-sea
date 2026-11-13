/* Fleet Strike — procedural sound effects (Web Audio API) + streamed background music (public/music).
 * window.SFX.play(name, ...args), SFX.unlock(), SFX.toggle(). Mute is remembered per device.
 * Mobile: the context is created/resumed on the first touch (iOS requirement) and suspended while
 * the tab is hidden to save battery.
 */
(() => {
  "use strict";

  const AC = window.AudioContext || window.webkitAudioContext;
  const MUTE_KEY = "fs_muted";
  let ctx = null, master = null, noiseBuf = null;
  let muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === "1"; } catch { /* storage blocked */ }

  function init() {
    if (ctx || !AC) return ctx;
    try {
      ctx = new AC();
    } catch {
      return null;
    }
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 6;
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.7;
    master.connect(comp).connect(ctx.destination);
    // 2s of white noise, shared by every noisy effect.
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }

  function unlock() {
    if (!init()) return;
    if (ctx.state === "suspended" && !document.hidden) ctx.resume().catch(() => {});
    unlockMusic();
  }
  ["pointerdown", "touchend", "keydown"].forEach((ev) => window.addEventListener(ev, unlock, { passive: true }));
  document.addEventListener("visibilitychange", () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend().catch(() => {});
    else ctx.resume().catch(() => {});
  });

  // ---------- building blocks ----------
  const now = () => ctx.currentTime;

  function env(gainNode, t, peak, attack, decay) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  /** Oscillator voice: freq may slide to `to`. `at` (absolute time) and `out` are used by the music sequencer. */
  function tone({ freq, to = freq, dur = 0.2, type = "sine", gain = 0.3, attack = 0.005, delay = 0, filter = null, at = null, out = null }) {
    const t = at ?? now() + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to !== freq) o.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t + dur);
    env(g, t, gain, attack, dur);
    let node = o;
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass"; f.frequency.value = filter;
      node.connect(f); node = f;
    }
    node.connect(g).connect(out || master);
    o.start(t); o.stop(t + attack + dur + 0.05);
  }

  /** Filtered noise burst: filter cutoff may sweep from `freq` to `to`. */
  function noise({ dur = 0.3, type = "lowpass", freq = 1000, to = freq, q = 0.8, gain = 0.4, attack = 0.005, delay = 0, at = null, out = null }) {
    const t = at ?? now() + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (to !== freq) f.frequency.exponentialRampToValueAtTime(Math.max(to, 20), t + attack + dur);
    const g = ctx.createGain();
    env(g, t, gain, attack, dur);
    src.connect(f).connect(g).connect(out || master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + attack + dur + 0.05);
  }

  // ---------- the sound bank ----------
  const bank = {
    click: () => tone({ freq: 1100, to: 900, dur: 0.04, type: "square", gain: 0.06 }),
    place: () => {
      tone({ freq: 190, to: 80, dur: 0.14, gain: 0.35 });
      noise({ dur: 0.08, freq: 900, gain: 0.12 });
    },
    deny: () => {
      tone({ freq: 220, dur: 0.08, type: "square", gain: 0.08, filter: 1200 });
      tone({ freq: 165, dur: 0.12, type: "square", gain: 0.08, filter: 1200, delay: 0.09 });
    },
    lock: () => { // heavy metallic latch
      noise({ dur: 0.05, type: "bandpass", freq: 2400, q: 4, gain: 0.25 });
      tone({ freq: 620, to: 560, dur: 0.18, type: "triangle", gain: 0.12, delay: 0.02 });
      tone({ freq: 930, dur: 0.12, type: "triangle", gain: 0.06, delay: 0.02 });
    },
    ping: () => { // sonar: your turn
      tone({ freq: 1250, dur: 0.7, gain: 0.16, attack: 0.01 });
      tone({ freq: 1250, dur: 0.5, gain: 0.05, delay: 0.32 });
    },
    tick: () => tone({ freq: 1600, dur: 0.035, type: "square", gain: 0.05 }),
    cannon: () => {
      noise({ dur: 0.45, freq: 2200, to: 180, gain: 0.7, attack: 0.002 });
      tone({ freq: 110, to: 38, dur: 0.4, gain: 0.6, attack: 0.002 });
    },
    whistle: () => tone({ freq: 1900, to: 650, dur: 0.7, gain: 0.05, attack: 0.05 }),
    incoming: () => { // enemy shell screaming down
      tone({ freq: 1500, to: 380, dur: 0.8, gain: 0.07, attack: 0.08 });
      noise({ dur: 0.8, type: "bandpass", freq: 3000, to: 900, q: 3, gain: 0.04, attack: 0.1 });
    },
    explosion: (combo = 1) => {
      const c = Math.min(Math.max(combo, 1), 6);
      noise({ dur: 0.9 + c * 0.05, freq: 3200, to: 90, gain: 0.8, attack: 0.003 });
      tone({ freq: 80 + c * 6, to: 28, dur: 0.6, gain: 0.7, attack: 0.003 });
      if (c > 1) tone({ freq: 300 + c * 80, to: 600 + c * 120, dur: 0.18, type: "triangle", gain: 0.08, delay: 0.05 });
    },
    sink: () => {
      bank.explosion(3);
      noise({ dur: 1.8, freq: 400, to: 60, gain: 0.45, attack: 0.25, delay: 0.25 }); // groaning hull
      tone({ freq: 70, to: 35, dur: 1.6, type: "sawtooth", gain: 0.12, filter: 220, attack: 0.3, delay: 0.3 });
      for (let k = 0; k < 6; k++) { // bubbles
        tone({ freq: 260 + Math.random() * 200, to: 700 + Math.random() * 400, dur: 0.07, gain: 0.05, delay: 0.9 + k * 0.13 + Math.random() * 0.06 });
      }
    },
    splash: () => {
      noise({ dur: 0.5, type: "bandpass", freq: 1800, to: 500, q: 0.7, gain: 0.35, attack: 0.01 });
      for (let k = 0; k < 3; k++) tone({ freq: 900 + Math.random() * 600, to: 1700, dur: 0.05, gain: 0.04, delay: 0.12 + k * 0.07 });
    },
    horn: () => { // battle stations
      [110, 165, 220].forEach((f, i) => tone({ freq: f, dur: 1.2, type: "sawtooth", gain: 0.1 - i * 0.02, filter: 900, attack: 0.12 }));
      noise({ dur: 0.6, freq: 300, gain: 0.08, attack: 0.1 });
    },
    victory: () => {
      [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 0.35, type: "triangle", gain: 0.16, delay: i * 0.13 }));
      [523, 659, 784].forEach((f) => tone({ freq: f, dur: 1.4, type: "sawtooth", gain: 0.05, filter: 2200, attack: 0.05, delay: 0.55 }));
    },
    defeat: () => {
      [392, 311, 262, 196].forEach((f, i) => tone({ freq: f, dur: 0.5, type: "sawtooth", gain: 0.09, filter: 900, delay: i * 0.22 }));
      noise({ dur: 1.5, freq: 300, to: 80, gain: 0.15, attack: 0.3, delay: 0.5 });
    },
    join: () => {
      tone({ freq: 520, dur: 0.12, type: "triangle", gain: 0.12 });
      tone({ freq: 780, dur: 0.2, type: "triangle", gain: 0.12, delay: 0.1 });
    },
    leave: () => {
      tone({ freq: 620, dur: 0.12, type: "triangle", gain: 0.1 });
      tone({ freq: 410, dur: 0.22, type: "triangle", gain: 0.1, delay: 0.1 });
    },
    thunder: () => {
      const d = Math.random() * 0.3;
      noise({ dur: 0.15, type: "highpass", freq: 1500, gain: 0.15, delay: d }); // crack
      noise({ dur: 2.6 + Math.random(), freq: 500, to: 70, gain: 0.35, attack: 0.08, delay: d + 0.05 }); // roll
      noise({ dur: 1.4, freq: 220, gain: 0.25, attack: 0.3, delay: d + 0.6 });
    },
  };

  function play(name, ...args) {
    if (muted || !bank[name] || !init() || ctx.state !== "running") return;
    try { bank[name](...args); } catch { /* never let audio break the game */ }
  }

  // ---------- background music ----------
  // Two looping tracks (public/music), streamed through <audio> elements into the Web Audio graph:
  // streaming keeps memory low on phones and starts playback before the whole file has downloaded,
  // while routing through the graph lets master mute, the music toggle and crossfades control them.
  //   bgm    — lobby & deployment
  //   battle — battle phase (restarts from the top each new battle); both fade out when a battle ends
  const MUSIC_KEY = "fs_music";
  const MUSIC_VOL = 0.75;
  const TRACKS = { calm: "music/bgm.mp3", battle: "music/battle.mp3" };
  let musicOn = true;
  try { musicOn = localStorage.getItem(MUSIC_KEY) !== "0"; } catch { /* storage blocked */ }

  let musicBus = null, current = null, lastMood = null;
  const tracks = {};

  function ensureMusic() {
    if (musicBus) return true;
    if (!init()) return false;
    musicBus = ctx.createGain();
    musicBus.gain.value = musicOn ? MUSIC_VOL : 0;
    musicBus.connect(master);
    for (const [mood, url] of Object.entries(TRACKS)) {
      const el = new Audio();
      el.src = url;
      el.loop = true;
      el.preload = mood === "calm" ? "auto" : "metadata";
      el.setAttribute("playsinline", "");
      const gain = ctx.createGain();
      gain.gain.value = 0;
      try { ctx.createMediaElementSource(el).connect(gain).connect(musicBus); } catch { el.muted = true; }
      tracks[mood] = { el, gain, pauseTimer: null, unlocked: false };
    }
    return true;
  }

  // iOS only lets an <audio> element start from inside a user gesture the first time, but battle music
  // starts from a network event. So on the first tap, start both elements (silently) to unlock them.
  function unlockMusic() {
    if (!ensureMusic()) return;
    for (const [mood, t] of Object.entries(tracks)) {
      if (t.unlocked) continue;
      t.unlocked = true;
      const p = t.el.play();
      if (p && p.then) p.then(() => { if (current !== mood) t.el.pause(); }).catch(() => { t.unlocked = false; });
    }
  }

  function desiredMood() {
    const S = window.FleetState;
    if (!S || S.phase === "lobby" || S.phase === "placing") return "calm";
    if (S.phase === "battle") return "battle";
    return null; // "over": let the victory/defeat stinger ring out
  }

  function fade(t, to, tau) {
    const g = t.gain.gain, now = ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(to, now, tau);
  }

  function startTrack(mood) {
    const t = tracks[mood];
    clearTimeout(t.pauseTimer);
    if (mood === "battle" && lastMood !== "battle") { try { t.el.currentTime = 0; } catch { /* not seekable yet */ } }
    const p = t.el.play();
    if (p && p.catch) p.catch(() => {});
    fade(t, 1, mood === "battle" ? 0.25 : 0.9);
    lastMood = mood;
  }

  function stopTrack(mood) {
    const t = tracks[mood];
    fade(t, 0, 0.45);
    clearTimeout(t.pauseTimer);
    t.pauseTimer = setTimeout(() => t.el.pause(), 2500); // stop decoding once silent (battery)
  }

  function musicTick() {
    if (!ctx || ctx.state !== "running" || !ensureMusic()) return;
    const S = window.FleetState;
    const want = muted || !musicOn || document.hidden ? null : desiredMood();
    if (want === current) {
      if (current && tracks[current].el.paused && !document.hidden) startTrack(current);
      return;
    }
    if (current) stopTrack(current);
    if (want) startTrack(want);
    else if (S && S.phase === "over") lastMood = null; // the next battle starts its track from the top
    current = want;
  }
  setInterval(musicTick, 250);

  const musicBtn = document.getElementById("musicToggle");
  function renderMusic() {
    if (!musicBtn) return;
    musicBtn.classList.toggle("off", !musicOn);
    musicBtn.setAttribute("aria-pressed", String(musicOn));
    musicBtn.setAttribute("aria-label", musicOn ? "Turn music off" : "Turn music on");
  }
  function toggleMusic() {
    musicOn = !musicOn;
    try { localStorage.setItem(MUSIC_KEY, musicOn ? "1" : "0"); } catch { /* ignore */ }
    unlock();
    if (musicBus) musicBus.gain.setTargetAtTime(musicOn ? MUSIC_VOL : 0, ctx.currentTime, 0.15);
    renderMusic();
    musicTick();
  }
  if (musicBtn) musicBtn.addEventListener("click", toggleMusic);
  renderMusic();

  // ---------- mute toggle ----------
  const btn = document.getElementById("soundToggle");
  function renderToggle() {
    if (!btn) return;
    btn.textContent = muted ? "🔇" : "🔊";
    btn.setAttribute("aria-pressed", String(!muted));
    btn.setAttribute("aria-label", muted ? "Turn sound on" : "Turn sound off");
  }
  function toggle() {
    muted = !muted;
    try { localStorage.setItem(MUTE_KEY, muted ? "1" : "0"); } catch { /* ignore */ }
    unlock();
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.7, ctx.currentTime, 0.02);
    renderToggle();
    if (!muted) play("click");
  }
  if (btn) btn.addEventListener("click", toggle);
  document.addEventListener("keydown", (e) => {
    if ((e.key === "m" || e.key === "M") && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) toggle();
  });
  renderToggle();

  window.SFX = { play, unlock, toggle, toggleMusic, get muted() { return muted; }, get musicOn() { return musicOn; } };
})();
