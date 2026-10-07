// Random ids for the MCP server: 128-bit url-safe ids (prepared actions,
// sign-in handles, grant mirror rows), hex markers and 6-digit codes, all
// from crypto.getRandomValues. Relative imports only.

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newId(bytes = 16): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Uniform over 000000 to 999999: values at or above the largest multiple of
// a million below 2^32 are drawn again.
const CODE_LIMIT = 4294000000;

export function sixDigitCode(): string {
  const value = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(value);
    if (value[0] < CODE_LIMIT) {
      return String(value[0] % 1000000).padStart(6, "0");
    }
  }
}
