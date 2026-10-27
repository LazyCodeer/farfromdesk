import sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from publish_desktop_release import release_notes

class ReleaseNotesTest(unittest.TestCase):
    def test_version_notes_replace_generated_internal_sections(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'docs/releases/0.8.0.md'
            path.parent.mkdir(parents=True)
            path.write_text('Hackathon release.\n\nRight-click Open, or use Open Anyway.\n')
            self.assertEqual(release_notes('0.8.0','internal validation',tmp),path.read_text())
            self.assertEqual(release_notes('0.7.9','fallback',tmp),'fallback')
            path.write_text(' ')
            with self.assertRaises(ValueError):release_notes('0.8.0','fallback',tmp)
