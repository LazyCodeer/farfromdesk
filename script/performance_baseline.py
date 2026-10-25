#!/usr/bin/env python3
"""Bounded read-only local bridge measurements; emits metrics, never response content.
No credentials, process arguments, recordings, chat names, or transcripts are logged.
Default: at most three sequential GETs per endpoint. Optional status-only soak: up to
20 requests spaced five seconds apart. Does not reload or invoke native agents.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import statistics
import subprocess
import time
import urllib.request
import urllib.parse

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--samples", type=int, choices=(1, 2, 3), default=3)
parser.add_argument("--soak", type=int, choices=range(2, 21), metavar="2..20", help="Only poll status at five-second intervals; first full then conditional")
args = parser.parse_args()

def command(argv):
    return subprocess.check_output(argv, text=True, timeout=6).strip()

def snapshot():
    rows = []
    raw = command(["/bin/ps", "-axo", "pid=,ppid=,rss=,%cpu=,comm="])
    for line in raw.splitlines():
        parts = line.strip().split(None, 4)
        if len(parts) == 5:
            pid, parent, rss, cpu, path = parts
            rows.append(dict(pid=int(pid), parent=int(parent), rss_kib=int(rss), cpu_percent=float(cpu), name=Path(path).name))
    ui = [r for r in rows if r["name"] == "SessionBridge"]
    bridge = [r for r in rows if r["pid"] == bridge_pid]
    owned = {bridge_pid}
    for _ in rows:
        expanded = owned | {r["pid"] for r in rows if r["parent"] in owned}
        if expanded == owned:
            break
        owned = expanded
    children = [r for r in rows if r["pid"] in owned and r["pid"] != bridge_pid]
    return {"elapsed_seconds": round(time.monotonic() - started, 3), "ui": ui, "bridge": bridge, "bridge_descendants": children}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

started = time.monotonic()
try:
    listeners = command(["/usr/sbin/lsof", "-nP", "-iTCP:47831", "-sTCP:LISTEN", "-t"]).splitlines()
    if len(set(listeners)) != 1:
        raise RuntimeError("Expected one local bridge listener")
    bridge_pid = int(listeners[0])
    token = (Path.home() / "Library/Application Support/WhatsApp Session Bridge/admin-token").read_text().strip()
    if not re.fullmatch("[a-f0-9]{64}", token):
        raise RuntimeError("Invalid local API authentication file")
except Exception:
    raise SystemExit("Local bridge listener or authentication unavailable; no request sent")

hardware = {}
for key in ("hw.memsize", "hw.model", "machdep.cpu.brand_string", "hw.ncpu"):
    try:
        hardware[key] = command(["/usr/sbin/sysctl", "-n", key])
    except Exception:
        hardware[key] = "unavailable"
try:
    hardware["macOS"] = command(["/usr/bin/sw_vers", "-productVersion"])
except Exception:
    hardware["macOS"] = "unavailable"
print(json.dumps({"event": "baseline", "utc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "samples_per_endpoint": args.soak or args.samples, "mode": "status-only-soak" if args.soak else "baseline", "hardware": hardware, "processes": snapshot()}), flush=True)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
catalog_revision = None
endpoints = ("/api/status",) if args.soak else ("/api/status", "/api/master-options", "/api/catalog?provider=codex", "/api/catalog?provider=claude")
for endpoint in endpoints:
    successful = []
    for number in range(1, (args.soak or args.samples) + 1):
        if args.soak and number > 1:
            time.sleep(5)
        before = snapshot()
        t = time.monotonic()
        conditional = endpoint == "/api/status" and isinstance(catalog_revision, str)
        request_path = endpoint + ("?" + urllib.parse.urlencode({"catalogRevision": catalog_revision}) if conditional else "")
        result = {"event": "request", "endpoint": endpoint, "sample": number, "conditional_catalog": conditional}
        try:
            req = urllib.request.Request("http://127.0.0.1:47831" + request_path, headers={"Authorization": "Bearer " + token})
            with opener.open(req, timeout=35) as response:
                body = response.read(8 * 1024 * 1024 + 1)
                result.update(status=response.status, bytes=len(body), body_limit_exceeded=len(body) > 8 * 1024 * 1024)
            elapsed = time.monotonic() - t
            successful.append(elapsed)
            result["seconds"] = round(elapsed, 4)
            if len(body) <= 8 * 1024 * 1024:
                data = json.loads(body)
                if isinstance(data.get("sessions"), list):
                    result["session_count"] = len(data["sessions"])
                setup = data.get("masterSetup", data)
                if endpoint == "/api/status" and isinstance(setup, dict):
                    next_revision = setup.get("catalogRevision")
                    result["catalog_included"] = isinstance(setup.get("platforms"), list) and setup.get("catalogUnchanged") is not True
                    result["catalog_unchanged"] = setup.get("catalogUnchanged") is True
                    result["catalog_revision_changed"] = catalog_revision != next_revision
                    if isinstance(next_revision, str) and len(next_revision) < 512:
                        catalog_revision = next_revision
                if isinstance(setup, dict) and isinstance(setup.get("platforms"), list):
                    result["platform_counts"] = [{"provider": p.get("provider"), "mode": p.get("executionMode"), "sessions": len(p.get("sessions", [])), "discovery_error": bool(p.get("discoveryError"))} for p in setup["platforms"]]
        except Exception as error:
            result.update(seconds=round(time.monotonic() - t, 4), error_type=type(error).__name__)
            if isinstance(error, urllib.error.HTTPError):
                result["status"] = error.code
        result.update(before=before, after=snapshot())
        print(json.dumps(result), flush=True)
    if successful:
        print(json.dumps({"event": "summary", "endpoint": endpoint, "successful_samples": len(successful), "median_seconds": round(statistics.median(successful), 4), "min_seconds": round(min(successful), 4), "max_seconds": round(max(successful), 4)}), flush=True)
print(json.dumps({"event": "complete", "processes": snapshot()}), flush=True)
