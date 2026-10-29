"""Create a macOS disk image, tolerating only a known transient hdiutil error."""
import pathlib
import re
import subprocess
import sys
import time


_RESOURCE_BUSY = re.compile(r'^\s*hdiutil:\s*create failed\s*-\s*resource busy\s*$', re.I | re.M)


def create_dmg(source_dir, output):
    """Retry a resource-busy create failure at most twice, then fail closed."""
    output = pathlib.Path(output)
    command = ['hdiutil', 'create', '-volname', 'FarFromDesk', '-srcfolder', str(source_dir),
               '-format', 'UDZO', '-ov', str(output)]
    for attempt in range(1, 4):
        # Only remove the exact output file owned by this packaging invocation.
        output.unlink(missing_ok=True)
        try:
            result = subprocess.run(command, capture_output=True, text=True)
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
