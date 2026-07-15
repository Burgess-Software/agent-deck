// Shared property-inspector glue implementing the Elgato PI protocol.
let ws, piUUID, actionInfo;

window.connectElgatoStreamDeckSocket = function (inPort, inUUID, inRegisterEvent, inInfo, inActionInfo) {
  piUUID = inUUID;
  actionInfo = JSON.parse(inActionInfo);
  ws = new WebSocket(`ws://127.0.0.1:${inPort}`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ event: inRegisterEvent, uuid: inUUID }));
    if (window.onPIReady) window.onPIReady(actionInfo.payload?.settings ?? {}, actionInfo);
  };
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.event === 'didReceiveSettings' && window.onSettings) {
      window.onSettings(data.payload?.settings ?? {});
    }
    if (data.event === 'sendToPropertyInspector' && window.onPluginMessage) {
      window.onPluginMessage(data.payload ?? {});
    }
  };
};

function saveSettings(settings) {
  ws?.send(JSON.stringify({ event: 'setSettings', context: piUUID, payload: settings }));
}

function sendToPlugin(payload) {
  ws?.send(JSON.stringify({ event: 'sendToPlugin', action: actionInfo?.action, context: piUUID, payload }));
}

// Collect values from all [data-setting] inputs and persist on change.
function bindForm() {
  const els = document.querySelectorAll('[data-setting]');
  const collect = () => {
    const s = {};
    els.forEach((el) => {
      s[el.dataset.setting] = el.type === 'checkbox' ? el.checked : el.value;
    });
    saveSettings(s);
  };
  els.forEach((el) => el.addEventListener('change', collect));
  els.forEach((el) => { if (el.tagName === 'TEXTAREA' || el.type === 'text') el.addEventListener('input', collect); });
  return {
    load(settings) {
      els.forEach((el) => {
        if (!(el.dataset.setting in settings)) return;
        if (el.type === 'checkbox') el.checked = !!settings[el.dataset.setting];
        else el.value = settings[el.dataset.setting];
      });
    },
  };
}
