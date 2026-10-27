import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare_workspace', Path(__file__).parents[1] / 'prepare_project_workspace.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ffd-snapshot-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.destination = self.root / 'worker'
        subprocess.run(['git', 'init', '-q', str(self.source)], check=True)

    def write(self, name, body='fixture', tracked=True):
        p = self.source / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
        if tracked:
            subprocess.run(['git', '-C', str(self.source), 'add', name], check=True)
        return p

    def test_full_tracked_tree_retains_assets_config_and_current_edits(self):
        self.write('desktop/pubspec.yaml', 'flutter:\n  assets:\n    - assets/logo.png\n  fonts:\n    - family: Test\n      fonts:\n        - asset: assets/font.ttf\n')
        for name in ['desktop/assets/logo.png', 'desktop/assets/font.ttf', 'desktop/macos/Runner/Info.plist', 'package-lock.json', '.gitignore']:
            self.write(name)
        p = self.write('src/main.ts');p.write_text('uncommitted edit')
        deleted = self.write('deleted.txt');deleted.unlink()
        result = module.prepare(self.source, self.destination)
        self.assertTrue(result['copied'])
        self.assertEqual((self.destination / 'src/main.ts').read_text(), 'uncommitted edit')
        self.assertTrue((self.destination / 'desktop/macos/Runner/Info.plist').is_file())
        self.assertFalse((self.destination / '.git').exists())
        self.assertFalse((self.destination / 'deleted.txt').exists())

    def test_missing_untracked_logo_fails_before_copy_then_explicit_include_passes(self):
        self.write('desktop/pubspec.yaml', 'flutter:\n  assets:\n    - assets/logo-telegram.png\n')
        self.write('desktop/assets/logo-telegram.png', tracked=False)
        self.write('desktop/assets/TELEGRAM.md', tracked=False)
        with self.assertRaisesRegex(ValueError, 'logo-telegram'):
            module.prepare(self.source, self.destination)
        self.assertFalse(self.destination.exists())
        module.prepare(self.source, self.destination, ['desktop/assets/logo-telegram.png', 'desktop/assets/TELEGRAM.md'])
        self.assertTrue((self.destination / 'desktop/assets/TELEGRAM.md').is_file())

    def test_check_is_nonmutating_and_does_not_copy_ignored_or_other_untracked_files(self):
        self.write('.gitignore', '.env\nnode_modules/\n')
        self.write('.env', 'synthetic-only', False)
        self.write('node_modules/example/index.js', tracked=False)
        self.write('notes.txt', tracked=False)
        module.prepare(self.source, self.destination, check=True)
        self.assertFalse(self.destination.exists())
        with self.assertRaisesRegex(ValueError, 'nonignored'):
            module.prepare(self.source, self.destination, ['.env'])
        module.prepare(self.source, self.destination)
        self.assertFalse((self.destination / '.env').exists())
        self.assertFalse((self.destination / 'notes.txt').exists())

    def test_existing_destination_is_never_overwritten(self):
        self.destination.mkdir();(self.destination / 'owner.txt').write_text('keep')
        with self.assertRaisesRegex(ValueError, 'new directory'):
            module.prepare(self.source, self.destination)
        self.assertEqual((self.destination / 'owner.txt').read_text(), 'keep')

    def test_source_symlinks_and_external_assets_are_rejected(self):
        outside = self.root / 'outside';outside.write_text('synthetic-only')
        (self.source / 'link').symlink_to(outside)
        subprocess.run(['git', '-C', str(self.source), 'add', 'link'], check=True)
        with self.assertRaisesRegex(ValueError, 'Symlink'):
            module.prepare(self.source, self.destination)
        (self.source / 'link').unlink()
        self.write('pubspec.yaml', 'flutter:\n  assets:\n    - ../outside\n')
        with self.assertRaisesRegex(ValueError, 'inside'):
            module.prepare(self.source, self.destination)

    def test_directory_assets_and_unsupported_inline_yaml(self):
        manifest = self.write('pubspec.yaml', 'flutter:\n  assets:\n    - images/\n')
        self.write('images/icon.png')
        module.prepare(self.source, self.destination, check=True)
        manifest.write_text('flutter:\n  assets: [missing.png]\n')
        with self.assertRaisesRegex(ValueError, 'Inline'):
            module.prepare(self.source, self.destination, check=True)


if __name__ == '__main__':
    unittest.main()
