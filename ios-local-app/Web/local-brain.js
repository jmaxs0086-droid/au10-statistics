/* AU10 Local Brain: AHK-equivalent decision core, running inside the iOS WebView.
 * This module does not contact n8n. It consumes draw/history records already loaded by the app.
 */
(function (root) {
  'use strict';
  const KEY = 'au10.localBrain.state.v1';
  const DEFAULT_AMOUNTS = [5, 15, 45, 90];
  const QUEUE_LENGTH = 4;
  const HISTORY_LIMIT = 20;

  const num = v => {
    const n = Number(String(v == null ? '' : v).trim());
    return Number.isInteger(n) ? n : 0;
  };
  const issueOf = x => String(x && (x.issue ?? x.period ?? x.issueNo ?? x.expect) || '').replace(/\D/g, '');
  const championOf = x => num(x && (x.champion ?? x.actualChampion ?? x.lastDrawChampion ?? x.winner ?? x.resultChampion));
  const candidatesOf = x => {
    const v = x && (x.candidates ?? x.nums ?? x.candidateNumbers);
    if (Array.isArray(v)) return [...new Set(v.map(num).filter(n => n >= 1 && n <= 10))];
    if (typeof v === 'string') return [...new Set(v.split(/[,，\s]+/).map(num).filter(n => n >= 1 && n <= 10))];
    return [];
  };
  const cmpIssue = (a, b) => a.localeCompare(b, undefined, { numeric: true });

  function readState() {
    try {
      const s = JSON.parse(root.localStorage.getItem(KEY) || '{}');
      return {
        queue: Array.isArray(s.queue) ? s.queue.filter(n => Number.isInteger(n) && n >= 0 && n <= 9).slice(-QUEUE_LENGTH) : [],
        step: Math.max(1, Math.min(4, num(s.step) || 1)),
        lastIssue: String(s.lastIssue || ''),
        pendingIssue: String(s.pendingIssue || ''),
        pendingCandidates: candidatesOf({ candidates: s.pendingCandidates || [] }),
        history: Array.isArray(s.history) ? s.history.slice(0, HISTORY_LIMIT) : [],
        paused: s.paused === true,
        amounts: Array.isArray(s.amounts) && s.amounts.length === 4 ? s.amounts.map(v => Math.max(0, Number(v) || 0)) : DEFAULT_AMOUNTS.slice()
      };
    } catch (_) {
      return { queue: [], step: 1, lastIssue: '', pendingIssue: '', pendingCandidates: [], history: [], paused: false, amounts: DEFAULT_AMOUNTS.slice() };
    }
  }
  let state = readState();
  function save() {
    try { root.localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {}
  }
  function buildMissQueue(history) {
    // Determine hit/miss from the same issue's candidates and actual champion.
    // Do not trust a display-only status field, and never shift the champion by one row.
    const entries = (Array.isArray(history) ? history : [])
      .map(x => {
        if (!x) return null;
        const rawIssue = String(x.issue ?? x.period ?? x.issueNo ?? x.expect ?? '');
        const issue = issueOf(x);
        const champion = championOf(x);
        const candidates = candidatesOf(x);
        if (!/^\d+$/.test(rawIssue) || !issue || champion < 1 || champion > 10 ||
            candidates.length !== 6) return null;
        return {
          issue,
          champion,
          candidates,
          missed: !candidates.includes(champion)
        };
      })
      .filter(Boolean)
      .sort((a,b) => cmpIssue(b.issue, a.issue))
      .slice(0, HISTORY_LIMIT);

    // Inspect the latest 10 settled prediction rows first; expand to 20 only
    // if fewer than four distinct missed issue tails are available.
    const collect = limit => {
      const tails = [], seen = new Set();
      for (const row of entries.slice(0, limit)) {
        if (!row.missed) continue;
        const tail = Number(row.issue.slice(-1));
        if (!Number.isInteger(tail) || tail < 0 || tail > 9 || seen.has(tail)) continue;
        seen.add(tail);
        tails.push(tail);
        if (tails.length === QUEUE_LENGTH) break;
      }
      return tails;
    };
    let missTails = collect(10);
    if (missTails.length < QUEUE_LENGTH) missTails = collect(HISTORY_LIMIT);
    state.queue = missTails.slice(0, QUEUE_LENGTH).reverse();
    save();
    return state.queue.slice();
  }
  function amount() { return state.amounts[state.step - 1] ?? state.amounts[0] ?? 5; }
  function setAmounts(values) {
    if (!Array.isArray(values) || values.length !== 4) throw new Error('必须提供四档金额');
    state.amounts = values.map(v => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error('金额必须是非负数字');
      return Math.round(n * 100) / 100;
    });
    save();
    return state.amounts.slice();
  }
  function shouldTrigger(issue) {
    if (state.paused || state.pendingIssue) return false;
    const id = String(issue || '');
    if (!id || id === state.lastIssue || !state.queue.length) return false;
    return state.queue.includes(Number(id.slice(-1)));
  }
  function canTrigger(issue) {
    if (!state.queue.length) buildMissQueue(appHistory());
    return shouldTrigger(issue);
  }
  function begin(issue, candidates) {
    if (!shouldTrigger(issue)) return { ok: false, reason: '本期尾数未触发或自动化已暂停' };
    const nums = candidatesOf({ candidates });
    if (nums.length !== 6) return { ok: false, reason: '候选号码必须恰好为 6 个' };
    state.pendingIssue = String(issue);
    state.pendingCandidates = nums;
    state.lastIssue = String(issue);
    // Keep the active trigger tail visible while this issue is pending.
    // Consume it only after the real result has been settled.
    save();
    return { ok: true, issue: state.pendingIssue, candidates: nums, amount: amount(), step: state.step, queue: state.queue.slice() };
  }
  function settle(champion, issue, history) {
    const c = num(champion);
    if (!state.pendingIssue || c < 1 || c > 10) return { settled: false };
    const hit = state.pendingCandidates.includes(c);
    const row = { issue: state.pendingIssue, candidates: state.pendingCandidates.slice(), status: hit ? '命中' : '未命中', champion: c, settledAt: Date.now() };
    state.history = [row, ...state.history.filter(x => String(x.issue) !== row.issue)].slice(0, HISTORY_LIMIT);
    // Consume the triggering tail only at settlement, so display and action share one queue.
    state.queue = state.queue.filter(t => String(t) !== String(state.pendingIssue).slice(-1));
    state.pendingIssue = '';
    state.pendingCandidates = [];
    if (hit || state.step >= 4) {
      state.step = 1;
      buildMissQueue(history || []);
    } else {
      state.step += 1;
      if (!state.queue.length) state.step = 1;
    }
    save();
    return { settled: true, hit, row, nextStep: state.step, amount: amount(), queue: state.queue.slice() };
  }
  function setPaused(paused) { state.paused = !!paused; save(); return state.paused; }
  function reset() { state = { queue: [], step: 1, lastIssue: '', pendingIssue: '', pendingCandidates: [], history: [], paused: false, amounts: DEFAULT_AMOUNTS.slice() }; save(); }
  function getState() { return JSON.parse(JSON.stringify(state)); }

  function appHistory() {
    try {
      if (typeof root.loadSimRounds === 'function') return root.loadSimRounds() || [];
    } catch (_) {}
    return [];
  }
  function appStatus(message) {
    const el = root.document && root.document.getElementById('betWebUrlStatus');
    if (el) el.textContent = message;
  }
  function installIntegration() {
    if (root.__au10LocalBrainInstalled) return;
    root.__au10LocalBrainInstalled = true;
    // Migration: older builds consumed the trigger tail before settlement.
    // Restore it for an already-pending issue so Records shows the same active combination.
    if (state.pendingIssue) {
      const pendingTail = Number(String(state.pendingIssue).slice(-1));
      if (Number.isInteger(pendingTail) && pendingTail >= 0 && pendingTail <= 9 && !state.queue.includes(pendingTail)) {
        const priorQueue = state.queue.slice();
        buildMissQueue(appHistory());
        if (!state.queue.includes(pendingTail)) {
          state.queue = priorQueue.slice(-3);
          state.queue.push(pendingTail);
          save();
        }
      }
    }
    try {
      if (typeof root.readBetSettings === 'function') {
        const initialSettings = root.readBetSettings();
        if (initialSettings && Array.isArray(initialSettings.tiers) && initialSettings.tiers.length === 4) setAmounts(initialSettings.tiers);
      }
    } catch (_) {}
    const originalStateSetter = root.setAutomationState;
    if (typeof originalStateSetter === 'function') {
      root.setAutomationState = function(running) {
        const result = originalStateSetter.apply(this, arguments);
        setPaused(!running);
        return result;
      };
      try { setPaused(root.localStorage.getItem('au10_automation_state_v1') !== 'RUNNING'); } catch (_) {}
    }
    const original = root.sendCoordinateAction;
    if (typeof original === 'function') {
      root.sendCoordinateAction = function(issue, nums, manual) {
        if (manual) return original.apply(this, arguments);
        const history = appHistory();
        if (!state.queue.length) buildMissQueue(history);
        const decision = begin(issue, nums);
        if (!decision.ok) {
          appStatus('本地大脑：' + decision.reason + '；未执行点击。');
          return false;
        }
        appStatus('本地大脑已触发：第' + decision.step + '档，金额 ' + decision.amount + '；正在执行网页坐标操作。');
        const result = original.apply(this, arguments);
        if (result === false) {
          state.pendingIssue = '';
          state.pendingCandidates = [];
          save();
        }
        return result;
      };
    } else {
      appStatus('本地大脑已加载；等待应用点击接口就绪。');
    }
    // Settle only from locally stored draw records; never infer a win from clicks alone.
    root.setInterval(function() {
      if (!state.pendingIssue) return;
      const rows = appHistory();
      const found = rows.find(x => issueOf(x) === state.pendingIssue);
      if (!found) return;
      const champion = championOf(found);
      const result = String(found.result || found.status || '').toLowerCase();
      if (champion < 1 || champion > 10 || !(/hit|miss|命中|未中|未命中/.test(result) || found.settled === true)) return;
      const out = settle(champion, state.pendingIssue, rows);
      if (out.settled) appStatus('本地结算：' + (out.hit ? '命中，档位重置' : '未命中') + '；下一档 ' + out.nextStep + '，金额 ' + out.amount + '。');
    }, 2500);
  }
  root.AU10LocalBrain = Object.freeze({ buildMissQueue, shouldTrigger, canTrigger, begin, settle, amount, setAmounts, setPaused, reset, getState, installIntegration, historyLimit: HISTORY_LIMIT, queueLength: QUEUE_LENGTH });
  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', installIntegration, { once: true });
  else installIntegration();
})(window);
