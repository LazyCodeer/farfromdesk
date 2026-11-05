"""Create a macOS disk image, tolerating only a known transient hdiutil error."""
import pathlib
import re
import subprocess
import sys
import time


_RESOURCE_BUSY = re.compile(r'^\s*hdiutil:\s*create failed\s*-\s*resource busy\s*$', re.I | re.M)

CREATE_TIMEOUT = 240  # A healthy create takes well under a minute.


def create_dmg(source_dir, output):
    """Retry a resource-busy or hung create at most twice, then fail closed."""
    output = pathlib.Path(output)
    # APFS images compress poorly (UDZO+APFS was ~70 MB larger than the zip);
    # HFS+ with LZFSE is as fast and mounts on every supported macOS (14+).
    command = ['hdiutil', 'create', '-volname', 'FarFromDesk', '-srcfolder', str(source_dir),
               '-fs', 'HFS+', '-format', 'ULFO', '-ov', str(output)]
    # ponytail: HFS+ creates sometimes stall on Intel runners (cause not yet isolated);
    # after a stall, fall back to the larger APFS/UDZO image that never stalled there.
    fallback = ['hdiutil', 'create', '-volname', 'FarFromDesk', '-srcfolder', str(source_dir),
                '-format', 'UDZO', '-ov', str(output)]
    for attempt in range(1, 4):
        # Only remove the exact output file owned by this packaging invocation.
        output.unlink(missing_ok=True)
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=CREATE_TIMEOUT)
        except subprocess.TimeoutExpired:
            # hdiutil can hang forever on CI runners; kill it and retry.
            output.unlink(missing_ok=True)
            if attempt == 3:
                raise
            command = fallback
            print(f'hdiutil create: no result after {CREATE_TIMEOUT}s; retrying as APFS/UDZO (attempt {attempt + 1}/3).', file=sys.stderr, flush=True)
            time.sleep(attempt * 3)
            continue
        except BaseException:
            output.unlink(missing_ok=True)
            raise
        if result.stdout:
            sys.stdout.write(result.stdout)
        if result.stderr:
            sys.stderr.write(result.stderr)
        if result.returncode == 0:
            return
        output.unlink(missing_ok=True)
        if attempt == 3 or not _RESOURCE_BUSY.search(result.stderr or ''):
            raise subprocess.CalledProcessError(result.returncode, command,
                                                output=result.stdout, stderr=result.stderr)
        delay = attempt * 3
        print(f'hdiutil create: resource busy; retrying in {delay}s (attempt {attempt + 1}/3).', file=sys.stderr, flush=True)
        time.sleep(delay)
