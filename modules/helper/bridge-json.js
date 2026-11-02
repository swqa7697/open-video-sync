export function parseBridgeJSON(raw, maxBytes) {
  if (
    typeof raw !== 'string' ||
    raw.length > maxBytes ||
    new TextEncoder().encode(raw).length > maxBytes
  )
    throw Error('Invalid bridge JSON');
  let at = 0;
  const invalid = () => {
    throw Error('Invalid bridge JSON');
  };
  const space = () => {
    while (at < raw.length && /[ \t\r\n]/.test(raw[at])) at++;
  };
  const string = () => {
    const start = at++;
    let escaped = false;
    while (at < raw.length) {
      const c = raw[at++];
      if (!escaped && c === '"') {
        const value = JSON.parse(raw.slice(start, at));
        if (
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
            value,
          )
        )
          invalid();
        return value;
      }
      if (c === '\\' && !escaped) escaped = true;
      else escaped = false;
    }
    return invalid();
  };
  const visit = (depth) => {
    space();
    const c = raw[at];
    if (c === '{' || c === '[') {
      if (depth >= 8) invalid();
      at++;
      space();
      const end = c === '{' ? '}' : ']',
        keys = new Set();
      if (raw[at] === end) {
        at++;
        return;
      }
      for (;;) {
        if (c === '{') {
          if (raw[at] !== '"') invalid();
          const key = string();
          if (keys.has(key)) invalid();
          keys.add(key);
          space();
          if (raw[at++] !== ':') invalid();
        }
        visit(depth + 1);
        space();
        const next = raw[at++];
        if (next === end) break;
        if (next !== ',') invalid();
        space();
      }
    } else if (c === '"') string();
    else {
      const token =
        /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
          raw.slice(at),
        )?.[0];
      if (!token) invalid();
      at += token.length;
    }
  };
  visit(0);
  space();
  if (at !== raw.length) invalid();
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value;
}
