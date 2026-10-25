"""Package an already-built native Flutter target. Run on that target's OS."""
import argparse, hashlib, json, pathlib, platform, shutil, subprocess, tarfile, zipfile
ROOT = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--version', default=json.loads((ROOT/'release.json').read_text())['version']+'-preview.1')
args = parser.parse_args()
if not args.version or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-' for c in args.version):
    raise SystemExit('Invalid version')
os_name = {'Darwin':'macos','Linux':'linux','Windows':'windows'}[platform.system()]
arch = {'arm64':'arm64','aarch64':'arm64','AMD64':'x64','x86_64':'x64'}[platform.machine()]
build = ROOT/'desktop'/'build'
source = {'macos':build/'macos/Build/Products/Release/FarFromDesk.app', 'linux':build/'linux'/arch/'release/bundle', 'windows':build/'windows'/arch/'runner/Release'}[os_name]
backend = ROOT/'build/desktop-backend'
if not source.is_dir() or not (backend/'dist/main.js').is_file(): raise SystemExit('Build Flutter and prepare the backend on this OS first.')
out = ROOT/'build/desktop-release'; out.mkdir(parents=True,exist_ok=True)
stage = out/'stage'; shutil.rmtree(stage,ignore_errors=True);stage.mkdir()
app = stage/('FarFromDesk.app' if os_name=='macos' else 'FarFromDesk')
shutil.copytree(source,app,symlinks=True)
destination = app/'Contents/Resources/backend' if os_name=='macos' else app/'backend'
shutil.copytree(backend,destination,symlinks=True)
shutil.copytree(ROOT/'build/speech',destination.parent/'speech',symlinks=False)
# Remove package-install metadata that is not needed at runtime.
for name in ['package-lock.json']:
    (destination/name).unlink(missing_ok=True)
ext = 'tar.gz' if os_name=='linux' else 'zip'
archive = out/f'FarFromDesk-{args.version}-{os_name}-{arch}.{ext}'
archive.unlink(missing_ok=True)
if os_name=='macos':
    # Ad-hoc development signing only. Release signing/notarization is a separate gate.
    subprocess.run(['codesign','--force','--deep','--sign','-',str(app)],check=True)
    subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
    subprocess.run(['ditto','-c','-k','--keepParent',str(app),str(archive)],check=True)
elif os_name=='linux':
    with tarfile.open(archive,'w:gz',dereference=True) as f:f.add(app,arcname=app.name)
else:
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as f:
        for path in app.rglob('*'):
            if path.is_file():f.write(path,path.relative_to(stage))
digest=hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()
archive.with_name(archive.name+'.sha256').write_text(f'{digest}  {archive.name}\n')
commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
manifest={'schema':1,'version':args.version,'platform':os_name,'architecture':arch,'sourceCommit':commit,'nativeEntry':'main.dart','speechBundled':True,'signing':'ad-hoc' if os_name=='macos' else 'unsigned','notarized':False,'artifacts':[{'name':archive.name,'sha256':digest,'bytes':archive.stat().st_size}]}
(out/f'manifest-{os_name}-{arch}.json').write_text(json.dumps(manifest,indent=2)+'\n')
install=out/'install';shutil.copytree(ROOT/'install',install,dirs_exist_ok=True)
for f in install.iterdir():
    if f.is_file(): f.write_text(f.read_text().replace('0.7.0-preview.1',args.version))
print(archive)
