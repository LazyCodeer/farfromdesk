"""Durable, at-most-one automatic submission to an existing Codex thread."""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
import re
import subprocess
import tempfile
import uuid

try:
    import fcntl
except ImportError:  # Windows: byte-range locks through the C runtime instead of flock.
    fcntl = None
    import msvcrt


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def message_id(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError, TypeError) as error:
        raise ValueError("Expected an exact UUID") from error


def record_path(root, identifier):
    return root / "codex-delivery" / (message_id(identifier) + ".json")


def sync_directory(path):
    if os.name == "nt":
        # Windows cannot open a directory as a file; a file's own fsync is what persists there.
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def save_record(path, record):
    path.parent.mkdir(mode=0o700, exist_ok=True)
    sync_directory(path.parent.parent)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".delivery-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(record, stream, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def exclusive(stream):
    """Hold an exclusive lock on an open lock file until the block ends."""
    if fcntl is not None:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield
        return
    # A Windows byte lock is mandatory, so it is only ever taken on a dedicated lock file.
    stream.seek(0)
    while True:
        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
            break
        except OSError:
            continue  # LK_LOCK already waited about ten seconds; keep waiting like flock.
    try:
        yield
    finally:
        stream.seek(0)
        msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)


@contextmanager
def delivery_lock(root):
    with (root / ".codex-delivery.lock").open("a") as stream, exclusive(stream):
        yield


def read_record(root, identifier):
    identifier = message_id(identifier)
    path = record_path(root, identifier)
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    source = root / "codex-inbox.jsonl"
    if source.exists():
        for line in source.read_bytes().splitlines(keepends=True):
            if not line.endswith(b"\n"):
                continue
            try:
                event = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(event, dict) and event.get("id") == identifier:
                return {"event": event,
                        "status": ("submitted" if event.get("wakeQueueId") else
                                   "unknown" if event.get("deliveryJournal") else "pending"),
                        "wakeQueueId": event.get("wakeQueueId")}
    return None


def receipt(record):
    event = record["event"]
    return {"status": record["status"],
            "deliveryConfirmed": record["status"] == "received",
            "messageId": event["id"], "targetThreadId": event["targetThreadId"],
            "transport": record.get("transport", "file-inbox" if record["status"] == "pending" else "codex-queue"),
            "wakeQueueId": record.get("wakeQueueId"),
            "wakeError": record.get("error")}


@contextmanager
def inbox_lock(root, stream):
    if fcntl is not None:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield
        return
    # Readers open the inbox itself, so Windows locks a sidecar file instead of the inbox.
    with (root / ".codex-inbox.lock").open("a") as lock, exclusive(lock):
        yield


def ensure_audit(root, event):
    with (root / "codex-inbox.jsonl").open("a+b") as stream, inbox_lock(root, stream):
        stream.seek(0)
        contents = stream.read()
        found = False
        for line in contents.splitlines(keepends=True):
            if not line.endswith(b"\n"):
                continue
            try:
                candidate = json.loads(line)
            except ValueError:
                continue
            if isinstance(candidate, dict) and candidate.get("id") == event["id"]:
                found = True
                break
        if not found:
            if contents and not contents.endswith(b"\n"):
                stream.write(b"\n")
            stream.write((json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8"))
        stream.flush()
        os.fsync(stream.fileno())
    sync_directory(root)


def submit(root, target, text, sender, codex=None, identifier=None, no_wake=False):
    target = message_id(target)
    identifier = message_id(identifier) if identifier else str(uuid.uuid4())
    if not text.strip() or len(text.encode()) > 64000:
        raise ValueError("Need a non-empty message under 64KB")
    if not sender.strip() or len(sender) > 128 or any(ord(c) < 32 for c in sender):
        raise ValueError("Sender must be a short, single-line attribution")
    event = {"type": "cross-session-message", "id": identifier,
             "targetThreadId": target, "sender": sender, "text": text,
             "createdAt": stamp(), "deliveryJournal": True}
    native = bool(codex) and not no_wake and sender.casefold() != "pr-watchd"
    path = record_path(root, identifier)
    with delivery_lock(root):
        previous = read_record(root, identifier)
        if previous:
            if any(previous["event"].get(k) != event[k]
                   for k in ("targetThreadId", "sender", "text")):
                raise ValueError("Message ID already belongs to different content or target")
            if previous["status"] != "prepared":
                return receipt(previous)
            event = previous["event"]
            native = native and previous.get("transport") == "codex-queue"
        record = {"event": event, "status": "prepared",
                  "transport": "codex-queue" if native else "file-inbox"}
        if not native:
            record["error"] = "Native wake disabled or Codex executable unavailable"
        save_record(path, record)
        ensure_audit(root, event)
        if not native:
            record["status"] = "pending"
            save_record(path, record)
            return receipt(record)
        record["status"] = "dispatching"
        save_record(path, record)
        # FarFromDesk's envelope already names the sender, channel and permissions.
        body = text
        try:
            result = subprocess.run([codex, "queue", "--thread", target, "--message", body],
                                    capture_output=True, text=True, timeout=30)
        except OSError as error:
            record.update(status="pending", transport="file-inbox",
                          error=f"Codex could not be launched ({type(error).__name__})")
        except subprocess.SubprocessError:
            record.update(status="unknown", error="Native queue acceptance is unconfirmed")
        else:
            match = re.fullmatch(r"Queued message ([\w-]+) for thread ([\w-]+)\.",
                                 result.stdout.strip())
            valid = False
            if match:
                try:
                    valid = message_id(match[1]) == match[1] and match[2] == target
                except ValueError:
                    pass
            if result.returncode == 0 and valid:
                record.update(status="submitted", wakeQueueId=match[1])
            else:
                record.update(status="unknown", error="Native queue acceptance is unconfirmed")
        record["updatedAt"] = stamp()
        save_record(path, record)
        return receipt(record)


def acknowledge_delivery(root, target, identifier):
    target = message_id(target)
    with delivery_lock(root):
        record = read_record(root, identifier)
        if record is None or record["event"]["targetThreadId"] != target:
            raise ValueError("No matching message for this target")
        if record["status"] not in {"submitted", "dispatching", "unknown", "received"}:
            raise ValueError("Acknowledge only a native message actually received in chat")
        record.update(status="received", receivedAt=stamp())
        save_record(record_path(root, identifier), record)
        return receipt(record)


def withheld_from_inbox(root, event):
    if event.get("wakeQueueId"):
        return True
    try:
        path = record_path(root, event["id"])
        if not path.exists():
            return bool(event.get("deliveryJournal"))
        return json.loads(path.read_text(encoding="utf-8")).get("status") != "pending"
    except ValueError:
        return True
