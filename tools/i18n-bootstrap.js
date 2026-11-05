// i18n-bootstrap.js — Chrome 150+ silently stopped substituting __MSG_*__ tokens
// in extension HTML body text and most attributes. This script runs synchronously
// before the page's main script and performs the substitution client-side via
// chrome.i18n.getMessage, matching the pre-150 behaviour the HTML was authored for.
// Injected by build.mjs into any dist HTML that still contains a literal __MSG_
// token. No-op if chrome.i18n is absent. Canonical fleet copy (TrustGrade verbatim).
(function () {
  if (!chrome || !chrome.i18n || !chrome.i18n.getMessage) return;
  var GLOBAL = /__MSG_(\w+)__/g;   // replaceAll
  var PROBE  = /__MSG_(\w+)__/;    // test (stateless)

  function sub(s) {
    return s.replace(GLOBAL, function (m, key) {
      var v = chrome.i18n.getMessage(key);
      return typeof v === 'string' && v.length ? v : m;
    });
  }

  // 1. <title> (in head)
  if (document.title && PROBE.test(document.title)) {
    document.title = sub(document.title);
  }

  // 2. Body text nodes (collected first, then rewritten — TreeWalker is live)
  if (document.body) {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var hits = [];
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && PROBE.test(node.nodeValue)) hits.push(node);
    }
    for (var i = 0; i < hits.length; i++) hits[i].nodeValue = sub(hits[i].nodeValue);
  }

  // 3. Localized attributes Chrome's i18n mechanism is documented to cover
  var ATTRS = ['aria-label', 'title', 'placeholder', 'alt', 'value', 'label'];
  var sel = ATTRS.map(function (a) { return '[' + a + ']'; }).join(',');
  document.querySelectorAll(sel).forEach(function (el) {
    for (var j = 0; j < ATTRS.length; j++) {
      var a = ATTRS[j];
      var v = el.getAttribute(a);
      if (v && PROBE.test(v)) el.setAttribute(a, sub(v));
    }
  });
})();
