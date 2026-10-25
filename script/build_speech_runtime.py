#!/usr/bin/env python3
"""Build pinned, self-contained local speech tools. Never download at note time."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
SYSTEM = platform.system()
ARCH = os.environ.get('WSB_TARGET_ARCH', {'AMD64':'x86_64', 'aarch64':'arm64'}.get(platform.machine(), platform.machine()))
SUFFIX = '.exe' if SYSTEM == 'Windows' else ''
if ARCH not in ('arm64', 'x86_64'):
    raise RuntimeError('Unsupported speech architecture')
WORK = ROOT / ('build/speech-toolchain' if ARCH == 'arm64' else 'build/speech-toolchain-x86_64')
OUTPUT = ROOT / ('build/speech-runtime' if ARCH == 'arm64' else 'build/speech-runtime-x86_64')
MODEL_HASH = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
SOURCES = {
    'ffmpeg-9.0.2.tar.xz': ('https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz', '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e'),
    'whisper-1.9.2.tar.gz': ('https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.2.tar.gz', 'a6abd064fcca8b85e794d205abf328c522e9451db43a3eadc178b883b7d0e9cd'),
}

def digest(path):
    result = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()

def download(url, path, expected):
    if path.exists() and digest(path) == expected:
        return
    temporary = path.with_suffix(path.suffix + '.partial')
    with urllib.request.urlopen(url, timeout=60) as source, open(temporary, 'wb') as dest:
        shutil.copyfileobj(source, dest)
    if digest(temporary) != expected:
        temporary.unlink()
        raise RuntimeError('Downloaded file checksum does not match pinned source: ' + path.name)
    temporary.replace(path)

def run(args, cwd=None, unix=False):
    if SYSTEM == 'Windows' and unix:
        bash = os.environ.get('FFD_MSYS_BASH', r'C:\msys64\usr\bin\bash.exe')
        args = [bash, '--noprofile', '--norc', '-c', 'export PATH=/ucrt64/bin:/usr/bin; exec "$@"', 'ffd-speech', *args]
    subprocess.run(args, cwd=cwd, check=True)

def extract(archive, name):
    destination = WORK / name
    if not destination.exists():
        destination.mkdir()
        with tarfile.open(archive) as source:
            source.extractall(destination, filter='data')
    folders = [p for p in destination.iterdir() if p.is_dir()]
    if len(folders) != 1:
        raise RuntimeError('Unexpected source layout')
    return folders[0]

def main():
    if SYSTEM not in ('Darwin', 'Linux', 'Windows'):
        raise RuntimeError('Unsupported speech platform.')
    WORK.mkdir(parents=True, exist_ok=True)
    for name, (url, sha) in SOURCES.items():
        cached = ROOT / 'build/speech-toolchain' / name
        if not (WORK / name).exists() and cached.is_file() and digest(cached) == sha:
            shutil.copy2(cached, WORK / name)
        download(url, WORK / name, sha)
    ffmpeg = extract(WORK / 'ffmpeg-9.0.2.tar.xz', 'ffmpeg-source')
    whisper = extract(WORK / 'whisper-1.9.2.tar.gz', 'whisper-source')
    ffmpeg_args = [
        './configure', '--disable-shared', '--enable-static', '--disable-autodetect',
        '--disable-network', '--disable-doc', '--disable-debug', '--disable-programs',
        '--disable-everything', '--enable-ffmpeg', '--enable-avcodec', '--enable-avformat',
        '--enable-avfilter', '--enable-swresample', '--disable-videotoolbox', '--disable-audiotoolbox',
        '--enable-protocol=file,pipe', '--enable-demuxer=ogg,mov,mp3,wav,flac,matroska,aac,amr',
        '--enable-parser=opus,vorbis,flac,mpegaudio,aac,amr',
        '--enable-decoder=opus,vorbis,mp3,mp3float,aac,aac_fixed,alac,flac,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le,pcm_s16be,amrnb,amrwb',
        '--enable-encoder=pcm_s16le', '--enable-muxer=wav',
        '--enable-filter=aresample,aformat,anull,atrim,abuffer,abuffersink,format',
    ]
    if SYSTEM == 'Darwin':
        ffmpeg_args.extend(['--cc=clang', '--arch=' + ARCH, '--target-os=darwin',
            '--extra-cflags=-arch ' + ARCH + ' -mmacosx-version-min=14.0', '--extra-ldflags=-arch ' + ARCH + ' -mmacosx-version-min=14.0'])
        if ARCH == 'x86_64': ffmpeg_args.append('--enable-cross-compile')
    elif SYSTEM == 'Windows':
        ffmpeg_args.extend(['--cc=gcc', '--target-os=mingw32', '--extra-ldflags=-static'])
    else:
        ffmpeg_args.append('--cc=cc')
    if ARCH == 'x86_64': ffmpeg_args.append('--disable-x86asm')
    if not (ffmpeg / ('ffmpeg' + SUFFIX)).exists():
        run(ffmpeg_args, ffmpeg, unix=True)
        run(['make', '-j', '4', 'ffmpeg' + SUFFIX], ffmpeg, unix=True)
    whisper_build = WORK / 'whisper-build'
    cmake_args = ['cmake', '-S', str(whisper), '-B', str(whisper_build),
        '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_OPENMP=OFF',
        '-DGGML_BACKEND_DL=OFF', '-DGGML_NATIVE=OFF', '-DGGML_METAL=' + ('ON' if SYSTEM == 'Darwin' and ARCH == 'arm64' else 'OFF'), '-DGGML_METAL_EMBED_LIBRARY=ON',
        '-DGGML_BLAS=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF']
    if SYSTEM == 'Darwin':
        cmake_args.extend(['-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0', '-DCMAKE_OSX_ARCHITECTURES=' + ARCH])
    if SYSTEM == 'Windows':
        cmake_args.extend(['-A', 'x64', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded$<$<CONFIG:Debug>:Debug>'])
    if ARCH == 'arm64':
        cmake_args.append('-DGGML_CPU_ARM_ARCH=armv8.2-a+fp16')
    else:
        cmake_args.extend(['-DGGML_AVX=OFF', '-DGGML_AVX2=OFF', '-DGGML_FMA=OFF', '-DGGML_F16C=OFF'])
    run(cmake_args)
    run(['cmake', '--build', str(whisper_build), '--target', 'whisper-cli', '--config', 'Release', '-j', '4'])
    OUTPUT.mkdir(parents=True, exist_ok=True)
    whisper_bin = whisper_build / ('bin/Release/whisper-cli.exe' if SYSTEM == 'Windows' else 'bin/whisper-cli')
    for src, name in [(ffmpeg / ('ffmpeg' + SUFFIX), 'ffmpeg' + SUFFIX), (whisper_bin, 'whisper-cli' + SUFFIX)]:
        shutil.copy2(src, OUTPUT / name)
        if SYSTEM == 'Darwin':
            run(['codesign', '--force', '--sign', '-', str(OUTPUT / name)])
            linked = subprocess.check_output(['otool', '-L', str(OUTPUT / name)], text=True).splitlines()[1:]
            if any(not line.strip().startswith(('/usr/lib/', '/System/Library/')) for line in linked):
                raise RuntimeError('Speech tool still depends on external libraries: ' + name)
    model = OUTPUT / 'ggml-base.bin'
    existing = Path(os.environ.get('WSB_MODEL_SOURCE', str(Path.home() / 'Library/Application Support/WhatsApp Session Bridge/models/ggml-base.bin')))
    if existing.is_file() and digest(existing) == MODEL_HASH:
        shutil.copy2(existing, model)
    else:
        download('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin', model, MODEL_HASH)
    licenses = OUTPUT / 'licenses'
    licenses.mkdir(exist_ok=True)
    shutil.copy2(ffmpeg / 'COPYING.LGPLv2.1', licenses / 'FFMPEG-LGPL-2.1.txt')
    shutil.copy2(whisper / 'LICENSE', licenses / 'WHISPER-CPP-MIT.txt')
    model_license = licenses / 'WHISPER-MODEL-MIT.txt'
    if not model_license.exists():
        with urllib.request.urlopen('https://raw.githubusercontent.com/openai/whisper/main/LICENSE', timeout=30) as source:
            model_license.write_bytes(source.read())
    # Include exact unmodified source archives and build recipe for redistribution.
    for name in SOURCES:
        shutil.copy2(WORK / name, licenses / name)
    shutil.copy2(__file__, licenses / 'build_speech_runtime.py')
    (licenses / 'build-options.json').write_text(json.dumps({'ffmpeg': ffmpeg_args, 'whisper': cmake_args}, indent=2).replace(str(ROOT), '${PROJECT_ROOT}'))
    manifest = {'schema': 1, 'architecture': 'arm64' if ARCH == 'arm64' else 'x64', 'minimumMacOS': '14.0',
        'platform': {'Darwin':'darwin','Linux':'linux','Windows':'win32'}[SYSTEM],
        'ffmpeg': 'ffmpeg' + SUFFIX, 'whisper': 'whisper-cli' + SUFFIX, 'model': 'ggml-base.bin',
        'versions': {'ffmpeg': '9.0.2', 'whisper': '1.9.2', 'model': 'multilingual-base'},
        'sha256': {name: digest(OUTPUT / name) for name in ['ffmpeg' + SUFFIX, 'whisper-cli' + SUFFIX, 'ggml-base.bin']}}
    (OUTPUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    for path in OUTPUT.rglob('*'):
        path.chmod(0o755 if path.is_dir() or path.name in ['ffmpeg' + SUFFIX, 'whisper-cli' + SUFFIX] else 0o644)
    print('Self-contained speech runtime:', OUTPUT)

if __name__ == '__main__':
    main()
