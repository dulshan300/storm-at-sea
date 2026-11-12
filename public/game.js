/* Fleet Strike — client game logic.
 * Networking model: two players share a Pusher presence channel and talk via client events.
 * Each player is authoritative over their own (hidden) board: the shooter sends `fire`,
 * the defender resolves it and replies with `result`. A hit earns another shot.
 */
(() => {
  "use strict";

  // ---------- constants ----------
  const N = 10;
  const LETTERS = "ABCDEFGHIJ";
  const FLEET = [
    { id: "dread", name: "Dreadnought", len: 5 },
    { id: "cruiser", name: "Battlecruiser", len: 4 },
    { id: "destroyer", name: "Destroyer", len: 3 },
    { id: "sub", name: "Submarine", len: 3 },
    { id: "corvette", name: "Corvette", len: 2 },
  ];
  const TURN_SECONDS = 30;
  const IMPACT_DELAY = 850; // ms between firing and impact (shell flight time)
  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const COMBO_WORDS = ["", "DIRECT HIT!", "DOUBLE STRIKE", "TRIPLE STRIKE", "RAMPAGE", "UNSTOPPABLE", "GODLIKE"];
  const UNKNOWN = 0, MISS = 1, HIT = 2, SUNK = 3, PENDING = 4, REVEAL = 5;

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const sfx = (name, ...a) => { try { window.SFX && window.SFX.play(name, ...a); } catch { /* audio is optional */ } };
  const store = {
    get(k, s = localStorage) { try { return s.getItem(k); } catch { return null; } },
    set(k, v, s = localStorage) { try { s.setItem(k, v); } catch { /* storage may be blocked */ } },
  };
  const randInt = (n) => Math.floor(Math.random() * n);
  const coord = (i) => LETTERS[Math.floor(i / N)] + ((i % N) + 1);
  const cleanName = (v) => String(v || "").replace(/[<>&"'`\\]/g, "").trim().slice(0, 16);
  function randStr(prefix, len) {
    const a = new Uint8Array(len);
    crypto.getRandomValues(a);
    return prefix + Array.from(a, (b) => (b % 36).toString(36)).join("");
  }
  function roomCode() {
    const a = new Uint8Array(5);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
  }

  // Per-tab guest id (sessionStorage) so two tabs in one browser can play each other while testing.
  let guestId = store.get("fs_tab_id", sessionStorage);
  if (!guestId) { guestId = randStr("g", 14); store.set("fs_tab_id", guestId, sessionStorage); }

  // ---------- state ----------
  const S = {
    me: { id: guestId, name: "" },
    opp: null,
    room: null, pusher: null, channel: null, config: null,
    phase: "lobby", // lobby | placing | battle | over
    ships: [], grid: new Array(N * N).fill(-1),
    incoming: new Set(), incomingShown: new Set(),
    enemy: new Array(N * N).fill(UNKNOWN), enemySunk: new Set(),
    myReady: false, oppReady: false,
    turn: null, prevTurn: null, gameNo: 0,
    awaiting: null, awaitTimer: null, animLock: 0,
    selected: 0, horizontal: true, hover: null,
    myRematch: false, oppRematch: false,
    stats: { shots: 0, hits: 0, combo: 0, maxCombo: 0 },
    lastEnemy: -1, lastMine: -1,
    timer: null, timeLeft: 0,
  };
  window.FleetState = S; // exposed for the progression module (phase 4) & debugging

  const myTurn = () => S.phase === "battle" && S.turn === S.me.id;

  // ---------- boards ----------
  function buildBoard(el, handlers) {
    const cells = [];
    const corner = document.createElement("div");
    corner.className = "lbl";
    el.appendChild(corner);
    for (let c = 0; c < N; c++) {
      const l = document.createElement("div");
      l.className = "lbl"; l.textContent = c + 1;
      el.appendChild(l);
    }
    for (let r = 0; r < N; r++) {
      const l = document.createElement("div");
      l.className = "lbl"; l.textContent = LETTERS[r];
      el.appendChild(l);
      for (let c = 0; c < N; c++) {
        const cell = document.createElement("div");
        cell.className = "cell";
        cell.dataset.i = r * N + c;
        el.appendChild(cell);
        cells.push(cell);
      }
    }
    const idx = (e) => { const t = e.target.closest(".cell"); return t ? +t.dataset.i : null; };
    el.addEventListener("click", (e) => { const i = idx(e); if (i !== null) handlers.click(i); });
    if (handlers.hover) {
      el.addEventListener("mouseover", (e) => handlers.hover(idx(e)));
      el.addEventListener("mouseleave", () => handlers.hover(null));
    }
    return cells;
  }

  const myCells = buildBoard($("myBoard"), { click: onMyCell, hover: (i) => { if (S.hover !== i) { S.hover = i; renderMine(); } } });
  const enemyCells = buildBoard($("enemyBoard"), { click: (i) => fire(i) });

  // ---------- placement ----------
  function resetShips() {
    S.ships = FLEET.map((f) => ({ ...f, cells: [], h: true, hits: 0 }));
    S.grid.fill(-1);
  }
  function shipCells(len, origin, h, clip = false) {
    const r0 = Math.floor(origin / N), c0 = origin % N, out = [];
    for (let k = 0; k < len; k++) {
      const r = r0 + (h ? 0 : k), c = c0 + (h ? k : 0);
      if (r >= N || c >= N) { if (clip) continue; return null; }
      out.push(r * N + c);
    }
    return out;
  }
  const canPlace = (cells, si) => !!cells && cells.every((i) => S.grid[i] === -1 || S.grid[i] === si);
  function removeShip(si) { S.ships[si].cells.forEach((i) => (S.grid[i] = -1)); S.ships[si].cells = []; }
  function placeShip(si, cells, h) { removeShip(si); cells.forEach((i) => (S.grid[i] = si)); S.ships[si].cells = cells; S.ships[si].h = h; }
  const allPlaced = () => S.ships.length && S.ships.every((s) => s.cells.length === s.len);
  const nextUnplaced = () => S.ships.findIndex((s) => !s.cells.length);

  function randomize() {
    resetShips();
    S.ships.forEach((s, si) => {
      for (let guard = 0; guard < 500; guard++) {
        const h = Math.random() < 0.5;
        const cells = shipCells(s.len, randInt(N * N), h);
        if (canPlace(cells, si)) { placeShip(si, cells, h); break; }
      }
    });
    S.selected = -1;
  }

  function onMyCell(i) {
    if (S.phase !== "placing" || S.myReady) return;
    const si = S.grid[i];
    if (si >= 0 && si !== S.selected) { // pick up a placed ship
      S.selected = si; S.horizontal = S.ships[si].h; removeShip(si);
      sfx("click");
    } else if (S.selected >= 0) {
      const ship = S.ships[S.selected];
      const cells = shipCells(ship.len, i, S.horizontal);
      if (canPlace(cells, S.selected)) {
        placeShip(S.selected, cells, S.horizontal);
        sfx("place");
        S.selected = nextUnplaced();
      } else {
        sfx("deny");
      }
    }
    render();
  }

  function rotate() {
    if (S.phase !== "placing" || S.myReady) return;
    S.horizontal = !S.horizontal;
    sfx("click");
    render();
  }

  // ---------- rendering ----------
  function renderMine() {
    let preview = null, previewOk = false;
    if (S.phase === "placing" && !S.myReady && S.selected >= 0 && S.hover !== null) {
      const ship = S.ships[S.selected];
      const full = shipCells(ship.len, S.hover, S.horizontal);
      previewOk = canPlace(full, S.selected);
      preview = new Set(full || shipCells(ship.len, S.hover, S.horizontal, true));
    }
    myCells.forEach((el, i) => {
      let cls = "cell";
      const si = S.grid[i];
      if (si >= 0) {
        const s = S.ships[si];
        cls += " ship " + (s.h ? "h" : "v");
        if (s.cells[0] === i) cls += " start";
        if (s.cells[s.cells.length - 1] === i) cls += " end";
        if (S.phase === "placing" && !S.myReady) cls += " placing";
        if (S.incomingShown.has(i)) cls += s.cells.every((c) => S.incomingShown.has(c)) ? " sunk" : " hit";
      } else if (S.incomingShown.has(i)) {
        cls += " miss";
      }
      if (preview && preview.has(i)) cls += previewOk ? " preview-ok" : " preview-bad";
      if (i === S.lastMine) cls += " last";
      el.className = cls;
    });
  }

  function renderEnemy() {
    const CLS = { [UNKNOWN]: "unknown", [MISS]: "miss", [HIT]: "hit", [SUNK]: "sunk", [PENDING]: "pending", [REVEAL]: "reveal" };
    enemyCells.forEach((el, i) => {
      el.className = "cell " + CLS[S.enemy[i]] + (i === S.lastEnemy ? " last" : "");
    });
    $("enemyBoard").classList.toggle("armed", myTurn() && !S.awaiting && !S.animLock);
  }

  function renderShipList() {
    const list = $("shipList");
    list.innerHTML = "";
    S.ships.forEach((s, si) => {
      const item = document.createElement("div");
      item.className = "ship-item" + (si === S.selected ? " selected" : "") + (s.cells.length ? " placed" : "");
      const name = document.createElement("span");
      name.className = "ship-name"; name.textContent = s.name;
      const pips = document.createElement("span");
      pips.className = "ship-pips";
      for (let k = 0; k < s.len; k++) pips.appendChild(document.createElement("i"));
      item.append(name, pips);
      item.addEventListener("click", () => {
        if (S.myReady) return;
        if (s.cells.length) { removeShip(si); S.horizontal = s.h; }
        S.selected = si; sfx("click"); render();
      });
      list.appendChild(item);
    });
    $("orient").textContent = S.horizontal ? "Horizontal" : "Vertical";
    const ready = $("readyBtn");
    ready.disabled = !allPlaced();
    ready.textContent = S.myReady ? "Stand Down" : "Battle Stations!";
    $("readyNote").textContent = S.myReady
      ? (S.opp ? "Fleet locked in. Awaiting the enemy's deployment…" : "Fleet locked in. Waiting for a rival to join…")
      : allPlaced() ? "Fleet deployed. Sound the battle stations!" : "";
    ["rotateBtn", "randomBtn", "clearBtn"].forEach((id) => ($(id).disabled = S.myReady));
  }

  function renderFleetStatus() {
    const mine = $("myFleetStatus"), theirs = $("enemyFleetStatus");
    mine.innerHTML = ""; theirs.innerHTML = "";
    if (S.phase === "placing") return;
    S.ships.forEach((s) => {
      const t = document.createElement("span");
      t.textContent = s.name;
      if (s.cells.every((c) => S.incomingShown.has(c))) t.className = "down";
      mine.appendChild(t);
    });
    FLEET.forEach((f) => {
      const t = document.createElement("span");
      t.textContent = f.name;
      if (S.enemySunk.has(f.id)) t.className = "down";
      theirs.appendChild(t);
    });
  }

  function renderHud() {
    $("meName").textContent = S.me.name || "You";
    $("oppName").textContent = S.opp ? S.opp.name : "Awaiting rival…";
    $("oppBox").classList.toggle("absent", !S.opp);
    $("roomCode").textContent = S.room || "-----";
    $("oppBox").classList.toggle("turn", S.phase === "battle" && S.opp && S.turn === S.opp.id);
    document.querySelector(".captain.me").classList.toggle("turn", myTurn());

    const b = $("banner");
    b.className = "banner";
    let text = "";
    if (S.phase === "placing") {
      if (!S.opp) text = "Waiting for a rival captain…";
      else if (S.myReady && !S.oppReady) text = "Enemy is deploying…";
      else if (!S.myReady && S.oppReady) text = "Enemy is ready — deploy!";
      else text = "Deploy your fleet";
    } else if (S.phase === "battle") {
      if (myTurn()) { text = "Your turn — FIRE!"; b.classList.add("your-turn"); }
      else { text = "Enemy is taking aim…"; b.classList.add("their-turn"); }
    } else if (S.phase === "over") {
      text = "The battle is over";
    }
    b.textContent = text;
    if (S.phase === "battle" && myTurn() && S.timer) {
      const t = document.createElement("span");
      t.className = "timer" + (S.timeLeft <= 5 ? " low" : "");
      t.id = "timer"; t.textContent = S.timeLeft + "s";
      b.appendChild(t);
    }
  }

  function render() {
    const placing = S.phase === "placing";
    $("placeWrap").classList.toggle("hidden", !placing);
    $("enemyWrap").classList.toggle("hidden", placing);
    renderMine();
    renderEnemy();
    if (placing) renderShipList();
    renderFleetStatus();
    renderHud();
  }

  function showScreen(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
  }

  // ---------- log / toast / fx ----------
  function log(text, kind = "") {
    const p = document.createElement("p");
    p.className = kind; p.textContent = text;
    const el = $("log");
    el.appendChild(p);
    while (el.children.length > 60) el.firstChild.remove();
    el.scrollTop = el.scrollHeight;
  }
  let toastT = null;
  function toast(text) {
    const t = $("toast");
    t.textContent = text; t.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2600);
  }
  function announce(text, sub = "", red = false) {
    const host = $("announce");
    host.innerHTML = "";
    const m = document.createElement("div");
    m.className = "msg" + (red ? " red" : "");
    m.textContent = text;
    if (sub) { const s = document.createElement("small"); s.textContent = sub; m.appendChild(s); }
    host.appendChild(m);
    setTimeout(() => m.remove(), 1700);
  }
  const center = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  function spawn(cls, el, parts, life) {
    const [x, y] = center(el);
    const d = document.createElement("div");
    d.className = cls; d.style.left = x + "px"; d.style.top = y + "px";
    parts.forEach((p) => d.appendChild(p));
    document.body.appendChild(d);
    setTimeout(() => d.remove(), life);
  }
  function part(cls, spread) {
    const p = document.createElement("span");
    p.className = cls;
    if (spread) {
      const a = Math.random() * Math.PI * 2, r = spread * (0.5 + Math.random());
      p.style.setProperty("--dx", Math.cos(a) * r + "px");
      p.style.setProperty("--dy", Math.sin(a) * r - spread * 0.3 + "px");
    }
    return p;
  }
  function fxBoom(el, power = 1) {
    const parts = [part("smoke"), part("core"), part("ring")];
    for (let k = 0; k < 10 * power; k++) parts.push(part("spark", 40 * power));
    if (power > 1) { parts.push(part("smoke"), part("ring")); }
    spawn("boom", el, parts, 1700);
  }
  function fxSplash(el) {
    const parts = [part("ripple"), part("ripple")];
    for (let k = 0; k < 8; k++) parts.push(part("drop", 26));
    spawn("splash", el, parts, 1100);
  }
  function shake(big = false) {
    const app = $("app");
    app.classList.remove("shake", "shake-big");
    void app.offsetWidth;
    app.classList.add(big ? "shake-big" : "shake");
  }
  function hitFlash() {
    const f = document.createElement("div");
    f.className = "hit-flash";
    document.body.appendChild(f);
    setTimeout(() => f.remove(), 700);
  }
  function comboPopup(el, n) {
    const [x, y] = center(el);
    const d = document.createElement("div");
    d.className = "combo";
    d.textContent = n <= 1 ? COMBO_WORDS[1] : `${COMBO_WORDS[Math.min(n, COMBO_WORDS.length - 1)]} ×${n}`;
    d.style.left = x + "px"; d.style.top = y + "px";
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 1300);
  }

  // ---------- turn timer ----------
  function stopTimer() { clearInterval(S.timer); S.timer = null; }
  function startTurnTimer() {
    stopTimer();
    if (S.turn !== S.prevTurn) {
      S.prevTurn = S.turn;
      if (myTurn()) sfx("ping");
    }
    if (myTurn()) {
      S.timeLeft = TURN_SECONDS;
      S.timer = setInterval(() => {
        S.timeLeft--;
        if (S.timeLeft <= 5 && S.timeLeft > 0) sfx("tick");
        if (S.timeLeft <= 0) { stopTimer(); autoFire(); }
        renderHud();
      }, 1000);
    }
    render();
  }
  function autoFire() {
    if (!myTurn() || S.awaiting) return;
    const open = S.enemy.map((v, i) => (v === UNKNOWN ? i : -1)).filter((i) => i >= 0);
    if (!open.length) return;
    toast("Time's up! Your gunners fired at will.");
    fire(open[randInt(open.length)]);
  }

  // ---------- networking ----------
  function send(evt, data = {}) {
    if (!S.channel || !S.opp) return;
    try { S.channel.trigger("client-" + evt, data); } catch (e) { console.warn("send failed", e); }
  }
  const hello = () => ({ name: S.me.name, ready: S.myReady, gameNo: S.gameNo, info: window.FleetProfile ? window.FleetProfile.publicInfo() : null });

  async function loadConfig() {
    if (S.config) return S.config;
    const r = await fetch("/api/config");
    if (!r.ok) throw new Error("Game server isn't configured yet (missing Pusher keys).");
    S.config = await r.json();
    return S.config;
  }

  function authParams() {
    return { user_id: S.me.id, name: S.me.name, ...(window.FleetProfile ? window.FleetProfile.authParams() : {}) };
  }

  async function joinRoom(code) {
    const cfg = await loadConfig();
    leaveRoom(true);
    S.pusher = new Pusher(cfg.key, {
      cluster: cfg.cluster,
      channelAuthorization: { endpoint: "/api/pusher-auth", transport: "ajax", params: authParams() },
    });
    S.room = code;
    const ch = S.pusher.subscribe("presence-room-" + code);
    S.channel = ch;

    ch.bind("pusher:subscription_succeeded", (members) => {
      if (members.me && members.me.id) S.me.id = members.me.id;
      members.each((m) => { if (m.id !== S.me.id && !S.opp) setOpp(m); });
      enterRoom();
      if (S.opp) send("hello", hello());
    });
    ch.bind("pusher:subscription_error", (err) => {
      const status = err && (err.status || (err.error && err.error.status));
      leaveRoom();
      lobbyError(status === 403 ? "That battle is full — two captains already." : "Couldn't reach the war room. Try again.");
    });
    ch.bind("pusher:member_added", (m) => {
      if (S.opp && S.opp.id !== m.id) return; // third wheel; server normally blocks this
      const returning = S.phase === "battle" || S.phase === "over";
      setOpp(m);
      if (returning) restartRound("Rival rejoined — battle reset.");
      log(`${S.opp.name} has entered the war room.`, "epic");
      sfx("join");
      send("hello", hello());
      render();
    });
    ch.bind("pusher:member_removed", (m) => { if (S.opp && m.id === S.opp.id) oppLeft(); });

    ch.bind("client-hello", (d, meta) => {
      if (!S.opp && meta && meta.user_id) S.opp = { id: meta.user_id, name: "Rival", info: {} };
      if (!S.opp) return;
      if (d && d.name) S.opp.name = cleanName(d.name) || S.opp.name;
      if (d && d.info && typeof d.info === "object") S.opp.helloInfo = d.info;
      S.oppReady = !!(d && d.ready);
      S.gameNo = Math.max(S.gameNo, (d && Number.isInteger(d.gameNo)) ? d.gameNo : 0);
      render(); checkStart();
    });
    ch.bind("client-ready", () => { S.oppReady = true; log(`${oppName()} has readied their fleet.`); sfx("lock"); render(); checkStart(); });
    ch.bind("client-unready", () => { if (S.phase === "placing") { S.oppReady = false; render(); } });
    ch.bind("client-fire", onIncomingFire);
    ch.bind("client-result", onResult);
    ch.bind("client-reveal", onReveal);
    ch.bind("client-rematch", () => {
      S.oppRematch = true;
      $("rematchNote").textContent = `${oppName()} wants a rematch!`;
      sfx("lock"); checkRematch();
    });
  }

  function setOpp(m) {
    const info = (m && m.info) || {};
    S.opp = { id: m.id, name: cleanName(info.name) || "Rival", info };
  }
  const oppName = () => (S.opp ? S.opp.name : "Rival");

  function enterRoom() {
    S.phase = "placing";
    S.myReady = false;
    if (!S.ships.length) resetShips();
    S.selected = nextUnplaced();
    try { history.replaceState(null, "", "?room=" + S.room); } catch { /* ignore */ }
    $("log").innerHTML = "";
    log(`War room ${S.room} established. Share the code to summon a rival.`, "epic");
    if (S.opp) log(`${S.opp.name} is already here.`, "epic");
    showScreen("game");
    render();
    window.dispatchEvent(new CustomEvent("fleet:room", { detail: { room: S.room, opp: !!S.opp } }));
  }

  function leaveRoom(silent = false) {
    stopTimer();
    clearTimeout(S.awaitTimer);
    if (S.pusher) { try { S.pusher.disconnect(); } catch { /* ignore */ } }
    Object.assign(S, {
      pusher: null, channel: null, opp: null, room: null, phase: "lobby", myReady: false, oppReady: false,
      turn: null, prevTurn: null, awaiting: null, myRematch: false, oppRematch: false, gameNo: 0, animLock: 0,
    });
    $("overlay").classList.remove("show");
    if (!silent) {
      try { history.replaceState(null, "", location.pathname); } catch { /* ignore */ }
      showScreen("lobby");
      window.dispatchEvent(new CustomEvent("fleet:lobby"));
    }
  }

  function oppLeft() {
    const wasFighting = S.phase === "battle";
    log(`${oppName()} has left the war room.`, "bad");
    S.opp = null; S.oppReady = false; S.oppRematch = false;
    if (S.phase === "battle" || S.phase === "over") {
      $("overlay").classList.remove("show");
      restartRound(wasFighting ? "Your rival abandoned the battle." : "Your rival left.");
    }
    sfx("leave");
    render();
    window.dispatchEvent(new CustomEvent("fleet:oppLeft"));
  }

  function restartRound(msg) {
    stopTimer();
    S.phase = "placing";
    S.myReady = false; S.oppReady = false; S.myRematch = false; S.oppRematch = false;
    S.awaiting = null; S.turn = null; S.prevTurn = null; S.animLock = 0;
    S.incoming.clear(); S.incomingShown.clear(); S.enemy.fill(UNKNOWN); S.enemySunk.clear();
    S.ships.forEach((s) => (s.hits = 0));
    S.lastEnemy = S.lastMine = -1;
    if (msg) toast(msg);
    render();
  }

  // ---------- flow ----------
  function toggleReady() {
    if (S.phase !== "placing" || !allPlaced()) return;
    S.myReady = !S.myReady;
    S.selected = -1;
    if (S.myReady) { send("ready"); sfx("lock"); log("Your fleet is locked in.", "good"); }
    else send("unready");
    render(); checkStart();
  }

  function checkStart() {
    if (S.phase === "placing" && S.opp && S.myReady && S.oppReady) startBattle();
  }

  function startBattle() {
    S.phase = "battle";
    S.enemy.fill(UNKNOWN); S.enemySunk.clear(); S.incoming.clear(); S.incomingShown.clear();
    S.ships.forEach((s) => (s.hits = 0));
    S.stats = { shots: 0, hits: 0, combo: 0, maxCombo: 0 };
    S.lastEnemy = S.lastMine = -1; S.awaiting = null; S.prevTurn = null;
    const ids = [S.me.id, S.opp.id].sort();
    S.turn = ids[S.gameNo % 2];
    S.matchId = `${S.room}-${S.gameNo}-${ids.map((x) => x.slice(-4)).join("")}`;
    sfx("horn");
    announce("BATTLE STATIONS", myTurn() ? "You fire first" : `${oppName()} fires first`);
    log(`⚔ Battle begins! ${myTurn() ? "You have" : oppName() + " has"} the first shot. A hit earns another shot.`, "epic");
    shake();
    startTurnTimer();
  }

  function fire(i) {
    if (!myTurn() || S.awaiting || S.animLock || S.enemy[i] !== UNKNOWN) return;
    stopTimer();
    S.awaiting = { i, at: performance.now() };
    S.enemy[i] = PENDING;
    S.stats.shots++;
    send("fire", { i });
    sfx("cannon");
    setTimeout(() => sfx("whistle"), 120);
    render();
    clearTimeout(S.awaitTimer);
    S.awaitTimer = setTimeout(() => {
      if (S.awaiting && S.awaiting.i === i) {
        S.enemy[i] = UNKNOWN; S.stats.shots--; S.awaiting = null;
        toast("Signal lost — fire again.");
        startTurnTimer();
      }
    }, 8000);
  }

  function onIncomingFire(d) {
    const i = d && Number.isInteger(d.i) ? d.i : -1;
    if (S.phase !== "battle" || !S.opp || S.turn !== S.opp.id || i < 0 || i >= N * N || S.incoming.has(i)) return;
    S.incoming.add(i);
    const si = S.grid[i];
    const hit = si >= 0;
    let sunk = null, ship = null;
    if (hit) {
      ship = S.ships[si];
      ship.hits++;
      if (ship.hits === ship.len) sunk = { id: ship.id, cells: ship.cells.slice() };
    }
    const over = hit && S.ships.every((s) => s.hits === s.len);
    send("result", { i, hit, sunk, over });
    S.turn = over ? null : hit ? S.opp.id : S.me.id;
    if (over) S.phase = "over";

    S.animLock++;
    sfx("incoming");
    renderHud();
    setTimeout(() => {
      S.animLock--;
      S.incomingShown.add(i);
      S.lastMine = i;
      const el = myCells[i];
      if (hit) {
        fxBoom(el, sunk ? 2 : 1); hitFlash(); shake(!!sunk);
        sfx(sunk ? "sink" : "explosion");
        log(`💥 Enemy hit your ${ship.name} at ${coord(i)}!`, "bad");
        if (sunk) { announce(`${ship.name.toUpperCase()} LOST`, "", true); log(`☠ Your ${ship.name} has been sunk.`, "bad"); }
      } else {
        fxSplash(el); sfx("splash");
        log(`Enemy shell splashed harmlessly at ${coord(i)}.`);
      }
      if (over) setTimeout(() => endGame(false), 1500);
      else startTurnTimer();
    }, IMPACT_DELAY);
  }

  function onResult(d) {
    const i = d && Number.isInteger(d.i) ? d.i : -1;
    if (S.phase !== "battle" || i < 0 || i >= N * N) return;
    if (S.enemy[i] !== PENDING && S.enemy[i] !== UNKNOWN) return;
    clearTimeout(S.awaitTimer);
    const firedAt = S.awaiting ? S.awaiting.at : performance.now() - IMPACT_DELAY;
    S.awaiting = null;
    const hit = !!d.hit, over = !!d.over;
    S.turn = over ? null : hit ? S.me.id : S.opp && S.opp.id;
    if (over) S.phase = "over";
    if (hit) { S.stats.hits++; S.stats.combo++; S.stats.maxCombo = Math.max(S.stats.maxCombo, S.stats.combo); }
    else S.stats.combo = 0;
    const combo = S.stats.combo;

    S.animLock++;
    render();
    setTimeout(() => {
      S.animLock--;
      S.lastEnemy = i;
      const el = enemyCells[i];
      if (hit) {
        S.enemy[i] = HIT;
        const sunk = d.sunk && FLEET.find((f) => f.id === d.sunk.id);
        if (sunk && Array.isArray(d.sunk.cells)) {
          d.sunk.cells.forEach((c) => { if (Number.isInteger(c) && c >= 0 && c < N * N) S.enemy[c] = SUNK; });
          S.enemySunk.add(sunk.id);
          fxBoom(el, 2); shake(true); sfx("sink");
          announce(`${sunk.name.toUpperCase()} SUNK!`, combo > 1 ? `${combo}-hit chain` : "");
          log(`🔥 You sank the enemy ${sunk.name}!`, "epic");
        } else {
          fxBoom(el, 1); shake(); sfx("explosion", combo);
          log(`💥 Direct hit at ${coord(i)}!${combo > 1 ? ` (${combo} in a row)` : ""} Fire again!`, "good");
        }
        comboPopup(el, combo);
      } else {
        S.enemy[i] = MISS;
        fxSplash(el); sfx("splash");
        log(`Splash at ${coord(i)}. Miss.`);
      }
      if (over) setTimeout(() => endGame(true), 1500);
      else startTurnTimer();
    }, Math.max(0, IMPACT_DELAY - (performance.now() - firedAt)));
  }

  function onReveal(d) {
    if (!d || !Array.isArray(d.cells)) return;
    d.cells.forEach((c) => { if (Number.isInteger(c) && c >= 0 && c < N * N && S.enemy[c] === UNKNOWN) S.enemy[c] = REVEAL; });
    renderEnemy();
  }

  function endGame(won) {
    stopTimer();
    S.phase = "over";
    S.myRematch = false;
    // Show the rival where our surviving ships were hiding.
    send("reveal", { cells: S.ships.flatMap((s) => s.cells) });
    const st = S.stats;
    const acc = st.shots ? Math.round((st.hits / st.shots) * 100) : 0;
    const shipsLeft = S.ships.filter((s) => s.hits < s.len).length;
    const card = document.querySelector(".overlay-card");
    card.classList.toggle("defeat", !won);
    $("ovEmblem").textContent = won ? "🏆" : "☠️";
    $("ovTitle").textContent = won ? "VICTORY" : "DEFEAT";
    $("ovText").textContent = won
      ? `The enemy fleet rests on the seabed. ${oppName()} has been vanquished.`
      : `Your fleet was sent to the depths by ${oppName()}. Seek vengeance!`;
    const statsEl = $("ovStats");
    statsEl.innerHTML = "";
    [[st.shots, "Shots"], [acc + "%", "Accuracy"], ["×" + st.maxCombo, "Best chain"]].forEach(([v, l]) => {
      const box = document.createElement("div");
      const b = document.createElement("b"); b.textContent = v;
      const s = document.createElement("small"); s.textContent = l;
      box.append(b, s); statsEl.appendChild(box);
    });
    $("rematchNote").textContent = S.oppRematch ? `${oppName()} wants a rematch!` : "";
    $("rematchBtn").disabled = false;
    $("overlay").classList.add("show");
    sfx(won ? "victory" : "defeat");
    log(won ? "🏆 VICTORY! The seas are yours." : "☠ DEFEAT. Your fleet is lost.", won ? "epic" : "bad");
    render();
    window.dispatchEvent(new CustomEvent("fleet:gameover", {
      detail: { won, matchId: S.matchId, shots: st.shots, hits: st.hits, maxCombo: st.maxCombo, shipsLeft, opponent: oppName() },
    }));
  }

  function requestRematch() {
    if (!S.opp) { toast("Your rival has left. Share the room code to find another."); return; }
    S.myRematch = true;
    $("rematchBtn").disabled = true;
    $("rematchNote").textContent = `Waiting for ${oppName()} to accept…`;
    send("rematch");
    sfx("click");
    checkRematch();
  }
  function checkRematch() {
    if (S.phase !== "over" || !S.myRematch || !S.oppRematch) return;
    S.gameNo++;
    $("overlay").classList.remove("show");
    restartRound();
    log(`Rematch! Redeploy your fleet, captain.`, "epic");
    sfx("horn");
  }

  // ---------- lobby ----------
  function lobbyError(msg) { $("lobbyError").textContent = msg || ""; if (msg) sfx("deny"); }
  function readName() {
    if (window.FleetProfile && window.FleetProfile.accountName()) return window.FleetProfile.accountName();
    const n = cleanName($("nameInput").value) || "Captain";
    store.set("fs_name", n);
    return n;
  }
  async function startJoin(code) {
    lobbyError("");
    S.me.name = readName();
    try {
      window.SFX && window.SFX.unlock();
      await joinRoom(code);
    } catch (e) {
      lobbyError(e.message || "Something went wrong.");
    }
  }

  $("nameInput").value = store.get("fs_name") || "";
  $("createBtn").addEventListener("click", () => { sfx("click"); startJoin(roomCode()); });
  $("joinBtn").addEventListener("click", () => {
    const code = $("codeInput").value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) return lobbyError("Enter a valid room code.");
    sfx("click"); startJoin(code);
  });
  $("codeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("joinBtn").click(); });
  const urlRoom = new URLSearchParams(location.search).get("room");
  if (urlRoom && /^[A-Z0-9]{4,8}$/i.test(urlRoom)) {
    $("codeInput").value = urlRoom.toUpperCase();
    $("lobbyError").textContent = "";
    $("joinBtn").textContent = "Join Battle";
  }

  // ---------- game controls ----------
  $("rotateBtn").addEventListener("click", rotate);
  $("randomBtn").addEventListener("click", () => { if (S.myReady) return; randomize(); sfx("place"); render(); });
  $("clearBtn").addEventListener("click", () => { if (S.myReady) return; resetShips(); S.selected = 0; sfx("click"); render(); });
  $("readyBtn").addEventListener("click", toggleReady);
  $("rematchBtn").addEventListener("click", requestRematch);
  $("leaveBtn").addEventListener("click", () => { sfx("click"); leaveRoom(); });
  $("roomChip").addEventListener("click", async () => {
    const link = `${location.origin}/?room=${S.room}`;
    try { await navigator.clipboard.writeText(link); toast("Invite link copied — send it to your rival!"); }
    catch { toast(`Room code: ${S.room}`); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === "r" || e.key === "R") rotate();
  });

  // ---------- storm ambience ----------
  (function storm() {
    setTimeout(() => {
      const l = $("lightning");
      l.style.setProperty("--lx", 10 + Math.random() * 80 + "%");
      l.classList.remove("flash"); void l.offsetWidth; l.classList.add("flash");
      setTimeout(() => sfx("thunder"), 250 + Math.random() * 900);
      storm();
    }, 9000 + Math.random() * 16000);
  })();

  // Public hooks for other modules
  window.Fleet = { S, leaveRoom, startJoin, roomCode, toast, announce, log, render, lobbyError, showScreen };

  resetShips();
  render();
})();
