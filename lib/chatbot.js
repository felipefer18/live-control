// Comandos de chat (!pix, !discord...) e mensagens automáticas por tempo.
export function createChatbot({ config, say, isLive, publish }) {
  const cooldowns = new Map();
  let timerState = [];

  async function send(text) {
    try { await say(text); publish({ type: 'botSay', text }); }
    catch (e) { publish({ type: 'botSay', text, error: e.message }); }
  }

  function onChat(m) {
    for (const t of timerState) t.lines++;
    const first = (m.text || '').trim().split(/\s+/)[0]?.toLowerCase();
    if (!first || !first.startsWith('!')) return;
    for (const c of config.commands ?? []) {
      if (!c.trigger || c.trigger.toLowerCase() !== first || !c.response) continue;
      const now = Date.now();
      if (now - (cooldowns.get(first) ?? 0) < (c.cooldown ?? 30) * 1000) return;
      cooldowns.set(first, now);
      send(c.response.replaceAll('{user}', m.user));
      return;
    }
  }

  function resetTimers() {
    timerState = (config.timers ?? []).map(() => ({ at: Date.now(), lines: 0 }));
  }
  resetTimers();

  setInterval(() => {
    if (!isLive()) return;
    (config.timers ?? []).forEach((t, i) => {
      const s = timerState[i] ?? (timerState[i] = { at: Date.now(), lines: 0 });
      if (!t.message || !t.everyMin) return;
      if (Date.now() - s.at >= t.everyMin * 60000 && s.lines >= (t.minLines ?? 0)) {
        s.at = Date.now(); s.lines = 0;
        send(t.message);
      }
    });
  }, 20000);

  return { onChat, resetTimers, send };
}
