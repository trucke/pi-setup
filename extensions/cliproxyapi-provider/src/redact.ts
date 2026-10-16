/**
 * Remove a credential from text that may have come from the proxy, such as an error page that
 * echoes request headers. Redact before truncating so a cut cannot leave a partial key behind.
 */
export function redactSecret(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}
