// ==UserScript==
// @name         AIPASS Video Speed
// @namespace    local.aipass.video-speed
// @version      5.1.0
// @description  AIPASS video controls with custom speed, background playback, and completed-lesson continuation.
// @match        https://de.aipass.net/*
// @noframes
// @run-at       document-start
// @grant        none
// ==/UserScript==
(() => {
  'use strict';
  if (window.top !== window.self) return;
  const rateAPI = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
  const nativePause = HTMLMediaElement.prototype.pause;
  const key = 'aipass-speed-studio-v5';
  let desired = 2, enabled = false, keepPlaying = true, autoNext = true;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || localStorage.getItem('aipass-speed-v4') || '{}');
    if (Number.isFinite(saved.rate) && saved.rate >= 0.25 && saved.rate <= 16) desired = saved.rate;
    enabled = saved.enabled === true;
    keepPlaying = saved.keepPlaying !== false;
    autoNext = saved.autoNext !== false;
  } catch {}
  let video = null, originalRate, originalPause, getter, pauseWrapper, baseline = 1;
  let intent = false, manualUntil = 0, corrections = [], prevented = 0, failure = '';
  let returnGraceUntil = 0, resumeNeeded = false, lastResumeAt = -Infinity;
  let resumeDenied = false, recoveryGeneration = 0, resumeJob = null, playbackMessage = '';
  let host, output, input, checkbox, panel, toggle, liveRate, miniRate, badge, lockCheck, playerSelect, autoCheck, continueStatus, playbackStatus;
  let collapsed = false, dragPosition = null, lastScan = -Infinity, found = [], selectedId = 'auto';
  let optionSignature = '', nextId = 1;
  const ids = new WeakMap();
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    collapsed = saved.collapsed === true;
    if (Number.isFinite(saved.position?.x) && Number.isFinite(saved.position?.y)) dragPosition = saved.position;
  } catch {}
  const completionDialogs = new Map();
  let advanced = 0, continuationMessage = 'รอป๊อปอัปจบบทเรียน';
  let pendingPlayback = null, attemptingPlayback = false;
  const pendingKey = 'aipass-auto-continue-pending-v5';
  const nativePlay = HTMLMediaElement.prototype.play;
  try {
    const saved = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
    if (saved && Date.now() - saved.at < 30000 && Date.now() >= saved.at) pendingPlayback = saved;
  } catch {}
  const visible = element => {
    if (!element.isConnected || !element.getClientRects().length || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  function clearPending() {
    pendingPlayback = null;
    try { sessionStorage.removeItem(pendingKey); } catch {}
  }
  function checkCompletion() {
    if (!autoNext || !location.pathname.startsWith('/lms/lesson/')) {
      completionDialogs.clear();
      return;
    }
    const matches = new Set();
    for (const dialog of document.querySelectorAll('[role="dialog"][data-state="open"], dialog[open]')) {
      if (!visible(dialog)) continue;
      const text = dialog.textContent.replace(/\s+/g,'');
      if (!text.includes('ยินดีด้วย') || !text.includes('คุณเรียนจบบทเรียนนี้แล้ว')) continue;
      const button = [...dialog.querySelectorAll('button')].find(b =>
        b.textContent.replace(/\s+/g,'') === 'เรียนต่อ' &&
        !b.disabled && b.getAttribute('aria-disabled') !== 'true' && visible(b));
      if (!button) continue;
      matches.add(dialog);
      let entry = completionDialogs.get(dialog);
      if (!entry || entry.button !== button) {
        entry = {button, since:performance.now(), clicked:false};
        completionDialogs.set(dialog,entry);
      }
      if (entry.clicked) continue;
      continuationMessage = 'พบบทเรียนจบแล้ว · กำลังเรียนต่อ…';
      if (performance.now() - entry.since < 1000) continue;
      // Click only this exact completion action, once per visible dialog.
      entry.clicked = true;
      pendingPlayback = {
        at:Date.now(), from:location.href,
        source:video?.currentSrc || '', previous:video
      };
      try {
        sessionStorage.setItem(pendingKey, JSON.stringify({
          at:pendingPlayback.at, from:pendingPlayback.from, source:pendingPlayback.source
        }));
      } catch {}
      advanced++;
      continuationMessage = 'กดเรียนต่อแล้ว ' + advanced + ' ครั้ง';
      button.click();
    }
    for (const dialog of completionDialogs.keys()) {
      if (!matches.has(dialog)) completionDialogs.delete(dialog);
    }
  }
  function startNextVideo() {
    if (!pendingPlayback || !autoNext || attemptingPlayback) return;
    if (Date.now() - pendingPlayback.at > 30000) {
      clearPending(); continuationMessage = 'หากคลิปถัดไปยังไม่เล่น ให้กดเล่นหนึ่งครั้ง'; return;
    }
    // Never start an old completed video or guess a quiz action.
    if (!video || video.ended || video.readyState < 1 || !location.pathname.startsWith('/lms/lesson/')) return;
    if (location.href === pendingPlayback.from &&
        video.currentSrc === pendingPlayback.source &&
        (!pendingPlayback.previous || video === pendingPlayback.previous)) return;
    if (!video.paused) {clearPending();return;}
    attemptingPlayback = true;
    const next = video;
    Promise.resolve().then(() => {
      if (!autoNext || !pendingPlayback || next !== video) return;
      return nativePlay.call(next);
    }).then(() => {
      if (next === video && autoNext) continuationMessage = next.paused
        ? 'คลิปถัดไปพร้อมแล้ว · กดเล่นเพื่อเริ่ม' : 'เริ่มคลิปถัดไปแล้ว';
    }).catch(() => {
      continuationMessage = 'เบราว์เซอร์ไม่ให้เล่นอัตโนมัติ · กดเล่นหนึ่งครั้ง';
    }).finally(() => {attemptingPlayback=false;clearPending();render();});
  }
  const videoId = v => { if (!ids.has(v)) ids.set(v, String(nextId++)); return ids.get(v); };
  const labelFor = v => 'วิดีโอ ' + videoId(v) + (v.videoWidth ? ' · ' + v.videoWidth + '×' + v.videoHeight : '');
  function discoverVideos(scope, list) {
    scope.querySelectorAll('video').forEach(v => list.push(v));
    scope.querySelectorAll('*').forEach(el => {
      if (el !== host && el.shadowRoot) discoverVideos(el.shadowRoot, list);
    });
  }
  function pickVideo() {
    const now = performance.now();
    if (now - lastScan >= 2000 || !found.length || found.some(v => !v.isConnected)) {
      lastScan = now;
      const list = []; discoverVideos(document, list);
      found = [...new Set(list)].filter(v => v.isConnected);
    }
    const selected = found.find(v => videoId(v) === selectedId);
    if (selected) return selected;
    const visible = found.filter(v => v.getClientRects().length);
    const candidates = visible.length ? visible : found;
    if (video && candidates.includes(video) && !video.paused && !video.ended) return video;
    const area = v => { const r = v.getBoundingClientRect(); return r.width * r.height; };
    return [...candidates].sort((a,b) =>
      Number(!b.paused && !b.ended) - Number(!a.paused && !a.ended) || area(b) - area(a))[0] || null;
  }
  const buttons = [];
  const away = () => document.hidden || !document.hasFocus();
  function save() {
    try { localStorage.setItem(key, JSON.stringify({rate:desired, enabled, keepPlaying, autoNext, collapsed, position:dragPosition})); } catch {}
  }
  function restoreProperty(name, own, marker, kind) {
    const current = Object.getOwnPropertyDescriptor(video, name);
    if (current?.[kind] !== marker || !marker) return;
    if (own) Object.defineProperty(video, name, own);
    else delete video[name];
  }
  function recoveryAllowed() {
    return keepPlaying && intent && video && video.isConnected && !video.ended && !video.error &&
      performance.now() >= manualUntil &&
      (away() || performance.now() < returnGraceUntil || resumeNeeded);
  }
  function stopRecovery() {
    intent = false; resumeNeeded = false; resumeDenied = false;
    recoveryGeneration++; resumeJob = null; playbackMessage = '';
  }
  function onPlay() {
    intent = true; resumeNeeded = false; resumeDenied = false; playbackMessage = '';
  }
  function onPause() {
    // A native/cached pause() can bypass our per-element wrapper. Preserve the
    // user's playing intent during tab transitions and repair actual pauses.
    if (recoveryAllowed()) {
      resumeNeeded = true;
      recoverPlayback();
    } else stopRecovery();
  }
  function onEnded() { stopRecovery(); }
  function onEmptied() { stopRecovery(); }
  function recoverPlayback() {
    if (!recoveryAllowed() || !video.paused || video.readyState < 1 || resumeDenied || resumeJob) return;
    const now = performance.now();
    if (now - lastResumeAt < 1000) return;
    lastResumeAt = now;
    const target = video, generation = recoveryGeneration;
    const job = {}; resumeJob = job;
    Promise.resolve().then(() => {
      if (target !== video || generation !== recoveryGeneration || !recoveryAllowed() || !target.paused) return;
      return nativePlay.call(target);
    }).then(() => {
      if (target !== video || generation !== recoveryGeneration) return;
      resumeNeeded = target.paused;
      if (!target.paused) playbackMessage = 'เล่นต่อแล้วหลังสลับแท็บ';
    }).catch(error => {
      if (target !== video || generation !== recoveryGeneration) return;
      resumeNeeded = true;
      resumeDenied = error?.name === 'NotAllowedError' || error?.name === 'NotSupportedError';
      playbackMessage = resumeDenied ? 'กดเล่นที่คลิปหนึ่งครั้ง เพื่ออนุญาตให้เล่นต่อ' : 'กำลังลองเล่นต่ออีกครั้ง';
    }).finally(() => {
      if (resumeJob === job) resumeJob = null;
      render();
    });
  }
  function onPageTransition() {
    if (!keepPlaying || !intent || !video || video.ended) return;
    // Site focus/visibility handlers may pause immediately or after a delay.
    returnGraceUntil = performance.now() + 8000;
    resumeDenied = false;
    if (video.paused) resumeNeeded = true;
    recoverPlayback();
  }
  document.addEventListener('visibilitychange', onPageTransition, true);
  window.addEventListener('focus', onPageTransition, true);
  window.addEventListener('blur', onPageTransition, true);
  window.addEventListener('pageshow', onPageTransition, true);
  function unbind() {
    if (!video) return;
    restoreProperty('playbackRate', originalRate, getter, 'get');
    restoreProperty('pause', originalPause, pauseWrapper, 'value');
    video.removeEventListener('play', onPlay);
    video.removeEventListener('pause', onPause);
    video.removeEventListener('ended', onEnded);
    video.removeEventListener('emptied', onEmptied);
    stopRecovery();
    try { if (enabled) rateAPI.set.call(video, baseline); } catch {}
    getter = null; pauseWrapper = null;
  }
  function bind(next) {
    unbind();
    video = next; corrections = []; intent = false;
    returnGraceUntil = 0; lastResumeAt = -Infinity; manualUntil = 0;
    if (!video) return;
    baseline = rateAPI.get.call(video);
    originalRate = Object.getOwnPropertyDescriptor(video, 'playbackRate');
    originalPause = Object.getOwnPropertyDescriptor(video, 'pause');
    intent = !video.paused && !video.ended;
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('emptied', onEmptied);
    if (!originalRate || originalRate.configurable) {
      getter = function () { return rateAPI.get.call(this); };
      Object.defineProperty(video, 'playbackRate', {
        configurable:true, enumerable:originalRate?.enumerable ?? true,
        get:getter,
        set(value) {
          const rate = enabled && this === video ? desired : value;
          if (rateAPI.get.call(this) !== rate) rateAPI.set.call(this, rate);
        }
      });
    }
    if (!originalPause || originalPause.configurable) {
      const previousPause = video.pause;
      pauseWrapper = function (...args) {
        // Protect both leaving a tab and the grace period after returning to it.
        // Visibility and focus values remain unchanged for the rest of the page.
        if (this === video && recoveryAllowed()) {
          prevented++;
          return;
        }
        return (typeof previousPause === 'function' ? previousPause : nativePause).apply(this, args);
      };
      Object.defineProperty(video, 'pause', {configurable:true, writable:true, value:pauseWrapper});
    }
  }
  function render() {
    if (!output) return;
    host.hidden = !video && completionDialogs.size === 0;
    buttons.forEach(([button, rate]) => button.setAttribute('aria-pressed', String(enabled && desired === rate)));
    let actual = '?';
    try { if (video) actual = rateAPI.get.call(video); } catch {}
    liveRate.textContent = actual + '×';
    miniRate.textContent = actual + '×';
    badge.textContent = !video ? 'ไม่พบคลิป' : video.ended ? 'จบแล้ว' : video.paused ? 'หยุดอยู่' : 'กำลังเล่น';
    badge.dataset.state = video && !video.paused && !video.ended ? 'playing' : 'paused';
    lockCheck.checked = enabled;
    checkbox.checked = keepPlaying;
    autoCheck.checked = autoNext;
    continueStatus.textContent = autoNext ? continuationMessage : 'เรียนต่ออัตโนมัติปิดอยู่';
    playbackStatus.textContent = playbackMessage;
    playbackStatus.hidden = !playbackMessage;
    output.textContent = failure || (enabled
      ? 'ตั้งไว้ ' + desired + '× · ใช้จริง ' + actual + '×'
      : 'กำลังใช้ความเร็วจากตัวเล่น');
    output.dataset.error = String(Boolean(failure));
    const signature = found.map(v => videoId(v) + ':' + v.videoWidth + ':' + v.videoHeight).join(',');
    if (signature !== optionSignature) {
      optionSignature = signature;
      playerSelect.replaceChildren();
      const automatic = document.createElement('option');
      automatic.value = 'auto'; automatic.textContent = 'เลือกคลิปอัตโนมัติ';
      playerSelect.append(automatic);
      for (const v of found) {
        const option = document.createElement('option'); option.value = videoId(v); option.textContent = labelFor(v);
        playerSelect.append(option);
      }
      if (!found.some(v => videoId(v) === selectedId)) selectedId = 'auto';
      playerSelect.value = selectedId;
    }
    playerSelect.parentElement.hidden = found.length < 2;
    panel.classList.toggle('collapsed', collapsed);
    toggle.textContent = collapsed ? '+' : '−';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'ขยายแผงควบคุม' : 'ย่อแผงควบคุม');
    const fullscreen = document.fullscreenElement;
    // A replaced fullscreen <video> cannot contain a visible overlay.
    const parent = fullscreen && fullscreen.tagName !== 'VIDEO' ? fullscreen : document.body;
    if (parent && host.parentElement !== parent) parent.append(host);
  }
  function tick() {
    try {
      const next = pickVideo();
      if (next !== video) bind(next);
      if (video && enabled && Math.abs(rateAPI.get.call(video) - desired) > 0.001) {
        const now = performance.now();
        corrections = corrections.filter(t => now - t < 10000);
        if (corrections.length >= 12) {
          enabled = false; save();
          failure = 'หยุดตรึง: ตัวเล่นเปลี่ยนความเร็วกลับซ้ำ ๆ';
        } else {
          corrections.push(now);
          rateAPI.set.call(video, desired);
          video.preservesPitch = true;
        }
      }
    } catch (e) {
      enabled = false; save();
      failure = 'ตั้งค่าไม่สำเร็จ: ' + e.message;
    }
    render();
  }
  function choose(raw) {
    const rate = Number(raw);
    if (!Number.isFinite(rate) || rate < 0.25 || rate > 16) {
      failure = 'กรอกตัวเลขตั้งแต่ 0.25 ถึง 16 เช่น 2.5 หรือ 6';
      render(); return;
    }
    // Check browser support before committing the new preference.
    try { if (video) { if (!enabled) baseline = rateAPI.get.call(video); rateAPI.set.call(video, rate); } }
    catch (e) { failure = 'เบราว์เซอร์ไม่รับความเร็วนี้: ' + e.message; render(); return; }
    desired = rate; enabled = true; corrections = []; failure = '';
    if (input) input.value = String(rate); save(); tick();
  }
  function markManual(event) {
    if (!event.isTrusted || !video) return;
    const player = video.closest('.video-js') || video;
    const target = event.composedPath?.()[0] || event.target;
    // Typing in forms is not a request to pause the lesson.
    if (target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    if ((event.type === 'pointerdown' && player.contains(event.target)) ||
        (event.type === 'keydown' && [' ', 'k', 'K', 'MediaPlayPause', 'MediaPause'].includes(event.key))) {
      manualUntil = performance.now() + 1000;
      // Cancel a queued recovery before the player's own click/key handler runs.
      recoveryGeneration++; resumeJob = null; resumeNeeded = false;
    }
  }
  document.addEventListener('pointerdown', markManual, true);
  document.addEventListener('keydown', markManual, true);
  function clampPosition(x, y) {
    const rect = host.getBoundingClientRect();
    return {
      x: Math.max(8, Math.min(x, Math.max(8, window.innerWidth - rect.width - 8))),
      y: Math.max(8, Math.min(y, Math.max(8, window.innerHeight - rect.height - 8)))
    };
  }
  function place(x, y) {
    dragPosition = clampPosition(x, y);
    host.style.left = dragPosition.x + 'px'; host.style.top = dragPosition.y + 'px';
    host.style.right = 'auto'; host.style.bottom = 'auto';
  }
  function mount() {
    if (host || !document.body || !video || document.getElementById('video-speed-studio-v5')) return;
    host = document.createElement('div'); host.id = 'video-speed-studio-v5';
    host.style.cssText = 'all:initial;position:fixed;bottom:20px;right:20px;z-index:2147483647;display:block;line-height:normal;color-scheme:dark';
    const root = host.attachShadow({mode:'open'});
    const style = document.createElement('style');
    style.textContent = `
      :host([hidden]){display:none!important}
      *{box-sizing:border-box}
      .panel{font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#eaf1fb;
        width:320px;max-width:calc(100vw - 24px);border:1px solid #344457;border-radius:20px;
        background:linear-gradient(145deg,#172432f5,#0c141ff5);box-shadow:0 16px 60px #0006,0 2px 8px #0003;
        backdrop-filter:blur(20px);overflow:hidden}
      .header{display:flex;align-items:center;gap:10px;padding:14px 16px;cursor:grab;touch-action:none;user-select:none}
      .header:active{cursor:grabbing}
      .mark{display:grid;place-items:center;width:34px;height:34px;border-radius:11px;background:#b7f4d6;color:#12382b;font-size:19px;font-weight:800}
      .branding{flex:1;min-width:0}.brand{font-size:13px;font-weight:700;letter-spacing:.15px}
      .version{font-size:10px;letter-spacing:1.8px;color:#93a7ba}
      button,input,select{font:inherit}button{cursor:pointer}
      button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #b7f4d6;outline-offset:3px}
      .icon{width:30px;height:30px;border:1px solid #354456;border-radius:9px;background:#ffffff08;color:#bac9d9;font-size:20px;line-height:1}
      .body{padding:0 18px 16px;max-height:calc(100vh - 98px);overflow:auto;scrollbar-width:thin}
      .readout{display:flex;align-items:center;justify-content:space-between;padding:4px 0 12px}
      .eyebrow{font-size:11px;color:#a4b5c7}
      .number{display:block;font-size:40px;line-height:1.2;letter-spacing:-2px;font-weight:650;font-variant-numeric:tabular-nums;color:#d3fce6}
      .badge{font-size:10px;padding:5px 8px;border-radius:20px;color:#b5c3d1;background:#ffffff08;border:1px solid #ffffff10}
      .badge[data-state=playing]{color:#b7f4d6;background:#a8f0ce0d;border-color:#a8f0ce30}
      .presets{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:14px}
      .preset{border:1px solid #344355;border-radius:9px;padding:7px 0;background:#ffffff04;color:#c4d0dd;font-weight:600}
      .preset:hover,.icon:hover{background:#ffffff13}
      .preset[aria-pressed=true]{background:#b7f4d6;border-color:#b7f4d6;color:#163e2c}
      .custom-label,.players-label{display:block;font-size:11px;color:#a4b5c7;margin:0 0 6px}
      .custom-row{display:flex;gap:8px}
      .input-wrap{display:flex;align-items:center;flex:1;min-width:0;border:1px solid #3c4e61;border-radius:10px;background:#07121b80;overflow:hidden}
      .input-wrap input{width:100%;min-width:0;appearance:textfield;border:0;background:transparent;color:#edf5fc;padding:9px 10px;outline-offset:-3px;font-variant-numeric:tabular-nums}
      input::-webkit-inner-spin-button{appearance:none}
      .suffix{padding-right:12px;color:#8ba2b7}
      .apply{border:0;border-radius:10px;padding:8px 16px;background:#b7f4d6;color:#133c2b;font-weight:700}
      .apply:hover{background:#d0ffe5}
      .hint{font-size:10px;color:#91a5b9;margin:5px 0 13px}
      .settings{border-top:1px solid #ffffff10;border-bottom:1px solid #ffffff10;padding:5px 0}
      .setting{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;cursor:pointer}
      .setting-name{display:block;font-size:12px}.setting-note{display:block;color:#94a8bc;font-size:10px;margin-top:1px}
      .switch{appearance:none;flex:none;margin:0;width:32px;height:19px;border-radius:99px;background:#3e4e60;border:0;position:relative;cursor:pointer;transition:background .15s}
      .switch:before{content:"";position:absolute;left:3px;top:3px;width:13px;height:13px;border-radius:50%;background:#e8eff7;transition:transform .15s}
      .switch:checked{background:#b7f4d6}.switch:checked:before{transform:translateX(13px);background:#214636}
      .players{margin-top:12px}.players[hidden]{display:none}
      select{width:100%;color:#d8e6f3;background:#172432;border:1px solid #344355;border-radius:8px;padding:7px}
      .status{font-size:10px;color:#9cbbad;margin:11px 0 0;overflow-wrap:anywhere}
      .status[data-error=true]{color:#ffbdad}
      .footer{display:flex;justify-content:space-between;align-items:center;margin-top:9px;color:#8197ad;font-size:9px}
      .reset{background:none;border:0;padding:0;color:#b2c4d4;font-size:10px;text-decoration:underline;text-underline-offset:3px}
      .mini{display:none;font-size:12px;color:#b7f4d6;font-weight:650;font-variant-numeric:tabular-nums}
      .collapsed{width:224px;border-radius:16px}.collapsed .body{display:none}.collapsed .mini{display:block}
      .collapsed .header{padding:10px 12px}.collapsed .version{display:none}.collapsed .mark{width:28px;height:28px;font-size:16px}
      @media(prefers-reduced-motion:reduce){*{transition:none!important}}
    `;
    const el = (tag, cls, text) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    panel = el('section','panel');
    panel.setAttribute('aria-label','AIPASS Video Studio');
    const header = el('div','header');
    header.title = 'ลากเพื่อย้ายแผงควบคุม';
    const mark = el('span','mark','▷');
    const branding = el('div','branding');
    branding.append(el('div','brand','AIPASS'),el('div','version','VIDEO STUDIO / V5.1'));
    miniRate = el('span','mini');
    toggle = el('button','icon','−'); toggle.type = 'button';
    const body = el('div','body');
    body.id = 'vss-controls'; toggle.setAttribute('aria-controls',body.id);
    toggle.addEventListener('click', () => {
      collapsed = !collapsed; save(); render();
      if (dragPosition) place(dragPosition.x, dragPosition.y);
    });
    header.append(mark,branding,miniRate,toggle);
    const readout = el('div','readout');
    const value = el('div');
    liveRate = el('strong','number','1×');
    value.append(el('span','eyebrow','ความเร็วที่เล่นจริง'),liveRate);
    badge = el('span','badge','พร้อมเล่น');
    readout.append(value,badge);
    const presets = el('div','presets');
    for (const rate of [1,1.5,2,4,8]) {
      const button = el('button','preset',rate+'×'); button.type = 'button';
      button.addEventListener('click', () => choose(rate));
      presets.append(button); buttons.push([button,rate]);
    }
    const form = el('form');
    const label = el('label','custom-label','กำหนดความเร็วเอง'); label.htmlFor = 'vss-rate';
    const row = el('div','custom-row');
    const inputWrap = el('div','input-wrap');
    input = el('input'); input.id = 'vss-rate'; input.type = 'number';
    input.min = '0.25'; input.max = '16'; input.step = 'any'; input.required = true;
    input.inputMode = 'decimal'; input.value = String(desired);
    inputWrap.append(input,el('span','suffix','×'));
    const apply = el('button','apply','ใช้ค่า'); apply.type = 'submit';
    row.append(inputWrap,apply);
    form.append(label,row,el('div','hint','0.25–16× · เช่น 2.5 หรือ 6'));
    form.addEventListener('submit', event => {event.preventDefault();choose(input.value);});
    const settings = el('div','settings');
    const setting = (name,note) => {
      const label = el('label','setting');
      const text = el('span'); text.append(el('span','setting-name',name),el('span','setting-note',note));
      const check = el('input','switch'); check.type = 'checkbox';
      label.append(text,check); settings.append(label);
      return check;
    };
    lockCheck = setting('ตรึงความเร็ว','รักษาค่าที่เลือกเมื่อเว็บเปลี่ยนค่า');
    lockCheck.checked = enabled;
    lockCheck.addEventListener('change', () => {
      if (lockCheck.checked) choose(input.value);
      else {
        enabled = false; save(); failure = '';
        try { if (video) rateAPI.set.call(video,baseline); } catch(e) {failure=e.message;}
        render();
      }
    });
    checkbox = setting('เล่นต่อเมื่อสลับแท็บ','เล่นต่อเองทั้งตอนออกและกลับมา');
    checkbox.checked = keepPlaying;
    checkbox.addEventListener('change', () => {
      keepPlaying=checkbox.checked;
      if (!keepPlaying) stopRecovery();
      else { intent=Boolean(video && !video.paused && !video.ended); onPageTransition(); }
      save();render();
    });
    autoCheck = setting('เรียนต่ออัตโนมัติ','กดเรียนต่อเมื่อมีป๊อปอัปจบบทเรียน');
    autoCheck.checked = autoNext;
    autoCheck.addEventListener('change', () => {
      autoNext=autoCheck.checked;
      if(!autoNext){completionDialogs.clear();clearPending();}
      save();render();
    });
    continueStatus = el('p','status');
    playbackStatus = el('p','status'); playbackStatus.hidden = true;
    const players = el('div','players'); players.hidden = true;
    const playersLabel = el('label','players-label','คลิปที่ควบคุม'); playersLabel.htmlFor='vss-player';
    playerSelect = el('select'); playerSelect.id='vss-player';
    playerSelect.addEventListener('change', () => {selectedId=playerSelect.value;tick();});
    players.append(playersLabel,playerSelect);
    output = el('p','status');
    const footer = el('div','footer');
    const reset = el('button','reset','คืนค่า 1×'); reset.type='button';
    reset.addEventListener('click', () => choose(1));
    footer.append(el('span',null,window.top===window.self?'HTML5 VIDEO':'EMBEDDED VIDEO'),reset);
    body.append(readout,presets,form,settings,players,output,playbackStatus,continueStatus,footer);
    panel.append(header,body);root.append(style,panel);document.body.append(host);

    let dragging = null;
    header.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.composedPath().includes(toggle)) return;
      const rect = host.getBoundingClientRect();
      dragging = {id:event.pointerId,dx:event.clientX-rect.left,dy:event.clientY-rect.top};
      header.setPointerCapture(event.pointerId);event.preventDefault();
    });
    header.addEventListener('pointermove', event => {
      if (!dragging || event.pointerId !== dragging.id) return;
      place(event.clientX-dragging.dx,event.clientY-dragging.dy);
    });
    const endDrag = () => {if(dragging){dragging=null;save();}};
    header.addEventListener('pointerup',endDrag);
    header.addEventListener('pointercancel',endDrag);
    header.addEventListener('lostpointercapture',endDrag);
    window.addEventListener('resize', () => {
      if(dragPosition)place(dragPosition.x,dragPosition.y);
    });
    render();
    if (dragPosition)place(dragPosition.x,dragPosition.y);
  }
  function run() {tick();checkCompletion();startNextVideo();recoverPlayback();mount();render();}
  if (document.readyState === 'loading')document.addEventListener('DOMContentLoaded',run,{once:true});
  else run();
  setInterval(run,500);
})();

