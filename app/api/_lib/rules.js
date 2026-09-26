// Turns Jev's answers into entry/exit decisions (same logic as the PC bot's rules.py).
const g = (v) => String(Number(Number(v).toPrecision(6)));   // like Python's :g

function check(cond, answers) {
  const key = cond.question;
  const a = answers[key];
  if (!a) return [false, `${key}: no answer`];
  const conf = a.confidence;
  if (cond.min_confidence != null && conf != null && conf < cond.min_confidence) {
    return [false, `${key}: confidence ${conf.toFixed(2)} < ${cond.min_confidence}`];
  }
  if (cond.is != null) {
    const ok = a.choice === cond.is;
    return [ok, `${key}=${a.choice} (${ok ? '=' : '!='} ${cond.is})`];
  }
  const value = a.type === 'score' ? a.score : a.noul;
  if (value == null) return [false, `${key}: no value`];
  if (cond.at_least != null) {
    const ok = value >= cond.at_least;
    return [ok, `${key}=${g(value)} (${ok ? '>=' : '<'} ${cond.at_least})`];
  }
  const ok = value < cond.below;
  return [ok, `${key}=${g(value)} (${ok ? '<' : '>='} ${cond.below})`];
}

export function entrySignal(rules, answers) {
  const res = rules.entry.map(c => check(c, answers));
  return [res.every(([ok]) => ok), res.map(([, r]) => r).join('; ')];
}

export function exitSignal(rules, answers) {
  const res = rules.exit.map(c => check(c, answers));
  const hits = res.filter(([ok]) => ok).map(([, r]) => r);
  return [hits.length > 0, hits.length ? hits.join('; ') : res.map(([, r]) => r).join('; ')];
}

export function summarise(answers) {
  return Object.entries(answers).map(([k, a]) => {
    if (a.type === 'choice') return `${k}=${a.choice}@${(a.confidence ?? 0).toFixed(2)}`;
    if (a.type === 'score') return `${k}=${g(a.score)}@${(a.confidence ?? 0).toFixed(2)}`;
    return `${k}=${(a.noul ?? 0).toFixed(2)}`;
  }).join(' ');
}

export function describe(conds) {
  return conds.map(c => {
    let s = c.is != null ? `${c.question} is '${c.is}'` : c.at_least != null ? `${c.question} at least ${c.at_least}` : `${c.question} below ${c.below}`;
    if (c.min_confidence != null) s += ` (confidence at least ${c.min_confidence})`;
    return s;
  });
}
