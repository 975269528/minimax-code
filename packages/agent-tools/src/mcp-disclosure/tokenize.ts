const HAN = /\p{Script=Han}/u;
const HAS_UPPER = /[A-Z]/;
const RUN_RE = /[A-Za-z0-9]+|\p{Script=Han}+/gu;

function splitIdentifier(s: string): string[] {
  let r = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  if (HAS_UPPER.test(s)) {
    r = r.replace(/([A-Za-z])([0-9])/g, '$1 $2').replace(/([0-9])([A-Za-z])/g, '$1 $2');
  }
  return r.split(/\s+/).filter(Boolean);
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const runs = text.match(RUN_RE) ?? [];
  for (const run of runs) {
    if (HAN.test(run)) {
      const chars = [...run];
      for (const ch of chars) out.push(ch);
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
    } else {
      for (const sub of splitIdentifier(run)) out.push(sub.toLowerCase());
    }
  }
  return out;
}
