#!/usr/bin/env python3
"""Explicit desktop messages through native queues, without periodic polling."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import socket
import stat
import subprocess
import tempfile
from datetime import datetime, timezone
import uuid
from codex_delivery import (acknowledge_delivery, delivery_lock, read_record,
                            receipt, submit, sync_directory, withheld_from_inbox)


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def atomic_json(path, value):
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".desktop-sync-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def inbox(root, target):
    source = root / "codex-inbox.jsonl"
    state_path = root / "codex-explicit-inbox-state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    seen = set(state.get("processedIds", []))
    messages = []
    if source.exists():
        for raw in source.read_bytes().splitlines(keepends=True):
            if not raw.endswith(b"\n"):
                continue
            try:
                event = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                continue
            if (not isinstance(event, dict)
                    or event.get("type") != "cross-session-message"
                    or event.get("targetThreadId") != target
                    or not isinstance(event.get("id"), str)
                    or not isinstance(event.get("text"), str)
                    or not event["text"].strip()
                    or withheld_from_inbox(root, event)
                    or event["id"] in seen):
                continue
            seen.add(event["id"])
            messages.append(event)
    digest = hashlib.sha256(json.dumps(messages, sort_keys=True).encode()).hexdigest()
    return {"status": "new" if messages else "unchanged",
            "sha256": digest, "messages": messages}


def acknowledge(root, target, expected, ids):
    with delivery_lock(root):
        return acknowledge_locked(root, target, expected, ids)


def acknowledge_locked(root, target, expected, ids):
    result = inbox(root, target)
    if result["sha256"] != expected:
        raise ValueError("Inbox changed; read it again before acknowledging")
    pending = {event["id"] for event in result["messages"]}
    if not ids or not set(ids).issubset(pending):
        raise ValueError("Acknowledge only explicit message IDs from this inbox batch")
    path = root / "codex-explicit-inbox-state.json"
    state = json.loads(path.read_text()) if path.exists() else {"schemaVersion": 1}
    state["processedIds"] = list(dict.fromkeys(state.get("processedIds", []) + ids))
    state["updatedAt"] = stamp()
    atomic_json(path, state)
    return {"status": "acknowledged", "ids": ids}


def queue_codex(root, target, text, sender, codex=None, identifier=None, no_wake=False):
    return submit(root, target, text, sender, codex, identifier, no_wake)


def run(args):
    return subprocess.check_output(args, text=True, timeout=10)


def sessions(binary):
    return json.loads(run([binary, "agents", "--json"]))


def target_socket(binary, session_id):
    matches = [s for s in sessions(binary) if s.get("sessionId") == session_id]
    if len(matches) != 1:
        raise ValueError("Exact Claude session is not uniquely running")
    session = matches[0]
    pid = int(session["pid"])
    paths = [line[1:] for line in run(
        ["lsof", "-a", "-p", str(pid), "-U", "-Fn"]).splitlines()
        if line.startswith("n/") and line.endswith(".sock")]
    candidates = [p for p in paths if Path(p).name == str(pid) + ".sock"
                  and Path(p).parent.name.startswith("cc-socks")]
    if len(candidates) != 1:
        raise ValueError("Cannot identify one Claude inbox; inspect discovery manually")
    path = Path(candidates[0])
    info = path.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError("Inbox is not a socket owned by this OS user")
    latest = [s for s in sessions(binary) if s.get("sessionId") == session_id]
    if len(latest) != 1 or int(latest[0]["pid"]) != pid:
        raise ValueError("Claude session changed during discovery")
    return str(path), session


def send(binary, session_id, text, sender):
    if not text.strip() or len(text.encode()) > 64000:
        raise ValueError("Message must contain text and fit within 64KB")
    path, target = target_socket(binary, session_id)
    frame = {"type": "user", "session_id": session_id,
             "uuid": str(uuid.uuid4()), "msg_id": str(uuid.uuid4()),
             "from_name": sender, "message": {"role": "user", "content": text}}
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(3)
        client.connect(path)
        client.sendall((json.dumps(frame) + "\n").encode())
    return {"status": "submitted", "deliveryConfirmed": False,
            "messageId": frame["msg_id"], "sessionId": session_id,
            "targetName": target.get("name"), "submittedAt": stamp()}


def watch(root, target, once):
    if not hasattr(select, "kqueue"):
        raise ValueError("Native watcher currently requires macOS/BSD kqueue")
    previous = None
    with closing(select.kqueue()) as queue:
        root_fd = os.open(root, os.O_RDONLY)
        try:
            queue.control([select.kevent(root_fd, filter=select.KQ_FILTER_VNODE,
                flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR,
                fflags=select.KQ_NOTE_WRITE | select.KQ_NOTE_RENAME |
                       select.KQ_NOTE_DELETE)], 0, 0)
            while True:
                result = inbox(root, target)
                digest = result.get("sha256")
                if result["status"] == "new" and digest != previous:
                    result.pop("snapshot", None)
                    print(json.dumps(result), flush=True)
                    if once:
                        return
                previous = digest
                descriptors = []
                try:
                    for source in (root / "codex-inbox.jsonl", root / "codex-delivery"):
                        if not source.exists():
                            continue
                        descriptor = os.open(source, os.O_RDONLY)
                        descriptors.append(descriptor)
                        queue.control([select.kevent(descriptor,
                            filter=select.KQ_FILTER_VNODE,
                            flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR,
                            fflags=select.KQ_NOTE_WRITE | select.KQ_NOTE_EXTEND |
                                   select.KQ_NOTE_RENAME | select.KQ_NOTE_DELETE)], 0, 0)
                    current = inbox(root, target)
                    if current.get("sha256") == previous:
                        queue.control(None, 8, None)
                finally:
                    for descriptor in descriptors:
                        os.close(descriptor)
        finally:
            os.close(root_fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path,
                        default=Path.home() / ".config/desktop-sync.json")
    parser.add_argument("--coord-dir", type=Path)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("inbox", help="Only explicit cross-session messages; no status/transcript reads")
    ack = sub.add_parser("ack", help="Acknowledge the exact snapshot already read")
    ack.add_argument("--sha256", required=True)
    ack.add_argument("--id", action="append", default=[])
    sub.add_parser("list-claude", help="List existing sessions without starting one")
    outgoing = sub.add_parser("send-claude", help="Send an authorized message")
    outgoing.add_argument("--session", required=True)
    content = outgoing.add_mutually_exclusive_group(required=True)
    content.add_argument("--text")
    content.add_argument("--file", type=Path)
    outgoing.add_argument("--sender", default="Codex desktop")
    incoming = sub.add_parser("send-codex", help="Explicitly queue a message to Codex")
    incoming.add_argument("--target", help="Exact Codex thread ID, defaults to configured target")
    incoming.add_argument("--sender", required=True, help="Actual sending agent/session; never impersonate another sender")
    incoming.add_argument("--id", help="Stable UUID for this logical message; reuse for safe receipt lookup")
    incoming.add_argument("--no-wake", action="store_true", help="Store in the file inbox only")
    incoming_text = incoming.add_mutually_exclusive_group(required=True)
    incoming_text.add_argument("--text")
    incoming_text.add_argument("--file", type=Path)
    delivery = sub.add_parser("delivery-status", help="Read one native delivery receipt")
    delivery.add_argument("--id", required=True)
    received = sub.add_parser("ack-delivery", help="Confirm a native message actually read in the target chat")
    received.add_argument("--id", required=True)
    watcher = sub.add_parser("watch", help="Native change events; cannot wake Codex")
    watcher.add_argument("--once", action="store_true")
    args = parser.parse_args()
    config = json.loads(args.config.read_text()) if args.config.exists() else {}
    root_value = args.coord_dir or config.get("coordinationDirectory")
    root = Path(root_value) if root_value else None
    binary = config.get("claudeBinary")
    target = config.get("codexThreadId")
    if args.command in {"inbox", "ack", "watch", "send-codex", "delivery-status", "ack-delivery"} and root is None:
        parser.error("Set --coord-dir or coordinationDirectory in config")
    if args.command in {"list-claude", "send-claude"} and not binary:
        parser.error("Set claudeBinary to the installed desktop executable")
    if args.command in {"inbox", "ack", "watch", "delivery-status", "ack-delivery"} and not target:
        parser.error("Set codexThreadId in config")
    if args.command == "inbox":
        result = inbox(root, target)
        result.pop("snapshot", None)
    elif args.command == "ack":
        result = acknowledge(root, target, args.sha256, args.id)
    elif args.command == "list-claude":
        result = sessions(binary)
    elif args.command == "send-codex":
        codex = config.get("codexBinary") or shutil.which("codex") or str(
            Path.home() / ".local/bin/codex")
        result = queue_codex(root, args.target or target,
            args.file.read_text() if args.file else args.text, args.sender,
            codex if os.access(codex, os.X_OK) else None, args.id, args.no_wake)
    elif args.command == "delivery-status":
        record = read_record(root, args.id)
        if record is None or record["event"]["targetThreadId"] != target:
            raise ValueError("No matching message for this target")
        result = receipt(record)
    elif args.command == "ack-delivery":
        result = acknowledge_delivery(root, target, args.id)
    elif args.command == "send-claude":
        result = send(binary, args.session,
                      args.file.read_text() if args.file else args.text, args.sender)
    else:
        watch(root, target, args.once)
        return
    print(json.dumps(result, indent=2))
    if args.command == "send-codex":
        file_only = args.no_wake or args.sender.casefold() == "pr-watchd"
        if (result["status"] not in {"submitted", "received"}
                and not (file_only and result["status"] == "pending")):
            raise SystemExit(2)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error))
