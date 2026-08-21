import { isIP } from "node:net";

function parseIpv4(address: string) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return undefined;
  const parts = address.split(".").map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : undefined;
}

function ipv6Parts(address: string): number[] | undefined {
  let normalized = address.toLowerCase().split("%")[0];
  const ipv4Match = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match) {
    const ipv4 = parseIpv4(ipv4Match[1]);
    if (!ipv4) return undefined;
    normalized = normalized.slice(0, -ipv4Match[1].length);
    normalized += `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const parts = [...left, ...Array(missing).fill("0"), ...right].map((part) =>
    Number.parseInt(part || "0", 16),
  );
  return parts.length === 8 && parts.every((part) => Number.isFinite(part))
    ? parts
    : undefined;
}

export function isPublicIpAddress(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const parts = parseIpv4(address);
    if (!parts) return false;
    const [a, b, c] = parts;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (family !== 6) return false;

  const parts = ipv6Parts(address);
  if (!parts) return false;
  const [first, second, third, fourth, fifth, sixth] = parts;
  const isUnspecifiedOrLoopback =
    parts.slice(0, 7).every((part) => part === 0) && parts[7] <= 1;
  const isIpv4Compatible =
    first === 0 &&
    second === 0 &&
    third === 0 &&
    fourth === 0 &&
    fifth === 0 &&
    sixth === 0;
  const isIpv4Mapped =
    first === 0 &&
    second === 0 &&
    third === 0 &&
    fourth === 0 &&
    fifth === 0 &&
    sixth === 0xffff;
  const embeddedIpv4 = (high: number, low: number) =>
    `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  if (isIpv4Mapped) {
    return isPublicIpAddress(embeddedIpv4(parts[6], parts[7]));
  }
  // 6to4 and the well-known NAT64 prefix can tunnel otherwise private IPv4.
  if (first === 0x2002) {
    return isPublicIpAddress(embeddedIpv4(second, third));
  }
  if (
    first === 0x0064 &&
    second === 0xff9b &&
    third === 0 &&
    fourth === 0 &&
    fifth === 0 &&
    sixth === 0
  ) {
    return isPublicIpAddress(embeddedIpv4(parts[6], parts[7]));
  }

  return !(
    isUnspecifiedOrLoopback ||
    isIpv4Compatible ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && second === 0x0db8)
  );
}

export function validateResolvedAddresses(addresses: readonly string[]) {
  if (addresses.length === 0) throw new Error("URL hostname did not resolve.");
  const blocked = addresses.find((address) => !isPublicIpAddress(address));
  if (blocked)
    throw new Error(`URL resolved to a non-public address: ${blocked}`);
}

export function parsePublicHttpUrl(input: string, label = "URL") {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid ${label}: ${input}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain embedded credentials.`);
  }

  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  const blockedName =
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "home.arpa" ||
    hostname.endsWith(".home.arpa") ||
    hostname === "metadata.google.internal";
  if (blockedName || (isIP(hostname) && !isPublicIpAddress(hostname))) {
    throw new Error(`${label} destination is not public: ${url.hostname}`);
  }

  return url;
}
