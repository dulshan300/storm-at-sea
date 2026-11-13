/* Fleet Strike — accounts, quick match, leaderboard and result reporting.
 * Talks to /api/account, /api/quickmatch, /api/match and /api/leaderboard (Upstash Redis behind them).
 * Hooks into game.js through window.Fleet and the fleet:* DOM events it dispatches.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const F = window.Fleet;
  const sfx = (name) => { try { window.SFX && window.SFX.play(name); } catch { /* optional */ } };
  const TOKEN_KEY = "fs_token";
  const store = {
    get() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } },
    set(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* blocked */ } },
  };

  let token = store.get();
  let profile = null;

  async function api(path, body, method = "POST") {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    const r = await fetch(path, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body || {}) });
    let data = {};
    try { data = await r.json(); } catch { /* empty body */ }
    if (!r.ok) {
      const err = new Error(data.error || `Request failed (${r.status})`);
      err.status = r.status;
      throw err;
    }
    return data;
  }

  // ---------- account ----------
  function setSession(t, p) {
    token = t || "";
    profile = t ? p : null;
    store.set(token);
    renderAccount();
  }

  function renderAccount() {
    const signedIn = !!(token && profile);
    $("accountGuest").classList.toggle("hidden", signedIn);
    $("accountUser").classList.toggle("hidden", !signedIn);
    $("nameField").classList.toggle("hidden", signedIn);
    if (signedIn) {
      $("accountName").textContent = profile.name;
      $("accountRating").textContent = `★ ${profile.rating}`;
      $("accountRating").title = `Rating · ${profile.rWins}W ${profile.rLosses}L ranked · ${profile.games} battles total`;
    }
  }

  async function refreshProfile() {
    if (!token) return null;
    try {
      const { profile: p } = await api("/api/account", { action: "me" });
      profile = p;
    } catch (e) {
      if (e.status === 401) setSession("", null);
    }
    renderAccount();
    return profile;
  }

  // Auth dialog
  let authMode = "login";
  function openAuth(mode) {
    authMode = mode;
    const reg = mode === "register";
    $("authTitle").textContent = reg ? "Enlist" : "Sign In";
    $("authSub").textContent = reg
      ? "Pick a captain's name. Ranked battles start you at ★ 1000."
      : "Track your record and climb the Hall of Admirals.";
    $("authSubmit").textContent = reg ? "Create Account" : "Sign In";
    $("authSwitch").textContent = reg ? "Already enlisted? Sign in" : "New here? Create an account";
    $("authPass").autocomplete = reg ? "new-password" : "current-password";
    $("authError").textContent = "";
    if (reg && !$("authName").value) $("authName").value = ($("nameInput").value || "").replace(/[^A-Za-z0-9_]/g, "");
    $("authModal").classList.add("show");
    // Pick the field now, not inside the timeout: typing during the delay must not move focus mid-word.
    const field = $("authName").value ? $("authPass") : $("authName");
    setTimeout(() => { if (!$("authModal").contains(document.activeElement) || document.activeElement === document.body) field.focus(); }, 50);
  }
  const closeAuth = () => { $("authModal").classList.remove("show"); $("authPass").value = ""; };

  $("signInBtn").addEventListener("click", () => openAuth("login"));
  $("registerBtn").addEventListener("click", () => openAuth("register"));
  $("authSwitch").addEventListener("click", () => openAuth(authMode === "login" ? "register" : "login"));
  $("authClose").addEventListener("click", closeAuth);
  $("authModal").addEventListener("click", (e) => { if (e.target === $("authModal")) closeAuth(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("authModal").classList.contains("show")) closeAuth(); });

  $("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("authName").value.trim();
    const password = $("authPass").value;
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) { $("authError").textContent = "Names are 3–16 letters, numbers or underscores."; return; }
    if (password.length < 6) { $("authError").textContent = "Passwords are at least 6 characters."; return; }
    const btn = $("authSubmit");
    btn.disabled = true;
    $("authError").textContent = "";
    try {
      const res = await api("/api/account", { action: authMode, name, password });
      setSession(res.token, res.profile);
      closeAuth();
      sfx("join");
      F.toast(authMode === "register" ? `Welcome aboard, Captain ${res.profile.name}!` : `Welcome back, Captain ${res.profile.name}.`);
      loadRanks();
    } catch (err) {
      $("authError").textContent = err.message;
      sfx("deny");
    } finally {
      btn.disabled = false;
    }
  });

  $("signOutBtn").addEventListener("click", async () => {
    try { await api("/api/account", { action: "logout" }); } catch { /* token is dropped locally anyway */ }
    setSession("", null);
    F.toast("Signed out. Sailing as a guest.");
    loadRanks();
  });

  // ---------- leaderboard ----------
  async function loadRanks() {
    const list = $("rankList");
    try {
      const { top, me } = await api("/api/leaderboard", null, "GET");
      list.innerHTML = "";
      if (!top.length) {
        const li = document.createElement("li");
        li.className = "rank-empty";
        li.textContent = "No ranked battles yet. Sign in and claim the top spot.";
        list.appendChild(li);
      }
      top.forEach((row) => {
        const li = document.createElement("li");
        if (row.you) li.className = "you";
        [["pos", row.rank], ["who", row.name], ["rec", `${row.w}W ${row.l}L`], ["pts", row.rating]].forEach(([cls, v]) => {
          const s = document.createElement("span");
          s.className = cls; s.textContent = v;
          li.appendChild(s);
        });
        list.appendChild(li);
      });
      const inTop = top.some((r) => r.you);
      $("rankMe").textContent = me && !inTop
        ? (me.rank ? `You: #${me.rank} · ★ ${me.rating} · ${me.w}W ${me.l}L` : `You: unranked · win a ranked battle to enter the Hall.`)
        : "";
    } catch {
      list.innerHTML = '<li class="rank-empty">The Hall of Admirals is out of reach right now.</li>';
      $("rankMe").textContent = "";
    }
  }

  // ---------- quick match ----------
  // Open our own room first, then ask the queue: either we take someone's waiting ticket and hop to their
  // room, or we post our room and keep the ticket alive with heartbeats until a rival walks in.
  const HEARTBEAT_MS = 8000;
  const REQUEUE_AFTER_MS = 7000; // ticket gone but nobody arrived (the matched rival vanished)
  const qm = { searching: false, mode: false, room: null, hopTo: null, timer: null, goneSince: 0, busy: false };

  function qmBody(extra) { return { id: F.S.me.id, room: qm.room, ...extra }; }

  function setSearching(on) {
    qm.searching = on;
    $("quickBtn").classList.toggle("searching", on);
    $("quickBtn").disabled = on;
    if (!on) { clearInterval(qm.timer); qm.timer = null; qm.goneSince = 0; }
  }

  function stopQuick(cancelTicket) {
    if (cancelTicket && qm.searching && qm.room) api("/api/quickmatch", qmBody({ action: "cancel" })).catch(() => {});
    setSearching(false);
    qm.mode = false;
    qm.room = null;
    qm.hopTo = null;
  }

  async function quickMatch() {
    if (qm.searching) return;
    F.lobbyError("");
    setSearching(true);
    qm.mode = true;
    await F.startJoin(F.roomCode());
    if (!F.S.room) stopQuick(false); // couldn't open a room; game.js already showed the error
  }

  async function enqueue() {
    if (qm.busy || !F.S.room) return;
    qm.busy = true;
    qm.room = F.S.room;
    try {
      const res = await api("/api/quickmatch", qmBody({ action: "join" }));
      if (res.role === "join" && res.room !== F.S.room && !F.S.opp) {
        F.log("⚡ Rival spotted! Sailing to their waters…", "epic");
        qm.room = res.room;
        qm.hopTo = res.room;
        await F.startJoin(res.room); // fleet:room fires again when we arrive
      } else if (!F.S.opp) {
        F.log("⚡ Searching the seas for a rival captain…", "epic");
        startHeartbeat();
      }
    } catch (e) {
      F.toast(e.message || "Matchmaking unavailable.");
      setSearching(false);
    } finally {
      qm.busy = false;
    }
  }

  function startHeartbeat() {
    clearInterval(qm.timer);
    qm.goneSince = 0;
    qm.timer = setInterval(async () => {
      if (!qm.searching) return;
      if (F.S.opp) { setSearching(false); return; }
      try {
        const { waiting } = await api("/api/quickmatch", qmBody({ action: "heartbeat" }));
        if (waiting || F.S.opp) { qm.goneSince = 0; return; }
        if (!qm.goneSince) qm.goneSince = Date.now();
        else if (Date.now() - qm.goneSince > REQUEUE_AFTER_MS) { qm.goneSince = 0; enqueue(); }
      } catch { /* transient; try again next beat */ }
    }, HEARTBEAT_MS);
  }

  $("quickBtn").addEventListener("click", () => { sfx("click"); quickMatch(); });

  window.addEventListener("fleet:room", (e) => {
    if (!qm.mode) return;
    if (e.detail && e.detail.opp) { setSearching(false); return; } // walked into a waiting rival
    setSearching(true);
    if (qm.hopTo && qm.hopTo === F.S.room) {
      qm.hopTo = null;
      // We hopped to a rival's room but they're gone: give them a moment, then wait here ourselves.
      setTimeout(() => { if (qm.mode && !F.S.opp) enqueue(); }, 2500);
    } else {
      enqueue();
    }
  });
  window.addEventListener("fleet:lobby", () => { stopQuick(true); loadRanks(); refreshProfile(); });
  window.addEventListener("fleet:oppLeft", () => {
    if (!qm.mode || qm.searching) return;
    F.toast("Your rival left. Searching for a new one…");
    setSearching(true);
    enqueue();
  });
  window.addEventListener("pagehide", () => {
    if (!qm.searching || !qm.room) return;
    const body = JSON.stringify({ ...qmBody({ action: "cancel" }), token });
    try { navigator.sendBeacon("/api/quickmatch", new Blob([body], { type: "application/json" })); } catch { /* best effort */ }
  });
  // A rival joining our room ends the search immediately (not just on the next heartbeat).
  new MutationObserver(() => { if (qm.searching && F.S.opp) setSearching(false); })
    .observe($("oppName"), { childList: true, characterData: true, subtree: true });

  // ---------- result reporting ----------
  function ratingNote(parts) {
    const el = $("ovRating");
    el.innerHTML = "";
    parts.forEach(([text, cls]) => {
      const s = document.createElement("span");
      if (cls) s.className = cls;
      s.textContent = text;
      el.appendChild(s);
    });
  }

  window.addEventListener("fleet:gameover", async (e) => {
    const d = e.detail || {};
    ratingNote([]);
    if (!d.matchId || !d.opponentId) return;
    if (!token && !d.opponentVerified) { ratingNote([["Sign in to earn a rating and a place in the Hall."]]); return; }

    const ranked = !!token && d.opponentVerified;
    const before = profile ? { rating: profile.rating, games: profile.games } : null;
    ratingNote([[ranked ? "Recording ranked result…" : "Recording result…"]]);
    try {
      await api("/api/match", {
        room: d.room, matchId: d.matchId, opponentId: d.opponentId,
        won: d.won, shots: d.shots, hits: d.hits, maxCombo: d.maxCombo, id: F.S.me.id,
      });
    } catch (err) {
      ratingNote([[err.status === 403 ? "Rival left before the result was confirmed." : "Result not recorded."]]);
      return;
    }
    if (!token) { ratingNote([["Result sent. Sign in to earn a rating too."]]); return; }

    // The match settles once both captains have reported; poll our profile until it lands.
    for (const wait of [600, 1500, 3000, 6000]) {
      await new Promise((r) => setTimeout(r, wait));
      const p = await refreshProfile();
      if (p && before && p.games > before.games) {
        if (ranked) {
          const delta = p.rating - before.rating;
          ratingNote([[`★ ${p.rating} `], [`(${delta >= 0 ? "+" : ""}${delta})`, delta >= 0 ? "up" : "down"]]);
        } else {
          ratingNote([[`Unranked vs a guest · career ${p.wins}W ${p.losses}L`]]);
        }
        F.render();
        return;
      }
    }
    ratingNote([["Waiting for your rival to confirm the result."]]);
  });

  // ---------- public hooks used by game.js ----------
  window.FleetProfile = {
    publicInfo: () => (token && profile ? { verified: true, rating: profile.rating } : null),
    authParams: () => (token ? { token } : {}),
    accountName: () => (token && profile ? profile.name : ""),
  };

  renderAccount();
  refreshProfile();
  loadRanks();
})();
