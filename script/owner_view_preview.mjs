import {ownerViewSetupServer} from '../dist/owner-view/http.js';
const view=ownerViewSetupServer();
console.log(await view.listen());
const stop=()=>view.server.close();
process.once('SIGINT',stop);process.once('SIGTERM',stop);
const timeout=setTimeout(stop,15*60_000);timeout.unref();
view.server.once('close',()=>clearTimeout(timeout));
