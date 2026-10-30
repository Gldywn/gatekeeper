// No crypto.subtle outside a secure context: Beekeeper 6.1.6 gives its plugin frame none
// (beekeeper-studio/beekeeper-studio#4942, fixed in 6.2.0). Kept apart from the Beekeeper SDK.
export const canEncrypt = (): boolean => globalThis.crypto?.subtle !== undefined;
