// Ações do chat: "quando acontecer X (recompensa de pontos, doação, bits, follow, comando...),
// faça Y (tocar som, mostrar texto, trocar de cena, falar no chat, marcar clipe...)".
const norm = (s) => String(s ?? '').trim().toLowerCase();
const stripBang = (s) => norm(s).replace(/^!/, '');

export const TRIGGER_TYPES = ['redeem', 'donation', 'bits', 'follow', 'sub', 'resub', 'gift', 'raid', 'command', 'win', 'loss'];

function whoOk(who, ctx) {
  if (!who || who === 'all') return true;
  const b = String(ctx.badges ?? '');
  const mod = /broadcaster|moderator/.test(b);
  if (who === 'mods') return mod;
  if (who === 'subs') return mod || /subscriber|founder/.test(b);
  if (who === 'vips') return mod || /vip/.test(b);
  return true;
}

export function matches(t, type, ctx) {
  const w = t.when ?? {};
  if (w.type !== type) return false;
  const amount = Number(ctx.amount) || 0;
  switch (type) {
    case 'redeem': return !w.match || norm(w.match) === norm(ctx.title);
    case 'donation': return amount >= (Number(w.min) || 0) && (!Number(w.max) || amount <= Number(w.max));
    case 'bits': case 'gift': case 'raid': return amount >= (Number(w.min) || 0);
    case 'command': return !!w.match && stripBang(w.match) === stripBang(ctx.command) && whoOk(w.who, ctx);
    default: return true; // follow, sub, resub, win, loss
  }
}

export const fill = (s, ctx) => String(s ?? '')
  .replaceAll('{user}', ctx.user ?? '').replaceAll('{amount}', ctx.amount ?? '')
  .replaceAll('{input}', ctx.input ?? '').replaceAll('{reward}', ctx.title ?? '').replaceAll('{game}', ctx.game ?? '');

// run(action, ctx) é fornecido pelo servidor e sabe executar cada tipo de ação
export function createTriggers({ config, run, onFire }) {
  const last = new Map();

  async function runActions(t, ctx) {
    for (const a of t.actions ?? []) {
      try { await run({ ...a, text: fill(a.text, ctx), label: fill(a.label, ctx) }, ctx); }
      catch (e) { onFire?.(t, ctx, { error: `${a.type}: ${e.message}` }); }
    }
  }

  async function fire(type, ctx = {}) {
    const fired = [];
    for (const t of config.triggers ?? []) {
      if (!t.enabled || !matches(t, type, ctx)) continue;
      const cd = (Number(t.cooldown) || 0) * 1000;
      const now = Date.now();
      if (cd && now - (last.get(t.id) ?? 0) < cd) continue;
      last.set(t.id, now);
      fired.push(t.label || t.id);
      onFire?.(t, ctx, {});
      runActions(t, ctx); // não espera, para uma ação lenta (trocar de cena por X segundos) não travar as outras
    }
    return fired;
  }

  async function test(id) {
    const t = (config.triggers ?? []).find((x) => x.id === id);
    if (!t) throw new Error('Ação não encontrada');
    const w = t.when ?? {};
    const ctx = { user: 'Teste', amount: Number(w.min) || 10, title: w.match || 'Recompensa', input: 'mensagem de teste', command: w.match, test: true, game: 'CS2' };
    await runActions(t, ctx);
    return ctx;
  }

  return { fire, test };
}
