/*
 * onboarding.js — premium 6-step controller (engine/2-onboarding template
 * pattern: rail dots done/now, skip, step counter, arrow-key nav). External
 * JS only — MV3 CSP blocks inline scripts. i18n resolves via data-i18n +
 * chrome.i18n.getMessage (NO __MSG_ tokens — Chrome 150 broke substitution).
 *
 * LOAD-BEARING (gate G14 greps the built file for it): the tab closes via
 * chrome.tabs.getCurrent + chrome.tabs.remove. Keep both calls verbatim.
 * No fabricated numbers anywhere in step copy.
 */
(function () {
  'use strict';

  var TOTAL = 6;
  var i = 0;
  var steps = Array.prototype.slice.call(document.querySelectorAll('.canvcdc5-step'));
  var rail = document.getElementById('canvcdc5-rail');
  var back = document.getElementById('canvcdc5-back');
  var next = document.getElementById('canvcdc5-next');
  var stepno = document.getElementById('canvcdc5-stepno');
  var skip = document.getElementById('canvcdc5-skip');

  function t(key, subs) {
    try {
      var v = chrome.i18n.getMessage(key, subs);
      return typeof v === 'string' && v.length ? v : key;
    } catch (e) {
      return key;
    }
  }

  function i18n() {
    if (typeof chrome === 'undefined' || !chrome.i18n) return;
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
  }

  function closeTab() {
    // LOAD-BEARING (TECHNICAL-BRIEF Phase 2): close via getCurrent + remove.
    try {
      chrome.tabs.getCurrent(function (tab) {
        if (tab && typeof tab.id === 'number') chrome.tabs.remove(tab.id);
      });
    } catch (e) {
      window.close();
    }
  }

  function finish() {
    try {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ canvcdc5_onboardingComplete: true });
      }
    } catch (e) {}
    closeTab();
  }

  for (var d = 0; d < TOTAL; d++) {
    var dot = document.createElement('span');
    dot.className = 'canvcdc5-dot';
    rail.appendChild(dot);
  }
  var dots = Array.prototype.slice.call(rail.children);

  function render() {
    steps.forEach(function (s, n) {
      s.classList.toggle('canvcdc5-on', n === i);
      s.hidden = n !== i;
    });
    dots.forEach(function (dt, n) {
      dt.className =
        'canvcdc5-dot' + (n < i ? ' canvcdc5-done' : n === i ? ' canvcdc5-now' : '');
    });
    back.style.visibility = i === 0 ? 'hidden' : 'visible';
    stepno.textContent = t('obStepOf', [String(i + 1), String(TOTAL)]);
    next.textContent = i === TOTAL - 1 ? t('obDone') : t('obNext');
    try {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ canvcdc5_onboard_step: i });
      }
    } catch (e) {}
  }

  function go(n) {
    i = Math.max(0, Math.min(TOTAL - 1, n));
    render();
  }

  next.addEventListener('click', function () {
    if (i === TOTAL - 1) finish();
    else go(i + 1);
  });
  back.addEventListener('click', function () {
    go(i - 1);
  });
  skip.addEventListener('click', finish);
  document.addEventListener('keydown', function (e) {
    var tag = document.activeElement && document.activeElement.tagName;
    if (e.key === 'ArrowRight' || e.key === 'Enter') {
      if (tag !== 'INPUT' && tag !== 'A' && tag !== 'BUTTON') next.click();
    }
    if (e.key === 'ArrowLeft') back.click();
  });

  i18n();
  render();
})();
