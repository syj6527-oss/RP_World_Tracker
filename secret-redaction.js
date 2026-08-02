// Redact obvious credentials from transient outbound text.
// This helper never reads from or writes to PAW MAP storage.

const PEM_PRIVATE_KEY = /-----BEGIN ((?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;
const OPENAI_KEY = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_-]{20,}\b/g;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const BEARER_TOKEN = /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{8,}/gi;
const AUTHORIZATION_HEADER = /(\bAuthorization\s*[:=]\s*)(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const NAMED_SECRET_ASSIGNMENT = /((?:["'])?(?:(?:[A-Za-z0-9]+[_-])?api[_-]?key|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?key|authorization|password)(?:["'])?\s*[:=]\s*)(\[REDACTED(?: PRIVATE KEY)?\]|"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gi;

export function redactOutboundSecrets(value) {
    let text = String(value ?? '');

    text = text
        .replace(PEM_PRIVATE_KEY, '[REDACTED PRIVATE KEY]')
        .replace(OPENAI_KEY, '[REDACTED]')
        .replace(GOOGLE_API_KEY, '[REDACTED]')
        .replace(AWS_ACCESS_KEY, '[REDACTED]')
        .replace(AUTHORIZATION_HEADER, '$1[REDACTED]')
        .replace(BEARER_TOKEN, 'Bearer [REDACTED]');

    return text.replace(NAMED_SECRET_ASSIGNMENT, (_match, prefix, assignedValue) => {
        const quote = assignedValue[0];
        return quote === '"' || quote === "'"
            ? `${prefix}${quote}[REDACTED]${quote}`
            : `${prefix}[REDACTED]`;
    });
}
