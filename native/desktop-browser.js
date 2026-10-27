// Constant JXA program. All caller-controlled values arrive as JSON argv.
function run(argv) {
    const q = JSON.parse(argv[0]);
    const a = Application(q.bundle);
    if (!a.running()) throw Error('BROWSER_NOT_RUNNING');
    const windows = () => a.windows().map(w => ({
        window_id: String(w.id()), bounds: w.bounds(),
        active_tab_id: String(w.tabs()[w.activeTabIndex() - 1].id()),
        tabs: w.tabs().map(t => ({tab_id: String(t.id()), title: t.title(), url: t.url()}))
    }));
    if (q.operation === 'list_tabs') return JSON.stringify({windows: windows()});
    const matches = a.windows().filter(w => String(w.id()) === String(q.window_id));
    if (matches.length !== 1) throw Error('WINDOW_NOT_FOUND');
    const w = matches[0];
    let t;
    if (q.operation !== 'new_tab') {
        const found = w.tabs().filter(t => String(t.id()) === String(q.tab_id));
        if (found.length !== 1) throw Error('TAB_NOT_FOUND');
        t = found[0];
    }
    if (q.operation === 'new_tab') {
        const before = w.tabs().map(t => String(t.id()));
        w.tabs.push(a.Tab({url:q.url}));
        const added = w.tabs().filter(t => !before.includes(String(t.id())));
        if (added.length !== 1) throw Error('NEW_TAB_OUTCOME_UNKNOWN');
        t = added[0];
    } else if (q.operation === 'navigate_tab') {
        t.url = q.url;
    } else if (q.operation === 'close_tab') {
        if (w.tabs().length === 1) throw Error('REFUSE_CLOSE_LAST_TAB');
        a.close(t);
        if (w.tabs().some(t => String(t.id()) === String(q.tab_id))) throw Error('CLOSE_UNVERIFIED');
        return JSON.stringify({closed:true, tab_id:String(q.tab_id)});
    } else if (q.operation !== 'focus_tab') throw Error('UNKNOWN_OPERATION');
    if (q.operation === 'focus_tab' || (q.operation === 'new_tab' && q.activate)) {
        w.activeTabIndex = w.tabs().findIndex(x => String(x.id()) === String(t.id())) + 1;
        if (q.foreground) { w.index = 1; a.activate(); }
        if (String(w.tabs()[w.activeTabIndex()-1].id()) !== String(t.id())) throw Error('FOCUS_UNVERIFIED');
    }
    return JSON.stringify({window_id:String(w.id()),tab_id:String(t.id()),title:t.title(),url:t.url()});
}
