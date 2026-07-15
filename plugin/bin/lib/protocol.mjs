// Minimal Elgato Stream Deck SDK websocket client (works with OpenDeck).
// Uses the global WebSocket available in Node >= 22 and Bun.

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length - 1; i++) {
    const a = argv[i];
    if (a.startsWith('-')) out[a.replace(/^-+/, '')] = argv[i + 1];
  }
  return out;
}

export class StreamDeck {
  constructor({ port, pluginUUID, registerEvent, info }) {
    this.uuid = pluginUUID;
    this.info = info ? JSON.parse(info) : {};
    this.handlers = new Map();
    this.readyPromise = new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
      this.ws.addEventListener('open', () => {
        this.ws.send(JSON.stringify({ event: registerEvent, uuid: pluginUUID }));
        resolve();
      });
      this.ws.addEventListener('error', (e) => reject(e));
      this.ws.addEventListener('close', () => {
        // Host went away; nothing useful left to do.
        console.log('websocket closed, exiting');
        process.exit(0);
      });
      this.ws.addEventListener('message', (msg) => {
        let data;
        try { data = JSON.parse(msg.data); } catch { return; }
        const fns = this.handlers.get(data.event) || [];
        for (const fn of fns) {
          try { fn(data); } catch (err) { console.error(`handler ${data.event} failed:`, err); }
        }
      });
    });
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
  }

  send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  setImage(context, image) {
    this.send({ event: 'setImage', context, payload: { image, target: 0 } });
  }

  setTitle(context, title) {
    this.send({ event: 'setTitle', context, payload: { title, target: 0 } });
  }

  setSettings(context, settings) {
    this.send({ event: 'setSettings', context, payload: settings });
  }

  setFeedback(context, payload) {
    this.send({ event: 'setFeedback', context, payload });
  }

  showOk(context) { this.send({ event: 'showOk', context }); }
  showAlert(context) { this.send({ event: 'showAlert', context }); }

  sendToPropertyInspector(context, payload) {
    this.send({ event: 'sendToPropertyInspector', context, payload });
  }

  logMessage(message) { this.send({ event: 'logMessage', payload: { message } }); }
}
