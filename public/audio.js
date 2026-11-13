/* Fleet Strike — procedural sound effects (Web Audio API, no audio files to download).
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
  // An original, procedurally performed score in D minor. Two moods follow the game:
  //   calm   — lobby & deployment: slow pads, low bass, sparse bells, sea swell
  //   battle — battle phase: taiko drums, driving bass, horn melody (enters on the 2nd loop)
  // The music fades out at the end of a battle so the victory/defeat stinger stands out.
  const MUSIC_KEY = "fs_music";
  const MUSIC_VOL = 0.8;
  let musicOn = true;
  try { musicOn = localStorage.getItem(MUSIC_KEY) !== "0"; } catch { /* storage blocked */ }

  const hz = (m) => 440 * 2 ** ((m - 69) / 12);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  function pad(notes, t, dur, out, gain, cutoff) {
    const f = ctx.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = cutoff; f.Q.value = 0.5;
    const g = ctx.createGain();
    const atk = Math.min(1.2, dur * 0.3), rel = Math.min(1.5, dur * 0.35);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + atk);
    g.gain.setValueAtTime(gain, t + dur - rel);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.2);
    f.connect(g).connect(out);
    notes.forEach((m) => [-7, 7].forEach((cents) => {
      const o = ctx.createOscillator();
      o.type = "sawtooth"; o.frequency.value = hz(m); o.detune.value = cents;
      o.connect(f); o.start(t); o.stop(t + dur + 0.3);
    }));
  }

  function lead(m, t, dur, out) { // brass-like horn with delayed vibrato
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = "lowpass"; f.Q.value = 1.2;
    f.frequency.setValueAtTime(900, t);
    f.frequency.linearRampToValueAtTime(2000, t + 0.08);
    f.frequency.linearRampToValueAtTime(1400, t + dur);
    const vib = ctx.createOscillator(), vibAmt = ctx.createGain();
    vib.frequency.value = 5.5;
    vibAmt.gain.setValueAtTime(0, t);
    vibAmt.gain.linearRampToValueAtTime(5, t + Math.min(0.25, dur));
    vib.connect(vibAmt);
    [["sawtooth", 0], ["square", 5]].forEach(([type, det]) => {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = hz(m); o.detune.value = det;
      vibAmt.connect(o.frequency);
      o.connect(f); o.start(t); o.stop(t + dur + 0.2);
    });
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.075, t + 0.03);
    g.gain.setValueAtTime(0.06, t + Math.max(0.04, dur - 0.08));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.12);
    f.connect(g).connect(out);
    vib.start(t); vib.stop(t + dur + 0.2);
  }

  function bell(m, t, out, gain = 0.05) {
    tone({ freq: hz(m), dur: 2.4, gain, attack: 0.004, at: t, out });
    tone({ freq: hz(m) * 2.76, dur: 0.9, gain: gain * 0.35, attack: 0.002, at: t, out }); // inharmonic shimmer
  }

  // Drum kit (battle)
  const kick = (t, out, big) => {
    tone({ freq: big ? 140 : 110, to: 42, dur: big ? 0.45 : 0.28, gain: big ? 0.6 : 0.38, attack: 0.002, at: t, out });
    noise({ dur: 0.06, freq: 600, gain: big ? 0.25 : 0.12, attack: 0.001, at: t, out });
  };
  const tom = (t, out, f) => tone({ freq: f, to: f * 0.62, dur: 0.2, gain: 0.26, attack: 0.002, at: t, out });
  const rim = (t, out) => noise({ dur: 0.05, type: "bandpass", freq: 2600, q: 5, gain: 0.14, attack: 0.001, at: t, out });
  const hat = (t, out, g = 0.03) => noise({ dur: 0.03, type: "highpass", freq: 7500, gain: g, attack: 0.001, at: t, out });

  //                      pad voicing (MIDI)    bass root
  const CALM = [
    { pad: [50, 57, 62, 65], root: 38 }, // Dm
    { pad: [46, 53, 58, 62], root: 34 }, // Bb
    { pad: [48, 53, 57, 60], root: 41 }, // F
    { pad: [48, 55, 60, 64], root: 36 }, // C
  ];
  const BATTLE = [
    { pad: [50, 57, 62, 65], root: 38 }, // Dm
    { pad: [46, 53, 58, 62], root: 34 }, // Bb
    { pad: [48, 55, 60, 64], root: 36 }, // C
    { pad: [45, 52, 57, 61], root: 33 }, // A (dominant, raised 7th)
  ];
  // Battle melody: per bar, [16th-step, MIDI note, length in 16ths]
  const MELODY = [
    [[0, 74, 3], [3, 69, 1], [4, 74, 2], [6, 76, 2], [8, 77, 6], [14, 76, 2]],
    [[0, 74, 4], [4, 77, 2], [6, 74, 2], [8, 70, 8]],
    [[0, 72, 3], [3, 67, 1], [4, 72, 2], [6, 74, 2], [8, 76, 4], [12, 79, 4]],
    [[0, 81, 6], [6, 79, 2], [8, 77, 2], [10, 76, 2], [12, 73, 4]],
  ];

  const SONGS = {
    calm: {
      bpm: 70, vol: 1.3,
      step(n, t, out, sd) {
        const bar = Math.floor(n / 16) % 8, s = n % 16, ch = CALM[Math.floor(bar / 2)];
        if (s === 0 && bar % 2 === 0) {
          pad(ch.pad, t, sd * 32, out, 0.035, 850);
          tone({ freq: hz(ch.root), dur: sd * 30, gain: 0.16, attack: 0.4, at: t, out });
          tone({ freq: hz(ch.root + 12), dur: sd * 28, type: "triangle", gain: 0.05, attack: 0.6, at: t, out });
          noise({ dur: sd * 26, freq: 260, to: 520, gain: 0.05, attack: sd * 10, at: t, out }); // sea swell
        }
        if (s % 4 === 0 && Math.random() < 0.3) bell(pick(ch.pad) + 12 + (Math.random() < 0.35 ? 12 : 0), t, out);
      },
    },
    battle: {
      bpm: 128, vol: 1,
      step(n, t, out, sd) {
        const loop = Math.floor(n / 64), bar = Math.floor(n / 16) % 4, s = n % 16, ch = BATTLE[bar];
        if (s === 0) pad(ch.pad, t, sd * 16, out, 0.022, 700);
        // Driving bass: eighth notes with octave pops.
        if (s % 2 === 0) {
          const m = ch.root + (s === 6 || s === 14 ? 12 : 0);
          tone({ freq: hz(m), dur: sd * 1.6, type: "sawtooth", gain: 0.12, attack: 0.005, filter: 420, at: t, out });
        }
        // Taiko pattern, with a tom fill closing every 4th bar.
        if (s === 0 || s === 8) kick(t, out, true);
        if (bar === 3 && s >= 12) tom(t, out, [230, 200, 170, 140][s - 12]);
        else if (s === 3 || s === 6 || s === 11 || s === 14) tom(t, out, s % 2 ? 190 : 160);
        if (s === 4 || s === 12) rim(t, out);
        if (s % 2 === 1) hat(t, out, s % 4 === 3 ? 0.035 : 0.02);
        // Melody from the second loop on, resting every 4th loop to breathe.
        if (loop >= 1 && loop % 4 !== 3) {
          for (const [st, m, len] of MELODY[bar]) if (st === s) lead(m, t, sd * len * 0.95, out);
        } else if (s === 0 && loop > 0) {
          bell(ch.pad[3] + 12, t, out, 0.04);
        }
      },
    },
  };

  let musicBus = null, current = null, stepCount = 0, nextTime = 0;
  const moodBus = {};

  function ensureMusic() {
    if (musicBus) return true;
    if (!init()) return false;
    musicBus = ctx.createGain();
    musicBus.gain.value = musicOn ? MUSIC_VOL : 0;
    musicBus.connect(master);
    for (const k of Object.keys(SONGS)) {
      moodBus[k] = ctx.createGain();
      moodBus[k].gain.value = 0;
      moodBus[k].connect(musicBus);
    }
    return true;
  }

  function desiredMood() {
    const S = window.FleetState;
    if (!S || S.phase === "lobby" || S.phase === "placing") return "calm";
    if (S.phase === "battle") return "battle";
    return null; // "over": let the stinger ring out
  }

  function switchMood(m) {
    const t = ctx.currentTime;
    if (current) {
      moodBus[current].gain.cancelScheduledValues(t);
      moodBus[current].gain.setTargetAtTime(0, t, 0.5);
    }
    current = m;
    stepCount = 0;
    nextTime = t + 0.15;
    if (m) {
      moodBus[m].gain.cancelScheduledValues(t);
      moodBus[m].gain.setTargetAtTime(SONGS[m].vol, t, m === "battle" ? 0.2 : 1.2);
    }
  }

  // Look-ahead sequencer: schedules notes ~300ms ahead so timing stays tight even on slow phones.
  function musicTick() {
    if (!ctx || ctx.state !== "running" || muted || !musicOn || document.hidden) return;
    if (!ensureMusic()) return;
    const want = desiredMood();
    if (want !== current) switchMood(want);
    if (!current) return;
    const song = SONGS[current];
    const sd = 60 / song.bpm / 4;
    if (nextTime < ctx.currentTime) nextTime = ctx.currentTime + 0.05; // resumed after a pause
    while (nextTime < ctx.currentTime + 0.3) {
      try { song.step(stepCount, nextTime, moodBus[current], sd); } catch { /* keep the beat going */ }
      stepCount++;
      nextTime += sd;
    }
  }
  setInterval(musicTick, 80);

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
    if (musicOn && current) nextTime = 0; // restart scheduling from "now"
    renderMusic();
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
