const REDACTED = '[REDACTED]';

const AUTH_SCHEME_TOKEN = /(Bearer|Basic)\s+[^\s,;"']+/gi;
const QUOTED_FIELD_VALUE = new RegExp(
  `(["'])([^"'\\\\\r\n]+)\\1(\\s*:\\s*)(["'])(?:\\\\.|(?!\\4)[^\\r\n])*(?:\\4|$)`,
  'gi',
);
const BARE_FIELD_VALUE = new RegExp(
  `(["']?)([A-Za-z0-9_.-]*(?:token|secret|password|credential)[A-Za-z0-9_.-]*|authorization|key|api[-_]?key|proxy[-_]?key|private[-_]?key|cookie|auth[-_]?conf|set[-_]?cookie)\\1(\\s*[:=]\\s*)(?:(['"])(?:\\\\.|(?!\\4)[^\\r\n])*(?:\\4|$)|([^\\s,;&\\]}]+))`,
  'gi',
);

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, '').toLowerCase();
  return normalized === 'authorization'
    || normalized === 'key'
    || normalized === 'authconf'
    || normalized === 'cookie'
    || normalized === 'privatekey'
    || normalized === 'setcookie'
    || normalized.includes('token')
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('credential')
    || normalized.includes('apikey')
    || normalized.includes('proxykey');
}

function redactText(value: string): string {
  return value
    .replace(AUTH_SCHEME_TOKEN, `$1 ${REDACTED}`)
    .replace(QUOTED_FIELD_VALUE, (match, keyQuote: string, key: string, separator: string, valueQuote: string) =>
      isSensitiveKey(key)
        ? `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${REDACTED}${valueQuote}`
        : match,
    )
    .replace(BARE_FIELD_VALUE, (match, keyQuote: string, key: string, separator: string, valueQuote: string | undefined) =>
      isSensitiveKey(key)
        ? `${keyQuote}${key}${keyQuote}${separator}${valueQuote ?? ''}${REDACTED}${valueQuote ?? ''}`
        : match,
    );
}

function redactParsedValue(parsed: unknown): unknown {
  if (typeof parsed === 'string') {
    try {
      return JSON.stringify(redactParsedValue(JSON.parse(parsed)));
    } catch (_error) {
      return redactText(parsed);
    }
  }
  if (Array.isArray(parsed)) return parsed.map(redactParsedValue);
  if (parsed !== null && typeof parsed === 'object') {
    return Object.fromEntries(
      Object.entries(parsed).map(([key, nestedValue]) => [
        key,
        isSensitiveKey(key) ? REDACTED : redactParsedValue(nestedValue),
      ]),
    );
  }
  return parsed;
}

function containsSensitiveKey(value: unknown): boolean {
  if (typeof value === 'string') {
    try {
      return containsSensitiveKey(JSON.parse(value));
    } catch (_error) {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nestedValue]) => isSensitiveKey(key) || containsSensitiveKey(nestedValue));
}

export function redactStructuredField(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  try {
    return JSON.stringify(redactParsedValue(JSON.parse(value)));
  } catch (_error) {
    return redactText(value);
  }
}

export function redactError(value: string): string {
  try {
    const parsed = JSON.parse(value);
    if (!containsSensitiveKey(parsed)) return redactText(value);
    const redactedValue = redactParsedValue(parsed);
    const redactedText = redactText(value);
    try {
      if (JSON.stringify(JSON.parse(redactedText)) === JSON.stringify(redactedValue)) return redactedText;
    } catch (_error) {
      return JSON.stringify(redactedValue);
    }
    return JSON.stringify(redactedValue);
  } catch (_error) {
    return redactText(value);
  }
}

function redactLogValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const redactedText = redactText(value);
    const jsonCandidate = redactedText.trimStart();

    if (!jsonCandidate.startsWith('{') && !jsonCandidate.startsWith('[') && !jsonCandidate.startsWith('"')) {
      return redactedText;
    }

    try {
      return JSON.stringify(redactLogValue(JSON.parse(redactedText)));
    } catch (_error) {
      return redactedText;
    }
  }
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        isSensitiveKey(key) ? REDACTED : redactLogValue(nestedValue),
      ]),
    );
  }
  return value;
}

export function redactLogLine(logLine: string): string {
  try {
    const ending = logLine.endsWith('\r\n') ? '\r\n' : '\n';
    return `${JSON.stringify(redactLogValue(JSON.parse(logLine)))}${ending}`;
  } catch (_error) {
    return redactText(logLine);
  }
}
