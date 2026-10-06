// Local state-machine checks only; does not contact the learning platform.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('雨课堂播放按钮助手.user.js', 'utf8');

function setup(options = {}) {
  let now = 0, timer, completion = options.initial ?? 5;
  const mutationObservers = new Set(), timeouts = new Map();
  let timeoutId = 0;
  const logs = [];
  const elements = [];
  const rect = { left: 200, top: 200, bottom: 400, width: 400, height: 200 };
  const element = () => ({ isConnected: true, style: {}, textContent: '',
    getBoundingClientRect: () => rect, append() {}, contains: () => false,
    addEventListener() {}, removeEventListener() {}, closest: () => null });
  const icon = { classList: { contains: () => true } };
  const volume = { ...element(), querySelector: () => icon };
  const layer = { ...element(), shown: true,
    getBoundingClientRect() { return this.shown ? rect : { width: 0, height: 0 }; },
    querySelector: () => button };
  let seeks = 0;
  const wrap = element();
  const bar = { ...element(), querySelector: () => wrap, dispatchEvent() {
    seeks++;
    if (!options.blockSeek) { v.currentTime = 0; v.ended = false; }
    if (!options.blockSeek && options.autoPlaySeek !== false) { v.paused = false; layer.shown = false; }
  } };
  const container = { dispatchEvent() {}, querySelector: selector =>
    selector === 'xt-bigbutton' ? layer : selector === 'xt-progress.xt_video_player_progress' ?
      (options.noBar ? null : bar) : volume };
  const v = { ...element(), paused: true, ended: false, currentTime: 50,
    readyState: options.readyState ?? 4, duration: 749, currentSrc: 'video-1', volume: 1, muted: false, seeking: false,
    closest: () => container, pause() { this.paused = true; layer.shown = true; } };
  const button = { ...element(), blocked: false, dispatchEvent() {
    if (!this.blocked) { v.paused = false; v.currentTime = 0; layer.shown = false; }
  } };
  const label = { ...element(),
    get innerText() { return typeof completion === 'string' ? completion : `完成度：${completion}%`; },
    getBoundingClientRect: () => ({ ...rect, top: 160, bottom: 190 }) };
  const extraLabels = (options.extraLabels || []).map(spec => ({ ...element(),
    innerText: spec.text, closest: () => spec.excluded ? {} : null,
    getBoundingClientRect: () => ({ ...rect, top: 160, bottom: 190, ...spec.rect }) }));
  if (options.widePlayer) container.getBoundingClientRect = () => ({ ...rect, width: 900 });
  let clicks = 0;
  let rows;
  const makeRow = index => {
    const item = { ...element(), innerText: index === 1 && options.nonVideo ? '课件 文档' : `视频 第 ${index + 1} 节`,
      matches: selector => selector.includes('is-disable') && !!options.disabled,
      querySelector: () => null,
      click() {
        clicks++;
        if (options.noNavigation) return;
        rows.forEach(row => { row.active = false; });
        if (options.rebuildDirectory) {
          rows.forEach(row => { row.isConnected = false; });
          rows = rows.map((_, rowIndex) => makeRow(rowIndex));
          rows.forEach(row => { row.active = false; });
        }
        rows[index].active = true;
        if (options.hashRoute) location.hash = `#/video/${index + 1}`;
        else location.pathname = `/video/${index + 1}`;
        if (!options.staleSource) v.currentSrc = `video-${index + 1}`;
        v.ended = false; v.paused = true; v.currentTime = 0; layer.shown = true;
        completion = options.completions?.[index] ?? options.nextCompletion ?? 0;
      } };
    return { ...element(), active: index === 0,
      matches(selector) { return selector === '.is-active' && this.active; },
      querySelector: selector => selector === '.leaf-item' ? item : null };
  };
  rows = Array.from({ length: options.courses ?? 0 }, (_, index) => makeRow(index));
  const document = { dialog: false, hidden: false, visibilityState: 'visible', focused: options.focused ?? true, hasFocus() { return this.focused; },
    getElementById: () => null, body: { append() {} }, addEventListener() {},
    createElement() { const e = element(); elements.push(e); return e; },
    querySelectorAll(selector) {
      if (selector === 'video.xt_video_player') return [v];
      if (selector === 'span,div,p,a,button,strong') return [label, ...extraLabels];
      if (selector === '.nav-item-leaf-box') return rows;
      if (selector.includes('el-dialog')) return this.dialog ? [element()] : [];
      return [];
    } };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const location = { pathname: options.pathname ?? '/video/1', search: options.search ?? '', hash: options.hashRoute ? '#/video/1' : '' };
  const navigator = { onLine: options.online !== false };
  const windowEvents = {};
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() { mutationObservers.add(this); }
    disconnect() { mutationObservers.delete(this); }
  }
  function flushTimeouts() {
    for (const [id, job] of [...timeouts]) {
      if (job.at <= now) { timeouts.delete(id); job.fn(); }
    }
  }
  vm.runInNewContext(source, { document, location, Date: FakeDate, URLSearchParams,
    navigator, window: { PointerEvent: class {}, addEventListener(type, handler) { windowEvents[type] = handler; } },
    PointerEvent: class {}, MouseEvent: class {},
    MutationObserver: options.observe ? FakeMutationObserver : undefined,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    console: { info: (...args) => logs.push(args) },
    setInterval: fn => { timer = fn; return 1; }, clearInterval: () => { timer = null; },
    setTimeout: (fn, ms) => { const id = ++timeoutId; timeouts.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timeouts.delete(id) });
  const status = elements[2], start = elements[3], stop = elements[4], debug = elements[5];
  start.onclick();
  return { v, status, start, stop, debug, guide: elements[6], logs, location, document, button, rows,
    get clicks() { return clicks; },
    get seeks() { return seeks; },
    get observerCount() { return mutationObservers.size; },
    get currentRows() { return rows; },
    mutate() { for (const observer of mutationObservers) observer.callback([{ target: label }]); },
    pulse(ms = 50) { now += ms; flushTimeouts(); },
    network(online) { navigator.onLine = online; windowEvents[online ? 'online' : 'offline'](); },
    progress(p) { completion = p; },
    tick(ms = 500, advance = 0.5) {
      now += ms; v.currentTime += advance; flushTimeouts(); if (timer) timer();
    }, get active() { return !!timer; } };
}

// Start time may reset from an old resume point to zero after pointerup.
const reset = setup({ courses: 1 });
reset.tick(); reset.tick();
assert.match(reset.status.textContent, /中央 Play 已消失/);
assert.equal(reset.active, true);
reset.progress(9); reset.tick();
assert.match(reset.status.textContent, /5% → 9%/);
const count = reset.logs.length;
reset.debug.onclick(); reset.tick();
assert.equal(reset.logs.length, count + 1, 'diagnostic must not repeat success log');

// Natural end must wait, despite paused=true and no time movement.
reset.v.ended = true; reset.v.paused = true; reset.tick(500, 0);
assert.match(reset.status.textContent, /等待更新到 100%/);
reset.tick(46000, 0);
assert.equal(reset.active, true, '45-second movement timeout must not apply after ended');
reset.progress(100); reset.tick(500, 0);
assert.match(reset.status.textContent, /已确认 100%/);
assert.equal(reset.active, false);
assert.equal(reset.location.pathname, '/video/1', 'last course must remain selected');

const timeout = setup(); timeout.tick(); timeout.tick();
timeout.v.ended = true; timeout.v.paused = true; timeout.tick(500, 0);
timeout.tick(60000, 0);
assert.match(timeout.status.textContent, /从头补播/);
assert.equal(timeout.active, true);
assert.equal(timeout.seeks, 1);
timeout.tick(500, 0); timeout.tick(); timeout.tick();
timeout.v.ended = true; timeout.v.paused = true; timeout.tick(500, 0);
timeout.tick(60000, 0);
assert.match(timeout.status.textContent, /整段补播后等待 60 秒/);
assert.equal(timeout.active, false);
assert.equal(timeout.seeks, 1);
assert.equal(timeout.location.pathname, '/video/1');

const pause = setup(); pause.tick(); pause.tick(); pause.v.pause(); pause.tick(500, 0);
assert.match(pause.status.textContent, /检测到媒体暂停/);
assert.equal(pause.active, true);
pause.tick(1500, 0);
assert.match(pause.status.textContent, /尝试前台恢复/);
pause.tick(); pause.tick();
assert.match(pause.status.textContent, /等待恢复后完成度增长/);
pause.progress(9); pause.tick();
assert.ok(pause.logs.some(args => String(args[1]).includes('恢复后页面完成度已增长')));

// Restore attempts remain bounded across successful resumes.
for (let i = 0; i < 2; i++) {
  pause.v.pause(); pause.tick(10000, 0); pause.tick(1500, 0);
  pause.tick(); pause.tick();
}
pause.v.pause(); pause.tick(10000, 0); pause.tick(1500, 0);
assert.equal(pause.active, false);
assert.match(pause.status.textContent, /已尝试恢复 3 次/);

const hidden = setup(); hidden.tick(); hidden.tick(); hidden.v.pause();
hidden.document.hidden = true; hidden.document.focused = false;
hidden.tick(500, 0); hidden.tick(3000, 0);
assert.equal(hidden.v.paused, true, 'must not restart in background');
hidden.document.hidden = false; hidden.document.focused = true; hidden.tick(500, 0);
assert.match(hidden.status.textContent, /尝试前台恢复/);

const blocked = setup(); blocked.tick(); blocked.tick(); blocked.v.pause();
blocked.button.blocked = true;
blocked.tick(500, 0); blocked.tick(1500, 0); blocked.tick(12500, 0);
assert.equal(blocked.active, false);
assert.match(blocked.status.textContent, /12 秒未确认媒体播放/);

const stale = setup(); stale.tick(); stale.tick(); stale.tick(180001, 1);
assert.equal(stale.active, false);
const stopLog = stale.logs.find(args => args[0] === '[雨课堂助手停止前状态]');
const preStop = JSON.parse(stopLog[1]);
assert.equal(preStop.before.paused, false, 'snapshot must precede helper pause');
assert.equal(preStop.helperWillPause, true);
assert.equal(stale.v.paused, true);

const sound = setup(); sound.v.volume = 1; sound.tick();
assert.match(sound.status.textContent, /音量恢复为非零/);
assert.equal(sound.v.paused, true);

// Completion, route, active row and changed source are all needed before restart.
const next = setup({ courses: 3 });
next.progress(99); next.tick(); assert.equal(next.clicks, 0);
next.progress(100); next.tick();
assert.equal(next.clicks, 1); assert.equal(next.location.pathname, '/video/2');
next.tick(); next.tick(2000, 0);
assert.equal(next.v.paused, false); assert.equal(next.v.volume, 0);
next.tick(); next.tick(); next.progress(10); next.tick();
assert.match(next.status.textContent, /0% → 10%/);
next.progress(100); next.tick(); assert.equal(next.clicks, 2);
next.tick(); next.tick(2000, 0); next.progress(100); next.tick();
assert.equal(next.active, false); assert.equal(next.clicks, 2);

const skip = setup({ courses: 3, initial: 100, nonVideo: true });
skip.tick(); assert.equal(skip.location.pathname, '/video/3');

for (const options of [{ noNavigation: true }, { staleSource: true }]) {
  const failed = setup({ courses: 2, ...options });
  failed.progress(100); failed.tick(); failed.tick(20000, 0);
  assert.equal(failed.active, false); assert.equal(failed.clicks, 1);
  assert.match(failed.status.textContent, /20 秒内未确认下一课程/);
}
const disabled = setup({ courses: 2, disabled: true });
disabled.progress(100); disabled.tick();
assert.equal(disabled.active, false); assert.equal(disabled.clicks, 0);

const pending = setup({ courses: 2 });
pending.progress(100); pending.tick(); pending.stop.onclick(); pending.tick(2500, 0);
assert.equal(pending.active, false); assert.equal(pending.v.paused, true);
assert.equal(pending.clicks, 1);

const foreground = setup({ courses: 2 });
foreground.document.hidden = true; foreground.document.focused = false;
foreground.progress(100); foreground.tick(); assert.equal(foreground.clicks, 0);
foreground.document.hidden = false; foreground.document.focused = true;
foreground.tick(); assert.equal(foreground.clicks, 1);

const unknown = setup(); unknown.progress(100); unknown.tick();
assert.equal(unknown.active, false); assert.match(unknown.status.textContent, /无法唯一确定/);

const replay = setup({ courses: 2, autoPlaySeek: true });
replay.tick(); replay.tick(); replay.v.ended = true; replay.v.paused = true;
replay.tick(500, 0); replay.tick(60000, 0); replay.tick(500, 0);
assert.equal(replay.seeks, 1); assert.equal(replay.v.playbackRate, 1);
replay.tick(); replay.tick(); replay.tick(180001, 180);
assert.equal(replay.active, true, 'known coverage can remain unchanged for >3 minutes during replay');
replay.progress(100); replay.tick(); assert.equal(replay.clicks, 1);
replay.tick(); replay.tick(2000, 0); replay.tick(); replay.tick(); replay.tick(180001, 180);
assert.equal(replay.active, false, 'next course must regain normal progress timeout');

for (const options of [{ blockSeek: true }, { noBar: true }]) {
  const seek = setup(options); seek.tick(); seek.tick();
  seek.v.ended = true; seek.v.paused = true; seek.tick(500, 0); seek.tick(60000, 0);
  if (options.blockSeek) seek.tick(12000, 0);
  assert.equal(seek.active, false);
  assert.match(seek.status.textContent, /回到开头|拖回开头/);
  assert.ok(seek.seeks <= 1);
}
timeout.v.ended = false; timeout.start.onclick(); timeout.tick(); timeout.tick();
timeout.v.ended = true; timeout.v.paused = true; timeout.tick(500, 0); timeout.tick(60000, 0);
assert.equal(timeout.seeks, 1, 'stop/restart cannot grant a second automatic replay');

const replayLimit = setup(); replayLimit.tick(); replayLimit.tick();
replayLimit.v.ended = true; replayLimit.v.paused = true;
replayLimit.tick(500, 0); replayLimit.tick(60000, 0); replayLimit.tick(500, 0);
replayLimit.tick(1200000, 1);
assert.equal(replayLimit.active, false); assert.match(replayLimit.status.textContent, /整段补播已超时/);

const offline = setup(); offline.tick(); offline.tick(); offline.network(false);
assert.equal(offline.v.paused, true); assert.match(offline.status.textContent, /检测到断网/);
offline.tick(200000, 0); assert.equal(offline.active, true, 'offline time must not consume progress timeout');
offline.document.hidden = true; offline.document.focused = false; offline.network(true); assert.equal(offline.v.paused, true);
offline.document.hidden = false; offline.document.focused = true; offline.tick(500, 0);
assert.equal(offline.v.paused, false); offline.tick(); offline.tick(); offline.tick();
assert.equal(offline.active, true); offline.progress(9); offline.tick();
assert.ok(offline.logs.some(args => String(args[1]).includes('恢复后页面完成度已增长')));

const offlineLimit = setup(); offlineLimit.network(false); offlineLimit.tick(300000, 0);
assert.equal(offlineLimit.active, false); assert.match(offlineLimit.status.textContent, /超过 5 分钟/);
offlineLimit.network(true); assert.equal(offlineLimit.v.paused, true);

const offlineEnd = setup(); offlineEnd.tick(); offlineEnd.tick();
offlineEnd.v.ended = true; offlineEnd.v.paused = true; offlineEnd.tick(500, 0);
offlineEnd.tick(30000, 0); offlineEnd.network(false); offlineEnd.tick(200000, 0);
offlineEnd.network(true); offlineEnd.tick(29000, 0); assert.equal(offlineEnd.seeks, 0);
offlineEnd.tick(1000, 0); assert.equal(offlineEnd.seeks, 1, 'offline must freeze the completion wait');

const lostFocusReplay = setup(); lostFocusReplay.tick(); lostFocusReplay.tick();
lostFocusReplay.v.ended = true; lostFocusReplay.v.paused = true;
lostFocusReplay.tick(500, 0); lostFocusReplay.tick(60000, 0);
lostFocusReplay.document.hidden = true; lostFocusReplay.document.focused = false; lostFocusReplay.tick(500, 0);
assert.equal(lostFocusReplay.active, false); assert.equal(lostFocusReplay.v.paused, true);

const offlineSwitch = setup({ courses: 2 }); offlineSwitch.progress(100); offlineSwitch.tick();
offlineSwitch.network(false); assert.equal(offlineSwitch.active, false);
assert.match(offlineSwitch.status.textContent, /切课期间检测到断网/);

const cancelled = setup(); cancelled.network(false); cancelled.stop.onclick(); cancelled.network(true);
assert.equal(cancelled.active, false); assert.equal(cancelled.v.paused, true);
const noStart = setup({ online: false }); assert.equal(noStart.active, false);
assert.match(noStart.status.textContent, /当前已断网/);

const modal = setup(); modal.tick(); modal.tick(); modal.document.dialog = true; modal.tick();
assert.equal(modal.active, false); assert.equal(modal.v.paused, true);
assert.match(modal.status.textContent, /关闭弹窗后点击助手/);
assert.match(modal.guide.textContent, /只点播放器 Play 不会恢复自动切课/);
modal.document.dialog = false; modal.tick(); assert.equal(modal.active, false);
modal.start.onclick(); modal.tick(); modal.tick(); assert.equal(modal.active, true);
// The platform replaces its percentage with a completed status before media end.
const completed = setup({ courses: 2 }); completed.tick(); completed.tick();
completed.progress('已完成'); completed.debug.onclick();
const completedDiagnostic = JSON.parse(completed.logs.at(-1)[1]);
assert.equal(completedDiagnostic.completion, 100);
assert.deepEqual(completedDiagnostic.completionLabels, ['已完成']);
completed.tick(); assert.equal(completed.clicks, 1); assert.equal(completed.seeks, 0);
assert.equal(completed.location.pathname, '/video/2');

const initiallyComplete = setup({ courses: 2, initial: '已完成 详情' });
assert.equal(initiallyComplete.v.paused, true, 'already completed course must not be started');
initiallyComplete.tick(); assert.equal(initiallyComplete.clicks, 1);

const rightHeader = setup({ courses: 2, initial: '', widePlayer: true,
  extraLabels: [{ text: '已完成', rect: { left: 980, width: 70 } }] });
rightHeader.tick(); assert.equal(rightHeader.clicks, 1, 'header can be outside video image but inside full player width');

for (const spec of [
  { text: '已完成', excluded: true }, // Sidebar or dialog.
  { text: '已完成', rect: { left: 700, width: 70 } }, // Outside player width.
  { text: '已完成', rect: { top: 210, bottom: 240 } }, // Below header.
  { text: '已完成', rect: { top: 0, bottom: 20 } } // Too far above header.
]) {
  const unrelated = setup({ courses: 2, extraLabels: [spec] }); unrelated.tick();
  assert.equal(unrelated.active, true); assert.equal(unrelated.clicks, 0);
}
for (const text of ['未完成', '尚未完成', '本课程已完成 3 节', '说明：已完成']) {
  const unknownStatus = setup({ courses: 2, initial: text });
  assert.equal(unknownStatus.active, false); assert.equal(unknownStatus.clicks, 0);
}
const conflicting = setup({ courses: 2, extraLabels: [{ text: '已完成' }] });
assert.equal(conflicting.active, false); assert.equal(conflicting.clicks, 0, 'conflicting header evidence must not navigate');
const consistent = setup({ courses: 2, initial: 100, extraLabels: [{ text: '已完成' }] });
consistent.tick(); assert.equal(consistent.clicks, 1);

// Reproduce the real failure: Vue replaces every directory row after each click.
const consecutive = setup({ courses: 7, initial: '已完成', rebuildDirectory: true,
  completions: ['已完成', '已完成', '已完成', '已完成', '已完成', '已完成', 35], observe: true });
const firstRow = consecutive.currentRows[0];
consecutive.tick(); assert.equal(firstRow.isConnected, false);
for (let lesson = 2; lesson <= 7; lesson++) {
  assert.equal(consecutive.location.pathname, `/video/${lesson}`);
  consecutive.mutate(); consecutive.pulse();
  consecutive.tick(2000, 0);
  assert.equal(consecutive.active, true, `lesson ${lesson} must not time out on detached old rows`);
  if (lesson < 7) consecutive.tick();
}
assert.equal(consecutive.clicks, 6);
assert.equal(consecutive.v.paused, false, 'first incomplete lesson must start playback');
assert.equal(consecutive.observerCount, 0, 'switch observer must be released after entering playback');
consecutive.tick(); consecutive.tick(); consecutive.progress(40); consecutive.tick();
assert.match(consecutive.status.textContent, /35% → 40%/);
assert.equal(consecutive.clicks, 6, 'incomplete lesson must not be skipped');

const metaOnly = setup({ courses: 3, initial: '已完成', nextCompletion: '已完成', readyState: 1,
  rebuildDirectory: true, hashRoute: true });
metaOnly.tick(); metaOnly.tick(); metaOnly.tick(2000, 0); metaOnly.tick();
assert.equal(metaOnly.clicks, 2, 'completed lessons need metadata, not playing frames; hash route must be recognized');
assert.equal(metaOnly.location.hash, '#/video/3');

const cancelledObserver = setup({ courses: 2, initial: '已完成', observe: true });
cancelledObserver.tick(); cancelledObserver.mutate(); cancelledObserver.stop.onclick();
cancelledObserver.pulse(3000); assert.equal(cancelledObserver.active, false);
assert.equal(cancelledObserver.observerCount, 0); assert.equal(cancelledObserver.clicks, 1);

const wrongTarget = setup({ courses: 3, initial: '已完成', rebuildDirectory: true });
wrongTarget.tick(); wrongTarget.currentRows[1].active = false; wrongTarget.currentRows[2].active = true;
wrongTarget.tick(20000, 0); assert.equal(wrongTarget.active, false); assert.equal(wrongTarget.clicks, 1);
const evidence = JSON.parse(wrongTarget.logs.find(args => args[0] === '[雨课堂助手停止前状态]')[1]).before.switchEvidence;
assert.equal(evidence.routeChanged, true); assert.equal(evidence.sourceChanged, true);
assert.equal(evidence.targetSelected, false); assert.deepEqual(evidence.selectedIndexes, [2]);

const growingDirectory = setup({ courses: 3, initial: '已完成', rebuildDirectory: true });
growingDirectory.tick(); growingDirectory.currentRows.push(growingDirectory.currentRows[2]);
growingDirectory.tick(); growingDirectory.tick(2000, 0);
assert.equal(growingDirectory.active, true);
assert.equal(growingDirectory.v.paused, false, 'later lazy-loaded resources must not prevent starting the target lesson');

const shrinkingDirectory = setup({ courses: 3, initial: '已完成', rebuildDirectory: true });
shrinkingDirectory.tick(); shrinkingDirectory.currentRows.pop();
shrinkingDirectory.tick(); shrinkingDirectory.tick(2000, 0);
assert.equal(shrinkingDirectory.active, true);
assert.equal(shrinkingDirectory.v.paused, false, 'removing later resources must not invalidate selected target');

const stableReplay = setup({ pathname: '/ai-workspace/lms-graph/123/video/456', search: '?node_id=789' });
stableReplay.tick(); stableReplay.tick(); stableReplay.v.ended = true; stableReplay.v.paused = true;
stableReplay.tick(500, 0); stableReplay.tick(60000, 0); stableReplay.tick(500, 0);
assert.equal(stableReplay.seeks, 1); stableReplay.stop.onclick();
stableReplay.v.currentSrc = 'different-cdn-or-signed-source';
stableReplay.location.search = '?node_id=789&display=detail';
stableReplay.start.onclick(); stableReplay.tick(); stableReplay.tick();
stableReplay.v.ended = true; stableReplay.v.paused = true;
stableReplay.tick(500, 0); stableReplay.tick(60000, 0);
assert.equal(stableReplay.active, false);
assert.equal(stableReplay.seeks, 1, 'same course identity must keep its replay budget across source/query changes');

// Reproduce both remote-control reports: visible=true, focused=false.
const visibleUnfocused = setup({ courses: 2, focused: false });
assert.equal(visibleUnfocused.active, true, 'visible page can be started without keyboard focus');
visibleUnfocused.tick(); visibleUnfocused.tick(); visibleUnfocused.progress(100); visibleUnfocused.tick();
assert.equal(visibleUnfocused.clicks, 1, 'completed visible page can advance without keyboard focus');
visibleUnfocused.tick(); visibleUnfocused.tick(2000, 0);
assert.equal(visibleUnfocused.active, true, 'switch confirmation must survive blur');
assert.equal(visibleUnfocused.v.paused, false);
visibleUnfocused.tick(); visibleUnfocused.tick(); visibleUnfocused.debug.onclick();
const focusSnapshot = JSON.parse(visibleUnfocused.logs.at(-1)[1]);
assert.equal(focusSnapshot.focused, false); assert.equal(focusSnapshot.pageEligible, true);

const blurDuringSwitch = setup({ courses: 2, initial: '已完成' });
blurDuringSwitch.tick(); blurDuringSwitch.document.focused = false;
blurDuringSwitch.tick(); blurDuringSwitch.tick(2000, 0);
assert.equal(blurDuringSwitch.active, true); assert.equal(blurDuringSwitch.v.paused, false);

const blurRecovery = setup({ focused: false }); blurRecovery.tick(); blurRecovery.tick();
blurRecovery.v.pause(); blurRecovery.tick(500, 0); blurRecovery.tick(1500, 0);
blurRecovery.tick(); blurRecovery.tick(); assert.equal(blurRecovery.active, true);
assert.equal(blurRecovery.v.paused, false);
blurRecovery.network(false); blurRecovery.network(true);
blurRecovery.tick(); blurRecovery.tick(); assert.equal(blurRecovery.v.paused, false);

const hiddenSwitch = setup({ courses: 2, initial: '已完成' }); hiddenSwitch.tick();
hiddenSwitch.document.hidden = true; hiddenSwitch.tick(); hiddenSwitch.tick(2000, 0);
assert.equal(hiddenSwitch.active, false); assert.equal(hiddenSwitch.v.paused, true);
assert.match(hiddenSwitch.status.textContent, /标签页已隐藏/);
console.log('PASS: all prior checks; visible unfocused start/advance/switch/recovery/network resume; actual hidden tab still stops or waits');
