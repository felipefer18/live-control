// Placar da sessão: vitórias, derrotas, sequência e quebra por jogo.
export function createScore({ state, saveState, onChange }) {
  const s = () => state.score;
  const bucket = (g) => (s().byGame[g || 'geral'] ??= { wins: 0, losses: 0 });

  function recomputeStreak() {
    const h = s().history; let n = 0, type = null;
    for (let i = h.length - 1; i >= 0; i--) {
      if (type === null) { type = h[i].result; n = 1; }
      else if (h[i].result === type) n++;
      else break;
    }
    s().streak = { type, n };
  }

  function status() {
    const { wins, losses, streak, byGame, history, auto } = s();
    const total = wins + losses;
    return { wins, losses, total, winRate: total ? Math.round((wins / total) * 100) : null, streak, byGame, last: history.at(-1) ?? null, auto: auto !== false };
  }
  const emit = () => { saveState(); onChange?.(status()); };

  return {
    status,
    add(result, game, source = 'manual') {
      if (result !== 'win' && result !== 'loss') throw new Error('Resultado inválido');
      const e = { t: Date.now(), game: game || 'geral', result, source };
      if (result === 'win') { s().wins++; bucket(e.game).wins++; } else { s().losses++; bucket(e.game).losses++; }
      s().history.push(e); if (s().history.length > 300) s().history.shift();
      recomputeStreak(); emit();
      return e;
    },
    undo() {
      const e = s().history.pop();
      if (!e) return null;
      if (e.result === 'win') { s().wins = Math.max(0, s().wins - 1); bucket(e.game).wins = Math.max(0, bucket(e.game).wins - 1); }
      else { s().losses = Math.max(0, s().losses - 1); bucket(e.game).losses = Math.max(0, bucket(e.game).losses - 1); }
      recomputeStreak(); emit();
      return e;
    },
    reset() { state.score = { ...state.score, wins: 0, losses: 0, byGame: {}, history: [], streak: { type: null, n: 0 } }; emit(); },
    setAuto(v) { s().auto = !!v; emit(); }
  };
}
