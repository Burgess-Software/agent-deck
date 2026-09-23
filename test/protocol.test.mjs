import test from 'node:test';
import assert from 'node:assert/strict';

import { StreamDeck } from '../plugin/bin/lib/protocol.mjs';

test('redraws send only changed image and title, then resend after a key reappears', async () => {
  const originalWebSocket = globalThis.WebSocket;
  let socket;
  class FakeWebSocket {
    constructor() {
      this.readyState = 0;
      this.listeners = new Map();
      this.messages = [];
      socket = this;
    }

    addEventListener(event, listener) { this.listeners.set(event, listener); }
    send(message) { this.messages.push(JSON.parse(message)); }
    open() {
      this.readyState = 1;
      this.listeners.get('open')();
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  try {
    const deck = new StreamDeck({ port: '1234', pluginUUID: 'plugin', registerEvent: 'registerPlugin' });
    deck.setImage('key', 'image-a'); // A disconnected write must not populate the cache.
    socket.open();
    await deck.readyPromise;

    deck.setImage('key', 'image-a');
    deck.setTitle('key', 'Working');
    deck.setImage('key', 'image-a');
    deck.setTitle('key', 'Working');
    deck.setImage('key', 'image-b');
    deck.clearContext('key');
    deck.setImage('key', 'image-b');
    deck.setTitle('key', 'Working');

    assert.deepEqual(socket.messages.map(({ event }) => event), [
      'registerPlugin', 'setImage', 'setTitle', 'setImage', 'setImage', 'setTitle',
    ]);
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});
