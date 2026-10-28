#!/usr/bin/env python3
"""Build and optionally launch one isolated local app. Never replace production/state."""
import argparse, hashlib, json, os, pathlib, plistlib, shutil, subprocess, sys

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',required=True,type=pathlib.Path)
parser.add_argument('--speech-root',required=True,type=pathlib.Path)
parser.add_argument('--launch',action='store_true')
args=parser.parse_args()
source=pathlib.Path(__file__).resolve().parents[1]
output=args.output.resolve();app=output/'FarFromDesk Phone Test.app'
if app.exists():raise SystemExit('App already exists; do not replace or replay an earlier build.')
if not (args.speech_root/'manifest.json').is_file():raise SystemExit('Verified speech runtime required')
output.mkdir(parents=True,exist_ok=True)
env=dict(os.environ)
env['FFD_LOCAL_BUILD']='1'
def run(cmd,cwd=source):subprocess.run(cmd,cwd=cwd,env=env,check=True)
runtime=source/'build/speech-runtime'
if runtime.exists():raise SystemExit('Speech staging already exists; inspect before reuse')
shutil.copytree(args.speech_root,runtime)
run(['npm','run','desktop:backend'])
run(['flutter','build','macos','--release','--build-name','0.9.1','--build-number','2301','--dart-define=FFD_VERSION=0.9.1-local.phone2301'],source/'desktop')
host=source/'desktop/build/macos/Build/Products/Release/FarFromDesk.app'
run(['/usr/bin/ditto',str(host),str(app)])
resources=app/'Contents/Resources'
for name in ['desktop-backend','speech']:
 run(['/usr/bin/ditto',str(source/'build'/name),str(resources/('backend' if name=='desktop-backend' else name))])
infoPath=app/'Contents/Info.plist';info=plistlib.loads(infoPath.read_bytes())
info.update(CFBundleIdentifier='com.codecylabs.farfromdesk.phonepreview.local',CFBundleName='FarFromDesk Phone Test',CFBundleDisplayName='FarFromDesk Phone Test')
info['LSEnvironment']={'WSB_STATE_DIR':str(output/'test-state'),'WSB_PORT':'49012','FARFROMDESK_HOME':str(output/'test-home'),'FFD_SMOKE_TEST':'1'}
infoPath.write_bytes(plistlib.dumps(info))
metaPath=resources/'backend/build.json';meta=json.loads(metaPath.read_text());meta.update(buildId='0.9.1-local.phone2301',localUncommittedPreview=True);metaPath.write_text(json.dumps(meta,indent=2))
files={}
for name in ['src','desktop/lib','native','script']:
 for p in (source/name).rglob('*'):
  if p.is_file() and not p.is_symlink():files[str(p.relative_to(source))]=hashlib.sha256(p.read_bytes()).hexdigest()
(output/'source-manifest.json').write_text(json.dumps({'base':meta['sourceCommit'],'files':files},indent=2))
sys.path.insert(0,str(source/'script'));from sign_macos_bundle import sign_bundle
sign_bundle(app)
manifestPath=resources/'speech/manifest.json';manifest=json.loads(manifestPath.read_text());manifest['upstreamSHA256']=dict(manifest['sha256'])
for name in manifest['sha256']:
 p=resources/'speech'/name
 if p.is_file():manifest['sha256'][name]=hashlib.sha256(p.read_bytes()).hexdigest()
manifestPath.write_text(json.dumps(manifest,indent=2)+'\n')
run(['codesign','--force','--sign','-',str(app)])
run(['codesign','--verify','--deep','--strict',str(app)])
(output/'build-result.json').write_text(json.dumps({'app':str(app),'version':'0.9.1-local.phone2301','base':meta['sourceCommit'],'published':False,'permissions':'not checked','liveTest':'pending'},indent=2))
print('Staged '+str(app),flush=True)
if args.launch:
 launch=['/usr/bin/open','-n']
 for key,value in info['LSEnvironment'].items():launch+=['--env',key+'='+value]
 run(launch+[str(app)])
