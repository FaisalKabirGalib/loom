const SECRET_KEY =
  /(api[-_]?key|authorization|bearer|credential|password|secret|token|dsn)/i;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? "[REDACTED]" : redactSecrets(item),
    ]),
  );
}

export function containsSecretValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretValue);
  if (!value || typeof value !== "object") return false;
  return Object.keys(value).some((key) => SECRET_KEY.test(key));
}
