# Phone remote page

Static page served at https://ffd.codecylabs.com/remote/. The phone and Mac talk directly over WebRTC; the server only serves these files.

`remote.js` imports `protocol.js` and `signal-codec.js`, compiled from `src/remote-p2p/` for each deploy:

```sh
for f in protocol signal-codec; do npx esbuild src/remote-p2p/$f.ts --format=esm --target=es2020 > out/$f.js; done
cp remote-page/* out/
```

Deploy the page together with the app release that matches it.
