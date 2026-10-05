// Prints a new VAPID key pair for web push (src/server/push.ts), in the
// shape the Worker reads: VAPID_PUBLIC_KEY is the raw uncompressed P-256
// public key and VAPID_PRIVATE_KEY its private scalar (JWK "d"), both
// base64url.
//
//   node scripts/generate-vapid.mjs
//
// Local development: paste the two lines into .dev.vars (never commit it).
// Production: the operator sets each value as a Worker secret, with
// VAPID_SUBJECT (mailto:<an address that reads mail>). Changing the pair
// later invalidates every existing browser subscription, so generate the
// production pair once and keep it.

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);

const base64Url = (bytes) => Buffer.from(bytes).toString("base64url");

console.log(`VAPID_PUBLIC_KEY=${base64Url(publicRaw)}`);
console.log(`VAPID_PRIVATE_KEY=${privateJwk.d}`);
