#!/usr/bin/env python3
"""Read app/source metadata only. Does not inspect Application Support state."""
import argparse,json,plistlib,subprocess
from pathlib import Path

def inspect(app,source):
    app=Path(app).expanduser()
    source=Path(source).expanduser()
    result={"app":str(app),"source":str(source),"source_exists":source.is_dir()}
    info=plistlib.loads((app/"Contents/Info.plist").read_bytes())
    result.update(version=info.get("CFBundleVersion"),bundle_id=info.get("CFBundleIdentifier"))
    if result["bundle_id"]!="com.codecylabs.farfromdesk.localtest":
        raise ValueError("Expected FarFromDesk Local bundle ID; refusing another app")
    meta=json.loads((app/"Contents/Resources/backend/build.json").read_text())
    for key in ["buildId","localSource","localChanges","sourceCommit"]:
        if key in meta:result[key]=meta[key]
    if source.is_dir():
        git=subprocess.run(["git","-C",str(source),"rev-parse","--show-toplevel"],capture_output=True,text=True)
        result["git_root"]=git.stdout.strip() if git.returncode==0 else None
        result["copied_snapshot_under_parent_git"]=bool(result["git_root"] and Path(result["git_root"]).resolve()!=source.resolve())
    return result

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app",default="/Users/sagar/Applications/FarFromDesk Local.app")
    parser.add_argument("--source",default="/Users/sagar/Documents/ChatGPT/Personal/whatsapp-session-bridge/.local/social-session-wiring-20261031")
    args=parser.parse_args()
    print(json.dumps(inspect(args.app,args.source),indent=2))
