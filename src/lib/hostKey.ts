export function hostKeyFingerprints(prompt: string): string[] {
  return [...prompt.matchAll(/\bkey fingerprint is (\S+?)\.?(?=\s|$)/g)].map((match) => match[1]!);
}
