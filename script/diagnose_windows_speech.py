"""Bounded diagnostics using only the repository's public English fixture."""
from pathlib import Path
import subprocess, tempfile, time
root = Path(__file__).resolve().parent.parent
speech = root / 'build/speech-runtime-x86_64'
with tempfile.TemporaryDirectory(prefix='ffd-speech-diagnostic-') as td:
    wav = Path(td) / 'input.wav'
    subprocess.run([str(speech/'ffmpeg.exe'), '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', str(root/'test/fixtures/local-english.ogg'), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(wav)], check=True, timeout=30)
    data = wav.read_bytes()
    print('Public fixture decoded bytes:', len(data), flush=True)
    for threads in [1, 4]:
        started = time.monotonic()
        args = [str(speech/'whisper-avx2.exe'), '-m', str(speech/'ggml-base.bin'), '-f', '-', '-l', 'auto', '-nt', '-t', str(threads)]
        try:
            r = subprocess.run(args, input=data, capture_output=True, timeout=60)
            print(f'Threads={threads} exit={r.returncode} seconds={time.monotonic()-started:.2f}', flush=True)
            print(r.stderr.decode(errors='replace')[-7000:], flush=True)
            print('Fixture output:', r.stdout.decode(errors='replace')[-1000:], flush=True)
        except subprocess.TimeoutExpired as e:
            print(f'Threads={threads} timed out after 60 seconds', flush=True)
            print((e.stderr or b'').decode(errors='replace')[-7000:], flush=True)
