#!/usr/bin/env python3
"""FarFromDesk desktop control for Linux, over AT-SPI.

One action per run: list, read, click, type, key, screenshot. Arguments arrive as
base64 JSON in argv[2] and the answer is one JSON object on stdout: {"ok": true, ...}
or {"ok": false, "error": "CODE: sentence"}.

AT-SPI is the same protocol on X11 and Wayland, so listing, reading, clicking a named
control and setting a named field work on both. Synthesized keystrokes and pointer
clicks need X11 (AT-SPI injects them through XTest); on Wayland they are refused, not
faked. Screenshots use the root window on X11 and the XDG Screenshot portal on Wayland.
Needs python3-gi and gir1.2-atspi-2.0 (installed with every GNOME, KDE and Xfce desktop).
"""
import base64, json, os, shutil, subprocess, sys

MAX_ELEMENTS = 250
MAX_WALK = 4000


def out(value):
    sys.stdout.write(json.dumps(value))
    sys.stdout.flush()
    sys.exit(0)


def fail(code, message):
    out({"ok": False, "error": f"{code}: {message}"})


def wayland():
    return os.environ.get("XDG_SESSION_TYPE") == "wayland" or (bool(os.environ.get("WAYLAND_DISPLAY")) and not os.environ.get("DISPLAY"))


def atspi():
    try:
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        return Atspi
    except Exception:
        fail("ATSPI_UNAVAILABLE", "Desktop control on Linux needs AT-SPI. Install python3-gi and gir1.2-atspi-2.0, then try again.")


def text_of(Atspi, node, limit=300):
    try:
        iface = node.get_text_iface()
        if iface is None:
            return ""
        count = Atspi.Text.get_character_count(iface)
        return (Atspi.Text.get_text(iface, 0, min(count, limit)) or "").strip()
    except Exception:
        return ""


def apps(Atspi):
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is not None:
            yield app


def windows(Atspi):
    rows = []
    for app in apps(Atspi):
        try:
            name, pid = app.get_name() or "", app.get_process_id()
        except Exception:
            continue
        for j in range(app.get_child_count()):
            win = app.get_child_at_index(j)
            if win is None:
                continue
            try:
                states = win.get_state_set()
                rows.append({"app": name, "title": win.get_name() or "", "pid": pid, "id": f"{pid}:{j}",
                             "active": states.contains(Atspi.StateType.ACTIVE), "node": win})
            except Exception:
                continue
    return rows


def public(row):
    return {k: v for k, v in row.items() if k != "node"}


def find_window(Atspi, args):
    want, title = (args.get("app") or "").lower(), (args.get("window") or "").lower()
    rows = [r for r in windows(Atspi) if not want or want in r["app"].lower() or want in r["title"].lower()]
    if title:
        rows = [r for r in rows if title in r["title"].lower()] or rows
    if not rows:
        fail("DESKTOP_APP_NOT_RUNNING", f"{args.get('app') or 'That app'} has no open window.")
    rows.sort(key=lambda r: (not r["active"], not r["title"]))
    return rows[0]


def walk(node, depth=0, seen=None):
    seen = seen if seen is not None else [0]
    if depth > 40 or seen[0] > MAX_WALK:
        return
    try:
        count = node.get_child_count()
    except Exception:
        return
    for i in range(count):
        try:
            child = node.get_child_at_index(i)
        except Exception:
            continue
        if child is None:
            continue
        seen[0] += 1
        yield child
        yield from walk(child, depth + 1, seen)


def describe(Atspi, node):
    role = node.get_role_name() or ""
    name = (node.get_name() or "").strip()[:300]
    value = "" if role == "password text" else text_of(Atspi, node)
    return {"role": role, "name": name, "value": value if value != name else ""}


def find_control(Atspi, win, args, editable=False):
    name, role = (args.get("name") or "").strip().lower(), (args.get("role") or "").strip().lower()
    exact, partial = [], []
    for node in walk(win):
        try:
            label = (node.get_name() or "").strip().lower()
            if role and role not in (node.get_role_name() or "").lower():
                continue
            if editable and not node.get_state_set().contains(Atspi.StateType.EDITABLE):
                continue
            if name and label == name:
                exact.append(node)
            elif name and name in label:
                partial.append(node)
            elif not name and role:
                exact.append(node)
        except Exception:
            continue
    found = exact or partial
    if not found:
        fail("DESKTOP_CONTROL_NOT_FOUND", f"No control named \"{args.get('name') or args.get('role')}\" in that window.")
    return found[0]


def raise_window(row):
    # AT-SPI cannot raise a window. xdotool can on X11; without it, input goes to whatever has focus.
    if not wayland() and shutil.which("xdotool"):
        ids = subprocess.run(["xdotool", "search", "--onlyvisible", "--pid", str(row["pid"])], capture_output=True, text=True, timeout=5).stdout.split()
        if ids:
            # windowactivate needs a window manager; windowfocus sets X input focus without one.
            subprocess.run(["xdotool", "windowactivate", "--sync", ids[-1]], capture_output=True, timeout=5)
            subprocess.run(["xdotool", "windowfocus", "--sync", ids[-1]], capture_output=True, timeout=5)
            return True
    try:
        row["node"].get_component_iface().grab_focus()
    except Exception:
        pass
    return False


KEYSYMS = {"return": 0xFF0D, "tab": 0xFF09, "escape": 0xFF1B, "up": 0xFF52, "down": 0xFF54, "left": 0xFF51,
           "right": 0xFF53, "space": 0x20, "delete": 0xFF08}


def key(Atspi, args):
    if wayland():
        fail("WAYLAND_INPUT_UNSUPPORTED", "Wayland does not let apps send keystrokes to other windows. Use a named control instead, or sign in to an X11 session.")
    row = find_window(Atspi, args)
    raise_window(row)
    name = args.get("key") or ""
    sym = KEYSYMS.get(name) or (ord(name) if len(name) == 1 else None)
    if sym is None:
        fail("DESKTOP_KEY_UNSUPPORTED", f"I cannot press {name}.")
    bits = {"shift": 0, "ctrl": 2, "cmd": 2, "option": 3}
    mask = 0
    for m in args.get("modifiers") or []:
        mask |= 1 << bits[m]
    if mask:
        Atspi.generate_keyboard_event(mask, None, Atspi.KeySynthType.LOCKMODIFIERS)
    try:
        Atspi.generate_keyboard_event(sym, None, Atspi.KeySynthType.SYM)
    finally:
        if mask:
            Atspi.generate_keyboard_event(mask, None, Atspi.KeySynthType.UNLOCKMODIFIERS)
    out({"ok": True, "app": row["app"], "window": row["title"]})


def type_text(Atspi, args):
    row = find_window(Atspi, args)
    text = args.get("text") or ""
    if args.get("name") or args.get("role"):
        node = find_control(Atspi, row["node"], args, editable=True)
        iface = node.get_editable_text_iface()
        if iface is None or not Atspi.EditableText.set_text_contents(iface, text):
            fail("TEXT_INPUT_REFUSED", "That field does not accept text through accessibility.")
        out({"ok": True, "app": row["app"], "window": row["title"], "field": node.get_name() or "", "mode": "set"})
    if wayland():
        fail("WAYLAND_INPUT_UNSUPPORTED", "Wayland does not let apps type into other windows. Name the field to fill instead, or sign in to an X11 session.")
    raise_window(row)
    parts = text.split("\n")
    for i, part in enumerate(parts):
        if part:
            Atspi.generate_keyboard_event(0, part, Atspi.KeySynthType.STRING)
        if i < len(parts) - 1:
            Atspi.generate_keyboard_event(KEYSYMS["return"], None, Atspi.KeySynthType.SYM)
    out({"ok": True, "app": row["app"], "window": row["title"], "mode": "keystrokes"})


def click(Atspi, args):
    row = find_window(Atspi, args)
    node = find_control(Atspi, row["node"], args)
    action = node.get_action_iface()
    if action is not None and Atspi.Action.get_n_actions(action) > 0:
        if Atspi.Action.do_action(action, 0):
            out({"ok": True, "app": row["app"], "window": row["title"], "control": describe(Atspi, node), "mode": "action"})
    if wayland():
        fail("ACTION_UNSUPPORTED_BY_CONTROL", "That control has no accessibility action, and Wayland does not allow a pointer click from another app.")
    rect = node.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
    raise_window(row)
    Atspi.generate_mouse_event(rect.x + rect.width // 2, rect.y + rect.height // 2, "b1c")
    out({"ok": True, "app": row["app"], "window": row["title"], "control": describe(Atspi, node), "mode": "pointer"})


def read(Atspi, args):
    row = find_window(Atspi, args)
    elements, total = [], 0
    for node in walk(row["node"]):
        try:
            if not node.get_state_set().contains(Atspi.StateType.SHOWING):
                continue
            item = describe(Atspi, node)
        except Exception:
            continue
        if not item["name"] and not item["value"]:
            continue
        total += 1
        if len(elements) < MAX_ELEMENTS:
            elements.append(item)
    out({"ok": True, "app": row["app"], "window": row["title"], "elements": elements, "truncated": total > len(elements)})


def portal_screenshot():
    from gi.repository import Gio, GLib
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    token = "ffd%d" % os.getpid()
    sender = bus.get_unique_name()[1:].replace(".", "_")
    path = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
    loop, result = GLib.MainLoop(), {}

    def done(_c, _s, _p, _i, _sig, params):
        code, values = params.unpack()
        result.update(code=code, uri=values.get("uri"))
        loop.quit()

    bus.signal_subscribe("org.freedesktop.portal.Desktop", "org.freedesktop.portal.Request", "Response", path, None, Gio.DBusSignalFlags.NO_MATCH_RULE, done)
    bus.call_sync("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.portal.Screenshot", "Screenshot",
                  GLib.Variant("(sa{sv})", ("", {"handle_token": GLib.Variant("s", token), "interactive": GLib.Variant("b", False)})), None, Gio.DBusCallFlags.NONE, 10000, None)
    GLib.timeout_add_seconds(60, loop.quit)
    loop.run()
    if result.get("code") != 0 or not result.get("uri"):
        fail("SCREENSHOT_REFUSED", "The desktop did not allow the screenshot. Approve the screenshot request on screen, then ask again.")
    file = Gio.File.new_for_uri(result["uri"])
    data = file.load_contents(None)[1]
    try:
        file.delete(None)  # the portal saved our capture to the owner's Pictures folder; it is ours to remove
    except Exception:
        pass
    return bytes(data), None


def x11_screenshot(Atspi, args):
    import gi
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk
    root = Gdk.get_default_root_window()
    if root is None:
        fail("SCREENSHOT_FAILED", "No X11 display to capture.")
    x, y, w, h = 0, 0, root.get_width(), root.get_height()
    window = None
    if args.get("app") and Atspi is not None:
        row = find_window(Atspi, args)
        window = row["title"]
        try:
            r = row["node"].get_component_iface().get_extents(Atspi.CoordType.SCREEN)
            if r.width > 0 and r.height > 0:
                x, y, w, h = max(r.x, 0), max(r.y, 0), min(r.width, root.get_width() - max(r.x, 0)), min(r.height, root.get_height() - max(r.y, 0))
        except Exception:
            pass
    pixbuf = Gdk.pixbuf_get_from_window(root, x, y, w, h)
    if pixbuf is None:
        fail("SCREENSHOT_FAILED", "The X11 server returned no image.")
    ok, data = pixbuf.save_to_bufferv("png", [], [])
    return bytes(data), window


def screenshot(args):
    try:
        if wayland():
            data, window = portal_screenshot()
        else:
            data, window = x11_screenshot(atspi() if args.get("app") else None, args)
    except SystemExit:
        raise
    except Exception as error:
        fail("SCREENSHOT_FAILED", str(error)[:200])
    out({"ok": True, "pngBase64": base64.b64encode(data).decode(), "window": window, "scope": "screen" if wayland() or not window else "window"})


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    args = json.loads(base64.b64decode(sys.argv[2]).decode()) if len(sys.argv) > 2 else {}
    if action == "screenshot":
        screenshot(args)
    Atspi = atspi()
    if action == "list":
        out({"ok": True, "windows": [public(r) for r in windows(Atspi)], "session": "wayland" if wayland() else "x11"})
    handlers = {"read": read, "click": click, "type": type_text, "key": key}
    if action not in handlers:
        fail("UNSUPPORTED_ACTION", f"Unknown action {action}.")
    handlers[action](Atspi, args)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:
        fail("DESKTOP_NATIVE_FAILED", str(error)[:300])
