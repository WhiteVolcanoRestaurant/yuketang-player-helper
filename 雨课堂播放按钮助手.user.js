// ==UserScript==
// @name         雨课堂播放按钮助手（自动切课验证版）
// @namespace    local.yuketang.click-player
// @version      1.5.5
// @description  完成后切课；漏记整段补播一次；断网暂停及有限恢复；弹窗后手动继续。
// @match        https://*.yuketang.cn/ai-workspace/lms-graph/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  if (document.getElementById('ykt-click-helper')) return;
  const LIMITS = { start: 12000, movement: 45000, progress: 180000, end: 60000,
    pauseGrace: 1500, recoveryGap: 10000, recoveryAttempts: 3,
    switch: 20000, settle: 2000, offline: 300000 };
  const box = document.createElement('div');
  box.id = 'ykt-click-helper';
  box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:white;color:#222;padding:12px;border:1px solid #aaa;border-radius:8px;max-width:360px;font:14px/1.5 sans-serif';
  const title = document.createElement('strong');
  title.textContent = '雨课堂助手 · 1.5.5 远程操作兼容版';
  const status = document.createElement('div');
  status.textContent = '完成度 100% 或显示“已完成”后切课；请展开目录并保持标签页静音。';
  const start = document.createElement('button');
  start.textContent = '开始连续播放';
  const stop = document.createElement('button');
  stop.textContent = '停止并暂停';
  const debug = document.createElement('button');
  debug.textContent = '诊断';
  box.append(title, status, start, stop, debug);
  const guide = document.createElement('div');
  guide.style.cssText = 'margin-top:8px;font-size:12px;color:#555;white-space:pre-line';
  guide.textContent = '使用步骤：展开左侧目录 → 将浏览器标签页静音 → 点击开始连续播放。\n完成度 100% 或播放器上方显示“已完成”才切课；漏记时从头补播一次。打开详情会停止，关闭后请重新点击助手开始。';
  box.append(guide);
  document.body.append(box);

  let session = null;
  let lastStop = null;
  let manualPauseAt = -Infinity;
  // 本页同一课程的补播额度不因停止/重新开始而重置。
  const replayedCourses = new Set();
  const events = [];
  const visible = el => {
    if (!el?.isConnected) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const video = () => [...document.querySelectorAll('video.xt_video_player')].find(visible);
  const route = () => location.pathname + location.search + (location.hash || '');
  // 远程操作或浏览器工具栏可夺走键盘焦点，但可见课程页仍能运行。
  // hasFocus 仅用于诊断；不伪造 hidden/visibilityState 或拦截页面事件。
  const pageVisible = () => !document.hidden;
  // 借鉴参考项目的 classroom/type/leaf/node 标识，不以临时视频源区分课程。
  function courseIdentity() {
    const match = location.pathname.match(/^\/ai-workspace\/lms-graph\/([^/]+)\/([^/]+)\/([^/]+)/);
    if (!match) return route();
    const nodeId = new URLSearchParams(location.search).get('node_id') || '';
    return `${match[1]}/${match[2]}/${match[3]}?node_id=${nodeId}`;
  }
  const hasDialog = () => [...document.querySelectorAll('.el-dialog__wrapper,.el-message-box__wrapper,[role="dialog"]')].some(visible);
  const overlay = v => v?.closest('.xt_video_player_container')?.querySelector('xt-bigbutton');
  const centralShown = v => visible(overlay(v));
  const say = (message, instruction) => {
    status.textContent = message;
    if (instruction) guide.textContent = instruction;
    console.info('[雨课堂助手]', message);
  };
  function record(type) {
    const v = session?.v;
    events.push({ at: new Date().toISOString(), type, time: v?.currentTime,
      paused: v?.paused, ended: v?.ended, visibility: document.visibilityState,
      focused: document.hasFocus() });
    if (events.length > 24) events.shift();
  }
  document.addEventListener('visibilitychange', () => record('visibilitychange'));
  window.addEventListener('blur', () => record('window.blur'));
  window.addEventListener('focus', () => record('window.focus'));
  window.addEventListener('offline', () => {
    record('network.offline');
    if (session) tick();
  });
  window.addEventListener('online', () => {
    record('network.online');
    if (session) tick();
  });
  // 用户主动点播放器暂停时，不自动把它重新打开。
  document.addEventListener('click', event => {
    const v = session?.v;
    if (!event.isTrusted || !v || v.paused || box.contains(event.target)) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('xt-playbutton,xt-videomask,xt-bigbutton') &&
        v.closest('.xt_video_player_container')?.contains(target)) {
      manualPauseAt = Date.now();
      record('user.player-toggle');
    }
  }, true);

  // 只读取整个播放器上方的当前视频状态。完成后百分比可能被“已完成”替换。
  function completionState(v) {
    if (!v) return { value: null, labels: [] };
    // 宽屏视频可能留有黑边，标题状态仍位于整个播放器的右上角。
    const vr = v.closest('.xt_video_player_container')?.getBoundingClientRect?.() || v.getBoundingClientRect();
    const right = vr.right ?? vr.left + vr.width;
    const values = [];
    const labels = new Set();
    for (const el of document.querySelectorAll('span,div,p,a,button,strong')) {
      if (box.contains(el) || !visible(el)) continue;
      if (el.closest('.nav-item-leaf-box,.el-dialog__wrapper,.el-message-box__wrapper,[role="dialog"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.left < vr.left - 10 || (r.right ?? r.left + r.width) > right + 10 ||
          r.bottom > vr.top + 10 || r.top < vr.top - 100) continue;
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (text.length > 100) continue;
      const m = text.match(/完成度\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/);
      if (m) {
        const value = Number(m[1]);
        if (value >= 0 && value <= 100) { values.push(value); labels.add(m[0]); }
      }
      // 精确匹配短状态，避免将“未完成”或说明文字当作完成。
      if (/^已完成(?:\s*详情)?$/.test(text)) { values.push(100); labels.add('已完成'); }
    }
    const unique = [...new Set(values)];
    return { value: unique.length === 1 ? unique[0] : null, labels: [...labels] };
  }
  const progress = v => completionState(v).value;
  function finish(message, pause = true) {
    const previous = session;
    const target = previous?.phase === 'switching' ? video() || previous.v : previous?.v;
    // 必须在助手 pause() 之前记录，否则事后 paused=true 无法证明暂停来源。
    lastStop = { reason: message, helperWillPause: Boolean(pause && target?.isConnected && !target.paused), before: inspect() };
    console.info('[雨课堂助手停止前状态]', JSON.stringify(lastStop, null, 2));
    if (lastStop.helperWillPause) record('helper.pause-before-stop');
    session = null;
    if (previous) {
      clearInterval(previous.timer);
      previous.release();
      if (pause && target?.isConnected) target.pause();
    }
    start.disabled = false;
    say(message, '助手已停止。先按状态提示处理问题，再点击“开始连续播放”继续。\n打开过详情弹窗：关闭弹窗后点击助手开始；只点播放器 Play 不会恢复自动切课。\n补播仍未完成：查看观看日志或手动刷新核对，必要时手动补看。');
  }
  function inspect() {
    const v = video();
    const completion = completionState(v);
    return { version: '1.5.5', phase: session?.phase || 'stopped',
      pageEligible: pageVisible(),
      switchEvidence: session?.switchEvidence || null,
      recoveryAttempts: session?.attempts || 0,
      replayUsed: Boolean(session && replayedCourses.has(session.courseKey)),
      online: navigator.onLine !== false,
      paused: v?.paused, ended: v?.ended, currentTime: v?.currentTime,
      duration: v?.duration, readyState: v?.readyState, muted: v?.muted,
      defaultMuted: v?.defaultMuted, volume: v?.volume,
      centralPlayVisible: centralShown(v), completion: completion.value,
      completionLabels: completion.labels,
      visibility: document.visibilityState, focused: document.hasFocus(),
      userActivation: navigator.userActivation ? {
        isActive: navigator.userActivation.isActive,
        hasBeenActive: navigator.userActivation.hasBeenActive
      } : null, recentEvents: events.slice() };
  }
  debug.onclick = () => {
    console.info('[雨课堂助手诊断]', JSON.stringify({ ...inspect(), lastStop }, null, 2));
    // 不覆盖监测状态，避免下次 tick 重复输出同一条成功日志。
  };
  function playerMute(v) {
    const control = v.closest('.xt_video_player_container')?.querySelector('xt-volumebutton');
    const icon = control?.querySelector('xt-icon');
    if (!control || !icon) throw new Error('未找到播放器音量按钮。');
    if (!icon.classList.contains('xt_video_player_common_icon_muted')) {
      const r = control.getBoundingClientRect();
      control.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true, clientX: r.left, clientY: r.top
      }));
      icon.click();
    }
    if (!icon.classList.contains('xt_video_player_common_icon_muted')) {
      throw new Error('播放器内部静音图标未确认。');
    }
    // 播放器会清除 muted/defaultMuted。通过内部静音及实际零音量确认无声。
    v.volume = 0;
    if (v.volume !== 0) throw new Error('实际零音量未确认。');
  }
  function requestStart(v) {
    const layer = overlay(v);
    const button = layer?.querySelector('button.xt_video_bit_play_btn');
    if (!visible(layer) || !visible(button)) throw new Error('未找到可见中央 Play。');
    if (!window.PointerEvent) throw new Error('浏览器不支持已确认的 PointerEvent 路径。');
    const r = button.getBoundingClientRect();
    // 源码确认的唯一启动事件；不调用 video.play 或补发其他鼠标事件。
    button.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, composed: true, pointerId: 1, pointerType: 'mouse',
      isPrimary: true, button: 0, buttons: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
    }));
  }
  function requestReplay(s) {
    const v = s.v;
    if (replayedCourses.has(s.courseKey)) {
      finish(`整段补播后等待 60 秒仍未确认 100%（当前 ${s.latest}%）；已停止，请打开观看日志或手动刷新核对。`);
      return;
    }
    if (!Number.isFinite(v.duration) || v.duration <= 0) throw new Error('无法读取视频时长，不能确认整段补播；请手动核对。');
    const container = v.closest('.xt_video_player_container');
    // 源码中进度条 click 会触发 xt.progress.seek，再定位媒体并上报。
    container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    const bar = container.querySelector('xt-progress.xt_video_player_progress');
    const wrap = bar?.querySelector('.xt_video_player_seek_handle_wrap');
    if (!visible(bar) || !visible(wrap) || getComputedStyle(bar).pointerEvents === 'none') {
      throw new Error('播放器进度条不可用；请手动将进度拖回开头，再点击助手开始。');
    }
    replayedCourses.add(s.courseKey);
    s.replaying = true;
    s.replayDeadline = Date.now() + Math.max(120000, v.duration * 1500 + LIMITS.end);
    s.phase = 'replay-seeking';
    s.started = Date.now();
    s.endedAt = null;
    s.advanced = 0;
    playerMute(v);
    v.playbackRate = 1;
    record('helper.replay-request');
    say(`结束后等待 60 秒仍为 ${s.latest}%；正在请求从头补播（本节仅一次）。`,
      '请保持课程页在前台并保持标签页静音。助手会确认回到开头后以 1 倍速补播；达到 100% 才切课。\n已记录区间可能不会增加完成度，补播期间会继续等待。再次播放结束仍不足 100% 时，请手动核对观看日志。');
    const r = wrap.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    bar.dispatchEvent(new MouseEvent('click', {
      bubbles: true, clientX: r.left, clientY: br.top + br.height / 2
    }));
  }
  function handleNetwork(s, now) {
    if (navigator.onLine === false && s.phase !== 'network-wait') {
      if (s.phase === 'switching') throw new Error('切课期间检测到断网，已停止；联网后确认当前课程，再点击助手开始。');
      s.networkPhase = s.phase;
      s.phase = 'network-wait';
      s.offlineAt = now;
      if (!s.v.paused) s.v.pause();
      record('helper.offline-pause');
      say('检测到断网，已暂停；等待联网且课程页回到前台（最多 5 分钟）。',
        '请检查网络并回到课程页。联网不代表观看记录已上传，恢复后仍会检查完成度。\n无需重复点击开始；点击“停止并暂停”可取消等待。');
    }
    if (s.phase !== 'network-wait') return false;
    if (now - s.offlineAt >= LIMITS.offline) throw new Error('断网或等待前台已超过 5 分钟，已停止；联网后点击助手开始。');
    if (navigator.onLine === false || !pageVisible()) {
      if (!s.v.paused) s.v.pause();
      return true;
    }
    const elapsed = now - s.offlineAt;
    s.lastIncrease += elapsed;
    s.lastMovement = now;
    s.lastTime = s.v.currentTime;
    s.started = now;
    if (s.endedAt !== null) s.endedAt += elapsed;
    if (s.networkPhase === 'waiting-next') {
      s.phase = 'waiting-next';
      s.nextWaitAt = now;
      return false;
    }
    if (s.networkPhase === 'waiting-completion' || s.v.ended) {
      s.phase = 'waiting-completion';
      say('网络已恢复；继续等待平台完成度更新。', '请保持页面在前台。若等待结束仍不足 100%，助手会尝试一次整段补播。');
      return false;
    }
    if (s.networkPhase === 'replay-seeking') throw new Error('补播定位期间发生断网，已停止；请手动回到开头后点击助手开始。');
    if (s.attempts >= LIMITS.recoveryAttempts) throw new Error('本节已尝试恢复 3 次，已停止；请检查网络及观看日志。');
    s.attempts++;
    s.lastAttempt = now;
    s.recoveryStarted = now;
    s.recoveryProgress = s.latest;
    s.advanced = 0;
    s.pauseAt = null;
    s.phase = 'recovering';
    playerMute(s.v);
    if (s.v.paused || centralShown(s.v)) requestStart(s.v);
    s.lastTime = s.v.currentTime;
    record('helper.network-recovery-request');
    say(`联网且页面已在前台；请求恢复（${s.attempts}/${LIMITS.recoveryAttempts}），等待播放及完成度验证。`,
      '请保持课程页在前台。播放恢复后仍需确认完成度；启动被浏览器阻止时，请手动点击中央 Play，再点击助手开始。');
    return true;
  }
  // 沿用早期目录识别方式，只选择当前课程后面的下一视频。
  const directoryRows = () => [...document.querySelectorAll('.nav-item-leaf-box')];
  const rowSelected = row => row.matches('.is-active') || Boolean(row.querySelector('.leaf-item.is-active,.is-active'));
  function rowSignature(row) {
    const item = row.querySelector('.leaf-item') || row.firstElementChild;
    // 不含完成图标/选中 class，这些会在正常切课时变化。
    const title = item?.querySelector('.leaf-item-title');
    const tag = item?.querySelector('.leaf-item-tag');
    const link = item?.matches('a') ? item : item?.querySelector('a');
    return [tag?.textContent || '', title?.textContent || (item?.innerText || '').trim(),
      link?.getAttribute('href') || ''].join('|');
  }
  function nextVideo() {
    const rows = directoryRows();
    const selected = rows.filter(rowSelected);
    if (selected.length !== 1) throw new Error('无法唯一确定左侧选中课程，已停止。');
    const index = rows.indexOf(selected[0]);
    for (const row of rows.slice(index + 1)) {
      const item = row.querySelector('.leaf-item') || row.firstElementChild;
      if (!item) continue;
      const text = (item.innerText || '').replace(/\s+/g, ' ').trim();
      const link = item.matches('a') ? item : item.querySelector('a');
      const isVideo = /^视频(?:\s|Video|$)/i.test(text) || /\/video\//.test(link?.getAttribute('href') || '') || Boolean(item.querySelector('[class*="shipin"]'));
      if (!isVideo) continue;
      if (!visible(item) || item.matches('.is-disable,[aria-disabled="true"]') ||
          row.matches('.is-disable,[aria-disabled="true"]') || item.querySelector('.is-disable,[aria-disabled="true"]')) {
        throw new Error('下一视频尚未显示或不可点击，请展开目录后重试。');
      }
      return { item, index: rows.indexOf(row), rowCount: rows.length, signature: rowSignature(row) };
    }
    return null;
  }
  const mediaSource = v => v?.currentSrc || v?.src || '';
  function advanceCourse(s) {
    if (!pageVisible()) {
      if (s.phase !== 'waiting-next') {
        s.phase = 'waiting-next';
        s.nextWaitAt = Date.now();
        say('页面完成度已确认 100%；标签页已隐藏，等待课程页重新可见后切课。');
      }
      if (Date.now() - s.nextWaitAt > LIMITS.movement) throw new Error('完成后 45 秒课程页仍被隐藏，已停止切课。');
      return;
    }
    const next = nextVideo();
    if (!next) {
      finish('页面完成度已确认 100%；当前已加载目录中没有下一视频。请确认是否还需展开或加载目录。');
      return;
    }
    // 点击前记录状态；切换期间不走当前视频的播放器变化/时间超时检查。
    s.phase = 'switching';
    // 仅存目标描述，点击后不再依赖旧 DOM 元素。
    const { item, ...target } = next;
    s.next = target;
    s.oldSource = mediaSource(s.v);
    s.switchAt = Date.now();
    s.readyAt = null;
    s.switchEvidence = null;
    s.release();
    s.release = () => {};
    // 目录/播放器经 Vue 重建时立即唤醒检查；500ms 定时检查仍作为兜底。
    if (typeof MutationObserver === 'function') {
      let wake = null;
      const observer = new MutationObserver(changes => {
        if (session !== s || s.phase !== 'switching' || wake !== null ||
            !changes.some(change => !box.contains(change.target))) return;
        wake = setTimeout(() => {
          wake = null;
          if (session === s && s.phase === 'switching') tick();
        }, 50);
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'src'] });
      s.release = () => { observer.disconnect(); if (wake !== null) clearTimeout(wake); };
    }
    if (!s.v.paused) s.v.pause();
    record('helper.next-course');
    say('页面完成度已确认 100%；已点击下一视频，等待课程及播放器更新。');
    item.click();
  }
  function beginCurrent(v) {
      if (!v || v.readyState < 1) throw new Error('视频尚未就绪。');
      if (hasDialog()) throw new Error('检测到弹窗；请先关闭，再点击助手“开始连续播放”。');
      if (navigator.onLine === false) throw new Error('当前已断网；请联网后点击助手开始。');
      if (!pageVisible()) throw new Error('课程标签页已隐藏，请切回课程标签页后开始。');
      const initial = progress(v);
      if (initial === null) throw new Error('无法唯一识别当前视频完成度。');
      if (initial !== 100 && v.readyState < 2) throw new Error('视频尚未就绪。');
      const now = Date.now();
      const timer = session?.timer ?? null;
      session?.release();
      session = { v, route: route(), initial, latest: initial, started: now,
        courseKey: courseIdentity(), replaying: false,
        lastIncrease: now, lastMovement: now, lastTime: v.currentTime,
        advanced: 0, phase: 'starting', endedAt: null, timer, release: () => {},
        attempts: 0, lastAttempt: -Infinity, pauseAt: null, recoveryStarted: null,
        recoveryProgress: null };
      if (replayedCourses.has(session.courseKey)) {
        // 用户检查弹窗后手动继续，也可能仍在经过已记录区间。
        session.replaying = true;
        session.replayDeadline = now + Math.max(120000,
          (Number.isFinite(v.duration) ? v.duration : 0) * 1500 + LIMITS.end);
      }
      manualPauseAt = -Infinity;
      const bindings = ['play', 'playing', 'pause', 'ended', 'waiting', 'stalled', 'seeking', 'seeked', 'error']
        .map(type => [type, () => record(`media.${type}`)]);
      for (const [type, handler] of bindings) v.addEventListener(type, handler);
      session.release = () => {
        for (const [type, handler] of bindings) v.removeEventListener(type, handler);
      };
      start.disabled = true;
      record('helper.start');
      playerMute(v);
      v.playbackRate = 1;
      // 同步发送，保留用户点击助手按钮的真实用户激活。
      if (initial !== 100 && (v.paused || centralShown(v))) requestStart(v);
      session.lastTime = v.currentTime;
      say(initial === 100 ? '页面完成度已是 100%；准备切换下一视频。' : '已请求启动；等待播放、零音量及完成度验证。');
      guide.textContent = '正在连续播放：完成度 100% 或显示“已完成” → 切换下一视频。\n保持课程标签页可见即可，鼠标位置和键盘焦点不影响切课。\n结束后未确认完成：等待 60 秒 → 从头补播一次 → 再次未完成则停止。\n断网自动暂停，联网且课程页可见后有限恢复。打开详情会停止，关闭后请点击助手开始。';
      if (session.timer === null) session.timer = setInterval(tick, 500);
  }
  start.onclick = () => {
    if (session) return;
    try { beginCurrent(video());
    } catch (error) { finish(error.message || String(error)); }
  };
  function tick() {
    const s = session;
    if (!s) return;
    const v = s.v;
    const now = Date.now();
    try {
      if (hasDialog()) throw new Error('检测到弹窗，已停止并暂停；关闭弹窗后点击助手“开始连续播放”继续。');
      if (s.phase !== 'switching' && (route() !== s.route || !v.isConnected || video() !== v)) throw new Error('课程或播放器变化，已停止。');
      if (handleNetwork(s, now)) return;
      if (s.phase === 'switching') {
        const latest = video();
        // 不保留旧 row 引用：切课会重建目录，即使目标课程已选中旧 row 也可能断开。
        const rows = directoryRows();
        const selectedIndexes = rows.map((row, index) => rowSelected(row) ? index : -1).filter(index => index >= 0);
        const target = rows[s.next.index];
        // 目录可继续追加/移除目标后面的资源；总条数变化不代表切课失败。
        const selected = selectedIndexes.length === 1 &&
          selectedIndexes[0] === s.next.index && target && rowSignature(target) === s.next.signature;
        const changed = latest && route() !== s.route &&
          (latest !== v || (mediaSource(latest) && mediaSource(latest) !== s.oldSource));
        const completion = progress(latest);
        s.switchEvidence = { routeChanged: route() !== s.route,
          playerChanged: Boolean(latest && latest !== v),
          sourceChanged: Boolean(latest && mediaSource(latest) && mediaSource(latest) !== s.oldSource),
          targetIndex: s.next.index, selectedIndexes, targetSelected: Boolean(selected),
          directoryCountBefore: s.next.rowCount, directoryCountNow: rows.length,
          readyState: latest?.readyState, completion };
        // 下一课若由平台自动播放，尽早静音，不等完成度标签稳定后才处理。
        if (changed && latest.readyState >= 1) {
          playerMute(latest);
          // 已完成课若由平台自动播放，先暂停，确认完成状态后继续跳过。
          if (selected && completion === 100 && !latest.paused) latest.pause();
        }
        const ready = changed && selected && completion !== null &&
          latest.readyState >= (completion === 100 ? 1 : 2);
        if (ready) {
          if (s.readyAt === null || s.readyVideo !== latest || s.readySource !== mediaSource(latest) || s.readyRoute !== route()) {
            s.readyAt = now;
            s.readyVideo = latest;
            s.readySource = mediaSource(latest);
            s.readyRoute = route();
          }
          if (now - s.readyAt >= LIMITS.settle) {
            if (!pageVisible()) throw new Error('切课后课程标签页已隐藏，已停止；请切回课程标签页后开始。');
            beginCurrent(latest);
            return;
          }
        } else s.readyAt = null;
        if (now - s.switchAt >= LIMITS.switch) {
          const e = s.switchEvidence;
          const missing = [!e.routeChanged && '课程地址未变化', !e.targetSelected && '最新目录未选中目标课',
            !(e.playerChanged || e.sourceChanged) && '播放器/视频源未更新',
            !(e.readyState >= (completion === 100 ? 1 : 2)) && '媒体未就绪',
            completion === null && '完成状态未识别'].filter(Boolean).join('、') || '页面未稳定满 2 秒';
          throw new Error(`20 秒内未确认下一课程：${missing}；已停止，不重复点击。`);
        }
        return;
      }
      if (route() !== s.route || !v.isConnected || video() !== v) throw new Error('课程或播放器变化，已停止。');
      if (v.error) throw new Error(`媒体错误 code=${v.error.code}，已停止。`);
      if (v.volume !== 0) throw new Error('实际音量恢复为非零，已暂停。');
      const p = progress(v);
      if (p === null) throw new Error('当前视频完成度无法识别，已停止。');
      if (p < s.latest) throw new Error('完成度回退，已停止。');
      const increased = p > s.latest;
      if (increased) { s.latest = p; s.lastIncrease = now; }
      if (p === 100) {
        advanceCourse(s);
        return;
      }
      if (s.replaying && now >= s.replayDeadline) throw new Error('本节整段补播已超时，已停止；请检查网络并核对观看日志。');
      if (s.phase === 'replay-seeking') {
        if (!pageVisible()) throw new Error('补播定位期间课程标签页已隐藏，已停止；切回课程页后点击助手开始。');
        if (!v.seeking && !v.ended && v.currentTime <= 2) {
          s.phase = 'starting';
          s.started = now;
          s.lastMovement = now;
          s.lastTime = v.currentTime;
          if (v.paused || centralShown(v)) requestStart(v);
          s.lastTime = v.currentTime;
          say('已确认回到开头；开始本节唯一一次整段补播，等待完成度 100%。');
        } else if (now - s.started >= LIMITS.start) {
          throw new Error('12 秒内未确认回到开头，已停止，不重复点击；请手动回到开头后点击助手开始。');
        }
        return;
      }
      // ended 是等待平台更新的起点，不能据此宣称完成，也不能立即判失败。
      if (v.ended || s.phase === 'waiting-completion') {
        if (s.endedAt === null) {
          s.endedAt = now;
          s.phase = 'waiting-completion';
          say(`视频已结束；页面完成度 ${p}%，等待更新到 100%（最多 60 秒）。`);
        } else if (increased) {
          say(`视频已结束；页面完成度更新到 ${p}%，继续等待 100%。`);
        }
        if (now - s.endedAt >= LIMITS.end) {
          if (replayedCourses.has(s.courseKey)) requestReplay(s);
          else if (!pageVisible()) {
            if (now - s.endedAt >= LIMITS.end + LIMITS.movement) throw new Error('补播前等待前台超过 45 秒，已停止；回到课程页后点击助手开始。');
            say('结束后仍不足 100%；请回到课程页前台，以便尝试一次从头补播。');
          } else requestReplay(s);
        }
        return; // 结束后的 paused 和时间不动属于正常状态。
      }
      const delta = v.currentTime - s.lastTime;
      if (delta < -0.1) s.advanced = 0;
      if (delta > 0.1 && !v.seeking) {
        s.advanced += delta;
        s.lastMovement = now;
      }
      s.lastTime = v.currentTime;
      const mediaOK = !v.paused && !centralShown(v) && s.advanced > 0.5;
      if (s.phase === 'starting' && mediaOK) {
        s.phase = 'playing';
        say('中央 Play 已消失、时间前进、音量为零；等待完成度增长。');
      }
      if (s.phase === 'recovering' && mediaOK) {
        s.phase = 'playing';
        s.pauseAt = null;
        say(`已确认恢复媒体播放（${s.attempts}/${LIMITS.recoveryAttempts}）；中央 Play 消失、时间前进、volume=0。等待恢复后完成度增长。`);
      }
      if (s.recoveryProgress !== null && p > s.recoveryProgress && mediaOK) {
        say(`恢复后页面完成度已增长 ${s.recoveryProgress}% → ${p}%，平台进度已确认。`);
        s.recoveryProgress = null;
      }
      if (s.phase === 'playing' && p > s.initial && mediaOK) {
        const message = `已验证页面完成度 ${s.initial}% → ${p}%；时间前进，volume=0，muted=${v.muted}。`;
        if (status.textContent !== message) say(message);
      }
      // 进度超时绝不通过重新点击/重置计时器无限延长。
      // 补播经过已记录区间时可能没有增长，改由整段补播时限兜底。
      if (!s.replaying && now - s.lastIncrease > LIMITS.progress) throw new Error('3 分钟内页面完成度未增长；无法确认平台状态，已停止。可手动刷新核对。');
      if (s.phase === 'recovering') {
        if (!pageVisible()) throw new Error('恢复期间课程标签页已隐藏，已停止。');
        if (now - s.recoveryStarted > LIMITS.start) throw new Error('恢复请求后 12 秒未确认媒体播放，已停止，不追加点击。');
        return;
      }
      if (s.phase === 'playing' && v.paused) {
        if (now - manualPauseAt < 2500) throw new Error('检测到用户主动暂停，已停止自动恢复。');
        if (s.pauseAt === null) {
          s.pauseAt = now;
          record('helper.observed-pause');
          console.info('[雨课堂助手暂停记录]', JSON.stringify(events.slice(-12), null, 2));
          say('检测到媒体暂停；等待短暂稳定及课程页前台，再尝试有限恢复。');
        }
        if (now - s.pauseAt > LIMITS.movement) throw new Error('暂停后 45 秒未能进入前台恢复条件，已停止。');
        if (!pageVisible()) return;
        if (now - s.pauseAt < LIMITS.pauseGrace || now - s.lastAttempt < LIMITS.recoveryGap) return;
        if (s.attempts >= LIMITS.recoveryAttempts) throw new Error('本节已尝试恢复 3 次，已停止，请检查暂停原因。');
        s.attempts++;
        s.lastAttempt = now;
        s.recoveryStarted = now;
        s.recoveryProgress = p;
        s.advanced = 0;
        s.phase = 'recovering';
        playerMute(v);
        record('helper.recovery-request');
        say(`尝试前台恢复（${s.attempts}/${LIMITS.recoveryAttempts}）；等待中央 Play、时间及零音量验证。`);
        requestStart(v);
        s.lastTime = v.currentTime;
        return;
      }
      if (!v.paused) s.pauseAt = null;
      if (s.phase === 'starting' && now - s.started > LIMITS.start) throw new Error('12 秒内未确认启动；已停止。');
      if (now - s.lastMovement > LIMITS.movement) throw new Error('45 秒内时间未前进，已停止。');
    } catch (error) { finish(error.message || String(error)); }
  }
  stop.onclick = () => {
    record('helper.stop');
    if (session) finish('已停止并暂停当前视频。');
    else { video()?.pause(); say('已暂停当前视频。'); }
  };
})();
