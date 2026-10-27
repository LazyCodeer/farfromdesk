"""Sign local release code inside-out, preserving the pinned vendor Cua executable."""
import hashlib, pathlib, subprocess
MACHO={b'\xfe\xed\xfa\xce',b'\xce\xfa\xed\xfe',b'\xfe\xed\xfa\xcf',b'\xcf\xfa\xed\xfe',b'\xca\xfe\xba\xbe',b'\xbe\xba\xfe\xca',b'\xca\xfe\xba\xbf',b'\xbf\xba\xfe\xca'}
CUA_SHA='92067848d0eeb9de76929fbd06a137af801b0ff6caedbb3109bd7a6cc84a1f9f'

def sign_bundle(app):
    app=pathlib.Path(app)
    vendor=app/'Contents/Resources/backend/native/cua-driver/cua-driver'
    if not vendor.is_file():raise ValueError('Bundled desktop driver is missing')
    before=hashlib.sha256(vendor.read_bytes()).hexdigest()
    if before!=CUA_SHA:raise ValueError('Bundled desktop driver hash mismatch')
    subprocess.run(['codesign','--verify','--strict',str(vendor)],check=True)
    code=[]
    for p in app.rglob('*'):
        if p.is_symlink() or p==vendor:continue
        if p.is_dir() and p.suffix in ('.app','.framework','.xpc','.bundle'):code.append(p)
        elif p.is_file():
            with p.open('rb') as f:magic=f.read(4)
            if magic in MACHO:code.append(p)
    for p in sorted(code,key=lambda p:len(p.parts),reverse=True)+[app]:
        subprocess.run(['codesign','--force','--sign','-',str(p)],check=True)
    if hashlib.sha256(vendor.read_bytes()).hexdigest()!=before:raise ValueError('Signing changed vendor executable')
    subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
