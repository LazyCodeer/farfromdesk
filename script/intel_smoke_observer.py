"""Bounded, read-only observation of one diagnostic smoke process tree.

Only numeric process metadata and heartbeat age are printed. No command line,
environment, filesystem path, account state, response body or secret is read
or logged. The observer never signals the processes it observes.
"""
import argparse
import datetime
import json
import pathlib
import re
import subprocess
import time

MAX_PROCESSES = 64
ROW = re.compile(r'^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z+<>-]{1,8})\s+(\d+(?:\.\d+)?)\s*$')


def parse_processes(text):
    rows = {}
    for line in text.splitlines():
        match = ROW.fullmatch(line)
        if match:
            pid, parent, group = map(int, match.group(1, 2, 3))
            rows[pid] = {'pid': pid, 'parent': parent, 'group': group,
                         'state': match.group(4), 'cpu': float(match.group(5))}
    return rows


def tree(root, rows):
    if root not in rows:
        return []
    found, pending = set(), [root]
    while pending and len(found) < MAX_PROCESSES:
        pid = pending.pop(0)
        if pid in found:
            continue
        found.add(pid)
        pending.extend(sorted(row['pid'] for row in rows.values()
                              if row['parent'] == pid and row['pid'] not in found))
    return [rows[pid] for pid in sorted(found)]


def heartbeat_age(path, root, now):
    try:
        # The diagnostic controls this file. Read only its bounded PID and time.
        content = path.read_text(encoding='ascii')[:80].strip()
        match = re.fullmatch(r'(\d{1,12}) (\d{1,16})', content)
        if not match or int(match.group(1)) != root:
            return None
        return max(0, round(now * 1000) - int(match.group(2)))
    except (OSError, UnicodeError):
        return None


def snapshot(root, heartbeat):
    now = time.time()
    result = {'at': datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat(),
              'heartbeat_age_ms': heartbeat_age(heartbeat, root, now)}
    try:
        ps = subprocess.run(['ps', '-axo', 'pid=,ppid=,pgid=,state=,pcpu='],
                            capture_output=True, text=True, timeout=3, check=True)
        result['processes'] = tree(root, parse_processes(ps.stdout))
        result['root_present'] = bool(result['processes'])
    except (OSError, subprocess.SubprocessError):
        # Do not print subprocess output or error strings, which may include paths.
        result['processes'] = []
        result['root_present'] = None
        result['process_sample'] = 'unavailable'
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root-pid', type=int, required=True)
    parser.add_argument('--heartbeat', type=pathlib.Path, required=True)
    parser.add_argument('--interval', type=float, default=15)
    parser.add_argument('--max-samples', type=int, default=32)
    args = parser.parse_args()
    if args.root_pid <= 1 or not 0.1 <= args.interval <= 30 or not 1 <= args.max_samples <= 64:
        parser.error('invalid bounds')
    for _ in range(args.max_samples):
        data = snapshot(args.root_pid, args.heartbeat)
        print(json.dumps(data, separators=(',', ':')), flush=True)
        if data['root_present'] is False:
            break
        time.sleep(args.interval)


if __name__ == '__main__':
    main()
