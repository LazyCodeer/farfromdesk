"""Generated Flutter source must survive a Windows-style Git checkout unchanged."""
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
GENERATED = [
    "desktop/linux/flutter/generated_plugin_registrant.cc",
    "desktop/linux/flutter/generated_plugin_registrant.h",
    "desktop/linux/flutter/generated_plugins.cmake",
    "desktop/macos/Flutter/GeneratedPluginRegistrant.swift",
    "desktop/windows/flutter/generated_plugin_registrant.cc",
    "desktop/windows/flutter/generated_plugin_registrant.h",
    "desktop/windows/flutter/generated_plugins.cmake",
]

class GeneratedLineEndingsTests(unittest.TestCase):
    def test_windows_checkout_and_regeneration_stay_clean_but_edits_do_not(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            def git(*args, check=True):
                return subprocess.run(["git", "-c", "core.autocrlf=true", *args],
                                      cwd=root, capture_output=True, check=check)
            git("init", "-q")
            (root / ".gitattributes").write_bytes((ROOT / ".gitattributes").read_bytes())
            body = b"// generated fixture\nvoid register_plugins();\n"
            for name in GENERATED:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(body)
            git("add", ".")
            git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                "-c", "commit.gpgsign=false", "commit", "-qm", "fixture")
            for name in GENERATED:
                (root / name).unlink()
            git("checkout", "--", *GENERATED)
            for name in GENERATED:
                self.assertEqual((root / name).read_bytes(), body, name)
                (root / name).write_bytes(body)  # Flutter writes LF on every host.
            self.assertEqual(git("status", "--porcelain", "--untracked-files=no").stdout, b"")
            (root / GENERATED[0]).write_bytes(body + b"// real source change\n")
            self.assertEqual(git("diff", "--quiet", "HEAD", "--", check=False).returncode, 1)

if __name__ == "__main__":
    unittest.main()
