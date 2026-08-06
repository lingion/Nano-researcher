const FILTER_NAMES = ["site", "domain", "filetype", "lang", "after", "before", "source", "type"];

function emptyFilters() {
  return {
    site: null,
    domain: null,
    filetype: null,
    lang: null,
    after: null,
    before: null,
    source: null,
    type: null
  };
}

function readAtom(input, start) {
  const quoted = input[start] === '"';
  let index = quoted ? start + 1 : start;
  let value = "";
  let closed = !quoted;

  while (index < input.length) {
    const character = input[index];
    if (character === "\\" && index + 1 < input.length) {
      value += input[index + 1];
      index += 2;
      continue;
    }
    if (quoted && character === '"') {
      closed = true;
      index += 1;
      break;
    }
    if (!quoted && /\s/.test(character)) break;
    value += character;
    index += 1;
  }

  return { value, end: index, quoted, closed };
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(`${value}T00:00:00Z`);
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function addDiagnostic(diagnostics, code, message, value) {
  diagnostics.push({ code, message, value });
}

function addFilter(filters, diagnostics, key, value) {
  if (!value) {
    addDiagnostic(diagnostics, "empty_filter", `Filter ${key} requires a value`, value);
    return;
  }
  if ((key === "after" || key === "before") && !isValidDate(value)) {
    addDiagnostic(diagnostics, "invalid_date", `Filter ${key} requires YYYY-MM-DD`, value);
    return;
  }
  if (filters[key] !== null) addDiagnostic(diagnostics, "duplicate_filter", `Filter ${key} was repeated`, value);
  filters[key] = key === "filetype" || key === "lang" || key === "source" || key === "type"
    ? value.toLowerCase()
    : value;
}

export function parseQuery(rawQuery) {
  const raw = typeof rawQuery === "string" ? rawQuery : "";
  const required = [];
  const optional = [];
  const excluded = [];
  const phrases = [];
  const anyOf = [];
  const positiveParts = [];
  const filters = emptyFilters();
  const diagnostics = [];
  let lastPositive = null;
  let currentOrGroup = null;
  let pendingOr = false;
  const finishOrGroup = () => {
    if (currentOrGroup?.length) anyOf.push(currentOrGroup);
    currentOrGroup = null;
    pendingOr = false;
  };
  let index = 0;

  while (index < raw.length) {
    while (index < raw.length && /\s/.test(raw[index])) index += 1;
    if (index >= raw.length) break;

    let modifier = "";
    if ((raw[index] === "+" || raw[index] === "-") && raw[index + 1] && !/\s/.test(raw[index + 1])) {
      modifier = raw[index];
      index += 1;
    }

    const atom = readAtom(raw, index);
    index = atom.end;
    if (!atom.closed) addDiagnostic(diagnostics, "unclosed_quote", "Quoted phrase is not closed", atom.value);
    if (!atom.value) {
      addDiagnostic(diagnostics, "empty_term", "A query term cannot be empty", atom.value);
      continue;
    }

    if (!modifier && !atom.quoted && atom.value.toLocaleLowerCase() === "or") {
      if (lastPositive !== null) {
        currentOrGroup ??= [lastPositive];
        pendingOr = true;
      }
      continue;
    }

    const colon = !modifier && !atom.quoted ? atom.value.indexOf(":") : -1;
    if (colon > 0) {
      const key = atom.value.slice(0, colon).toLowerCase();
      const value = atom.value.slice(colon + 1);
      if (FILTER_NAMES.includes(key)) {
        finishOrGroup();
        addFilter(filters, diagnostics, key, value);
        continue;
      }
      addDiagnostic(diagnostics, "unsupported_filter", `Unsupported filter ${key}`, atom.value);
    }

    if (modifier === "-") {
      finishOrGroup();
      excluded.push(atom.value);
      continue;
    }
    if (!pendingOr) finishOrGroup();
    if (modifier === "+") required.push(atom.value);
    else if (!atom.quoted) optional.push(atom.value);
    else if (modifier === "") phrases.push(atom.value);
    positiveParts.push(atom.value);
    if (pendingOr && currentOrGroup) currentOrGroup.push(atom.value);
    lastPositive = atom.value;
    pendingOr = false;
  }

  finishOrGroup();
  const alternativeValues = new Set(anyOf.flat());
  return {
    raw,
    text: positiveParts.join(" "),
    required: required.filter((term) => !alternativeValues.has(term)),
    optional,
    excluded,
    phrases: phrases.filter((phrase) => !alternativeValues.has(phrase)),
    anyOf,
    filters,
    diagnostics
  };
}
