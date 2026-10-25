"""Package an already-built native Flutter target. Run on that target's OS."""
import argparse, hashlib, json, pathlib, platform, shutil, subprocess, tarfile, zipfile, tempfile, struct
from release_installers import write_installer
from windows_installer import build_windows_installer
ROOT = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--version', default=json.loads((ROOT/'release.json').read_text())['version'])
args = parser.parse_args()
if not args.version or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-' for c in args.version):
    raise SystemExit('Invalid version')
os_name = {'Darwin':'macos','Linux':'linux','Windows':'windows'}[platform.system()]
arch = {'arm64':'arm64','aarch64':'arm64','AMD64':'x64','x86_64':'x64'}[platform.machine()]
build = ROOT/'desktop'/'build'
source = {'macos':build/'macos/Build/Products/Release/FarFromDesk.app', 'linux':build/'linux'/arch/'release/bundle', 'windows':build/'windows'/arch/'runner/Release'}[os_name]
backend = ROOT/'build/desktop-backend'
if os_name=='macos':
    native=source/'Contents/MacOS/FarFromDesk'
else: native=source/('farfromdesk.exe' if os_name=='windows' else 'farfromdesk')
if os_name=='windows':
    for dll in ['msvcp140.dll','vcruntime140.dll']:
        if not (source/dll).is_file(): raise SystemExit('Missing Windows redistributable runtime: '+dll)
if not source.is_dir() or not (backend/'dist/main.js').is_file(): raise SystemExit('Build Flutter and prepare the backend on this OS first.')
# Validate the actual executable format before giving an archive an architecture name.
extra_speech=[p for p in (ROOT/'build/speech').iterdir() if p.name in ['whisper-avx2','whisper-avx2.exe','speech-cpu','speech-cpu.exe']]
for binary in [*extra_speech,native, backend/'runtime'/('node.exe' if os_name=='windows' else 'node'), *[ROOT/'build/speech'/(name+('.exe' if os_name=='windows' else '')) for name in ['ffmpeg','whisper-cli']]]:
    if os_name=='macos':
        targets=subprocess.check_output(['lipo','-archs',str(binary)],text=True).split()
        if ('arm64' if arch=='arm64' else 'x86_64') not in targets: raise SystemExit('Wrong executable architecture: '+str(binary))
    else:
        with binary.open('rb') as f:
            head=f.read(64)
            if os_name=='linux':
                if head[:4]!=b'\x7fELF' or head[4]!=2 or struct.unpack('<H',head[18:20])[0]!=62: raise SystemExit('Expected Linux x64 ELF: '+str(binary))
            else:
                if head[:2]!=b'MZ': raise SystemExit('Expected Windows executable: '+str(binary))
                f.seek(struct.unpack('<I',head[60:64])[0]);pe=f.read(6)
                if pe[:4]!=b'PE\0\0' or struct.unpack('<H',pe[4:6])[0]!=0x8664: raise SystemExit('Expected Windows x64 PE: '+str(binary))
out = ROOT/'build/desktop-release'; out.mkdir(parents=True,exist_ok=True)
stage = out/'stage'; shutil.rmtree(stage,ignore_errors=True);stage.mkdir()
app = stage/('FarFromDesk.app' if os_name=='macos' else 'FarFromDesk')
shutil.copytree(source,app,symlinks=True)
destination = app/'Contents/Resources/backend' if os_name=='macos' else app/'backend'
shutil.copytree(backend,destination,symlinks=True)
meta_file=destination/'build.json'
meta=json.loads(meta_file.read_text());meta['buildId']=args.version;meta_file.write_text(json.dumps(meta))
shutil.copytree(ROOT/'build/speech',destination.parent/'speech',symlinks=False)
# CI tests the pinned model; users fetch it once into persistent app data on first use.
speech=destination.parent/'speech'
(speech/'ggml-base.bin').unlink()
speech_manifest=json.loads((speech/'manifest.json').read_text())
speech_manifest['modelDelivery']='first-use'
(speech/'manifest.json').write_text(json.dumps(speech_manifest,indent=2)+'\n')
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
archives=[archive]
if os_name=='windows': archives.append(build_windows_installer(app,out,args.version))
if os_name=='macos':
    dmg=archive.with_suffix('.dmg')
    with tempfile.TemporaryDirectory(prefix='ffd-dmg-') as td:
        image_root=pathlib.Path(td)
        subprocess.run(['ditto',str(app),str(image_root/app.name)],check=True)
        (image_root/'Applications').symlink_to('/Applications')
        subprocess.run(['hdiutil','create','-volname','FarFromDesk','-srcfolder',td,'-format','UDZO','-ov',str(dmg)],check=True)
    subprocess.run(['hdiutil','verify',str(dmg)],check=True);archives.append(dmg)
artifacts=[]
for asset in archives:
    with asset.open('rb') as f: digest=hashlib.file_digest(f,'sha256').hexdigest()
    asset.with_name(asset.name+'.sha256').write_text(f'{digest}  {asset.name}\n')
    artifacts.append({'name':asset.name,'sha256':digest,'bytes':asset.stat().st_size})
commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
manifest={'schema':1,'version':args.version,'platform':os_name,'architecture':arch,'sourceCommit':commit,'nativeEntry':'main.dart','speechBundled':True,'voiceModelDelivery':'first-use','signing':'ad-hoc' if os_name=='macos' else 'unsigned','notarized':False,'artifacts':artifacts}
(out/f'manifest-{os_name}-{arch}.json').write_text(json.dumps(manifest,indent=2)+'\n')
install=out/'install';shutil.copytree(ROOT/'install',install,dirs_exist_ok=True)
for f in install.iterdir():
    if f.is_file():
        # Identical installer assets across Windows and Unix are required by the publisher.
        write_installer(f,f,args.version)
print(archive)
