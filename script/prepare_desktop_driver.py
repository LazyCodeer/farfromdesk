#!/usr/bin/env python3
"""Bundle pinned universal Cua driver, retaining upstream signature and notices."""
import argparse, hashlib, json, pathlib, shutil, subprocess, tarfile, tempfile, urllib.request

VERSION='0.38.0'
ARCHIVE_SHA='2bb8dc4a7e69185ffd04c4a9c0eab590bd2c54b72c2c1be13ab675be4f487732'
BINARY_SHA='92067848d0eeb9de76929fbd06a137af801b0ff6caedbb3109bd7a6cc84a1f9f'
URL=f'https://github.com/trycua/cua/releases/download/cua-driver-rs-v{VERSION}/cua-driver-rs-{VERSION}-darwin-universal-binary.tar.gz'

def prepare(destination, archive=None):
    root=pathlib.Path(__file__).resolve().parents[1]
    destination=pathlib.Path(destination);destination.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='ffd-cua-prepare-') as temp:
        archive=pathlib.Path(archive) if archive else pathlib.Path(temp)/'driver.tar.gz'
        if not archive.exists():
            with urllib.request.urlopen(URL,timeout=60) as src, archive.open('wb') as dst:shutil.copyfileobj(src,dst)
        if hashlib.sha256(archive.read_bytes()).hexdigest()!=ARCHIVE_SHA:raise ValueError('Cua archive hash mismatch')
        with tarfile.open(archive) as bundle:
            matches=[m for m in bundle.getmembers() if pathlib.PurePosixPath(m.name).name=='cua-driver' and m.isfile()]
            if len(matches)!=1:raise ValueError('Expected exactly one driver executable')
            data=bundle.extractfile(matches[0]).read()
        if hashlib.sha256(data).hexdigest()!=BINARY_SHA:raise ValueError('Cua executable hash mismatch')
        binary=destination/'cua-driver';binary.write_bytes(data);binary.chmod(0o755)
        subprocess.run(['codesign','--verify','--strict',str(binary)],check=True)
    for name in ['LICENSE-MIT.txt','THIRD_PARTY_NOTICES.md']:
        source=root/'native/cua-driver'/name
        if source.resolve()!=(destination/name).resolve():shutil.copyfile(source,destination/name)
    (destination/'manifest.json').write_text(json.dumps({'version':VERSION,'source':URL,'archiveSHA256':ARCHIVE_SHA,'binarySHA256':BINARY_SHA,'license':'MIT','vendorSignaturePreserved':True},indent=2)+'\n')
    print(destination)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('destination');p.add_argument('--archive');a=p.parse_args();prepare(a.destination,a.archive)
