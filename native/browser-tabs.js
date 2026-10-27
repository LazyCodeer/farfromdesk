/* JXA browser-only adapter. No UI scripting, debugger, profile or credential access. */
ObjC.import('AppKit');
function run(argv) {
  var q = JSON.parse(argv[0]);
  // Fixed markers only: stderr identifies a stalled phase without logging titles, URLs or UI text.
  var lastStage;
  function stage(name) { if (lastStage === name) return; lastStage = name; console.log('FFD_BROWSER_STAGE:' + name); }
  var supported = {
    'com.google.Chrome': 'Google Chrome', 'ai.perplexity.comet': 'Comet',
    'com.microsoft.edgemac': 'Microsoft Edge', 'com.brave.Browser': 'Brave'
  };
  stage('inventory');
  var running = ObjC.unwrap($.NSWorkspace.sharedWorkspace.runningApplications).map(function(a) {
    return {id: ObjC.unwrap(a.bundleIdentifier), name: ObjC.unwrap(a.localizedName), pid: Number(a.processIdentifier)};
  });
  if (q.action === 'inventory') return JSON.stringify(running.filter(function(a) {
    return supported[a.id] || /^(Safari|Firefox|Arc|Opera|Vivaldi|Orion|Zen)$/.test(a.name || '');
  }).map(function(a) { a.supported = !!supported[a.id]; return a; }));
  if (!supported[q.browser]) throw Error('UNSUPPORTED_BROWSER');
  if (!running.some(function(a) { return a.id === q.browser && a.pid === q.pid; })) throw Error('BROWSER_DISCONNECTED');
  stage('application');
  var app = Application(q.pid), safari = q.browser === 'com.apple.Safari';
  if (!app.running()) throw Error('BROWSER_DISCONNECTED');
  stage('windows');
  var windows = app.windows();
  if (q.action === 'tabs') return JSON.stringify(windows.reduce(function(rows, w) {
    stage('tabs');
    return rows.concat(w.tabs().map(function(t, i) {
      stage('tab-metadata');
      return {windowId: String(w.id()), tabId: safari ? String(i + 1) : String(t.id()), title: safari ? t.name() : t.title(), url: t.url()};
    }));
  }, []));
  stage('target');
  var w = windows.filter(function(w) { return String(w.id()) === q.windowId; })[0];
  if (!w) throw Error('TAB_STALE');
  var tabs = w.tabs(), index = -1;
  tabs.forEach(function(t, i) { if ((safari ? String(i + 1) : String(t.id())) === q.tabId) index = i; });
  if (index < 0 || tabs[index].url() !== q.expectedUrl) throw Error('TAB_STALE');
  var t = tabs[index];
  if (q.action === 'select') {
    if (safari) w.currentTab = t; else w.activeTabIndex = index + 1;
    w.index = 1; app.activate();
    if (!safari && w.activeTabIndex() !== index + 1) throw Error('TAB_STALE');
    return JSON.stringify({selected: true});
  }
  function execute(js) { return safari ? app.doJavaScript(js, {in: t}) : t.execute({javascript: js}); }
  // Page output is untrusted evidence. Never read form values or hidden text.
  var inspect = '(' + function() {
    function visible(el) {
      if (!el || el.closest('[hidden],[aria-hidden="true"],input,textarea,[contenteditable],script,style')) return false;
      for (var parent=el;parent;parent=parent.parentElement) if (getComputedStyle(parent).opacity === '0') return false;
      var r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    }
    var text = [], size = 0, visited = 0, walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), n;
    while ((n = walker.nextNode()) && size < 12000 && visited++ < 5000) {
      if (!visible(n.parentElement)) continue;
      var range = document.createRange(); range.selectNodeContents(n); var r = range.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= innerHeight || r.width <= 0) continue;
      var s = n.textContent.replace(/\s+/g, ' ').trim(); if (s) { text.push(s); size += s.length; }
    }
    var links = Array.from(document.querySelectorAll('a[href]')).filter(visible).slice(0, 60).map(function(a, i) {
      var r = a.getBoundingClientRect(); return {id: String(i), label: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 180), href: a.href, x: Math.round(r.x), y: Math.round(r.y)};
    });
    var controls = Array.from(document.querySelectorAll('button,[role="button"],select,input:not([type="hidden"])')).filter(function(el) {
      var r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return !el.closest('[hidden],[aria-hidden="true"]') && r.width > 0 && r.height > 0 && r.top >= 0 && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none';
    }).slice(0,60).map(function(el) { var r=el.getBoundingClientRect(); return {label:(el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').slice(0,180),role:el.getAttribute('role') || el.tagName.toLowerCase(),x:Math.round(r.x),y:Math.round(r.y)}; });
    return JSON.stringify({url:location.href,title:document.title,text:text.join('\n').slice(0,12000),links:links,controls:controls,viewport:{width:innerWidth,height:innerHeight},scrollY:scrollY});
  }.toString() + ')()';
  if (q.action === 'read') { stage('page-read'); return execute(inspect); }
  if (q.action === 'scroll') {
    stage('scroll');
    if (q.direction !== 'up' && q.direction !== 'down') throw Error('INVALID_DIRECTION');
    execute('window.scrollBy(0, ' + (q.direction === 'down' ? '' : '-') + 'Math.round(innerHeight * 0.75)); "scrolled"');
    return JSON.stringify({scrolled:true});
  }
  if (q.action === 'follow') {
    stage('follow');
    // Re-read the selected viewport immediately before navigation. Never click buttons or submit forms.
    var page = JSON.parse(execute(inspect)), link = page.links.filter(function(a) {return a.id === q.linkId;})[0];
    if (page.url !== q.expectedUrl || !link || link.href !== q.href || link.label !== q.label) throw Error('PAGE_STALE');
    if (!/^https?:\/\//.test(q.href)) throw Error('UNSUPPORTED_URL');
    t.url = q.href;
    return JSON.stringify({navigationRequested:true});
  }
  throw Error('UNSUPPORTED_ACTION');
}
